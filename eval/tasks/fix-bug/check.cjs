// 채점기: node calc.js 출력이 SUM=15여야 통과.
const { execFileSync } = require("node:child_process");
try {
  const out = execFileSync("node", ["calc.js"], { timeout: 10_000 }).toString().trim();
  if (out === "SUM=15") {
    console.log("PASS: SUM=15");
    process.exit(0);
  }
  console.log(`FAIL: 출력 → "${out.slice(0, 60)}"`);
  process.exit(1);
} catch (e) {
  console.log(`FAIL: 실행 오류 → ${String(e.message).slice(0, 80)}`);
  process.exit(1);
}
