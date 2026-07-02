// 채점기: big_knows.txt —
//  (1) 입력 항목 수의 80% 이상이 '이름: 5자 이상 설명' 형식으로 채워졌고
//  (2) 무의미 값이 유효 값의 10% 이하여야 통과.
const { readFileSync, existsSync } = require("node:fs");

if (!existsSync("big_knows.txt")) {
  console.log("FAIL: big_knows.txt 없음");
  process.exit(1);
}
const inputCount = readFileSync("pip_list.txt", "utf-8").split("\n").filter(l => l.trim()).length;
const lines = readFileSync("big_knows.txt", "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
const entryRe = /^\S+\s*[:\-–]\s*(.{5,})$/;
const junkRe = /no description|설명 불명|알 수 없음|unknown package/i;

let good = 0, junk = 0;
for (const l of lines) {
  const m = l.match(entryRe);
  if (!m) continue;
  if (junkRe.test(m[1])) junk++;
  else good++;
}
const need = Math.floor(inputCount * 0.8);
if (good >= need && junk <= good * 0.1) {
  console.log(`PASS: 유효 ${good}/${inputCount} (기준 ${need}), 무의미 ${junk}`);
  process.exit(0);
}
console.log(`FAIL: 유효 ${good}/${inputCount} (기준 ${need}), 무의미 ${junk}, 전체 줄 ${lines.length}`);
process.exit(1);
