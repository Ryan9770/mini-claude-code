// 로컬 LLM 연결 및 에이전트 설정
// Ollama / vLLM / LM Studio 모두 OpenAI 호환 엔드포인트를 제공하므로 baseURL만 바꾸면 됩니다.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 이 파일(src/ 또는 dist/)의 부모 = mini-claude-code 프로젝트 루트.
// 스킬·하네스를 홈(~/.mcc)이 아니라 '프로젝트 안'에서 읽기 위한 기준점.
// cwd는 에이전트 작업 디렉터리(도커선 /work)라 부적합하므로, 코드 위치를 기준으로 삼는다.
// (dev: src/, 빌드: dist/, 도커: /app/dist — 모두 한 단계 위가 프로젝트 루트)
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 경량 .env 로더(의존성 없음). API 키 등 비밀을 코드/compose 밖(.env, gitignore됨)에 두기 위함.
// 이미 설정된 환경변수가 우선 — .env는 '없을 때만' 채운다(셸/Docker env를 덮지 않음).
function loadDotEnv(dir: string): void {
  try {
    const p = join(dir, ".env");
    if (!existsSync(p)) return;
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* 무시 */
  }
}
loadDotEnv(projectRoot);
if (process.cwd() !== projectRoot) loadDotEnv(process.cwd());

// run_command가 사용할 셸 선택.
// 윈도우 기본 cmd.exe는 bash 문법(mkdir -p, && 등)을 모르고 출력 인코딩(CP949)도 깨지므로,
// Git Bash가 있으면 그쪽으로 라우팅한다. MCC_SHELL로 강제 지정 가능.
function detectShell(): string | undefined {
  if (process.env.MCC_SHELL) return process.env.MCC_SHELL;
  if (process.platform === "win32") {
    for (const p of [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ]) {
      if (existsSync(p)) return p;
    }
  }
  return undefined; // 플랫폼 기본 셸 사용
}

// 서버의 컨텍스트 창 크기(llama-server --ctx-size와 반드시 일치시킬 것).
// 이 값을 넘으면 서버가 400을 뱉으므로, 압축은 이보다 훨씬 일찍 시작해야 한다.
const contextSize = Number(process.env.MCC_CONTEXT_SIZE ?? 16384);

export const config = {
  // llama.cpp(llama-server) 기본값. Ollama면 :11434/v1, vLLM이면 :8000/v1
  // Spark가 원격이면 localhost 대신 http://<spark-ip>:8080/v1 로 설정
  baseURL: process.env.MCC_BASE_URL ?? "http://localhost:8080/v1",

  // llama-server는 요청의 model 값을 무시하고 로드된 모델을 서빙하므로 임의 문자열 OK.
  // (Ollama 사용 시엔 ollama create로 만든 실제 모델명을 넣어야 함)
  model: process.env.MCC_MODEL ?? "gemma4",

  // 로컬 서버는 키 검사를 안 하지만 SDK가 값을 요구함
  apiKey: process.env.MCC_API_KEY ?? "local",

  // 한 작업당 에이전트 루프 최대 반복 횟수 (무한루프 방지).
  // 대형 과제(수백 항목 일괄 처리)는 정당하게 더 필요할 수 있음 — MCC_MAX_STEPS로 조정.
  maxSteps: Number(process.env.MCC_MAX_STEPS ?? 25),

  // 샘플링 파라미터. 에이전트 코딩은 창의성보다 '정확·결정성'이 중요하므로 좁게 잡는다.
  // temperature 낮음 + min_p(꼬리 컷)로 다국어 오염(Q4 blur가 꼬리의 외국문자 토큰을
  // 뽑는 현상: 토크나이저→토크نا이저, (a,б)/(a,బ))을 근본적으로 억제한다.
  temperature: Number(process.env.MCC_TEMPERATURE ?? 0.15),
  // min_p: 최상위 토큰 확률 대비 이 비율 미만인 후보를 잘라낸다(llama.cpp 확장 파라미터).
  // 외국문자 토큰은 대개 확률이 낮은 꼬리라 여기서 걸러진다. 0이면 비활성.
  minP: Number(process.env.MCC_MIN_P ?? 0.1),
  // frequencyPenalty: 기본 0. eval 실증 — 0.4에선 파일명 손상('know스.final'), 0.2에서도 오염.
  // 반복 붕괴는 스트림 isLooping 감지기가 별도로 잡으므로 페널티 불필요. MCC_FREQ_PENALTY로 조정.
  frequencyPenalty: Number(process.env.MCC_FREQ_PENALTY ?? 0),
  presencePenalty: 0.0,

  // 한 응답의 최대 출력 토큰. 반복 루프·폭주가 무한정 길어지는 것을 하드 차단.
  // 너무 작으면(4096) 긴 콘텐츠·도구 인자가 도중에 잘려 tool_call JSON이 깨지고 서버 500이 난다
  // (닫는 따옴표 없이 truncated). 폭주는 isLooping 감지기가 별도로 잡으므로 넉넉히 8192로. MCC_MAX_TOKENS로 조정.
  maxResponseTokens: Number(process.env.MCC_MAX_TOKENS ?? 8192),

  // 모델 응답 오류(예: 깨진 tool JSON으로 인한 500) 연속 발생 시 재시도 허용 횟수.
  maxModelRetries: 2,

  // '예고만 하고 멈춤'(도구 없이 다음 단계만 예고)일 때, 즉시 실행하도록 떠밀 최대 횟수.
  maxNudges: 3,

  // 분석마비(analysis paralysis) 감지: 스텝을 넘겨가며 사고/행동이 거의 같은 내용으로
  // 반복되면(진전 없이 같은 계획 재탕) 중단한다. 이 횟수만큼 연속 유사하면 작업 중단.
  // 중간(floor/2)에서 "한 접근에 커밋하고 즉시 실행하라"는 강한 넛지를 1회 넣는다.
  paralysisAbortRounds: 4,
  // 직전 몇 스텝과의 char 3-gram 겹침 계수 임계값(0~1). 실측: 재탕 0.53~0.65 / 진짜 진전 0.12~0.24
  // → 0.45면 재탕은 잡고 진전 오탐 여유는 넉넉(0.45 vs 0.24).
  paralysisSimilarity: 0.45,

  // Ralph 루프 백스톱: 정체·시간 안전망이 있으므로 높게 둔다(실제 종료는 보통 success/stall/timeout).
  // 무한 방지용 최후 상한일 뿐, 이 값에 자주 걸리면 너무 낮은 것이다. /ralph <N> <목표>로 실행마다 덮어쓸 수 있음.
  ralphMaxIterations: 100,

  // Ralph 종료/수렴 엔진 예산 (실질적 종료 조건).
  ralphMaxSeconds: 1800, // 벽시계 시간 예산(초). 초과 시 중단.
  ralphMaxStallRounds: 3, // 연속 N회 파일 변경이 없으면 '정체'로 보고 중단.

  // 서버 컨텍스트 창 크기 (MCC_CONTEXT_SIZE로 조정). 서버 --ctx-size와 일치시켜야 함.
  contextSize,

  // 컨텍스트 압축 임계값(추정 토큰). 서버 한계의 60%에서 압축을 시작해
  // 응답 생성·도구 결과가 들어갈 여유를 남긴다. (서버 한계를 절대 넘지 않도록)
  compactThreshold: Math.floor(contextSize * 0.6),

  // mini-claude-code 프로젝트 루트 (스킬·하네스를 여기 하위에서 읽는다)
  projectRoot,

  // 검증 게이트 명령 (예: "npm test", "npx tsc --noEmit && npm test").
  // 설정되면 critic 루프가 이 명령의 '종료코드'로 성공/실패를 객관 판정한다.
  // 미설정이면 게이트 비활성(모델 리뷰만) — 기존 동작 유지.
  verifyCmd: process.env.MCC_VERIFY_CMD,

  // auto-gate: 검증 명령이 없을 때, 모델이 먼저 '성공 조건 체크 스크립트'(gate_check.mjs)를 스스로 작성해
  // 그걸 게이트로 삼는다. "테스트가 없으면 테스트를 만들어라" — 게이트 이득(refactor 1/6→6/6)을
  // 테스트 미제공 과제로 확장하는 실험. 약한 모델이 '쓸 만한 명세'를 쓸 수 있는지가 관건. MCC_AUTO_GATE=1.
  autoGate: process.env.MCC_AUTO_GATE === "1",

  // 스파이럴 시 승격(escalate-on-spiral): 기본 단일 루프(runAgent)가 분석마비·스텝소진·반복오류로
  // 막히면, 같은 작업을 critic 루프(컨텍스트 격리된 구현→리뷰→수정)로 재시도한다.
  // 측정 근거(2026-07-06): 진짜 레버는 게이트가 아니라 critic 루프의 '컨텍스트 격리'
  // (plain refactor 1/6·median 2/6 → critic 6/6). 실패할 때만 비용을 지불하므로 쉬운 작업은 그대로 빠르다.
  // 기본 ON. MCC_ESCALATE=0으로 끈다(기준선 비교용).
  escalateOnSpiral: process.env.MCC_ESCALATE !== "0",

  // ── 2티어 검증: 클라우드 리뷰어 (프로바이더 무관) ──────────────
  // 생성은 로컬 모델, '리뷰(critic)'만 강한 클라우드 모델에 위탁한다.
  // OpenAI·Google·Anthropic 모두 OpenAI 호환 엔드포인트를 제공하므로 baseURL만 다르다.
  // 설정: MCC_REVIEW_PROVIDER(프리셋) 또는 MCC_REVIEW_BASE_URL + MCC_REVIEW_MODEL + MCC_REVIEW_API_KEY.
  // 키 또는 모델이 없으면 비활성 → 기존처럼 로컬 모델이 리뷰(하위 호환).
  reviewBaseURL: (() => {
    if (process.env.MCC_REVIEW_BASE_URL) return process.env.MCC_REVIEW_BASE_URL;
    const presets: Record<string, string> = {
      gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1/",
    };
    return presets[(process.env.MCC_REVIEW_PROVIDER ?? "").toLowerCase()];
  })(),
  reviewModel: process.env.MCC_REVIEW_MODEL,
  reviewApiKey: process.env.MCC_REVIEW_API_KEY,

  // 평가(eval) 모드: 비대화형 배치 실행용. HITL 프롬프트를 자동 처리한다 —
  // 일반 승인=자동 허용, 위험 명령=자동 거부, ask_user=자동 응답, 분석마비 핸드오프=중단.
  evalMode: process.env.MCC_EVAL === "1",

  // 어블레이션: 하네스 기능을 선택적으로 꺼서 기여도를 측정한다 (eval 전용).
  // 쉼표 목록: antiflail(삽질 방지 규칙) / router(스킬 라우터 힌트) / paralysis(분석마비 감지)
  //          / skills(로컬 스킬 목록) / lsp(쓰기 후 문법 진단 첨부)
  //          / editfix(edit_file 공백 관용 매칭 + 실패 시 실제 내용 반환)
  //          / gitgate(git push 사전 게이트: 비밀·강제·기본브랜치·검증)
  ablate: new Set(
    (process.env.MCC_ABLATE ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  ),

  // GBNF grammar 사용 여부. llama.cpp 포트(:8080)이거나 명시적 환경변수가 1일 때.
  useGrammar: process.env.MCC_USE_GRAMMAR === "1" || 
    (process.env.MCC_BASE_URL ? process.env.MCC_BASE_URL.includes("8080") : true),

  // 에이전트 작업 루트 (도구 접근을 이 디렉터리로 제한)
  workdir: process.cwd(),

  // run_command가 사용할 셸 (윈도우+Git Bash 자동 감지). undefined면 플랫폼 기본.
  shell: detectShell(),
};

