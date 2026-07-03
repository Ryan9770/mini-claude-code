// 위험 명령 분류기 (HITL 강제 / 차단)
// run_command의 명령 문자열을 검사해 위험도를 판정한다. 휴리스틱이므로 완벽하진 않지만,
// approve-all(자동 허용)을 우회해 파괴적 명령을 잡는 '심층 방어' 장치다.

export type Danger = { level: "block" | "danger"; why: string };

// 절대 실행하면 안 되는(시스템 파괴) 패턴 → 아예 차단
const BLOCK: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME)(\/|\s|$)/, why: "루트/홈 디렉터리 강제 삭제" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "포크 폭탄" },
  { re: /\bmkfs(\.\w+)?\b/, why: "파일시스템 포맷" },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/, why: "디스크 장치 직접 덮어쓰기" },
  { re: />\s*\/dev\/(sd|nvme|disk)[a-z0-9]/, why: "디스크 장치 덮어쓰기" },
];

// 위험하지만 정당한 용도가 있는 패턴 → approve-all 무시하고 항상 명시 확인
const DANGER: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-zA-Z]*r/, why: "재귀 삭제(rm -r)" },
  { re: /\brm\s+-[a-zA-Z]*f/, why: "강제 삭제(rm -f)" },
  { re: /\brm\b[^\n]*--(recursive|force)/, why: "rm --recursive/--force" },
  // NOTE: git push는 여기서 일괄 '위험'으로 잡지 않는다 — tools.ts의 gitPushGate가
  // 전담(비밀 스캔·강제 차단·기본브랜치 차단·검증). 여기서 danger로 잡으면 eval 모드가
  // 게이트 도달 전에 자동 거부해버려 "게이트 통과 시 자율 푸시"가 동작하지 않는다.
  { re: /\bgit\s+reset\s+--hard/, why: "git reset --hard(로컬 변경 손실)" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: "git clean(미추적 파일 삭제)" },
  { re: /\bgit\s+checkout\s+--\s/, why: "git checkout --(변경 폐기)" },
  { re: /\bsudo\b/, why: "권한 상승(sudo)" },
  { re: /\bchmod\s+-R\b/, why: "재귀 권한 변경" },
  { re: /\bchown\s+-R\b/, why: "재귀 소유자 변경" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "시스템 종료/재시작" },
  { re: /\bdel\s+\/[sqf]/i, why: "Windows 재귀/강제 삭제" },
  { re: /\brmdir\s+\/s/i, why: "Windows 디렉터리 트리 삭제" },
  { re: /\bformat\s+[a-z]:/i, why: "드라이브 포맷" },
  { re: /\bcurl\b[^\n]*\|\s*(sh|bash)\b/, why: "원격 스크립트 다운로드 후 실행" },
];

export function classifyCommand(cmd: string): Danger | null {
  const c = cmd ?? "";
  for (const p of BLOCK) if (p.re.test(c)) return { level: "block", why: p.why };
  for (const p of DANGER) if (p.re.test(c)) return { level: "danger", why: p.why };
  return null;
}
