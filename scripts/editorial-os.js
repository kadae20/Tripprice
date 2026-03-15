#!/usr/bin/env node
/**
 * editorial-os.js
 * - pipeline.js로 draft 생성
 * - publish-auto.js로 QA → (옵션에 따라) 발행
 *
 * 옵션:
 *   --hotels=a,b,c   (필수) pipeline 입력
 *   --lang=ko|en|ja
 *   --html
 *   --publish        publish-auto에 --publish 전달
 *   --dry-run        publish-auto에 --dry-run 전달
 *   --match=keyword  publish-auto에 전달
 *   --since=YYYY-MM-DD publish-auto에 전달 (기본: 오늘)
 */
const { spawnSync } = require("child_process");
const path = require("path");

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

function runNode(scriptRel, args) {
  const script = path.join(process.cwd(), scriptRel);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  return r.status || 0;
}

function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function main() {
  const args = parseArgs(process.argv);
  const hotels = args["hotels"];
  if (!hotels) {
    console.error("오류: --hotels 옵션이 필요합니다. 예: --hotels=ibis-myeongdong,shilla-stay-mapo");
    process.exit(1);
  }

  const lang = typeof args["lang"] === "string" ? args["lang"] : "ko";
  const html = !!args["html"];
  const publish = !!args["publish"];
  const dryRun = !!args["dry-run"];
  const match = typeof args["match"] === "string" ? args["match"] : null;
  const since = typeof args["since"] === "string" ? args["since"] : today();

  // 1) pipeline
  const pipelineArgs = [`--hotels=${hotels}`, `--lang=${lang}`];
  if (html) pipelineArgs.push("--html");
  // pipeline의 --publish는 건드리지 않음 (최소 변경 원칙)
  console.log("\n[1/2] pipeline 실행:", pipelineArgs.join(" "));
  const p1 = runNode("scripts/pipeline.js", pipelineArgs);
  if (p1 !== 0) process.exit(p1);

  // 2) publish-auto
  const publishArgs = [`--since=${since}`];
  if (match) publishArgs.push(`--match=${match}`);
  if (dryRun) publishArgs.push("--dry-run");
  if (publish) publishArgs.push("--publish");

  console.log("\n[2/2] publish-auto 실행:", publishArgs.join(" "));
  const p2 = runNode("scripts/publish-auto.js", publishArgs);
  process.exit(p2);
}

main();
