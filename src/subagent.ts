// 서브에이전트: 전문화된 프롬프트 + 격리된 컨텍스트로 하위 작업을 수행하고 결과만 반환.
// 메인 에이전트의 spawn_subagent 도구가 이걸 호출한다. (생성-검증/전문가 풀 패턴의 토대)
//
// 에이전트 간 "통신"은 공유 파일시스템(workdir)을 통해 이뤄진다 — Ralph의 PROGRESS.md와 같은 원리.
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createSession, runLoop, ANTI_FLAIL_RULES } from "./agent.js";
import { toolSchemas } from "./tools.js";

// 읽기 전용 도구만 (탐색/리뷰 서브에이전트는 파일을 바꾸지 않는다)
const READONLY_NAMES = new Set(["read_file", "list_dir", "glob", "grep", "use_skill"]);
const readonlyTools: ChatCompletionTool[] = toolSchemas.filter((t) =>
  READONLY_NAMES.has(t.function.name)
);

type Role = "explore" | "code" | "review";

const ROLES: Record<Role, { prompt: string; tools: ChatCompletionTool[] }> = {
  explore: {
    tools: readonlyTools,
    prompt:
      "너는 '탐색 전문' 서브에이전트다. 읽기 전용 도구(read_file/list_dir/glob/grep)로 코드베이스를 조사한다. " +
      "절대 파일을 수정하거나 명령을 실행하지 마라. 요청된 정보를 찾아, 관련 파일 경로·핵심 코드·구조를 " +
      "간결한 보고서로 정리해 마지막 메시지로 반환하라.",
  },
  code: {
    tools: toolSchemas,
    prompt:
      "너는 '구현 전문' 서브에이전트다. 주어진 작업을 실제로 구현한다(파일 생성·수정, 명령 실행). " +
      "큰 파일은 나눠서 작성하고, 변경 후 가능하면 실행해 검증하라. " +
      "완료하면 무엇을 어떤 파일에 했는지 간결히 요약해 반환하라.",
  },
  review: {
    tools: readonlyTools,
    prompt:
      "너는 '코드 리뷰어(비평가)' 서브에이전트다. 읽기 전용 도구로 구현 결과를 검토한다. " +
      "요구사항 충족 여부, 버그, 누락, 잘못된 가정, 실행 오류 가능성을 구체적으로 지적하라. " +
      "문제가 있으면 '수정 지시'를 번호 매겨 명확히 제시하라. 문제가 전혀 없으면 마지막 줄에 정확히 APPROVED 만 출력하라.",
  },
};

export async function runSubagent(type: string, task: string): Promise<string> {
  const role = (["explore", "code", "review"].includes(type) ? type : "code") as Role;
  const { prompt, tools } = ROLES[role];

  console.log(`\n  ┌─── 🧩 서브에이전트[${role}] 시작 ───`);
  // 서브에이전트도 삽질 방지 규칙을 공유해야 한다(/critic·/ralph는 전부 서브에이전트로 도므로).
  const session = createSession(`${prompt}\n\n${ANTI_FLAIL_RULES}`, tools, role);
  const result = await runLoop(session, task); // 텔레메트리 없음(메인만 기록)
  console.log(`  └─── 🧩 서브에이전트[${role}] 완료 ───\n`);

  return result || `(서브에이전트[${role}]가 텍스트 결과를 반환하지 않음)`;
}
