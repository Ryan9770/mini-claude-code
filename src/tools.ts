// 에이전트가 사용할 도구(tool) 정의 + 실행 로직
// 각 도구는 (1) LLM에게 보낼 JSON 스키마, (2) 실제 실행 함수로 구성됩니다.

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join, relative, isAbsolute, dirname, basename, extname } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { getSkills, getSkillBody, skillsDir } from "./skills.js";
import { getLibrarySkillBody } from "./skill-router.js";
import { askUserChoice } from "./io.js";
import { callMcpTool, mcpHasTool } from "./mcp.js";
import { activeSignal } from "./io.js";
import { patchJsTs, patchPython, type PatchResult } from "./ast.js";

// run_command 실행기: 취소(abort) 시 자식 프로세스 '트리 전체'를 종료한다.
// execAsync/exec의 abort·timeout은 직속 셸만 죽여, 그 셸이 띄운 손자 프로세스
// (npm run dev, node server.js 등)가 Windows에서 고아로 남는다. 그래서
// Windows는 taskkill /T, POSIX는 프로세스 그룹(-pid) kill로 트리째 종료한다.
const RUN_TIMEOUT_MS = 120_000;
const RUN_MAX_OUTPUT = 1024 * 1024 * 10;

function runCommand(
  command: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const isWin = process.platform === "win32";
    const child = spawn(command, {
      cwd: config.workdir,
      shell: config.shell ?? true, // config.shell(Git Bash) 없으면 플랫폼 기본 셸
      detached: !isWin, // POSIX: 자체 프로세스 그룹 생성 → -pid로 그룹 전체 종료
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      if (stdout.length < RUN_MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < RUN_MAX_OUTPUT) stderr += d.toString();
    });

    const killTree = () => {
      const pid = child.pid;
      if (pid == null) return;
      if (isWin) {
        // 셸 + 손자 프로세스까지 강제 종료
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
        } catch {
          /* 무시 */
        }
      } else {
        try {
          process.kill(-pid, "SIGKILL"); // 프로세스 그룹 전체
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 무시 */
          }
        }
      }
    };

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      killTree();
      cleanup();
      rejectP(new Error("사용자가 명령을 취소함"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      cleanup();
      rejectP(new Error(`명령 시간 초과(${RUN_TIMEOUT_MS / 1000}s)로 중단됨`));
    }, RUN_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectP(err);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveP({ stdout, stderr });
    });
  });
}

// 검증 게이트 실행: config.verifyCmd를 돌려 '종료코드'로 통과/실패를 판정한다.
// runCommand와 달리 exit code가 핵심(critic 루프의 객관 게이트). 미설정이면 null(게이트 없음).
export async function runVerify(): Promise<{ ok: boolean; output: string } | null> {
  const cmd = config.verifyCmd;
  if (!cmd) return null;
  return new Promise((resolveP) => {
    const child = spawn(cmd, {
      cwd: config.workdir,
      shell: config.shell ?? true,
      windowsHide: true,
    });
    let out = "";
    const cap = (d: Buffer) => {
      if (out.length < RUN_MAX_OUTPUT) out += d.toString();
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    let done = false;
    const finish = (ok: boolean, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ ok, output: (out + extra).slice(0, 20_000) });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 무시 */
      }
      finish(false, `\n(검증 시간 초과 ${RUN_TIMEOUT_MS / 1000}s)`);
    }, RUN_TIMEOUT_MS);
    child.on("error", (err) => finish(false, `\n(검증 실행 오류: ${err.message})`));
    child.on("close", (code) => finish(code === 0));
  });
}

// ── 웹 도구(브라우저 불필요, Node 내장 fetch) ──────────────────
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 사용자 취소(Ctrl+C) + 20초 타임아웃을 함께 거는 신호
function webSignal(): AbortSignal {
  const t = AbortSignal.timeout(20_000);
  const s = activeSignal();
  return s ? AbortSignal.any([s, t]) : t;
}

// HTML을 대략적인 평문으로 변환(스크립트/스타일 제거 → 태그 제거 → 엔티티 일부 복원)
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// DuckDuckGo HTML 엔드포인트로 검색(키·브라우저 불필요). 상위 결과의 제목·URL·요약 반환.
async function webSearch(query: string, limit = 8): Promise<string> {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": WEB_UA }, signal: webSignal() });
  if (!res.ok) return `오류: 검색 실패 (HTTP ${res.status})`;
  const html = await res.text();

  const snippets: string[] = [];
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let sm; (sm = snipRe.exec(html)); ) snippets.push(htmlToText(sm[1]));

  const out: string[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m, i = 0; (m = linkRe.exec(html)) && out.length < limit; i++) {
    let link = m[1];
    const uddg = link.match(/[?&]uddg=([^&]+)/); // DDG 리다이렉트에서 실제 URL 추출
    if (uddg) link = decodeURIComponent(uddg[1]);
    else if (link.startsWith("//")) link = "https:" + link;
    const title = htmlToText(m[2]);
    if (!title) continue;
    out.push(`${out.length + 1}. ${title}\n   ${link}\n   ${snippets[i] ?? ""}`.trimEnd());
  }
  return out.length
    ? out.join("\n\n")
    : "검색 결과 없음(질의를 바꾸거나, 엔드포인트 형식이 변경됐을 수 있음).";
}

// URL의 내용을 평문으로 가져온다(HTML은 본문만 추출). web_search 결과 링크 읽기에 사용.
async function fetchUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const res = await fetch(url, { headers: { "User-Agent": WEB_UA }, signal: webSignal() });
  if (!res.ok) return `오류: 가져오기 실패 (HTTP ${res.status})`;
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = /html|xml/i.test(ct) || /^\s*</.test(body) ? htmlToText(body) : body;
  return text.slice(0, 15_000) || "(빈 응답)";
}

// ── LSP 경량 진단: 쓰기/편집 직후 파일 문법 검사를 도구 결과에 첨부 ──────
// 약한 모델이 방금 깨뜨린 것을 '즉시' 보고 고치게 한다(opencode의 LSP 통합 경량판).
// JS/TS는 TypeScript API로(프로세스 없이 정확), Python은 syntax compile, JSON은 파싱.
// MCC_ABLATE=lsp로 끌 수 있어 eval에서 기여도 측정 가능.
let tsCache: any | null | undefined; // undefined=미시도, null=미설치
async function loadTs(): Promise<any | null> {
  if (tsCache === undefined) {
    try {
      const m: any = await import("typescript");
      tsCache = m.default ?? m;
    } catch {
      tsCache = null; // typescript 없으면 JS/TS 진단만 조용히 생략
    }
  }
  return tsCache;
}

// python으로 파일 문법만 검사(실행 아님, pyc 안 남김). 오류 시 메시지, 정상/불가 시 "".
function pyCheck(absPath: string): Promise<string> {
  return new Promise((res) => {
    const py = process.platform === "win32" ? "python" : "python3";
    let child;
    try {
      child = spawn(py, ["-c", "import sys; f=sys.argv[1]; compile(open(f,encoding='utf-8').read(), f, 'exec')", absPath], { windowsHide: true });
    } catch {
      return res("");
    }
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 무시 */ }
      res("");
    }, 8000);
    child.on("error", () => { clearTimeout(timer); res(""); });
    child.on("close", (code) => { clearTimeout(timer); res(code === 0 ? "" : err.trim().slice(-400)); });
  });
}

const JS_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

async function diagnose(absPath: string, source: string): Promise<string> {
  if (config.ablate.has("lsp")) return "";
  try {
    const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
    if (ext === ".json") {
      try { JSON.parse(source); return ""; }
      catch (e: any) { return `\n[진단] JSON 오류: ${String(e?.message ?? e).slice(0, 140)}`; }
    }
    if (JS_EXT.has(ext)) {
      const ts = await loadTs();
      if (!ts) return "";
      const out = ts.transpileModule(source, {
        reportDiagnostics: true,
        fileName: absPath,
        compilerOptions: { noEmit: true, allowJs: true },
      });
      const errs = out.diagnostics ?? [];
      if (!errs.length) return "";
      const items = errs.slice(0, 5).map((d: any) => {
        const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
        const at = pos ? ` (line ${pos.line + 1})` : "";
        return `  - ${ts.flattenDiagnosticMessageText(d.messageText, " ")}${at}`;
      });
      return `\n[진단] 문법 오류 ${errs.length}건 — 지금 고쳐라:\n${items.join("\n")}`;
    }
    if (ext === ".py") {
      const e = await pyCheck(absPath);
      return e ? `\n[진단] 파이썬 문법 오류 — 지금 고쳐라:\n${e}` : "";
    }
  } catch {
    /* 진단은 보조 — 실패해도 도구를 막지 않는다 */
  }
  return "";
}

// 경로가 허용 루트(작업 디렉터리 또는 스킬 디렉터리) 밖으로 나가지 못하게 제한.
function safePath(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(config.workdir, p);
  const roots = [config.workdir, skillsDir()];
  const allowed = roots.some((root) => !relative(root, abs).startsWith(".."));
  if (!allowed) {
    throw new Error(`허용된 디렉터리 밖 접근 거부: ${p}`);
  }
  return abs;
}

// ── 경로 퍼지 수리 ───────────────────────────────────────────
// 약한 모델이 파일 경로/확장자를 오염(.md→.mmd/.py, 이름 오타)시켜 read/edit/patch가
// 대상을 못 찾는 것을 완화한다. 요청 경로가 없으면 같은 디렉터리에서 '유일하게 근접한
// 실존 파일'을 찾아 대신 쓰고, 수리 사실을 결과에 밝힌다. MCC_ABLATE=pathfix로 끔(측정용).
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  const cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let k = 0; k <= n; k++) prev[k] = cur[k];
  }
  return prev[n];
}

// 실존 파일이면 그대로. 없으면 같은 디렉터리에서 근접 실존 파일을 '유일할 때만' 반환.
async function resolveExistingPath(abs: string): Promise<{ path: string; repaired?: string }> {
  try {
    if ((await stat(abs)).isFile()) return { path: abs };
  } catch {
    /* 없음 → 수리 시도 */
  }
  const dir = dirname(abs);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { path: abs };
  }
  const want = basename(abs);
  const wStem = basename(abs, extname(abs));
  const wExt = extname(abs);
  const cands = entries.filter((e) => {
    if (e === want) return false;
    // (a) 같은 스템, 다른 확장자 (예: 00_input.md ↔ 00_input.py/.mmd)
    if (wStem && basename(e, extname(e)) === wStem) return true;
    // (b) 같은 확장자 + 편집거리 ≤2 + 이름 길이 ≥4 (오타 방어, 짧은 이름 오매칭 방지)
    if (wExt && extname(e) === wExt && want.length >= 4 && levenshtein(e, want) <= 2) return true;
    return false;
  });
  if (cands.length === 1) {
    const p = join(dir, cands[0]);
    try {
      if ((await stat(p)).isFile()) return { path: p, repaired: cands[0] };
    } catch {
      /* skip */
    }
  }
  return { path: abs };
}

// safePath + 경로 퍼지 수리. 실존 파일이 필요한 도구(read/edit/patch)에서 사용.
// 반환 note는 수리가 일어났을 때만 채워져 결과에 앞에 붙는다(투명성).
async function safeExisting(p: string): Promise<{ path: string; note: string }> {
  const abs = safePath(p);
  if (config.ablate.has("pathfix")) return { path: abs, note: "" };
  const r = await resolveExistingPath(abs);
  return {
    path: r.path,
    note: r.repaired ? `(경로 수리: 요청 '${p}' 없음 → 실제 파일 '${r.repaired}' 사용)\n` : "",
  };
}

// ── edit_file 회복력 ─────────────────────────────────────────────
// 약한 모델의 최대 실패 원인: old_string을 '읽지 않고 환각'해서 매칭 실패 → 삽질.
// eval(refactor-rename)에서 직접 측정된 병목. 아래 두 장치로 대응한다:
//  (1) 공백 관용 매칭 — 들여쓰기·줄바꿈 양만 다르면 실제 텍스트에 재매칭해 '성공'시킴.
//  (2) 실패 시 진짜 파일 내용을 돌려줌 — 모델이 환각 대신 실물을 보고 재시도하게 한다.
// MCC_ABLATE=editfix로 끄면 예전의 짧은 오류만 반환(기여도 측정용).

function editTrigrams(s: string): Set<string> {
  const t = s.toLowerCase();
  const g = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}
// 겹침 계수(0~1): 짧은 쪽 기준이라 길이 차이에 관대. 앵커 줄 찾기에 사용.
function editSim(a: string, b: string): number {
  const A = editTrigrams(a), B = editTrigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

// 공백(들여쓰기/줄바꿈)의 '양'만 다른 경우를 관용해 실제 매칭 구간을 찾는다.
// 비공백 토큰은 순서·내용이 정확히 일치해야 하므로 오매칭 위험은 낮다.
// 정확히 1곳일 때만 성공 처리(모호하면 null → 상위에서 다중발생으로 안내).
function whitespaceTolerantMatch(original: string, needle: string): { start: number; end: number } | null {
  const tokens = needle.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const pattern = tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  let rx: RegExp;
  try { rx = new RegExp(pattern, "g"); } catch { return null; }
  const matches = [...original.matchAll(rx)];
  if (matches.length !== 1) return null;
  const m = matches[0];
  return { start: m.index!, end: m.index! + m[0].length };
}

// 매칭 실패 시 '진짜 파일'을 보여준다. 작으면 전체(줄번호), 크면 가장 근접한 창.
function editReality(original: string, needle: string): string {
  const lines = original.split("\n");
  const num = (arr: string[], base: number) =>
    arr.map((l, i) => `${String(base + i + 1).padStart(4)}| ${l}`).join("\n");
  if (lines.length <= 80) {
    return `\n── 실제 파일 내용(${lines.length}줄) — 이걸 보고 old_string을 정확히 복사하라 ──\n${num(lines, 0)}`;
  }
  const anchor = needle.split("\n").map((l) => l.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? "";
  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = editSim(lines[i].trim(), anchor);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best < 0 || bestScore < 0.3) {
    return `\n(파일 ${lines.length}줄 — old_string과 유사한 구간을 못 찾음. read_file로 실제 내용을 먼저 확인하라)`;
  }
  const from = Math.max(0, best - 6), to = Math.min(lines.length, best + 7);
  return `\n── 실제 파일에서 가장 근접한 구간(${from + 1}~${to}줄) — 여기서 정확히 복사하라 ──\n${num(lines.slice(from, to), from)}`;
}

// count>1: 각 발생의 줄번호를 보여 '더 긴 문맥'을 넣도록 구체적으로 돕는다.
function editOccurrences(original: string, needle: string): string {
  const idxs: number[] = [];
  let from = 0;
  while (true) {
    const i = original.indexOf(needle, from);
    if (i === -1) break;
    idxs.push(i);
    from = i + needle.length;
  }
  const lineOf = (i: number) => original.slice(0, i).split("\n").length;
  const locs = idxs.map((i) => `${lineOf(i)}줄`).join(", ");
  return `\n발생 위치: ${locs}. 각 위치가 구별되도록 앞뒤 줄을 더 포함하라.`;
}

// 탐색에서 제외할 디렉터리 (속도·노이즈 방지)
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", ".cache",
]);

// 글롭 패턴(**/*.ts 등)을 정규식으로 변환
function globToRegex(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++; // **/ 는 0개 이상의 디렉터리
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// ── git push 사전 게이트 ─────────────────────────────────────────
// 정책: "게이트 통과 시 자율" — 통과하면 확인 없이 밀고, 실패하면 밀지 않고 이유를 반환.
// 약한 로컬 모델의 자율 푸시 리스크(비밀 유출·깨진 코드·강제푸시·기본브랜치 직접푸시)를 막는다.
// 우회 escape: MCC_ALLOW_FORCE=1, MCC_ALLOW_MAIN=1. 측정용 무력화: MCC_ABLATE=gitgate.

// diff의 '추가된 줄(+)'에서만 찾는 비밀 패턴(기존 코드 오탐 최소화).
const SECRET_PATTERNS: [RegExp, string][] = [
  [/AIza[0-9A-Za-z_\-]{35}/, "Google API 키"],
  [/AKIA[0-9A-Z]{16}/, "AWS 액세스 키"],
  [/\bsk-[A-Za-z0-9]{20,}/, "OpenAI 키"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub 토큰"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack 토큰"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "개인키 블록"],
  [/(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i, "하드코딩된 비밀값"],
];

function isGitPush(command: string): boolean {
  return /\bgit\s+push\b/.test(command);
}

async function sh(command: string): Promise<{ out: string; code: boolean }> {
  const { stdout, stderr } = await runCommand(command, activeSignal());
  // runCommand는 실패해도 reject 안 하므로 stderr로 대략 판정(정밀 판정은 별도 명령으로)
  return { out: (stdout + stderr).trim(), code: !/fatal:|error:/i.test(stderr) };
}

// 통과면 null, 막으면 '왜 막혔는지(+어떻게 고칠지)'를 반환한다.
async function gitPushGate(command: string): Promise<string | null> {
  if (config.ablate.has("gitgate")) return null;

  // (1) 강제 푸시 차단(--force-with-lease는 안전하므로 허용)
  if (/(--force\b(?!-with-lease)|(?:^|\s)-f(?:\s|$))/.test(command) && process.env.MCC_ALLOW_FORCE !== "1") {
    return "🚫 푸시 차단: 강제 푸시(--force/-f)는 히스토리를 파괴할 수 있어 금지된다. "
      + "필요하면 --force-with-lease를 쓰거나, 정말 의도했다면 사용자에게 MCC_ALLOW_FORCE=1을 요청하라.";
  }

  // (2) 기본 브랜치 직접 푸시 차단 → 피처 브랜치 권장
  const branch = (await sh("git rev-parse --abbrev-ref HEAD")).out.split("\n").pop()?.trim() ?? "";
  if (/^(main|master)$/.test(branch) && process.env.MCC_ALLOW_MAIN !== "1") {
    return `🚫 푸시 차단: 기본 브랜치(${branch})에 직접 푸시 금지. `
      + `'git switch -c feature/<이름>'으로 피처 브랜치를 만들어 거기서 커밋·푸시하라.`;
  }

  // (3) 밀려는 커밋 범위의 diff에서 비밀 스캔(추가된 줄만)
  const hasUp = (await sh("git rev-parse --abbrev-ref --symbolic-full-name @{u}")).code;
  const diffCmd = hasUp ? "git diff @{u}..HEAD" : "git log -p --no-color -n 30";
  const diff = (await sh(diffCmd)).out;
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  for (const [rx, label] of SECRET_PATTERNS) {
    if (rx.test(added)) {
      return `🚫 푸시 차단: 커밋에 비밀로 보이는 값(${label})이 있다. `
        + `절대 푸시하지 마라. 해당 값을 .env 등으로 빼고(코드/커밋에서 제거), `
        + `이미 커밋됐다면 히스토리에서 지운 뒤 다시 시도하라. `
        + `⚠️ 게이트를 통과시키려고 값의 형식을 바꾸거나 위장(우회)하지 마라 — 그건 탐지만 속일 뿐 `
        + `비밀은 그대로 유출된다. 유일하게 올바른 해결은 '실제로 비밀을 제거'하는 것이다.`;
    }
  }

  // (4) 검증 게이트가 설정돼 있으면 테스트 초록일 때만 푸시
  if (config.verifyCmd) {
    const v = await runVerify();
    if (v && !v.ok) {
      return `🚫 푸시 차단: 검증 명령 실패 → 깨진 코드를 밀 수 없다.\n${v.output.slice(0, 1500)}`;
    }
  }

  return null; // 모든 게이트 통과 → 자율 푸시 허용
}

// workdir 하위 파일을 재귀적으로 순회 (IGNORE_DIRS 제외)
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) yield* walkFiles(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

// ── 도구 스키마 (LLM에게 전달) ──────────────────────────────
const allToolSchemas: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "파일 내용을 읽는다.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "읽을 파일 경로" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "파일을 생성하거나 전체 내용을 덮어쓴다.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "파일에 쓸 전체 내용" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "파일에서 old_string을 찾아 new_string으로 교체한다. old_string은 파일 내에서 유일해야 한다.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_ast_node",
      description:
        "함수/클래스/const/메서드 등 '심볼 이름'으로 코드 블록 전체를 안전하게 교체한다. old_string 문자열 매칭이 " +
        "아니라 AST로 노드를 찾으므로, 파일 내용을 정확히 기억하지 못해도 편집할 수 있다. " +
        "기존 함수/클래스/메서드의 본문을 통째로 새로 쓸 때 edit_file보다 안전하다. JS/TS/Python 지원.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "편집할 파일 경로" },
          target_symbol: {
            type: "string",
            description:
              "교체할 심볼 이름. 최상위 함수/클래스/const는 이름만(예: 'analyze'). " +
              "클래스 안의 메서드/프로퍼티는 'Class.method' 형태로 지정(예: 'Parser.parse'). " +
              "메서드 이름이 파일에서 유일하면 이름만으로도 찾는다.",
          },
          new_body: {
            type: "string",
            description:
              "해당 심볼을 대체할 새 코드 전체(선언부 포함). 메서드면 메서드 정의 전체. " +
              "Python 메서드는 들여쓰기를 생략해도 원본 들여쓰기에 맞춰 재배치된다.",
          },
        },
        required: ["path", "target_symbol", "new_body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_dir",
      description: "디렉터리를 생성한다(상위 경로 포함, 재귀). 셸 mkdir 대신 이 도구를 사용하라.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "생성할 디렉터리 경로" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "디렉터리 내 파일/폴더 목록을 반환한다.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "기본값은 현재 디렉터리" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "글롭 패턴으로 파일 경로를 찾는다. 예: '**/*.ts', 'src/**/*.json'.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "글롭 패턴 (워크디렉터리 기준 상대경로에 매칭)" },
          path: { type: "string", description: "탐색 시작 디렉터리 (기본값: 현재)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "파일 내용에서 정규식 패턴을 검색해 'path:line: 내용' 형태로 반환한다.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "검색할 정규식" },
          path: { type: "string", description: "탐색 시작 디렉터리 (기본값: 현재)" },
          glob: { type: "string", description: "검색 대상 파일을 글롭으로 제한 (선택, 예: '**/*.ts')" },
          ignore_case: { type: "boolean", description: "대소문자 무시 (기본 false)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "지정한 스킬의 전체 지침(SKILL.md)과 번들 파일 목록을 불러온다. 시스템 프롬프트의 '사용 가능한 스킬' 중 작업에 맞는 것이 있을 때 호출하고, 반환된 지침을 그대로 따르라.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "불러올 스킬 이름" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "셸 명령을 실행하고 stdout/stderr를 반환한다. 빌드·테스트·git 등에 사용.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "결정이 모호하거나 정보가 부족해 진행 방향을 정할 수 없을 때 사용한다. 추측하거나 같은 고민을 반복하지 말고, 사용자에게 번호 선택지를 제시해 물어보고 그 답(선택 또는 자유입력)을 받는다. 예: 용어의 의미가 불분명, 자료를 어디서 찾을지 모름, 여러 접근 중 무엇을 원하는지 확인 필요.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "무엇이 모호한지 명확히 담은 질문" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "제시할 선택지 2~4개(간결하게). '기타(직접 입력)'는 자동으로 추가됨",
          },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "웹을 검색해 상위 결과(제목·URL·요약)를 반환한다. 최신 정보·외부 자료·블로그 포스트·문서를 찾을 때 사용(브라우저 불필요). 찾은 URL의 실제 내용은 fetch_url로 읽어라.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "검색어" },
          limit: { type: "number", description: "결과 개수(기본 8)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "URL의 페이지 내용을 텍스트로 가져온다(HTML은 본문만 추출). web_search로 찾은 링크의 실제 내용을 읽어 요약·분석할 때 사용.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "가져올 페이지 URL" } },
        required: ["url"],
      },
    },
  },
];

// AST 편집기 기여도 측정용 ablation: MCC_ABLATE=ast면 patch_ast_node 도구를 노출하지 않는다
// (모델은 edit_file만 쓰게 됨 → 편집실패 지표를 AST 있음/없음으로 A/B 비교).
export const toolSchemas: ChatCompletionTool[] = config.ablate.has("ast")
  ? allToolSchemas.filter((t) => t.function.name !== "patch_ast_node")
  : allToolSchemas;

// ── 도구 실행 함수 ──────────────────────────────────────────
type ToolResult = string;

export async function executeTool(name: string, args: any): Promise<ToolResult> {
  try {
    // MCP 도구(mcp__서버__도구)는 해당 서버로 라우팅
    if (name.startsWith("mcp__") && mcpHasTool(name)) {
      return await callMcpTool(name, args);
    }
    switch (name) {
      case "read_file": {
        const { path: fp, note } = await safeExisting(args.path);
        const content = await readFile(fp, "utf-8");
        return note + (content.length ? content : "(빈 파일)");
      }
      case "write_file": {
        const p = safePath(args.path);
        await mkdir(dirname(p), { recursive: true }); // 상위 디렉터리 자동 생성
        await writeFile(p, args.content, "utf-8");
        return `OK: ${args.path} (${args.content.length} bytes)` + (await diagnose(p, args.content));
      }
      case "make_dir": {
        await mkdir(safePath(args.path), { recursive: true });
        return `OK: ${args.path} 디렉터리 생성됨`;
      }
      case "use_skill": {
        // 로컬 스킬(<프로젝트>/skills) 우선, 없으면 라우팅된 라이브러리(harness)에서 로드
        const body = getSkillBody(args.name) ?? getLibrarySkillBody(args.name);
        if (body) return body;
        const names = getSkills().map((s) => s.name).join(", ") || "(없음)";
        return `오류: '${args.name}' 스킬을 찾지 못함. 사용 가능: ${names}`;
      }
      case "ask_user": {
        const opts = Array.isArray(args.options) ? args.options.map(String) : [];
        const answer = await askUserChoice(String(args.question ?? "어떻게 진행할까요?"), opts);
        return `사용자 답변: ${answer}`;
      }
      case "web_search":
        return await webSearch(String(args.query ?? ""), Number(args.limit) || 8);
      case "fetch_url":
        return await fetchUrl(String(args.url ?? ""));
      case "edit_file": {
        const { path: p, note } = await safeExisting(args.path);
        const original = await readFile(p, "utf-8");
        const fix = !config.ablate.has("editfix");
        const count = original.split(args.old_string).length - 1;

        if (count === 1) {
          const updated = original.replace(args.old_string, args.new_string);
          await writeFile(p, updated, "utf-8");
          return note + `OK: ${args.path} 수정됨` + (await diagnose(p, updated));
        }
        if (count > 1) {
          return `오류: old_string이 ${count}곳에서 발견됨(유일해야 함). 더 긴 문맥을 포함하라.`
            + (fix ? editOccurrences(original, args.old_string) : "");
        }
        // count === 0: 정확히 못 찾음.
        if (fix) {
          // (1) 공백 차이만이면 실제 텍스트에 재매칭해 그대로 성공시킨다.
          const m = whitespaceTolerantMatch(original, args.old_string);
          if (m) {
            const updated = original.slice(0, m.start) + args.new_string + original.slice(m.end);
            await writeFile(p, updated, "utf-8");
            return `OK: ${args.path} 수정됨(공백 차이 자동 보정)` + (await diagnose(p, updated));
          }
          // (2) 그래도 못 찾으면 진짜 파일 내용을 돌려줘 환각을 끊는다.
          return `오류: old_string을 찾지 못함. 아래 실제 내용과 정확히 일치시켜라.`
            + editReality(original, args.old_string);
        }
        return `오류: old_string을 찾지 못함`;
      }
      case "patch_ast_node": {
        // 심볼 이름으로 함수/클래스/const 노드를 통째로 교체(문자열 매칭 우회).
        const { path: p, note } = await safeExisting(args.path);
        const source = await readFile(p, "utf-8");
        const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
        const target = String(args.target_symbol ?? "");
        const body = String(args.new_body ?? "");
        let r: PatchResult;
        if (ext === ".py") r = await patchPython(p, source, target, body);
        else if (JS_EXT.has(ext)) r = await patchJsTs(p, source, target, body);
        else return `오류: patch_ast_node는 JS/TS/Python만 지원한다(확장자 ${ext}).`;

        if (!r.ok) {
          const hint = r.symbols?.length ? ` 파일에서 사용 가능한 심볼: ${r.symbols.join(", ")}` : "";
          return note + `오류: ${r.error}.${hint}`;
        }
        await writeFile(p, r.updated!, "utf-8");
        return note + `OK: ${args.path}의 '${target}' 교체됨` + (await diagnose(p, r.updated!));
      }
      case "list_dir": {
        const dir = safePath(args.path ?? ".");
        const entries = await readdir(dir);
        const detailed = await Promise.all(
          entries.map(async (e) => {
            const s = await stat(join(dir, e));
            return s.isDirectory() ? `${e}/` : e;
          })
        );
        return detailed.join("\n") || "(빈 디렉터리)";
      }
      case "glob": {
        const root = safePath(args.path ?? ".");
        const rx = globToRegex(args.pattern);
        const out: string[] = [];
        for await (const f of walkFiles(root)) {
          const rel = relative(config.workdir, f).replace(/\\/g, "/");
          if (rx.test(rel)) out.push(rel);
          if (out.length >= 200) break;
        }
        return out.length ? out.join("\n") : "(일치하는 파일 없음)";
      }
      case "grep": {
        const root = safePath(args.path ?? ".");
        const rx = new RegExp(args.pattern, args.ignore_case ? "i" : "");
        const fileRx = args.glob ? globToRegex(args.glob) : null;
        const out: string[] = [];
        outer: for await (const f of walkFiles(root)) {
          const rel = relative(config.workdir, f).replace(/\\/g, "/");
          if (fileRx && !fileRx.test(rel)) continue;
          let content: string;
          try {
            content = await readFile(f, "utf-8");
          } catch {
            continue;
          }
          if (content.indexOf(String.fromCharCode(0)) !== -1) continue; // NUL 바이트 포함 시 바이너리로 간주
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (rx.test(lines[i])) {
              out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (out.length >= 100) break outer;
            }
          }
        }
        return out.length ? out.join("\n") : "(일치 없음)";
      }
      case "run_command": {
        // git push는 사전 게이트(비밀·강제·기본브랜치·검증)를 통과할 때만 실행한다.
        // 통과=자율 푸시, 실패=푸시 안 하고 이유 반환(모델이 고치도록).
        if (isGitPush(args.command)) {
          const blocked = await gitPushGate(args.command);
          if (blocked) return blocked;
        }
        // Ctrl+C 시 실행 중인 명령의 프로세스 트리 전체를 종료(손자 프로세스 포함)
        const { stdout, stderr } = await runCommand(args.command, activeSignal());
        return `[stdout]\n${stdout}\n[stderr]\n${stderr}`.slice(0, 20_000);
      }
      default:
        return `알 수 없는 도구: ${name}`;
    }
  } catch (err: any) {
    return `오류: ${err.message}`;
  }
}
