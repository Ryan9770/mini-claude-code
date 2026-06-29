// Critic 루프 (생성-검증 패턴): code 서브에이전트가 구현 → review 서브에이전트가 검토 →
// 문제가 있으면 code가 수정. APPROVED가 나오거나 최대 라운드에 도달할 때까지 반복.
//
// 로컬 모델은 한 번에 완벽하지 않으므로, 독립된 '리뷰어 시각'을 한 패스 더 통과시켜 품질을 끌어올린다.
import { runSubagent } from "./subagent.js";

export async function buildWithCritic(task: string, rounds = 2): Promise<void> {
  console.log(`\n🔬 Critic 루프 시작 — 최대 ${rounds}라운드`);
  console.log(`   작업: ${task}\n`);

  // 1) 최초 구현
  let impl = await runSubagent("code", `다음 작업을 구현하라:\n${task}`);

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n──────── 검토 라운드 ${round}/${rounds} ────────`);

    // 2) 리뷰 (읽기 전용으로 실제 파일을 검사)
    const review = await runSubagent(
      "review",
      `아래 요구사항에 대해 현재 작업 디렉터리의 구현을 검토하라. ` +
        `필요한 파일을 read_file/grep으로 직접 확인하라.\n\n` +
        `[요구사항]\n${task}\n\n[구현자 보고]\n${impl}`
    );

    if (review.includes("APPROVED")) {
      console.log(`\n✅ Critic: 라운드 ${round}에서 승인됨(APPROVED). 종료합니다.\n`);
      return;
    }

    // 3) 수정 (리뷰 피드백 반영)
    console.log(`\n──────── 수정 라운드 ${round}/${rounds} ────────`);
    impl = await runSubagent(
      "code",
      `이전 구현에 대한 코드 리뷰 피드백이 있다. 지적된 문제를 모두 수정하라.\n\n` +
        `[원래 요구사항]\n${task}\n\n[리뷰 피드백]\n${review}`
    );
  }

  console.log(`\n⏹️  Critic: 최대 ${rounds}라운드 완료. 결과를 확인하세요.\n`);
}
