// Critic 루프 (생성-검증 패턴): code 서브에이전트가 구현 → 검증 게이트 + review 서브에이전트가 검토 →
// 문제가 있으면 code가 수정. APPROVED+검증통과가 나오거나 최대 라운드에 도달할 때까지 반복.
//
// 로컬 모델은 한 번에 완벽하지 않다. 그래서 두 겹으로 거른다:
//   (1) 객관 게이트 — config.verifyCmd(테스트/타입체크)의 '종료코드'. 통과 못 하면 성공으로 인정 안 함.
//       실패 시 리뷰(주관) 대신 '실제 오류 출력'을 주고 수정시킨다 → 약한 모델에 훨씬 효과적.
//   (2) 주관 리뷰 — 검증이 통과한 뒤, 독립 리뷰어 시각으로 남은 결함을 잡는다.
import { runSubagent } from "./subagent.js";
import { runVerify } from "./tools.js";
import { isAborted } from "./io.js";
import { config } from "./config.js";

export async function buildWithCritic(task: string, rounds = 2): Promise<void> {
  console.log(`\n🔬 Critic 루프 시작 — 최대 ${rounds}라운드`);
  console.log(`   작업: ${task}`);
  console.log(
    config.verifyCmd
      ? `   검증 게이트: \`${config.verifyCmd}\` (종료코드로 판정)\n`
      : `   검증 게이트: 없음(모델 리뷰만) — MCC_VERIFY_CMD로 테스트/타입체크를 걸면 품질이 크게 오릅니다.\n`
  );

  // 1) 최초 구현
  let impl = await runSubagent("code", `다음 작업을 구현하라:\n${task}`);

  for (let round = 1; round <= rounds; round++) {
    if (isAborted()) {
      console.log("\n⛔ Critic 루프가 취소되었습니다.\n");
      return;
    }

    // 2) 객관 게이트: 검증 명령 실행(설정된 경우)
    const verify = await runVerify();
    if (verify && !verify.ok) {
      console.log(`\n──────── ❌ 검증 실패 라운드 ${round}/${rounds} ────────`);
      console.log("   객관 검증(테스트/타입체크) 실패 — 실제 오류를 주고 수정합니다.");
      impl = await runSubagent(
        "code",
        `검증 명령(\`${config.verifyCmd}\`)이 실패했다. 아래 '실제 오류 출력'을 보고 원인을 고쳐라. ` +
          `추측하지 말고 오류 메시지가 가리키는 곳을 직접 확인해 수정하라.\n\n` +
          `[원래 요구사항]\n${task}\n\n[검증 오류 출력]\n${verify.output}`
      );
      continue; // 다음 라운드에서 재검증
    }
    if (verify) console.log(`\n   ✅ 검증 통과: \`${config.verifyCmd}\``);

    // 3) 주관 리뷰 (읽기 전용으로 실제 파일 검사)
    console.log(`\n──────── 검토 라운드 ${round}/${rounds} ────────`);
    const review = await runSubagent(
      "review",
      `아래 요구사항에 대해 현재 작업 디렉터리의 구현을 검토하라. ` +
        `필요한 파일을 read_file/grep으로 직접 확인하라.\n\n` +
        `[요구사항]\n${task}\n\n[구현자 보고]\n${impl}`
    );

    if (review.includes("APPROVED")) {
      // 게이트가 켜져 있으면 이 지점은 '검증 통과 + 리뷰 승인' 둘 다 만족한 상태다.
      console.log(
        `\n✅ Critic: 라운드 ${round} 승인(APPROVED)${verify ? " + 검증 통과" : ""}. 종료합니다.\n`
      );
      return;
    }

    // 4) 수정 (리뷰 피드백 반영)
    console.log(`\n──────── 수정 라운드 ${round}/${rounds} ────────`);
    impl = await runSubagent(
      "code",
      `이전 구현에 대한 코드 리뷰 피드백이 있다. 지적된 문제를 모두 수정하라.\n\n` +
        `[원래 요구사항]\n${task}\n\n[리뷰 피드백]\n${review}`
    );
  }

  // 종료 전 마지막 검증 상태 보고
  const finalV = await runVerify();
  if (finalV) {
    console.log(
      finalV.ok
        ? `\n✅ 최종 검증 통과(\`${config.verifyCmd}\`). 다만 최대 ${rounds}라운드 도달 — 리뷰 승인은 못 받았을 수 있음.\n`
        : `\n⏹️  최대 ${rounds}라운드 완료했으나 검증(\`${config.verifyCmd}\`)은 여전히 실패. 결과를 직접 확인하세요.\n`
    );
  } else {
    console.log(`\n⏹️  Critic: 최대 ${rounds}라운드 완료. 결과를 확인하세요.\n`);
  }
}
