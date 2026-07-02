// 채점기: hello.js가 존재하고, 실행하면 정확히 EVAL_OK_7731을 출력해야 통과.
// cwd = 과제 워크스페이스. exit 0 = PASS.
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");

if (!existsSync("hello.js")) {
  console.log("FAIL: hello.js 없음");
  process.exit(1);
}
try {
  const out = execFileSync("node", ["hello.js"], { timeout: 10_000 }).toString().trim();
  if (out === "EVAL_OK_7731") {
    console.log("PASS: 출력 일치");
    process.exit(0);
  }
  console.log(`FAIL: 출력 불일치 → "${out.slice(0, 60)}"`);
  process.exit(1);
} catch (e) {
  console.log(`FAIL: 실행 오류 → ${String(e.message).slice(0, 80)}`);
  process.exit(1);
}
