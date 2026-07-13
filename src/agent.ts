// 에이전트 루프: LLM ↔ 도구 실행을 작업이 끝날 때까지 반복하는 핵심.
// 세션(Session) 단위로 동작하므로, 메인 에이전트와 서브에이전트가 각자 격리된 컨텍스트를 가진다.
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { config } from "./config.js";
import { toolSchemas, executeTool } from "./tools.js";
import { confirm, confirmDangerous, activeSignal, isAborted, askUserChoice } from "./io.js";
import { classifyCommand } from "./dangerous.js";
import { getSkills } from "./skills.js";
import { skillHint } from "./skill-router.js";
import { logRun, loadLearnings, type RunRecord } from "./evolve.js";
import { runSubagent } from "./subagent.js"; // 런타임에서만 사용(순환 import 안전)

// 시작 시 스킬 인덱스(name + description)만 노출 — 점진적 공개.
// ablation(skills) 시 로컬 스킬 목록도 프롬프트에서 제거(기여도 측정용).
const skills = config.ablate.has("skills") ? [] : getSkills();
const skillsSection = skills.length
  ? `\n\n[사용 가능한 스킬]\n` +
    skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") +
    `\n작업에 맞는 스킬이 있으면 먼저 use_skill("이름")으로 전체 지침을 불러와 그대로 따르라.`
  : "";

// 과거 실행에서 진화한 교훈(LEARNINGS)을 주입 — 사용 델타 되먹임.
const learnings = loadLearnings();
const learningsSection = learnings
  ? `\n\n[학습된 교훈 — 과거 실행에서 도출됨, 반드시 반영하라]\n${learnings}`
  : "";

// 실행 전 사용자 승인이 필요한 도구(파일시스템 변경·명령 실행). 읽기 전용 도구는 제외.
const RISKY = new Set(["write_file", "edit_file", "make_dir", "run_command"]);

// 분석마비 감지 시 모델에 넣는 강한 넛지.
const PARALYSIS_NUDGE =
  "너는 지금 같은 판단을 반복하며 진전이 없다(분석마비). 더 이상 같은 고민을 반복하지 마라. " +
  "정보·결정이 모호해서 막힌 거라면(무슨 뜻인지/어디서 찾는지 등) 지금 즉시 ask_user 도구로 사용자에게 선택지를 제시해 물어라. " +
  "단지 실행을 미룬 거라면 하나의 접근을 골라 즉시 도구로 실행하라. 설명·계획을 더 쓰지 마라.";

const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

const shellName = config.shell ? "bash" : process.platform === "win32" ? "cmd.exe" : "sh";

// 현재 시각(시스템 클럭). 모델의 학습 컷오프가 과거라 '지금'을 미래/가상으로 오인하는 것을 막는다.
const NOW_STR = (() => {
  try {
    return new Date().toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short" });
  } catch {
    return new Date().toISOString();
  }
})();

// 삽질 방지 핵심 규칙 — 메인/서브에이전트 '모두'가 공유해야 하는 행동 규칙.
// (서브에이전트는 BASE_SYSTEM_PROMPT가 아니라 자체 role 프롬프트를 쓰므로 별도 주입 필요)
// ablation(antiflail) 시 빈 문자열이 되어 메인·서브 모두에서 일관되게 빠진다.
export const ANTI_FLAIL_RULES = config.ablate.has("antiflail") ? "" : `[삽질 방지 — 반드시 지켜라]
- 값싼 검증 먼저(fail-fast): 수백 번 반복하는 스크립트나 비싼 작업 전에, 반드시 1건으로 먼저 시험하라. 예: pip show 하나를 먼저 실행해 실제로 설명이 나오는지 확인한 뒤 전체 루프를 돌려라.
- 결과 품질을 확인하라(단, 딱 1회): 파일을 만든 뒤 head/샘플로 내용을 한 번 확인하라. 값이 대부분 동일하거나 무의미하면(예: 'No description available'만 반복) 실행이 성공해도 작업은 실패다 — 접근을 바꿔라. '파일 생성됨'은 '작업 완료'가 아니다. ⚠️ 확인은 한 번이면 충분하다: 확인 결과가 기대와 일치하면 그 즉시 완료로 보고하라. 같은 출력을 두 번 이상 재확인하거나 글자 하나하나를 의심하며 다시 읽지 마라 — 그것이 삽질이다.
- 한 접근에 커밋하라: 같은 결정(어떤 방법을 쓸지)을 반복해서 다시 논의하지 마라. 이미 만든 스크립트를 조금씩 바꿔 새로 쓰지 마라(v2, v3 …). 방법 하나를 골라 끝까지 실행하고, 안 되면 근본 원인을 바꿔라.
- 도구가 안 되면 방식을 바꿔라: 로컬에 설치 안 된 패키지에 pip show가 안 되듯, 도구가 빈 결과를 주면 같은 도구를 반복하지 말고 다른 수단(예: 네 자체 지식)으로 전환하라.
- 모호하면 물어라: 용어의 뜻·자료 위치·사용자가 원하는 방향이 불분명하면, 추측하거나 같은 고민을 반복하지 말고 즉시 ask_user 도구로 사용자에게 번호 선택지를 제시해 물어라. 혼자 헤매는 것보다 한 번 묻는 게 낫다.
- 추가 작업이 있는지 물어봐라: 작업 종료 시 추가 작업이 존재하는지 즉시 ask_user 도구로 사용자에게 번호 선택지를 제시해 물어라.`;

// AST 편집 힌트 — 약한 모델은 좋은 도구가 있어도 습관적으로 edit_file을 쓰므로 명시적으로 유도한다.
// ablation(ast) 시 빈 문자열 → patch_ast_node 도구도 함께 빠져(tools.ts) 순수 edit_file 베이스라인이 된다.
export const AST_EDIT_HINT = config.ablate.has("ast") ? "" : `
[코드 편집 — 중요]
- 기존 함수/클래스/const '전체'를 새로 쓸 때는 edit_file(문자열 매칭)보다 patch_ast_node를 우선하라.
  심볼 이름만 대면 되므로 파일 내용을 정확히 기억하지 못해도 안전하게 교체된다(old_string 환각 방지).
- 한 줄·일부 표현만 바꾸는 부분 수정은 edit_file을 쓰라.`;

export const BASE_SYSTEM_PROMPT = `당신은 로컬에서 동작하는 에이전트형 코딩 어시스턴트다.

[현재 시각 — 매우 중요]
- 지금은 ${NOW_STR}이다. 네 학습 데이터가 이보다 과거라도, 이 날짜가 '실제 현재'다. 이 시점을 미래·가상으로 취급하지 마라.
- 뉴스·시세·최근 동향 등 시의성 있는 정보가 필요하면 반드시 web_search/fetch_url로 실제 조회하라. 절대 추측하거나 '가상 시뮬레이션'으로 지어내지 마라(가칭·유사모델 금지).

[행동 원칙]
- 절대 "~하겠습니다"라고 예고만 하고 턴을 끝내지 마라. 할 일이 있으면 그 즉시 해당 도구를 호출하라.
- 도구 없이 텍스트만 답하는 것은 "작업이 완전히 끝났을 때의 최종 요약"일 때뿐이다.
- 추측하지 말고 먼저 read_file/list_dir/grep/glob으로 사실을 확인하라.
- 파일을 수정한 뒤에는 가능하면 run_command로 실행해 결과를 검증하라.

${ANTI_FLAIL_RULES}

[파일·디렉터리]
- 디렉터리 생성은 셸 mkdir이 아니라 make_dir 도구를 사용하라.
- write_file은 상위 디렉터리를 자동 생성하므로, 새 폴더 안 파일도 바로 만들 수 있다.
${AST_EDIT_HINT}

[큰 파일 작성 — 중요]
- 한 번의 write_file로 거대한 파일을 통째로 만들지 마라. 길고 복잡한 출력은 도중에 깨지기 쉽다.
- 한 번에 약 150줄 이하로 유지하라. 더 큰 파일은 먼저 짧은 골격을 write_file로 만든 뒤, edit_file로 한 섹션씩 덧붙여라.
- 웹 프로젝트는 HTML/CSS/JS를 각각 별도 파일로 분리하라(한 파일에 몰아넣지 말 것).

[실행 환경]
- OS: ${process.platform}, run_command 셸: ${shellName}.
- run_command는 매 호출이 독립 셸이라 cd 상태가 유지되지 않는다. 경로는 항상 작업 디렉터리 기준 상대경로로 지정하라(예: \`node workspace/app/index.js\`).
- 작업 디렉터리: ${config.workdir}${skillsSection}${learningsSection}`;

// 메인 에이전트가 하위 작업을 전문 서브에이전트에 위임할 때 쓰는 도구.
export const spawnSubagentSchema: ChatCompletionTool = {
  type: "function",
  function: {
    name: "spawn_subagent",
    description:
      "전문 서브에이전트에게 하위 작업을 위임하고 결과 요약을 받는다. 큰 작업을 나눌 때 사용. " +
      "type: 'explore'(읽기 전용 조사 — 정보를 찾아 텍스트로만 반환, 파일 생성·저장 불가), " +
      "'code'(구현·문서 산출 — 파일 생성·수정·명령 실행 가능), 'review'(읽기 전용 코드 검토·비평). " +
      "⚠️ 파일을 생성하거나 저장해야 하는 작업(보고서·분석 결과를 _workspace/*.md로 저장 등)은 반드시 'code'로 위임하라 — " +
      "explore/review는 쓰기 도구가 없어 그런 작업을 완료할 수 없다.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["explore", "code", "review"], description: "서브에이전트 종류" },
        task: { type: "string", description: "서브에이전트에게 줄 구체적 작업 설명(맥락 포함)" },
      },
      required: ["type", "task"],
    },
  },
};

// ── 세션 ──────────────────────────────────────────────────
export interface Session {
  history: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  label: string;
  client?: OpenAI; // 세션 전용 클라이언트(예: 클라우드 리뷰어). 없으면 로컬 기본.
  model?: string; // 세션 전용 모델명(client와 함께 지정)
}

export function createSession(
  systemPrompt: string = BASE_SYSTEM_PROMPT,
  tools: ChatCompletionTool[] = toolSchemas,
  label = "main",
  remote?: { client: OpenAI; model: string }
): Session {
  return {
    history: [{ role: "system", content: systemPrompt }],
    tools,
    label,
    client: remote?.client,
    model: remote?.model,
  };
}

// 메인 대화 세션 (기본 도구 + 서브에이전트 위임 도구). MCP 도구는 startup에서 추가됨.
const mainSession = createSession(BASE_SYSTEM_PROMPT, [...toolSchemas, spawnSubagentSchema], "main");

// 메인 세션 초기화 (Ralph 루프 등에서 컨텍스트 리셋용)
export function resetSession(): void {
  mainSession.history.length = 0;
  mainSession.history.push({ role: "system", content: BASE_SYSTEM_PROMPT });
}

// 메인 세션에 도구 추가 (예: MCP 도구를 startup에 병합)
export function addMainTools(tools: ChatCompletionTool[]): void {
  if (tools.length) mainSession.tools.push(...tools);
}

// 메인 에이전트 실행 (텔레메트리 기록 포함)
export async function runAgent(userInput: string): Promise<string> {
  const record: RunRecord = {
    ts: new Date().toISOString(),
    goal: userInput.slice(0, 200),
    steps: 0,
    tools: {},
    errors: [],
    rejections: 0,
    outcome: "",
  };
  return runLoop(mainSession, userInput, record);
}

// ── 챗봇(비에이전트) 모드 ──────────────────────────────────
// 도구 없이 '단발 응답'만 하는 순수 대화. 에이전트와 '분리된' 자체 히스토리를 쓴다.
const CHAT_SYSTEM_PROMPT =
  "너는 도움이 되는 대화형 어시스턴트다. 한국어로 간결하고 정확하게 답한다. " +
  `현재 시각은 ${NOW_STR}이다. 학습 데이터가 과거라도 이 날짜를 실제 현재로 받아들여라(미래·가상 취급 금지). ` +
  "이 모드에서는 파일·명령·웹검색 등 도구를 쓸 수 없다. 실제 작업이나 최신 정보 조회(뉴스·시세 등)가 " +
  "필요하면 지어내지 말고, '에이전트 모드(/agent)에서 web_search로 실행하라'고 안내하라.";
const chatSession = createSession(CHAT_SYSTEM_PROMPT, [], "chat");

// 챗봇 히스토리 리셋
export function resetChat(): void {
  chatSession.history.length = 0;
  chatSession.history.push({ role: "system", content: CHAT_SYSTEM_PROMPT });
}

// 챗봇 단발 응답(도구·루프 없음). 자체 히스토리로 문맥을 유지한다.
export async function runChat(userInput: string): Promise<string> {
  chatSession.history.push({ role: "user", content: userInput });
  await maybeCompress(chatSession);
  try {
    const { content } = await streamAssistant(chatSession);
    chatSession.history.push({ role: "assistant", content: content || "" });
    return content;
  } catch (err: any) {
    if (isAborted()) {
      console.log("\n⛔ 취소되었습니다.\n");
      return "";
    }
    console.log(`\n⚠️  응답 오류: ${String(err?.message ?? err).slice(0, 160)}\n`);
    return "";
  }
}

// 의도 분류: 이 메시지가 도구·파일시스템이 필요한 '에이전트' 작업인지 '순수 대화'인지.
// auto 모드 라우팅에 사용. 분류 실패 시 안전하게 agent(기존 동작)로 폴백.
// 결정적 fast-path: 명백한 '행동' 요청은 약한 모델의 분류(오분류 잦음)에 맡기지 않고 즉시 AGENT.
// 실전 버그: "hello.txt 만들고 커밋·push해줘"가 CHAT으로 오분류돼 "컴퓨터 접근 못함"을 답했음.
// 비대칭 비용: 행동→CHAT 오분류(작업 거부)가 개념질문→AGENT 오분류(그냥 답함)보다 훨씬 해롭다 → AGENT로 편향.
const AGENT_ACTION_RE =
  /커밋|푸시|브랜치|머지|스테이징|만들어|만들라|생성|작성|수정|고쳐|편집|삭제|지워|실행|돌려|빌드|리팩터|리팩토링|구현|설계|디자인|기획|조사|분석|리서치|실험|개발|\bgit\b|\bcommit\b|\bpush\b|\bbranch\b|\bmerge\b|\bpull\b|\bclone\b|\brun\b|\bbuild\b|\bnpm\b|\bnode\b|\btsc\b/i;

// 에이전트 작업을 critic 루프(격리)로 보낼지 plain(단일 루프)로 둘지 판별.
// 근거: 측정상 critic 루프가 코드 수정·구현 과제에서 plain을 압도(refactor 1/6→6/6, median 2/6→6/6) —
// 격리가 국소 편집실패·반복이 전체로 번지는 걸 막는다. 조회·검색·배치생성은 반복이득이 없어 plain(빠름) 유지.
// 비대칭 비용: 어려운 코드작업→plain(스파이럴)이 trivial→critic(느림)보다 훨씬 해로우므로 코드작업은 critic 편향.
const CODE_WORK_RE =
  /리팩터|리팩토링|리네임|디버그|버그|고쳐|수정|바꿔|함수|클래스|메서드|컴포넌트|알고리즘|스크립트|엔드포인트|모듈|앱|게임|구현|리팩토|refactor|rename|\bfix\b|\bdebug\b|\bfunction\b|\bclass\b|\bcomponent\b|\bimplement\b|\bendpoint\b/i;
const QUERY_RE =
  /검색|찾아|찾아줘|조회|알려줘|설명해|보여줘|목록|뭐야|무엇|어때|시세|뉴스|최신|요약해|어디/i;
// 창작·문서 글쓰기 — "게임 시나리오"처럼 코드어(게임/앱)를 포함해도 코드가 아니다.
// critic(코드 구현→리뷰→수정 루프)의 대상이 아니므로 CODE_WORK_RE보다 먼저 plain으로 보낸다.
const WRITING_RE =
  /시나리오|스토리|줄거리|시놉시스|서사|세계관|대본|각본|소설|에세이|카피|기획서|보고서|문서로/i;

export function classifyAgentTask(input: string): "critic" | "plain" {
  if (config.agentRoute !== "auto") return config.agentRoute; // 강제 지정(plain/critic)
  if (QUERY_RE.test(input)) return "plain"; // 조회·검색·요약 → 빠른 단일 루프
  if (WRITING_RE.test(input)) return "plain"; // 창작·문서 글쓰기 → 코드 루프 아님
  if (CODE_WORK_RE.test(input)) return "critic"; // 코드 수정·구현 → 격리 루프
  return "plain"; // 기본은 보수적으로 plain(critic 오버헤드는 명확한 코드작업에만)
}

export async function classifyIntent(userInput: string): Promise<"agent" | "chat"> {
  if (AGENT_ACTION_RE.test(userInput)) return "agent"; // 명백한 행동 요청 → LLM 분류 건너뜀
  try {
    const res = await client.chat.completions.create({
      model: config.model,
      stream: false,
      temperature: 0,
      max_tokens: 4,
      messages: [
        {
          role: "system",
          content:
            "다음 사용자 메시지를 분류하라. 파일 읽기/쓰기/수정, 코드 구현, 명령 실행, 프로젝트·코드베이스 조사가 필요하면 AGENT. " +
            "또한 웹 검색·자료 조사·최신/시의성 정보가 필요한 요청('검색해', '찾아서', '최신', '뉴스', '시세', '현재 ~는' 등)도 반드시 AGENT. " +
            "순수하게 개념 설명·의견·잡담으로 끝나면 CHAT. 애매하면 AGENT. " +
            "반드시 AGENT 또는 CHAT 한 단어만 출력하라.",
        },
        { role: "user", content: userInput },
      ],
    });
    return (res.choices[0].message.content ?? "").toUpperCase().includes("AGENT") ? "agent" : "chat";
  } catch {
    return "agent";
  }
}

// ── 핵심 루프: 주어진 세션에서 작업을 완료까지 수행하고 최종 텍스트를 반환 ──
export async function runLoop(
  session: Session,
  userInput: string,
  record?: RunRecord
): Promise<string> {
  // 프롬프트를 읽고 관련 스킬(harness 등)만 동적으로 골라 이 턴에 주입한다.
  // (전체 주입 시 소형 모델이 과부하로 붕괴하므로 상위 K개만. 관련 없으면 빈 문자열)
  // Gemma 등 system 역할이 없는 템플릿과의 호환을 위해 별도 메시지가 아닌 user 턴에 덧붙인다.
  const hint = config.ablate.has("router") ? "" : skillHint(userInput);
  session.history.push({ role: "user", content: userInput + hint });
  await maybeCompress(session);

  const finish = (outcome: string, text: string): string => {
    if (record) {
      record.outcome = outcome;
      logRun(record);
    }
    return text;
  };

  let consecutiveErrors = 0;
  let nudges = 0; // '예고만 하고 멈춤'을 다시 행동하도록 떠민 횟수
  const recentTranscripts: string[] = []; // 최근 스텝의 사고+응답(분석마비 감지용)
  let paralysis = 0; // 연속으로 '거의 같은 내용'을 반복한 스텝 수
  let paralysisNudged = false; // 강한 넛지를 이미 1회 넣었는지
  let refusals = 0; // 연속 거부 횟수 — 거부는 '하지 마'라는 의도적 신호. 우회 루프를 끊는 근거

  // 분석마비 최종 방어선: 스스로 못 풀면 죽이지 않고 사용자에게 넘긴다(HITL).
  // true 반환 시 호출부가 작업을 종료한다. false면 사용자 지시를 주입하고 계속.
  const handoffToUser = async (): Promise<boolean> => {
    if (config.evalMode) {
      // 평가 모드: 사용자가 없으므로 핸드오프 대신 중단(outcome=paralysis로 기록됨)
      console.log(`\n🌀 분석마비 — 평가 모드이므로 중단합니다.`);
      return true;
    }
    // 라이브락 가드: 쓰기 도구가 없는 서브에이전트(explore/review)가 마비되면 사용자에게 물어봐야
    // 소용없다 — "계속 진행"해도 없는 쓰기 능력이 생기지 않아 같은 결론을 무한 반복한다(livelock).
    // 대신 중단하고 부모에게 반환한다. (쓰기가 필요한 작업이면 오케스트레이터가 'code'로 재위임해야 함)
    // 메인 세션은 항상 쓰기 도구를 가지므로 이 분기에 걸리지 않는다 = 서브에이전트에만 적용.
    const canWrite = session.tools.some((t) => RISKY.has(t.function.name));
    if (!canWrite) {
      console.log(
        `\n🌀 분석마비(읽기 전용 서브에이전트) — 사용자 위임은 무의미하므로 중단하고 부모에 반환합니다. ` +
          `쓰기가 필요한 작업이면 'code' 역할로 재위임하세요.`
      );
      return true;
    }
    console.log(`\n🌀 분석마비 — 진전이 없어 사용자에게 넘깁니다.`);
    const choice = await askUserChoice(
      "계속 같은 고민을 반복하고 있어요. 어떻게 진행할까요?",
      ["지금까지 파악한 정보로 최선을 다해 진행", "이 작업 중단"]
    );
    if (/중단|취소|stop|abort/i.test(choice)) return true;
    session.history.push({ role: "user", content: `사용자 지시: ${choice}` });
    paralysis = 0;
    paralysisNudged = false;
    recentTranscripts.length = 0;
    return false;
  };

  for (let step = 0; step < config.maxSteps; step++) {
    if (isAborted()) {
      console.log("\n⛔ 작업이 취소되었습니다.\n");
      return finish("aborted", "");
    }
    if (record) record.steps = step + 1;
    await maybeCompress(session); // 매 스텝 선제 압축 — 초과가 나기 전에 줄인다
    let content = "";
    let toolCalls: ChatCompletionMessageToolCall[] = [];
    let transcript = "";
    try {
      ({ content, toolCalls, transcript } = await streamAssistant(session));
      consecutiveErrors = 0;
    } catch (err: any) {
      // 사용자 취소(Ctrl+C)면 오류 처리·재시도 없이 즉시 정리하고 종료
      if (isAborted()) {
        console.log("\n⛔ 작업이 취소되었습니다.\n");
        return finish("aborted", "");
      }
      consecutiveErrors++;
      const emsg = String(err?.message ?? err);
      record?.errors.push(emsg.slice(0, 120));
      console.log(`\n⚠️  모델 응답 오류: ${emsg.slice(0, 160)}`);
      if (consecutiveErrors > config.maxModelRetries) {
        console.log("   연속 오류로 이번 작업을 중단합니다.\n");
        return finish("error_abort", "");
      }

      // 반복 루프: 같은 말만 되풀이한 경우 → 멈추고 행동하라고 지시 후 재시도
      if (/REPETITION_LOOP/.test(emsg)) {
        console.log("   → 반복을 멈추고 즉시 행동하도록 지시 후 재시도합니다.\n");
        session.history.push({
          role: "user",
          content:
            "직전 응답이 같은 말을 반복하며 멈췄다. 반복하지 마라. " +
            "다음 행동이 정해졌으면 설명 없이 즉시 그 도구를 호출하라. " +
            "아직 결정하지 못했으면 가장 합리적인 하나를 골라 바로 실행하라(되묻거나 망설이지 말 것).",
        });
      }
      // 컨텍스트 초과(400)는 '텍스트 추가'가 아니라 '압축'으로만 회복된다.
      // (텍스트를 더 넣으면 토큰이 늘어 영영 회복 못 함)
      else if (/context (size|length)|exceed|too long|too many tokens/i.test(emsg)) {
        console.log("   → 컨텍스트 초과: 히스토리를 강제 압축 후 재시도합니다.\n");
        await maybeCompress(session, { force: true });
      } else {
        // 흔한 원인: Q4 모델이 큰 파일을 한 번에 생성하다 tool 인자 JSON이 깨져 서버가 500.
        console.log("   → 더 작게 나눠 재시도하도록 모델에 지시합니다.\n");
        session.history.push({
          role: "user",
          content:
            "직전 응답에서 도구 호출 인자(JSON)가 깨졌다. 보통 한 번에 너무 큰 파일을 생성하려 할 때 발생한다. " +
            "파일을 더 작은 조각으로 나눠라: 먼저 짧은 골격을 write_file로 만들고, 이어서 edit_file로 섹션을 덧붙여라. " +
            "HTML/CSS/JS는 각각 별도 파일로 분리하라.",
        });
      }
      continue;
    }

    session.history.push({
      role: "assistant",
      content: content || "",
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    // ── 분석마비 감지(스텝 간): 이번 사고/응답이 최근 스텝들과 거의 같으면 진전 없이 재탕 중 ──
    // tool_call↔tool 짝을 깨지 않도록, 중단은 즉시 하되 넛지는 '스텝 마무리 시점'에만 넣는다.
    let paralysisNudgeNow = false;
    let paralysisHandoffNow = false;
    if (!config.ablate.has("paralysis")) {
      const sim = maxSimilarity(transcript, recentTranscripts);
      recentTranscripts.push(transcript);
      if (recentTranscripts.length > 3) recentTranscripts.shift();
      paralysis =
        transcript.length > 300 && sim >= config.paralysisSimilarity ? paralysis + 1 : 0;
      if (paralysis >= config.paralysisAbortRounds) {
        // 죽이지 않고 스텝 마무리 시점에 사용자에게 핸드오프(tool 짝 보존)
        paralysisHandoffNow = true;
      } else if (paralysis === Math.floor(config.paralysisAbortRounds / 2) && !paralysisNudged) {
        paralysisNudged = true;
        paralysisNudgeNow = true;
        console.log("  🌀 같은 계획 반복 감지 — 커밋하거나 ask_user로 물어보도록 넛지합니다.");
      }
    }

    if (toolCalls.length === 0) {
      // 분석마비 개입(도구 없음 → 짝 문제 없음): 핸드오프 우선, 그다음 넛지
      if (paralysisHandoffNow) {
        if (await handoffToUser()) return finish("paralysis_user_stop", content);
        continue;
      }
      if (paralysisNudgeNow) {
        session.history.push({ role: "user", content: PARALYSIS_NUDGE });
        continue;
      }
      // 도구 없이 '이제 ~하겠습니다'로 끝낸 경우 → 실제로 안 끝난 것일 수 있다.
      // 미래 작업을 예고하는 신호가 있으면 즉시 실행하도록 떠민다(최대 maxNudges회).
      if (announcesMoreWork(content) && nudges < config.maxNudges) {
        nudges++;
        console.log("  ↻ 예고만 하고 멈춤 — 즉시 실행하도록 넛지합니다.");
        session.history.push({
          role: "user",
          content:
            "방금 말한 작업을 지금 바로 도구로 실행하라(write_file/run_command 등). " +
            "더 이상 설명하거나 다음 단계를 예고하지 마라. " +
            "정말로 모든 작업이 끝났다면 'DONE'과 함께 무엇을 했는지 한 줄 요약을 답하라(예: DONE — hello.js 생성, 실행 확인 완료).",
        });
        continue;
      }
      return finish("done", content);
    }

    nudges = 0; // 도구를 호출해 진전이 있었으면 넛지 카운트 리셋

    for (const call of toolCalls) {
      if (isAborted()) {
        console.log("\n⛔ 작업이 취소되었습니다.\n");
        return finish("aborted", "");
      }
      const name = call.function.name;
      if (record) record.tools[name] = (record.tools[name] ?? 0) + 1;
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* 모델이 깨진 JSON을 낸 경우 */
      }
      console.log(`  ⚙️  ${name}(${summarize(args)})`);

      // run_command 위험도 판정 (approve-all을 우회하는 심층 방어)
      const danger = name === "run_command" ? classifyCommand(String(args.command ?? "")) : null;

      let result: string;
      if (danger?.level === "block") {
        console.log(`  🛑 안전 정책 차단: ${danger.why}`);
        if (record) record.rejections++;
        result = `안전 정책으로 차단된 명령입니다(${danger.why}). 실행하지 않았다. 더 안전한 대안을 사용하라.`;
      } else if (danger?.level === "danger" && !(await confirmDangerous(String(args.command), danger.why))) {
        console.log("  ⛔ 거부됨(위험 명령)");
        if (record) record.rejections++;
        refusals++;
        result =
          "사용자가 이 위험 명령을 의도적으로 거부했다. 같은 목표를 다른 명령·도구로 우회하려 하지 마라. " +
          "멈추고 사용자의 지시를 기다려라(꼭 필요하면 ask_user로 한 번만 물어라).";
      } else if (
        // 위험 명령은 위에서 이미 확인됨 → 일반 RISKY 확인은 건너뜀
        !danger &&
        RISKY.has(name) &&
        !(await confirm(`${name}: ${summarize(args)}`))
      ) {
        console.log("  ⛔ 거부됨");
        if (record) record.rejections++;
        refusals++;
        result =
          "사용자가 이 작업을 의도적으로 거부했다. 이는 '하지 마라'는 신호다. " +
          "같은 목표를 다른 도구로 우회 시도하지 마라(예: make_dir 거부됐다고 write_file/run_command로 재시도 금지). " +
          "멈추고, 정말 필요하면 ask_user로 어떻게 진행할지 한 번만 물어라. 그 외에는 여기서 종료하라.";
      } else if (name === "spawn_subagent") {
        // 하위 작업을 전문 서브에이전트에 위임 (격리 컨텍스트)
        result = await runSubagent(args.type, args.task);
      } else {
        if (RISKY.has(name)) refusals = 0; // 위험 작업을 승인·실행함 → 사용자가 관여 중, 카운터 리셋
        result = await executeTool(name, args);
        if (result.startsWith("오류") && record) record.errors.push(`${name}: ${result.slice(0, 100)}`);
      }
      session.history.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    // 거부가 연속 2회면 → 우회 루프를 끊고 사용자에게 넘긴다. 거부는 '하지 마'라는 의도적
    // 신호이므로, 문구로 타일러도 무시하고 다른 도구로 계속 시도하는 약한 모델을 강제로 멈춘다.
    if (refusals >= 2) {
      console.log("\n⛔ 거부가 반복됨 — 우회를 멈추고 사용자에게 넘깁니다.\n");
      if (config.evalMode) return finish("user_refused", content);
      if (await handoffToUser()) return finish("user_refused", content);
      refusals = 0; // 사용자가 새 방향을 줬으면(handoff가 false) 계속
    }

    // ask_user로 사용자가 새 방향을 줬으면 분석마비 카운터를 리셋(새 국면 → 백지에서 재시작).
    // 이렇게 안 하면 방금 물어봤는데 바로 또 핸드오프로 묻는 중복이 생긴다.
    if (toolCalls.some((c) => c.function.name === "ask_user")) {
      paralysis = 0;
      paralysisNudged = false;
      recentTranscripts.length = 0;
      refusals = 0; // 사용자에게 새 방향을 물었으니 거부 카운터도 리셋
    } else if (paralysisHandoffNow) {
      // 도구 결과를 모두 넣은 뒤(짝 유지) 분석마비 개입: 핸드오프 우선, 그다음 넛지
      if (await handoffToUser()) return finish("paralysis_user_stop", content);
    } else if (paralysisNudgeNow) {
      session.history.push({ role: "user", content: PARALYSIS_NUDGE });
    }
  }
  console.log(`\n⚠️  최대 ${config.maxSteps}스텝에 도달해 중단했습니다.\n`);
  return finish("max_steps", "");
}

// ── 스트리밍: 토큰을 실시간 출력하면서 tool_call 델타를 재조립 ──
async function streamAssistant(session: Session): Promise<{
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
  transcript: string; // 사고(reasoning)+본문 합본 — 스텝 간 분석마비 감지에 사용
}> {
  const signal = activeSignal();
  // 세션 전용 클라이언트/모델이 있으면 그것으로(클라우드 리뷰어), 없으면 로컬 기본.
  const llm = session.client ?? client;
  const isRemote = !!session.client;
  const stream = await llm.chat.completions.create(
    {
      model: session.model ?? config.model,
      messages: session.history,
      // 도구가 없는 세션(챗봇 모드)은 tools 필드를 아예 빼서 순수 대화로 만든다.
      ...(session.tools.length ? { tools: session.tools } : {}),
      temperature: config.temperature,
      // 페널티·min_p는 로컬 Q4 모델 보정용(다국어 오염 억제). 원격(클라우드)엔 보내지 않는다 —
      // Gemini 호환 엔드포인트는 frequency_penalty/min_p 같은 비표준 필드를 400으로 거부한다.
      ...(isRemote
        ? {}
        : ({
            frequency_penalty: config.frequencyPenalty,
            presence_penalty: config.presencePenalty,
            // min_p: OpenAI 표준 아님(llama.cpp 확장). SDK 타입엔 없으므로 스프레드로 주입.
            ...(config.minP > 0 ? { min_p: config.minP } : {}),
          } as Record<string, unknown>)),
      max_tokens: config.maxResponseTokens, // 한 응답이 무한정 길어지는 것을 하드 차단
      stream: true,
    },
    { signal } // Ctrl+C 시 진행 중인 스트림을 즉시 취소
  );

  // 신호에만 의존하면 SDK 버전/플랫폼에 따라 루프가 늦게 풀릴 수 있으므로,
  // abort 시 스트림 컨트롤러를 직접 닫아 서버 측 생성도 즉시 끊는다.
  const onAbort = () => {
    try {
      (stream as any).controller?.abort();
    } catch {
      /* 무시 */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let content = "";
  let printedContent = false;
  let printedThinking = false;
  const calls: ChatCompletionMessageToolCall[] = [];

  // 반복 루프 감지용: content와 reasoning을 합친 최근 텍스트를 추적
  let loopBuf = "";
  let lastChecked = 0;

  for await (const chunk of stream) {
    // 취소되면 즉시 루프를 빠져나간다(이터레이터가 늦게 throw해도 무한 대기 방지).
    if (signal?.aborted) break;
    const delta: any = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.reasoning_content) {
      if (!printedThinking) {
        process.stdout.write("\n\x1b[90m💭 ");
        printedThinking = true;
      }
      process.stdout.write(`\x1b[90m${delta.reasoning_content}\x1b[0m`);
      loopBuf += delta.reasoning_content;
    }

    if (delta.content) {
      if (!printedContent) {
        process.stdout.write("\n🤖 ");
        printedContent = true;
      }
      process.stdout.write(delta.content);
      content += delta.content;
      loopBuf += delta.content;
    }

    // 같은 말("쓸까…아니 확인할까…")을 반복하며 멈춘 경우 → 스트림을 끊는다.
    if (loopBuf.length - lastChecked > 400) {
      lastChecked = loopBuf.length;
      if (isLooping(loopBuf)) {
        try {
          (stream as any).controller?.abort();
        } catch {
          /* 무시 */
        }
        if (printedContent || printedThinking) process.stdout.write("\n");
        console.log("  🔁 반복 루프 감지 — 응답을 중단합니다.");
        throw new Error("REPETITION_LOOP: 모델 응답이 같은 말을 반복하며 멈춤");
      }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
    }
  }

  signal?.removeEventListener("abort", onAbort);
  if (printedContent || printedThinking) process.stdout.write("\n");
  // 취소로 루프를 벗어난 경우: 부분 응답을 처리하지 않고 즉시 취소로 분기시킨다.
  if (signal?.aborted) throw new Error("ABORTED: 사용자 취소");
  return { content, toolCalls: calls.filter(Boolean), transcript: loopBuf };
}

// 반복 루프 판정:
//  (1) 동일 라인 과다 반복  (2) 개행 없는 짧은 주기 반복
//  (3) 낮은 다양성 — 표현을 조금씩 바꿔가며 같은 말을 되풀이하는 '의도 루프'(analysis paralysis)
function isLooping(text: string): boolean {
  const t = text.slice(-6000);
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 6) {
    const counts = new Map<string, number>();
    for (const l of lines) {
      const n = (counts.get(l) ?? 0) + 1;
      counts.set(l, n);
      if (n >= 6) return true; // 같은 문장 6회 이상 (교대 반복도 각자 누적되어 잡힘)
    }
  }
  // (2) 개행 없는 반복: 마지막 300자가 어떤 주기(4~150)로든 완전히 반복되면 루프.
  const tail = t.slice(-300);
  for (let p = 4; p <= 150; p++) {
    if (tail.length < p * 3) continue;
    let periodic = true;
    for (let i = p; i < tail.length; i++) {
      if (tail[i] !== tail[i - p]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return true;
  }
  // (3) 다양성: 최근 1500자에서 새로운 내용(고유 3-gram) 비율이 낮으면 같은 말 재활용으로 본다.
  // 정상 산문 ~0.9 / 코드 ~0.7 / 의도 루프 ~0.15 → 0.35로 분리.
  if (t.length > 1500) {
    const recent = t.slice(-1500);
    const grams = new Set<string>();
    let total = 0;
    for (let i = 0; i + 3 <= recent.length; i++) {
      grams.add(recent.slice(i, i + 3));
      total++;
    }
    if (total > 0 && grams.size / total < 0.35) return true;
  }
  return false;
}

// ── 스텝 간 유사도(분석마비 감지) ──
// 문자 3-gram 겹침 계수(overlap coefficient): 작은 쪽 기준이라 길이 차가 큰 재탕에도 강하다.
function charGrams3(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const set = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}
function overlapCoef(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}
// 이번 텍스트가 최근 스텝들과 얼마나 겹치는지(최댓값). 교대 반복도 잡히도록 최근 N개와 비교.
function maxSimilarity(text: string, recent: string[]): number {
  if (!recent.length) return 0;
  const g = charGrams3(text);
  let max = 0;
  for (const r of recent) max = Math.max(max, overlapCoef(g, charGrams3(r)));
  return max;
}

// 도구 없이 끝난 응답이 '앞으로 할 일을 예고'하는지 판정(=실제로 안 끝남).
// 완료를 명시했거나 미래 작업 신호가 없으면 false(진짜 최종 답변).
function announcesMoreWork(text: string): boolean {
  if (/\bDONE\b/.test(text)) return false;
  const done = /(완료(했|됐|함|하였)|끝냈|마쳤|마무리|done\b|finished|completed)/i;
  const future =
    /(하겠습니다|할게요|할 것|진행하겠|작성하겠|만들겠|구현하겠|생성하겠|추가하겠|이제\s|다음\s*단계|먼저\s|단계:|step\s*\d|i'?ll|let'?s|going to|will (create|write|implement|add|make))/i;
  if (done.test(text) && !future.test(text)) return false; // 끝났다고 보고
  return future.test(text);
}

// ── 컨텍스트 압축: 오래된 대화를 요약해 교체 ──
// tool_call ↔ tool 짝이 깨지지 않도록, 잘라내는 경계는 항상 'user' 메시지로 맞춘다.
// force=true: 임계값 미만이어도 강제 압축(컨텍스트 초과 400 복구용). 더 공격적으로 줄인다.
async function maybeCompress(session: Session, opts: { force?: boolean } = {}): Promise<void> {
  const history = session.history;
  const force = opts.force === true;
  if (!force && estimateTokens(history) < config.compactThreshold) return;
  if (!force && history.length < 8) return;

  const keepBudget = force ? Math.floor(config.compactThreshold * 0.4) : config.compactThreshold / 2;
  let acc = 0;
  let cut = history.length;
  for (let i = history.length - 1; i >= 1; i--) {
    acc += estimateOne(history[i]);
    if (acc >= keepBudget && history[i].role === "user") {
      cut = i;
      break;
    }
  }
  if (cut <= 1 || cut >= history.length) {
    // 경계를 못 찾음(예: 거대한 단일 메시지). force면 하드 트림으로라도 줄인다.
    if (force) hardTrim(history);
    return;
  }

  const system = history[0];
  const block = history.slice(1, cut);
  const recent = history.slice(cut);

  const transcript = block
    .map((m) => {
      const body =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify((m as any).tool_calls ?? m.content ?? "");
      return `${m.role}: ${body}`;
    })
    .join("\n")
    .slice(0, 24000);

  let summary = "(요약 실패)";
  try {
    const res = await client.chat.completions.create({
      model: config.model,
      stream: false,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "다음은 코딩 에이전트의 이전 대화 기록이다. 향후 작업에 필요한 핵심만 간결히 요약하라: 사용자의 목표, 내려진 결정, 변경/생성된 파일, 발견한 사실, 미해결 항목. 불필요한 잡담은 제외.",
        },
        { role: "user", content: transcript },
      ],
    });
    summary = res.choices[0].message.content ?? summary;
  } catch {
    return;
  }

  history.length = 0;
  history.push(system, { role: "user", content: `[이전 대화 요약]\n${summary}` }, ...recent);
  console.log(`\n🗜️  컨텍스트 압축[${session.label}]: ${block.length}개 메시지 → 요약 1개\n`);

  // 강제 압축 후에도 여전히 크면(예: 보존 구간에 거대한 도구 결과) 내용을 잘라 최종 보장.
  if (force && estimateTokens(history) > config.compactThreshold) hardTrim(history);
}

// 최후 수단: system 제외, 긴 메시지 내용을 잘라 토큰을 강제로 줄인다.
// 컨텍스트 초과로 아무것도 못 보내는 것보다, 일부 손실을 감수하고 진행하는 게 낫다.
function hardTrim(history: ChatCompletionMessageParam[]): void {
  let trimmed = 0;
  for (const m of history) {
    if (m.role === "system") continue;
    if (typeof m.content === "string" && m.content.length > 3000) {
      m.content = m.content.slice(0, 3000) + "\n…(컨텍스트 초과로 생략됨)";
      trimmed++;
    }
  }
  if (trimmed) console.log(`   ✂️  하드 트림: 긴 메시지 ${trimmed}개 잘라 컨텍스트 확보\n`);
}

function estimateOne(m: ChatCompletionMessageParam): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}
function estimateTokens(msgs: ChatCompletionMessageParam[]): number {
  return msgs.reduce((n, m) => n + estimateOne(m), 0);
}

function summarize(args: Record<string, any>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40).replace(/\n/g, " ")}`)
    .join(", ");
}
