#!/usr/bin/env node
/**
 * publish-auto.js
 * - wordpress/drafts/*.json 대상으로 qa-wp-post.js 실행
 * - QA PASS면:
 *    - --publish 없으면 queued 로그만 출력 (파일 이동 없음)
 *    - --publish 있으면 wp-publish.js 실행 후 wordpress/published 로 이동
 * - QA FAIL면:
 *    - --dry-run이면 파일 기록/이동 없음
 *    - 아니면 wordpress/failed 로 QA 결과 json 저장 + 드래프트 이동
 *
 * 옵션:
 *   --since=YYYY-MM-DD  (기본: 오늘)  파일명에 날짜가 들어간 draft만 대상
 *   --match=keyword     파일명 필터
 *   --dry-run           콘솔만 출력 (파일 조작 없음)
 *   --publish           QA PASS 시 wp-publish 실행
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const DRAFT_DIR = path.join(ROOT, "wordpress", "drafts");
const FAILED_DIR = path.join(ROOT, "wordpress", "failed");
const PUBLISHED_DIR = path.join(ROOT, "wordpress", "published");

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--")) {
      const [k, v] = a.replace(/^--/, "").split("=");
      args[k] = v === undefined ? true : v;
    }
  }
  return args;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function listDrafts({ since, match }) {
  if (!fs.existsSync(DRAFT_DIR)) return [];
  const files = fs.readdirSync(DRAFT_DIR)
    .filter(f => f.endsWith(".json"))
    .filter(f => f.startsWith("post-"));
  return files
    .filter(f => !since || f.includes(since))
    .filter(f => !match || f.includes(match))
    .map(f => path.join(DRAFT_DIR, f))
    .sort();
}


function runNode(scriptRel, args, opts = {}) {
  const script = path.join(ROOT, scriptRel);
  const r = spawnSync(process.execPath, [script, ...args], {
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  return r;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function saveQAResult(qaObj, outDir, baseName) {
  ensureDir(outDir);
  const p = path.join(outDir, baseName.replace(/\.json$/, "") + ".qa.json");
  fs.writeFileSync(p, JSON.stringify(qaObj, null, 2), "utf8");
  return p;
}

function moveFile(src, destDir) {
  ensureDir(destDir);
  const dest = path.join(destDir, path.basename(src));
  fs.renameSync(src, dest);
  return dest;
}

function todayKST() {
  // 서버 TZ가 UTC일 수도 있으니, 단순히 로컬 date 기준으로 YYYY-MM-DD
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function main() {
  const args = parseArgs(process.argv);
  const dryRun = !!args["dry-run"];
  const publish = !!args["publish"];
  const since = typeof args["since"] === "string" ? args["since"] : todayKST();
  const match = typeof args["match"] === "string" ? args["match"] : null;

  const drafts = listDrafts({ since, match });
  console.log(`publish-auto — 대상 drafts: ${drafts.length}개 (since=${since}${match ? `, match=${match}` : ""})`);
  if (drafts.length === 0) process.exit(0);

  let summary = { total: drafts.length, qaPass: 0, qaFail: 0, published: 0, queued: 0 };

  for (const file of drafts) {
    const base = path.basename(file);
    console.log(`\n=== QA: ${base} ===`);

    // qa-wp-post.js는 콘솔 출력도 하고, exit code 0/1로 pass/fail을 알려줌.
    const qa = runNode("scripts/qa-wp-post.js", [file], { capture: true });
    const out = (qa.stdout || "") + (qa.stderr || "");
    // 콘솔에 QA 출력 보여주기
    process.stdout.write(out);

    const qaOk = qa.status === 0;

    if (!qaOk) {
      summary.qaFail++;
      if (!dryRun) {
        // 실패 기록 + 이동
        const qaObj = safeJsonParse(qa.stdout) || { raw: out, exitCode: qa.status };
        const saved = saveQAResult(qaObj, FAILED_DIR, base);
        console.log(`→ QA 실패 기록: ${saved}`);
        const moved = moveFile(file, FAILED_DIR);
        console.log(`→ draft 이동: ${moved}`);
      } else {
        console.log(`→ DRY-RUN: QA 실패 (파일 기록/이동 없음)`);
      }
      continue;
    }

    summary.qaPass++;

    if (!publish) {
      summary.queued++;
      console.log(`→ 발행 준비됨 (queued) — 실제 발행은 --publish 옵션 추가`);
      continue;
    }

    if (dryRun) {
      console.log(`→ DRY-RUN: QA PASS + publish 요청됨 (실제 발행/이동 없음)`);
      continue;
    }

    // 실제 발행
    console.log(`→ wp-publish 실행`);
    const pub = runNode("scripts/wp-publish.js", [file], { capture: true });
    process.stdout.write((pub.stdout || "") + (pub.stderr || ""));
    if (pub.status !== 0) {
      console.log(`→ wp-publish 실패 (exit=${pub.status}) — failed로 이동`);
      const moved = moveFile(file, FAILED_DIR);
      console.log(`→ draft 이동: ${moved}`);
      continue;
    }

    const moved = moveFile(file, PUBLISHED_DIR);
    summary.published++;
    console.log(`→ 발행 완료. 파일 이동: ${moved}`);
  }

  console.log(`\n--- summary ---`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main();
