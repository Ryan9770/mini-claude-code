// 공용 입력(readline) + 권한 확인
// 메인 프롬프트와 권한 확인이 같은 stdin을 공유하도록 readline을 싱글톤으로 둔다.
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

export const rl = readline.createInterface({ input: stdin, output: stdout });

let approveAll = false; // 세션 동안 'a'를 누르면 이후 자동 허용

// 위험한 작업 실행 전 사용자 승인을 받는다.
export async function confirm(summary: string): Promise<boolean> {
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

// 위험 명령 전용 승인. approve-all을 무시하고 항상 묻는다. 'yes'를 정확히 타이핑해야 실행.
export async function confirmDangerous(cmd: string, why: string): Promise<boolean> {
  process.stdout.write(`\n  🚨 위험 명령 감지 — ${why}\n     ${cmd}\n`);
  const ans = (
    await rl.question(`  실행하려면 정확히 'yes'를 입력하세요 (그 외 모두 취소): `)
  ).trim();
  return ans === "yes";
}
