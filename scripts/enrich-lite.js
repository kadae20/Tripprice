#!/usr/bin/env node
/**
 * enrich-lite.js
 * OSM(Nominatim/Overpass)으로 호텔 위치 정보 자동 보강.
 * nearest_station, station_walk_min, location_description, transport_info 채움.
 * 캐시: state/enrich-cache/{hotel_id}.json (30일 유효)
 *
 * 사용법:
 *   node scripts/enrich-lite.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul
 *   node scripts/enrich-lite.js --hotels=grand-hyatt-seoul --dry-run
 *   node scripts/enrich-lite.js --hotels=grand-hyatt-seoul --force  # 캐시 무시
 *
 * 환경변수:
 *   ENRICH_NOMINATIM_URL — Nominatim 서버 (기본: https://nominatim.openstreetmap.org)
 *   ENRICH_OVERPASS_URL  — Overpass API (기본: https://overpass-api.de/api/interpreter)
 *   ENRICH_UA            — User-Agent (기본: Tripprice/1.0 (https://tripprice.net))
 *   ENRICH_CACHE_DAYS    — 캐시 유효기간 일수 (기본 30)
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const ROOT          = path.join(__dirname, '..');
const PROCESSED_DIR = path.join(ROOT, 'data', 'processed');
const COVERAGE_DIR  = path.join(ROOT, 'state', 'coverage');
const CACHE_DIR     = path.join(ROOT, 'state', 'enrich-cache');

const NOMINATIM_URL  = process.env.ENRICH_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OVERPASS_URL   = process.env.ENRICH_OVERPASS_URL  || 'https://overpass-api.de/api/interpreter';
const UA             = process.env.ENRICH_UA            || 'Tripprice/1.0 (https://tripprice.net)';
const CACHE_DAYS     = parseInt(process.env.ENRICH_CACHE_DAYS || '30', 10);

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const hotelIds  = (args.hotels || '').split(',').map(h => h.trim()).filter(Boolean);
const dryRun    = args['dry-run'] === true;
const force     = args.force     === true;

if (hotelIds.length === 0) {
  console.error('사용법: node scripts/enrich-lite.js --hotels=hotel1,hotel2');
  process.exit(1);
}

// ── HTTP 유틸 ─────────────────────────────────────────────────────────────────
function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib     = url.startsWith('https') ? https : http;
    const options = {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...extraHeaders },
      timeout: 15000,
    };
    lib.get(url, options, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try   { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse fail: ${body.slice(0, 100)}`)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function httpPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib    = url.startsWith('https') ? https : http;
    const buf    = Buffer.from(body, 'utf8');
    const u      = new URL(url);
    const opts   = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  {
        'User-Agent':     UA,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': buf.length,
        ...extraHeaders,
      },
      timeout: 20000,
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch { reject(new Error(`JSON parse fail: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(buf);
    req.end();
  });
}

// ── 거리 계산 (Haversine, km) ─────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Nominatim 지오코딩 ────────────────────────────────────────────────────────
async function geocode(hotelName, city, country) {
  const q   = encodeURIComponent(`${hotelName} ${city} ${country || ''}`);
  const url = `${NOMINATIM_URL}/search?q=${q}&format=json&limit=1&addressdetails=1`;
  const res = await httpGet(url);
  if (!Array.isArray(res) || res.length === 0) return null;
  const r = res[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name };
}

// ── Overpass: 반경 1km 내 최근접 역 탐색 ────────────────────────────────────
async function findNearestStation(lat, lng) {
  const query = `[out:json][timeout:10];
(
  node["railway"="station"](around:1000,${lat},${lng});
  node["station"="subway"](around:1000,${lat},${lng});
  node["railway"="halt"](around:800,${lat},${lng});
);
out;`;

  const res  = await httpPost(`${OVERPASS_URL}?data=`, `data=${encodeURIComponent(query)}`);
  const els  = (res.elements || []).filter(e => e.lat && e.lon);
  if (els.length === 0) return null;

  // 최근접 요소
  let nearest = null;
  let minDist = Infinity;
  for (const el of els) {
    const d = haversineKm(lat, lng, el.lat, el.lon);
    if (d < minDist) { minDist = d; nearest = el; }
  }

  const nameKo = nearest.tags?.['name:ko'] || nearest.tags?.name || '';
  const name   = nameKo.includes('역') ? nameKo : `${nameKo}역`.replace(/역역$/, '역');
  const walkMin = Math.max(1, Math.round(minDist * 1000 / 80)); // 80m/min

  return { name, dist_km: Math.round(minDist * 100) / 100, walk_min: walkMin };
}

// ── 캐시 로드/저장 ────────────────────────────────────────────────────────────
function loadCache(hotelId) {
  const p = path.join(CACHE_DIR, `${hotelId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ageDays = (Date.now() - new Date(c.enriched_at || 0).getTime()) / 86400000;
    return ageDays < CACHE_DAYS ? c : null; // 만료 시 null 반환
  } catch { return null; }
}

function saveCache(hotelId, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${hotelId}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ── 처리된 JSON 업데이트 ──────────────────────────────────────────────────────
function applyEnrichment(hotelId, enrichData) {
  const pPath = path.join(PROCESSED_DIR, `${hotelId}.json`);
  if (!fs.existsSync(pPath)) return false;
  const hotel = JSON.parse(fs.readFileSync(pPath, 'utf8'));

  let changed = false;
  if (enrichData.lat && !hotel.latitude)                     { hotel.latitude = enrichData.lat;                     changed = true; }
  if (enrichData.lng && !hotel.longitude)                    { hotel.longitude = enrichData.lng;                    changed = true; }
  if (enrichData.nearest_station && !hotel.nearest_station)  { hotel.nearest_station = enrichData.nearest_station;  changed = true; }
  if (enrichData.station_walk_min && !hotel.station_walk_min){ hotel.station_walk_min = enrichData.station_walk_min; changed = true; }
  if (enrichData.location_description && !hotel.location_description) {
    hotel.location_description = enrichData.location_description; changed = true;
  }
  if (enrichData.transport_info && !hotel.transport_info) {
    hotel.transport_info = enrichData.transport_info; changed = true;
  }

  if (changed) {
    // coverage_score 재계산 (간이: overview/location_description 길이로 overview 점수 추가)
    const overviewLen  = (hotel.overview || hotel.location_description || '').trim().length;
    const overviewPts  = Math.min(10, Math.floor(overviewLen / 30));
    const existingCov  = hotel.coverage_score || 0;
    if (overviewPts > 0 && existingCov < 100) {
      // 위치 정보 추가로 최소 +3점 (address·lat/lng 점수 반영)
      hotel.coverage_score = Math.min(100, existingCov + 3);
    }
    fs.writeFileSync(pPath, JSON.stringify(hotel, null, 2), 'utf8');
  }
  return changed;
}

// ── 단일 호텔 보강 ────────────────────────────────────────────────────────────
async function enrichOne(hotelId) {
  const pPath = path.join(PROCESSED_DIR, `${hotelId}.json`);
  if (!fs.existsSync(pPath)) {
    console.log(`  [SKIP] ${hotelId}: processed JSON 없음`);
    return { status: 'skip', reason: 'no-processed-json' };
  }

  const hotel = JSON.parse(fs.readFileSync(pPath, 'utf8'));

  // 이미 풍부한 데이터 → 보강 불필요
  if (!force && hotel.nearest_station && hotel.location_description) {
    console.log(`  [SKIP] ${hotelId}: 이미 위치 정보 있음`);
    return { status: 'skip', reason: 'already-enriched' };
  }

  // 캐시 확인
  const cached = force ? null : loadCache(hotelId);
  if (cached) {
    if (!dryRun) applyEnrichment(hotelId, cached);
    console.log(`  [CACHE] ${hotelId}: 캐시 적용 (역: ${cached.nearest_station || '없음'})`);
    return { status: 'cache', ...cached };
  }

  // 좌표 결정: processed JSON 우선, 없으면 Nominatim
  let lat = hotel.latitude  ? parseFloat(hotel.latitude)  : null;
  let lng = hotel.longitude ? parseFloat(hotel.longitude) : null;
  let displayName = null;

  if (!lat || !lng) {
    try {
      const geo = await geocode(hotel.hotel_name || hotel.hotel_name_en || hotelId, hotel.city, hotel.country);
      if (geo) { lat = geo.lat; lng = geo.lng; displayName = geo.display; }
    } catch (e) {
      console.log(`  [WARN] ${hotelId}: Nominatim 실패 — ${e.message}`);
    }
    await sleep(1100); // Nominatim 1req/sec 준수
  }

  if (!lat || !lng) {
    console.log(`  [FAIL] ${hotelId}: 좌표 없음`);
    return { status: 'fail', reason: 'no-coords' };
  }

  // Overpass: 최근접 역 탐색
  let stationResult = null;
  try {
    stationResult = await findNearestStation(lat, lng);
  } catch (e) {
    console.log(`  [WARN] ${hotelId}: Overpass 실패 — ${e.message}`);
  }
  await sleep(600); // Overpass rate limit 배려

  // 결과 조합
  const cityKo   = { seoul: '서울', busan: '부산', jeju: '제주', incheon: '인천' }[hotel.city] || hotel.city;
  const hotelNameKo = hotel.hotel_name || hotel.hotel_name_en || hotelId;

  const enrichData = {
    hotel_id:    hotelId,
    enriched_at: new Date().toISOString(),
    lat,
    lng,
  };

  if (stationResult) {
    enrichData.nearest_station  = stationResult.name;
    enrichData.station_walk_min = stationResult.walk_min;
    enrichData.transport_info   = `${stationResult.name} 도보 ${stationResult.walk_min}분`;
    enrichData.location_description = `${hotelNameKo}은(는) ${cityKo}에 위치하며, ${stationResult.name}에서 도보 ${stationResult.walk_min}분 거리입니다.`;
  } else if (displayName) {
    enrichData.location_description = `${hotelNameKo}은(는) ${cityKo}에 위치합니다. (${displayName.split(',').slice(0, 3).join(',')})`;
  }

  if (!dryRun) {
    saveCache(hotelId, enrichData);
    applyEnrichment(hotelId, enrichData);
  }

  const stLabel = stationResult ? `역: ${stationResult.name}(${stationResult.walk_min}분)` : '역 미탐지';
  console.log(`  [OK]   ${hotelId}: lat=${lat.toFixed(4)} ${stLabel}${dryRun ? ' (dry-run)' : ''}`);
  return { status: 'ok', ...enrichData };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`\nenrich-lite 실행: ${hotelIds.length}개 호텔${dryRun ? ' (DRY-RUN)' : ''}${force ? ' (--force)' : ''}`);

  const stats = { ok: 0, cache: 0, skip: 0, fail: 0 };

  for (const hotelId of hotelIds) {
    try {
      const r = await enrichOne(hotelId);
      stats[r.status] = (stats[r.status] || 0) + 1;
    } catch (e) {
      console.log(`  [ERR]  ${hotelId}: ${e.message}`);
      stats.fail++;
    }
  }

  console.log(`\n완료: 처리 ${stats.ok} / 캐시 ${stats.cache} / 건너뜀 ${stats.skip} / 실패 ${stats.fail}`);
  process.exit(0);
})().catch(e => {
  console.error('enrich-lite 오류:', e.message);
  process.exit(0); // soft-fail: 파이프라인 중단 않음
});
