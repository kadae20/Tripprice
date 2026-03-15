#!/usr/bin/env node
/**
 * qa-wp-post.js (shim)
 * publish-auto.js가 호출하는 QA 엔트리.
 *
 * 목표:
 *  - draft json을 받아서 "본문 길이/H2/이미지" 같은 하드룰로 PASS/FAIL 결정
 *  - exit 0 = PASS, exit 1 = FAIL
 *
 * 필요하면 MIN_* 값만 조절하면 됨.
 */
const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/qa-wp-post.js <wordpress/drafts/*.json>");
  process.exit(1);
}

const MIN_TEXT = Number(process.env.QA_MIN_TEXT || 2000);
const MIN_H2 = Number(process.env.QA_MIN_H2 || 4);
const MIN_IMAGES = Number(process.env.QA_MIN_IMAGES || 5);

function stripTags(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const m = (html || "").match(re);
  return m ? m.length : 0;
}

function countImagesDeep(obj) {
  let n = 0;
  const visit = (v) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v === "object") {
      for (const k of Object.keys(v)) visit(v[k]);
      return;
    }
    if (typeof v === "string") {
      const m = v.match(/<img\b/gi);
      if (m) n += m.length;
    }
  };
  visit(obj);
  return n;
}

let j;
try {
  j = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.error("Invalid JSON:", e.message);
  process.exit(1);
}

// draft 구조가 제각각일 수 있어서 넉넉히 잡음
const html =
  (typeof j.html === "string" && j.html) ||
  (typeof j.content === "string" && j.content) ||
  (j.post && typeof j.post.content === "string" && j.post.content) ||
  (typeof j.body === "string" && j.body) ||
  "";

const text = stripTags(html);
const textLen = text.length;
const h2 = countTag(html, "h2");
const h3 = countTag(html, "h3");
const images = countImagesDeep(j);

let seoScore = 0;
// 점수는 간단히 "규칙 충족도"로 계산 (표시용)
seoScore += Math.min(40, Math.floor((textLen / MIN_TEXT) * 40));
seoScore += Math.min(30, Math.floor((h2 / MIN_H2) * 30));
seoScore += Math.min(30, Math.floor((images / MIN_IMAGES) * 30));
seoScore = Math.max(0, Math.min(100, seoScore));

const hardFails = [];
if (textLen < MIN_TEXT) hardFails.push(`본문 텍스트 부족: ${textLen}자 (최소 ${MIN_TEXT}자)`);
if (h2 < MIN_H2) hardFails.push(`H2 부족: ${h2}개 (최소 ${MIN_H2}개)`);
if (images < MIN_IMAGES) hardFails.push(`이미지 부족: ${images}개 (최소 ${MIN_IMAGES}개)`);

const pass = hardFails.length === 0;

// 콘솔 출력 형식(너가 본 로그랑 비슷하게)
console.log(`${pass ? "✅ PASS" : "❌ FAIL"}\n  ${require("path").basename(file)}  SEO 점수: ${seoScore}/100`);
console.log(`  통계: 텍스트 ${textLen}자 | H2 ${h2} | H3 ${h3} | 이미지 ${images}`);

if (!pass) {
  console.log(`\n  [Hard Fail]`);
  for (const f of hardFails) console.log(`    ✗ ${f}`);
}

process.exit(pass ? 0 : 1);
