// 채점기: analyze를 '중앙값'으로 재작성했는지 실행으로 검증.
// [10,20,30,100] 정렬 → n=4(짝수) → 중앙값 (20+30)/2 = 25. 출력에 MEDIAN=25가 있어야 통과.
// (평균 MEAN=40 그대로면 실패). clamp/label 함수 보존 여부도 확인(통째 재작성 방지).
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

let out;
try {
  out = execFileSync("node", ["main.js"], { timeout: 10_000 }).toString();
} catch (e) {
  console.log(`FAIL: main.js 실행 오류 → ${String(e.message).slice(0, 80)}`);
  process.exit(1);
}
const m = out.match(/MEDIAN\s*=\s*(-?\d+(?:\.\d+)?)/);
if (!m) {
  console.log(`FAIL: 'MEDIAN=<값>' 출력 없음 → "${out.trim().slice(0, 60)}"`);
  process.exit(1);
}
if (Math.abs(Number(m[1]) - 25) > 1e-9) {
  console.log(`FAIL: MEDIAN=${m[1]} (기대 25 — 중앙값 로직 오류)`);
  process.exit(1);
}
const src = readFileSync("main.js", "utf-8");
if (!/function clamp\b/.test(src) || !/function label\b/.test(src)) {
  console.log("FAIL: clamp/label 함수가 사라짐(analyze만 고쳐야 함)");
  process.exit(1);
}
console.log("PASS: MEDIAN=25, clamp/label 보존");
process.exit(0);
