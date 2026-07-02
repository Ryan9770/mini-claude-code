// 채점기: total.txt의 TOTAL=<수> 가 정답(945.00)과 일치해야 통과(±0.01).
// 정답 산출: 120.50+89.25-15.75+0+200+33.33-8.08+450.00+0+75.75 = 945.00
const { readFileSync, existsSync } = require("node:fs");

if (!existsSync("total.txt")) {
  console.log("FAIL: total.txt 없음");
  process.exit(1);
}
const text = readFileSync("total.txt", "utf-8");
const m = text.match(/TOTAL\s*=\s*(-?\d+(?:\.\d+)?)/i);
if (!m) {
  console.log(`FAIL: 'TOTAL=<수>' 형식 없음 → "${text.trim().slice(0, 60)}"`);
  process.exit(1);
}
const got = parseFloat(m[1]);
const expected = 945.0;
if (Math.abs(got - expected) < 0.01) {
  console.log(`PASS: TOTAL=${got}`);
  process.exit(0);
}
console.log(`FAIL: TOTAL=${got} (정답 ${expected})`);
process.exit(1);
