// 로컬 LLM 연결 및 에이전트 설정
// Ollama / vLLM / LM Studio 모두 OpenAI 호환 엔드포인트를 제공하므로 baseURL만 바꾸면 됩니다.
import { existsSync } from "node:fs";

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

  // 한 작업당 에이전트 루프 최대 반복 횟수 (무한루프 방지)
  maxSteps: 25,

  // 샘플링 파라미터.
  // temperature는 낮게(도구 호출 안정), frequencyPenalty로 반복 붕괴(같은 토큰 무한반복) 억제.
  // Q4 모델이 긴 코드를 생성할 때 '<div class<div class...' 같은 루프에 빠지는 걸 막는다.
  temperature: 0.3,
  frequencyPenalty: 0.4,
  presencePenalty: 0.0,

  // 한 응답의 최대 출력 토큰. 반복 루프·폭주가 무한정 길어지는 것을 하드 차단.
  maxResponseTokens: 4096,

  // 모델 응답 오류(예: 깨진 tool JSON으로 인한 500) 연속 발생 시 재시도 허용 횟수.
  maxModelRetries: 2,

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

  // 에이전트 작업 루트 (도구 접근을 이 디렉터리로 제한)
  workdir: process.cwd(),

  // run_command가 사용할 셸 (윈도우+Git Bash 자동 감지). undefined면 플랫폼 기본.
  shell: detectShell(),
};
