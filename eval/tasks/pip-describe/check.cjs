// 채점기: pip_knows.txt가 존재하고,
//  (1) 25개 중 20개 이상 항목이 '이름: 5자 이상 설명' 형식으로 채워졌고
//  (2) 무의미 값('No description', '설명 불명' 등)이 과반이 아니어야 통과.
const { readFileSync, existsSync } = require("node:fs");

if (!existsSync("pip_knows.txt")) {
  console.log("FAIL: pip_knows.txt 없음");
  process.exit(1);
}
const lines = readFileSync("pip_knows.txt", "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
const entryRe = /^\S+\s*[:\-–]\s*(.{5,})$/;
const junkRe = /no description|설명 불명|알 수 없음|unknown package/i;

let good = 0, junk = 0;
for (const l of lines) {
  const m = l.match(entryRe);
  if (!m) continue;
  if (junkRe.test(m[1])) junk++;
  else good++;
}
if (good >= 20 && junk <= good) {
  console.log(`PASS: 유효 설명 ${good}개 (무의미 ${junk})`);
  process.exit(0);
}
console.log(`FAIL: 유효 ${good}개 / 무의미 ${junk}개 / 전체 줄 ${lines.length} (기준: 유효≥20, 무의미≤유효)`);
process.exit(1);
