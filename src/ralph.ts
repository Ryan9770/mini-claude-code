// Ralph(위검) 루프: 같은 목표를 여러 번 통과시켜 큰 작업을 점진적으로 수렴시킨다.
//
// 핵심 원리:
//   1) 상태(진행상황)는 대화 컨텍스트가 아니라 디스크 파일(PROGRESS.md)에 저장한다.
//   2) 매 반복마다 컨텍스트를 리셋해 "깨끗한 머리"로 시작한다(context rot 방지).
//   3) 에이전트는 매번 PROGRESS.md를 읽고 → 다음 한 조각만 처리하고 → PROGRESS.md를 갱신한다.
//   4) 목표가 끝나면 'RALPH_DONE' 신호를 내고 루프를 멈춘다.
//
// 로컬 Q4 모델처럼 "한 번에 멀리 못 가는" 모델에 특히 효과적이다.
import { runAgent, resetSession } from "./agent.js";
import { config } from "./config.js";
import { ConvergenceController } from "./loop.js";
import { isAborted } from "./io.js";

const DONE = "RALPH_DONE";

export async function ralphLoop(goal: string, maxIterations = config.ralphMaxIterations): Promise<void> {
  // 종료/수렴 엔진: 예산(횟수·시간) + 정체 감지(파일 무변경) + 성공 신호로 종료를 판단.
  const loop = new ConvergenceController({
    maxIterations,
    maxSeconds: config.ralphMaxSeconds,
    maxStallRounds: config.ralphMaxStallRounds,
    watchDir: config.workdir,
  });

  const capLabel = Number.isFinite(maxIterations) ? `${maxIterations}회` : "무제한";
  console.log(`\n🔁 Ralph 루프 시작 — 최대 ${capLabel} / ${config.ralphMaxSeconds}s / 정체 ${config.ralphMaxStallRounds}회 허용`);
  if (!Number.isFinite(maxIterations)) {
    console.log(`   ※ 무제한 모드: 완료 신호·정체(파일 무변경 ${config.ralphMaxStallRounds}회)·시간 예산(${config.ralphMaxSeconds}s)으로만 종료합니다.`);
  }
  console.log(`   목표: ${goal}`);
  console.log(`   (각 반복은 컨텍스트를 리셋하고 PROGRESS.md로 상태를 이어받습니다)\n`);

  while (true) {
    if (isAborted()) {
      console.log("\n⛔ Ralph 루프가 취소되었습니다.\n");
      return;
    }
    const turn = loop.begin();
    if (!turn.proceed) break;

    console.log(`\n══════════ Ralph 반복 ${turn.iteration}/${capLabel} (경과 ${loop.elapsedSec}s) ══════════`);
    resetSession(); // 매 반복 새 컨텍스트

    const prompt = [
      `[전체 목표]`,
      goal,
      ``,
      `[지시]`,
      `1) 먼저 PROGRESS.md가 있으면 read_file로 읽어 지금까지의 진행 상황과 남은 일을 파악하라. 없으면 새로 시작이다.`,
      `2) 전체 목표를 향해 '다음 한 단계'만 수행하라(한 번에 너무 많이 하려 하지 말 것). 파일 생성·수정·명령 실행 등 실제 작업을 하라.`,
      `3) 작업 중 모든 생성 내용은 한국어로 한다.`,
      `4) 작업 후 PROGRESS.md를 write_file로 갱신하라: "## 완료"와 "## 남은 일" 섹션에 항목을 정리해 다음 반복이 이어받을 수 있게 하라.`,
      `5) 전체 목표가 완전히 달성되어 더 할 일이 없으면, 마지막에 정확히 ${DONE} 한 단어만 출력하라. 아직 남았으면 출력하지 마라.`,
    ].join("\n");

    const finalText = await runAgent(prompt);
    const { changed } = loop.end({ done: finalText.includes(DONE) });
    if (!changed) console.log(`   ⚠️ 이번 반복에서 파일 변경 없음 — 정체 가능(연속 ${config.ralphMaxStallRounds}회면 중단)`);
  }

  // 종료 사유 보고
  const msg: Record<string, string> = {
    success: `✅ 완료 신호(${DONE}) 감지 — ${loop.iterations}회 만에 목표 달성으로 판단`,
    stalled: `⏹️  정체 감지 — 연속 ${config.ralphMaxStallRounds}회 파일 변경 없음. 막힌 것으로 보고 중단(무한 반복 방지)`,
    timeout: `⏱️  시간 예산(${config.ralphMaxSeconds}s) 초과 — 중단`,
    max_iterations: `⏹️  최대 ${maxIterations}회 도달 — 중단`,
  };
  console.log(`\n${msg[loop.stopReason] ?? "종료"}. (총 ${loop.iterations}회, ${loop.elapsedSec}s) PROGRESS.md로 남은 일을 확인하세요.\n`);
}
