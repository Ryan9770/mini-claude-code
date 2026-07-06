// eval 진입점: 프롬프트 하나를 비대화형(eval 모드)으로 실행하고 종료한다.
// 러너(run.ts)가 과제마다 이 프로세스를 '작업 워크스페이스를 cwd로' 새로 띄운다
// (프로세스 격리 = 세션/모듈 상태 오염 방지).
//
// 사용: MCC_EVAL=1 npx tsx eval/entry.ts "<프롬프트>"
import { runAgent, classifyAgentTask } from "../src/agent.js";
import { buildWithCritic } from "../src/critic.js";
import { beginAbortable, endAbortable, rl } from "../src/io.js";

const prompt = process.argv[2];
if (!prompt) {
  console.error("사용법: MCC_EVAL=1 npx tsx eval/entry.ts <프롬프트>");
  process.exit(2);
}
if (process.env.MCC_EVAL !== "1") {
  console.error("MCC_EVAL=1 없이 실행됨 — HITL 프롬프트에서 멈출 수 있어 중단합니다.");
  process.exit(2);
}

beginAbortable();
try {
  // MCC_ENTRY_MODE=critic이면 강제 critic. 아니면 라우터(classifyAgentTask)가 코드작업은 critic,
  // 조회·배치·단순작업은 plain으로 보낸다(config.agentRoute=auto). MCC_AGENT_ROUTE=plain으로 순수 baseline 측정.
  // 성공/실패 판정은 어느 쪽이든 러너의 채점기(exit code)가 한다.
  if (process.env.MCC_ENTRY_MODE === "critic") await buildWithCritic(prompt);
  else if (classifyAgentTask(prompt) === "critic") await buildWithCritic(prompt);
  else await runAgent(prompt);
} catch (err: any) {
  console.error(`eval 실행 오류: ${String(err?.message ?? err).slice(0, 200)}`);
} finally {
  endAbortable();
  rl.close();
}
process.exit(0);
