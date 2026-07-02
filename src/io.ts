// 공용 입력(readline) + 권한 확인
// 메인 프롬프트와 권한 확인이 같은 stdin을 공유하도록 readline을 싱글톤으로 둔다.
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "./config.js";

export const rl = readline.createInterface({ input: stdin, output: stdout });

// ── 작업 중 강제 종료(취소) ──────────────────────────────
// 한 작업이 도는 동안 현재 AbortController를 보관. Ctrl+C가 이걸 abort하면 작업만 취소된다.
let aborter: AbortController | null = null;

export function beginAbortable(): AbortSignal {
  aborter = new AbortController();
  return aborter.signal;
}
export function endAbortable(): void {
  aborter = null;
}
// 진행 중인 작업을 취소. 작업이 있었으면 true.
export function requestAbort(): boolean {
  if (aborter && !aborter.signal.aborted) {
    aborter.abort();
    return true;
  }
  return false;
}
export function activeSignal(): AbortSignal | undefined {
  return aborter?.signal;
}
export function isAborted(): boolean {
  return aborter?.signal.aborted ?? false;
}

let approveAll = false; // 세션 동안 'a'를 누르면 이후 자동 허용

// 위험한 작업 실행 전 사용자 승인을 받는다.
export async function confirm(summary: string): Promise<boolean> {
  if (config.evalMode) return true; // 평가 모드: 일반 승인 자동 허용(비대화형)
  if (approveAll) return true;
  const ans = (
    await rl.question(`  ❓ 실행 승인? [${summary}]  (y=허용 / n=거부 / a=이후 모두 허용): `)
  )
    .trim()
    .toLowerCase();
  if (ans === "a") {
    approveAll = true;
    return true;
  }
  return ans === "y" || ans === "yes";
}

// 사용자에게 번호 선택지를 제시하고 답을 받는다(모호할 때 HITL로 방향 결정).
// 번호 선택 / '기타'(직접 입력) / 숫자 아닌 자유 입력 모두 허용.
export async function askUserChoice(question: string, options: string[]): Promise<string> {
  if (config.evalMode) {
    // 평가 모드: 사용자가 없다 — 모델이 스스로 합리적으로 진행하게 지시
    console.log(`\n🙋(자동) ${question}`);
    return "(자동 평가 모드 — 사용자 없음) 선택지 중 가장 합리적인 것을 네가 골라 즉시 진행하라. 다시 묻지 마라.";
  }
  console.log(`\n🙋 ${question}`);
  options.forEach((o, i) => console.log(`   ${i + 1}. ${o}`));
  const other = options.length + 1;
  console.log(`   ${other}. 기타(직접 입력)`);
  const ans = (await rl.question(`  선택 [1-${other}] 또는 자유 입력: `)).trim();
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  if (Number.isInteger(n) && n === other) return (await rl.question("  직접 입력: ")).trim();
  return ans; // 숫자가 아니면 그대로 자유 답변으로 취급
}

// 위험 명령 전용 승인. approve-all을 무시하고 항상 묻는다. 'yes'를 정확히 타이핑해야 실행.
export async function confirmDangerous(cmd: string, why: string): Promise<boolean> {
  if (config.evalMode) {
    console.log(`\n  🚨 위험 명령 자동 거부(평가 모드): ${cmd}`);
    return false; // 평가 모드: 위험 명령은 무조건 거부(안전)
  }
  process.stdout.write(`\n  🚨 위험 명령 감지 — ${why}\n     ${cmd}\n`);
  const ans = (
    await rl.question(`  실행하려면 정확히 'yes'를 입력하세요 (그 외 모두 취소): `)
  ).trim();
  return ans === "yes";
}
