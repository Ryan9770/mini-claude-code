// 채점기: (1) node main.js가 RESULT=12 출력, (2) 모든 .js에서 getData가 완전히 사라짐,
//        (3) fetchData가 실제로 사용됨(정의+호출) — 셋 다 만족해야 통과.
const { execFileSync } = require("node:child_process");
const { readFileSync, readdirSync } = require("node:fs");

let out;
try {
  out = execFileSync("node", ["main.js"], { timeout: 10_000 }).toString().trim();
} catch (e) {
  console.log(`FAIL: main.js 실행 오류 → ${String(e.message).slice(0, 80)}`);
  process.exit(1);
}
if (out !== "RESULT=12") {
  console.log(`FAIL: 출력 → "${out.slice(0, 60)}" (기대 RESULT=12)`);
  process.exit(1);
}
const jsFiles = readdirSync(".").filter((f) => f.endsWith(".js"));
const leftover = [];
let fetchCount = 0;
for (const f of jsFiles) {
  const src = readFileSync(f, "utf-8");
  if (/\bgetData\b/.test(src)) leftover.push(f);
  fetchCount += (src.match(/\bfetchData\b/g) ?? []).length;
}
if (leftover.length) {
  console.log(`FAIL: getData 잔존 → ${leftover.join(", ")}`);
  process.exit(1);
}
if (fetchCount < 2) {
  console.log(`FAIL: fetchData 사용 흔적 부족(${fetchCount}회 — 정의+호출 최소 2회 필요)`);
  process.exit(1);
}
console.log(`PASS: RESULT=12, getData 완전 제거, fetchData ${fetchCount}회`);
process.exit(0);
