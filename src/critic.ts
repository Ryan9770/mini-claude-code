// Critic 루프 (생성-검증 패턴): code 서브에이전트가 구현 → 검증 게이트 + review 서브에이전트가 검토 →
// 문제가 있으면 code가 수정. APPROVED+검증통과가 나오거나 최대 라운드에 도달할 때까지 반복.
//
// 로컬 모델은 한 번에 완벽하지 않다. 그래서 두 겹으로 거른다:
//   (1) 객관 게이트 — config.verifyCmd(테스트/타입체크)의 '종료코드'. 통과 못 하면 성공으로 인정 안 함.
//       실패 시 리뷰(주관) 대신 '실제 오류 출력'을 주고 수정시킨다 → 약한 모델에 훨씬 효과적.
//   (2) 주관 리뷰 — 검증이 통과한 뒤, 독립 리뷰어 시각으로 남은 결함을 잡는다.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runSubagent } from "./subagent.js";
import { runVerify } from "./tools.js";
import { isAborted } from "./io.js";
import { config } from "./config.js";

// auto-gate: 검증 명령이 없을 때, 구현에 앞서 모델이 '성공 조건 체크 스크립트'를 스스로 작성하게 한다(TDD식).
// 파일명은 반드시 gate_check.mjs — .js면 채점기의 getData 스캔과 충돌하므로 .mjs로 격리한다.
// 성공하면 config.verifyCmd를 세팅해 이후 루프가 이 자가-게이트로 판정한다. 세팅했으면 true 반환.
async function generateAutoGate(task: string): Promise<boolean> {
  console.log("\n🧪 auto-gate: 검증 명령이 없어, 모델이 성공 조건 체크 스크립트(gate_check.mjs)를 먼저 작성합니다.");
  await runSubagent(
    "code",
    `아래 작업의 '성공 조건'을 검사하는 실행 가능한 체크 스크립트를 작성하라.\n` +
      `- 반드시 파일명 'gate_check.mjs'(Node ESM)로 저장하라. .js는 금지(채점 충돌).\n` +
      `- 성공이면 exit 0, 실패면 무엇이 왜 틀렸는지 한 줄 출력 후 process.exit(1).\n` +
      `- 네 구현을 가정하지 말고, 요구사항이 '관찰 가능하게' 충족됐는지 검사하라(프로그램 실행 결과·파일 내용 등).\n` +
      `- node:child_process로 실제 실행 결과를 확인하고, 필요하면 node:fs로 파일 내용을 검사하라.\n` +
      `- 이 단계에선 체크 스크립트만 만들어라. 작업 자체(리네임 등)는 아직 구현하지 마라.\n\n[작업]\n${task}`
  );
  if (!existsSync(join(config.workdir, "gate_check.mjs"))) {
    console.log("   ⚠️ gate_check.mjs가 생성되지 않음 — 게이트 없이 진행(모델 리뷰만).");
    return false;
  }

  // "테스트를 테스트하라": 아직 구현 전(원본 상태)이므로, 판별력 있는 게이트라면 지금은 '실패'해야 한다.
  // 지금 통과하면 = 변화를 검사 못 하는 no-op(빈 스크립트·항상 exit 0 등) → 거짓 확신을 주므로 폐기.
  config.verifyCmd = "node gate_check.mjs";
  const pre = await runVerify();
  if (pre && pre.ok) {
    console.log("   ⚠️ 게이트가 '구현 전'에도 통과 = 변화를 검사 못 하는 no-op → 폐기(게이트 없이 진행).");
    config.verifyCmd = undefined;
    return false;
  }
  console.log(`   ✅ 자가-게이트 생성·검증됨(구현 전 상태를 올바르게 실패시킴): \`node gate_check.mjs\``);
  return true;
}

export async function buildWithCritic(task: string, rounds = 2): Promise<void> {
  console.log(`\n🔬 Critic 루프 시작 — 최대 ${rounds}라운드`);
  console.log(`   작업: ${task}`);

  // auto-gate: 게이트 미설정 + MCC_AUTO_GATE=1이면, 구현 전에 모델이 검증 스크립트를 스스로 만든다.
  const restoreVerify = !config.verifyCmd && config.autoGate ? await generateAutoGate(task) : false;

  console.log(
    config.verifyCmd
      ? `   검증 게이트: \`${config.verifyCmd}\` (종료코드로 판정)\n`
      : `   검증 게이트: 없음(모델 리뷰만) — MCC_VERIFY_CMD로 테스트/타입체크를 걸면 품질이 크게 오릅니다.\n`
  );

  try {
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
  } finally {
    // auto-gate로 임시 설정한 verifyCmd는 원복(다음 작업/세션 오염 방지).
    if (restoreVerify) config.verifyCmd = undefined;
  }
}
