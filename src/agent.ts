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
import { confirm, confirmDangerous } from "./io.js";
import { classifyCommand } from "./dangerous.js";
import { getSkills } from "./skills.js";
import { logRun, loadLearnings, type RunRecord } from "./evolve.js";
import { runSubagent } from "./subagent.js"; // 런타임에서만 사용(순환 import 안전)

// 시작 시 스킬 인덱스(name + description)만 노출 — 점진적 공개.
const skills = getSkills();
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

const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

const shellName = config.shell ? "bash" : process.platform === "win32" ? "cmd.exe" : "sh";
export const BASE_SYSTEM_PROMPT = `당신은 로컬에서 동작하는 에이전트형 코딩 어시스턴트다.

[행동 원칙]
- 절대 "~하겠습니다"라고 예고만 하고 턴을 끝내지 마라. 할 일이 있으면 그 즉시 해당 도구를 호출하라.
- 도구 없이 텍스트만 답하는 것은 "작업이 완전히 끝났을 때의 최종 요약"일 때뿐이다.
- 추측하지 말고 먼저 read_file/list_dir/grep/glob으로 사실을 확인하라.
- 파일을 수정한 뒤에는 가능하면 run_command로 실행해 결과를 검증하라.

[파일·디렉터리]
- 디렉터리 생성은 셸 mkdir이 아니라 make_dir 도구를 사용하라.
- write_file은 상위 디렉터리를 자동 생성하므로, 새 폴더 안 파일도 바로 만들 수 있다.

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
      "type: 'explore'(읽기 전용 탐색·조사), 'code'(구현·수정), 'review'(코드 검토·비평).",
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
}

export function createSession(
  systemPrompt: string = BASE_SYSTEM_PROMPT,
  tools: ChatCompletionTool[] = toolSchemas,
  label = "main"
): Session {
  return { history: [{ role: "system", content: systemPrompt }], tools, label };
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

// ── 핵심 루프: 주어진 세션에서 작업을 완료까지 수행하고 최종 텍스트를 반환 ──
export async function runLoop(
  session: Session,
  userInput: string,
  record?: RunRecord
): Promise<string> {
  session.history.push({ role: "user", content: userInput });
  await maybeCompress(session);

  const finish = (outcome: string, text: string): string => {
    if (record) {
      record.outcome = outcome;
      logRun(record);
    }
    return text;
  };

  let consecutiveErrors = 0;
  for (let step = 0; step < config.maxSteps; step++) {
    if (record) record.steps = step + 1;
    await maybeCompress(session); // 매 스텝 선제 압축 — 초과가 나기 전에 줄인다
    let content = "";
    let toolCalls: ChatCompletionMessageToolCall[] = [];
    try {
      ({ content, toolCalls } = await streamAssistant(session));
      consecutiveErrors = 0;
    } catch (err: any) {
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

    if (toolCalls.length === 0) return finish("done", content);

    for (const call of toolCalls) {
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
        result = "사용자가 위험 명령을 거부했다. 파괴적이지 않은 안전한 대안을 찾으라.";
      } else if (
        // 위험 명령은 위에서 이미 확인됨 → 일반 RISKY 확인은 건너뜀
        !danger &&
        RISKY.has(name) &&
        !(await confirm(`${name}: ${summarize(args)}`))
      ) {
        console.log("  ⛔ 거부됨");
        if (record) record.rejections++;
        result = "사용자가 이 작업을 거부했습니다. 다른 접근을 시도하거나 사용자에게 무엇을 원하는지 물어보세요.";
      } else if (name === "spawn_subagent") {
        // 하위 작업을 전문 서브에이전트에 위임 (격리 컨텍스트)
        result = await runSubagent(args.type, args.task);
      } else {
        result = await executeTool(name, args);
        if (result.startsWith("오류") && record) record.errors.push(`${name}: ${result.slice(0, 100)}`);
      }
      session.history.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  console.log(`\n⚠️  최대 ${config.maxSteps}스텝에 도달해 중단했습니다.\n`);
  return finish("max_steps", "");
}

// ── 스트리밍: 토큰을 실시간 출력하면서 tool_call 델타를 재조립 ──
async function streamAssistant(session: Session): Promise<{
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
}> {
  const stream = await client.chat.completions.create({
    model: config.model,
    messages: session.history,
    tools: session.tools,
    temperature: config.temperature,
    frequency_penalty: config.frequencyPenalty,
    presence_penalty: config.presencePenalty,
    max_tokens: config.maxResponseTokens, // 한 응답이 무한정 길어지는 것을 하드 차단
    stream: true,
  });

  let content = "";
  let printedContent = false;
  let printedThinking = false;
  const calls: ChatCompletionMessageToolCall[] = [];

  // 반복 루프 감지용: content와 reasoning을 합친 최근 텍스트를 추적
  let loopBuf = "";
  let lastChecked = 0;

  for await (const chunk of stream) {
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

  if (printedContent || printedThinking) process.stdout.write("\n");
  return { content, toolCalls: calls.filter(Boolean) };
}

// 반복 루프 판정: (1) 동일 라인이 과도하게 반복 (2) 개행 없는 짧은 주기 반복
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
  // 개행 없는 반복: 마지막 300자가 어떤 주기(4~150)로든 완전히 반복되면 루프로 본다.
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
  return false;
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
