// 에이전트가 사용할 도구(tool) 정의 + 실행 로직
// 각 도구는 (1) LLM에게 보낼 JSON 스키마, (2) 실제 실행 함수로 구성됩니다.

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { config } from "./config.js";
import { getSkills, getSkillBody, skillsDir } from "./skills.js";
import { getLibrarySkillBody } from "./skill-router.js";
import { callMcpTool, mcpHasTool } from "./mcp.js";
import { activeSignal } from "./io.js";

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
export const toolSchemas: ChatCompletionTool[] = [
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
];

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
        const content = await readFile(safePath(args.path), "utf-8");
        return content.length ? content : "(빈 파일)";
      }
      case "write_file": {
        const p = safePath(args.path);
        await mkdir(dirname(p), { recursive: true }); // 상위 디렉터리 자동 생성
        await writeFile(p, args.content, "utf-8");
        return `OK: ${args.path} (${args.content.length} bytes)`;
      }
      case "make_dir": {
        await mkdir(safePath(args.path), { recursive: true });
        return `OK: ${args.path} 디렉터리 생성됨`;
      }
      case "use_skill": {
        // 로컬 스킬(<프로젝트>/skills) 우선, 없으면 라우팅된 라이브러리(harness-100)에서 로드
        const body = getSkillBody(args.name) ?? getLibrarySkillBody(args.name);
        if (body) return body;
        const names = getSkills().map((s) => s.name).join(", ") || "(없음)";
        return `오류: '${args.name}' 스킬을 찾지 못함. 사용 가능: ${names}`;
      }
      case "edit_file": {
        const p = safePath(args.path);
        const original = await readFile(p, "utf-8");
        const count = original.split(args.old_string).length - 1;
        if (count === 0) return `오류: old_string을 찾지 못함`;
        if (count > 1) return `오류: old_string이 ${count}곳에서 발견됨(유일해야 함). 더 긴 문맥을 포함하라.`;
        await writeFile(p, original.replace(args.old_string, args.new_string), "utf-8");
        return `OK: ${args.path} 수정됨`;
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
