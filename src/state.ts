// FSM(유한 상태 기계) 상태 정의 및 도구 필터링 로직
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type AgentState = "PLAN" | "EXPLORE" | "CODE" | "VERIFY";

/**
 * 에이전트의 현재 상태와 히스토리(직전 도구 호출)를 기반으로 다음 상태를 전이시킵니다.
 */
export function transitionState(currentState: AgentState, lastToolCalled?: string): AgentState {
  if (!lastToolCalled) {
    // 직전에 실행한 도구가 없으면 (루프 시작 혹은 단순 텍스트 답변)
    return currentState === "VERIFY" ? "PLAN" : currentState; 
  }

  // 1. 코드 수정 도구 호출 시 -> CODE 상태로 전이
  if (["write_file", "edit_file", "make_dir", "patch_ast_node"].includes(lastToolCalled)) {
    return "CODE";
  }

  // 2. 명령어 실행 도구 호출 시 -> VERIFY 상태로 전이
  if (["run_command"].includes(lastToolCalled)) {
    return "VERIFY";
  }

  // 3. 읽기 전용 검색/조회 도구 호출 시 -> EXPLORE 상태로 전이
  if (["read_file", "list_dir", "glob", "grep", "web_search", "fetch_url"].includes(lastToolCalled)) {
    // 이미 CODE 상태이거나 VERIFY 상태일 때 가벼운 읽기는 상태를 역전시키지 않고 유지
    if (currentState === "CODE" || currentState === "VERIFY") {
      return currentState;
    }
    return "EXPLORE";
  }

  return currentState;
}

/**
 * FSM 상태에 따라 모델에게 제공할 도구 목록(Tool Schema)을 필터링합니다.
 * 소형 모델의 도구 과부하(Tool Overload)를 차단하여 집중도를 높입니다.
 */
export function filterToolsForState(state: AgentState, allTools: ChatCompletionTool[]): ChatCompletionTool[] {
  // 항상 노출되어야 하는 코어 도구
  const CORE_TOOLS = new Set(["use_skill", "ask_user", "spawn_subagent"]);

  // 상태별 허용 도구 정의
  const ALLOWED_TOOLS_BY_STATE: Record<AgentState, Set<string>> = {
    PLAN: new Set([
      "read_file", "list_dir", "glob", "grep"
    ]),
    EXPLORE: new Set([
      "read_file", "list_dir", "glob", "grep", "web_search", "fetch_url"
    ]),
    CODE: new Set([
      "write_file", "edit_file", "make_dir", "patch_ast_node", "read_file"
    ]),
    VERIFY: new Set([
      "run_command", "read_file"
    ])
  };

  const allowedNames = ALLOWED_TOOLS_BY_STATE[state];
  return allTools.filter(t => 
    CORE_TOOLS.has(t.function.name) || allowedNames.has(t.function.name)
  );
}

/**
 * FSM 상태별로 주입할 최적화된 마이크로 시스템 지침(Prompt snippet)을 반환합니다.
 */
export function getStateInstruction(state: AgentState): string {
  const instructions: Record<AgentState, string> = {
    PLAN: 
      `\n[현재 단계: 계획 수립 (PLAN)]\n` +
      `- 코드 변경 및 터미널 명령어 실행 도구가 비활성화되어 있습니다.\n` +
      `- 먼저 분석 도구(read_file, list_dir 등)를 활용하여 프로젝트의 구조를 이해하고, 작업을 어떻게 구현할지 논리적인 계획을 세우십시오.\n` +
      `- 계획 수립 시 설명은 최소화하고 필요한 경우 즉시 탐색 단계로 넘어가십시오.`,
    
    EXPLORE: 
      `\n[현재 단계: 정보 탐색 (EXPLORE)]\n` +
      `- 작업 대상 코드와 구조를 상세히 추적하는 단계입니다.\n` +
      `- 필요한 파일의 정확한 경로와 old_string 매칭 구간을 찾은 뒤 즉시 구현 단계(CODE)로 이행하십시오.`,
    
    CODE: 
      `\n[현재 단계: 코드 구현 (CODE)]\n` +
      `- 실제 코드를 수정하고 작성하는 단계입니다.\n` +
      `- 터미널 명령어 실행 도구가 제약되어 있으므로, 오직 파일 수정(edit_file/write_file)에 집중하십시오.\n` +
      `- 수정을 완료한 후에는 검증 단계(VERIFY)로 전이하여 구현한 내용을 테스트하십시오.`,
    
    VERIFY: 
      `\n[현재 단계: 동작 검증 (VERIFY)]\n` +
      `- 수정된 코드의 정합성을 검증하는 단계입니다.\n` +
      `- run_command를 사용해 테스트를 돌리거나 코드를 컴파일하여 완결성을 입증하십시오.\n` +
      `- 실패 시 발생한 에러를 분석하고 다시 구현 단계(CODE)로 돌아가 수정하십시오.`
  };

  return instructions[state];
}
