// MCP(Model Context Protocol) 클라이언트: 외부 MCP 서버에 연결해 그들의 도구를
// 우리 에이전트 도구로 노출한다. (브라우저·DB·파일시스템 등 표준 연결)
//
// 설정 파일: ~/.mcc/mcp.json
//   { "mcpServers": { "filesystem": { "command": "npx",
//       "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/some/dir"] } } }
//
// 노출되는 도구 이름은 `mcp__<서버>__<도구>` 형태로 네임스페이스된다.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const mccDir = process.env.MCC_HOME ?? join(homedir(), ".mcc");
const mcpConfigFile = join(mccDir, "mcp.json");

interface ServerConf {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const mcpTools: ChatCompletionTool[] = [];
const router = new Map<string, { client: any; toolName: string }>();
const clients: any[] = [];

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export function getMcpTools(): ChatCompletionTool[] {
  return mcpTools;
}
export function mcpHasTool(name: string): boolean {
  return router.has(name);
}
export function mcpServerInfo(): { tools: number; names: string[] } {
  return { tools: mcpTools.length, names: [...router.keys()] };
}

// 종료 시 모든 MCP 연결(자식 프로세스)을 닫는다 — 안 닫으면 프로세스가 종료되지 않음.
export async function closeMcp(): Promise<void> {
  for (const c of clients) {
    try {
      await c.close();
    } catch {
      /* 무시 */
    }
  }
}

// mcp__ 도구 호출을 해당 서버로 라우팅
export async function callMcpTool(name: string, args: any): Promise<string> {
  const entry = router.get(name);
  if (!entry) return `오류: MCP 도구 '${name}'를 찾을 수 없음`;
  try {
    const res = await entry.client.callTool({ name: entry.toolName, arguments: args ?? {} });
    const content = (res?.content ?? []) as any[];
    const text = content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
    return text || "(빈 응답)";
  } catch (err: any) {
    return `오류: MCP 호출 실패 (${String(err?.message ?? err).slice(0, 160)})`;
  }
}

// 시작 시 설정된 MCP 서버들에 연결하고 도구를 수집한다.
export async function initMcp(): Promise<{ servers: number; tools: number }> {
  if (!existsSync(mcpConfigFile)) return { servers: 0, tools: 0 };

  let conf: any;
  try {
    conf = JSON.parse(readFileSync(mcpConfigFile, "utf-8"));
  } catch {
    console.log("⚠️  mcp.json 파싱 실패 — MCP 비활성화");
    return { servers: 0, tools: 0 };
  }
  const servers: Record<string, ServerConf> = conf.mcpServers ?? conf.servers ?? {};
  const names = Object.keys(servers);
  if (!names.length) return { servers: 0, tools: 0 };

  let Client: any, StdioClientTransport: any;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js"));
  } catch {
    console.log("⚠️  @modelcontextprotocol/sdk 미설치 — MCP 비활성화");
    return { servers: 0, tools: 0 };
  }

  for (const sName of names) {
    const sc = servers[sName];
    try {
      const transport = new StdioClientTransport({
        command: sc.command,
        args: sc.args ?? [],
        env: { ...process.env, ...(sc.env ?? {}) },
      });
      const client = new Client({ name: "mini-claude-code", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      clients.push(client);

      const { tools } = await client.listTools();
      for (const t of tools) {
        const fqName = `mcp__${sanitize(sName)}__${sanitize(t.name)}`;
        router.set(fqName, { client, toolName: t.name });
        mcpTools.push({
          type: "function",
          function: {
            name: fqName,
            description: `[MCP:${sName}] ${t.description ?? t.name}`,
            parameters: (t.inputSchema ?? { type: "object", properties: {} }) as any,
          },
        });
      }
      console.log(`  🔌 MCP '${sName}' 연결됨 (${tools.length}개 도구)`);
    } catch (err: any) {
      console.log(`  ⚠️  MCP '${sName}' 연결 실패: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return { servers: clients.length, tools: mcpTools.length };
}
