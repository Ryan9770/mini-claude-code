// 서브에이전트: 전문화된 프롬프트 + 격리된 컨텍스트로 하위 작업을 수행하고 결과만 반환.
// 메인 에이전트의 spawn_subagent 도구가 이걸 호출한다. (생성-검증/전문가 풀 패턴의 토대)
//
// 에이전트 간 "통신"은 공유 파일시스템(workdir)을 통해 이뤄진다 — Ralph의 PROGRESS.md와 같은 원리.
import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createSession, runLoop, ANTI_FLAIL_RULES, AST_EDIT_HINT } from "./agent.js";
import { toolSchemas } from "./tools.js";
import { config } from "./config.js";
import type { RunRecord } from "./evolve.js";

// 2티어 검증: 리뷰어용 클라우드 클라이언트(설정된 경우에만). 생성은 로컬, 판단은 강한 모델.
// OpenAI·Gemini·Anthropic 모두 OpenAI 호환 엔드포인트라 같은 SDK로 통한다.
let reviewClient: OpenAI | null | undefined; // undefined=미초기화, null=비활성
function getReviewRemote(): { client: OpenAI; model: string } | undefined {
  if (reviewClient === undefined) {
    reviewClient =
      config.reviewBaseURL && config.reviewApiKey && config.reviewModel
        ? new OpenAI({ baseURL: config.reviewBaseURL, apiKey: config.reviewApiKey })
        : null;
  }
  return reviewClient ? { client: reviewClient, model: config.reviewModel! } : undefined;
}

// 읽기 전용 도구만 (탐색/리뷰 서브에이전트는 파일을 바꾸지 않는다)
const READONLY_NAMES = new Set([
  "read_file", "list_dir", "glob", "grep", "use_skill", "web_search", "fetch_url",
]);
const readonlyTools: ChatCompletionTool[] = toolSchemas.filter((t) =>
  READONLY_NAMES.has(t.function.name)
);

type Role = "explore" | "code" | "review";

const ROLES: Record<Role, { prompt: string; tools: ChatCompletionTool[] }> = {
  explore: {
    tools: readonlyTools,
    prompt:
      "너는 '탐색 전문' 서브에이전트다. 읽기 전용 도구(read_file/list_dir/glob/grep/web_search/fetch_url)로 조사한다. " +
      "너에겐 쓰기 도구가 없다 — 파일을 만들거나 저장할 수 없다. 요청된 정보를 찾아, 결과를 " +
      "마지막 메시지의 텍스트로 정리해 반환하라(부모가 그 텍스트를 파일로 저장한다). " +
      "만약 작업이 파일 생성·저장을 요구한다면, 그건 네가 할 수 없는 일이다 — 조사 결과 텍스트만 반환하고, " +
      "'이 작업은 파일 저장이 필요하므로 code 역할로 수행해야 한다'고 한 줄 덧붙여라. 같은 고민을 반복하지 마라.",
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

  // review 역할은 클라우드 리뷰어가 설정돼 있으면 그 모델로 실행(2티어 검증).
  const remote = role === "review" ? getReviewRemote() : undefined;
  console.log(
    `\n  ┌─── 🧩 서브에이전트[${role}]${remote ? ` ☁️ ${remote.model}` : ""} 시작 ───`
  );
  // 서브에이전트도 삽질 방지 규칙을 공유해야 한다(/critic·/ralph는 전부 서브에이전트로 도므로).
  // AST_EDIT_HINT는 '호출 시점'에 참조한다 — 모듈 로드 시점 참조는 순환 import TDZ로 깨진다.
  const codeHint = role === "code" ? AST_EDIT_HINT : "";
  const session = createSession(`${prompt}\n\n${ANTI_FLAIL_RULES}${codeHint}`, tools, role, remote);
  // 서브에이전트도 텔레메트리를 기록한다(role 표시). critic 모드 라운드가 runs.jsonl에
  // 기록을 남겨야 eval 메커니즘 지표(편집실패·파싱실패 건수)를 집계할 수 있다.
  const record: RunRecord = {
    ts: new Date().toISOString(),
    goal: task.slice(0, 200),
    steps: 0,
    tools: {},
    errors: [],
    rejections: 0,
    outcome: "",
    role: `sub:${role}`,
  };
  const result = await runLoop(session, task, record);
  console.log(`  └─── 🧩 서브에이전트[${role}] 완료 ───\n`);

  // 넛지 프로토콜("끝났다면 DONE")이 서브에이전트 안에서 발동하면 반환값이 'DONE' 한 단어가
  // 되어 부모가 내용을 잃는다 → 요약 없는 DONE은 안내 문구로 대체(결과는 파일시스템에 있음).
  if (!result || /^\s*DONE\s*[.!—-]*\s*$/i.test(result)) {
    return `(서브에이전트[${role}]가 요약 없이 완료(DONE)만 반환함 — 변경 결과는 작업 디렉터리의 파일을 직접 확인하라)`;
  }
  return result;
}
