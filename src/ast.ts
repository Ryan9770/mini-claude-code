// AST 기반 심볼 치환 편집기.
// edit_file의 old_string 매칭은 약한 모델의 최다 실패(실측 1순위 ~110건: 파일 내용을 환각해
// 매칭 실패)다. 여기서는 문자열을 맞추는 대신 '심볼 이름'으로 함수/클래스/const 노드를 찾아
// 그 노드의 소스 범위만 정확히 교체한다(printer로 재포맷하지 않고 원본을 스플라이스 → 나머지 보존).
// JS/TS: TypeScript 컴파일러 API. Python: 표준 ast로 노드의 줄 범위를 얻어 스플라이스.
import { spawn } from "node:child_process";

export interface PatchResult {
  ok: boolean;
  updated?: string;
  error?: string;
  symbols?: string[]; // 실패 시 파일 최상위 심볼 목록(모델이 올바른 이름을 고르게 안내)
}

let tsCache: any | null | undefined; // undefined=미시도, null=미설치
async function loadTs(): Promise<any | null> {
  if (tsCache === undefined) {
    try {
      const m: any = await import("typescript");
      tsCache = m.default ?? m;
    } catch {
      tsCache = null;
    }
  }
  return tsCache;
}

function scriptKind(ts: any, filename: string): any {
  if (/\.tsx$/i.test(filename)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filename)) return ts.ScriptKind.JSX;
  if (/\.(mjs|cjs|js)$/i.test(filename)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

// JS/TS: 최상위 함수/클래스/const 선언에서 targetSymbol을 찾아 newBody로 교체.
export async function patchJsTs(
  filename: string,
  source: string,
  targetSymbol: string,
  newBody: string
): Promise<PatchResult> {
  const ts = await loadTs();
  if (!ts) return { ok: false, error: "typescript 미설치 — AST 편집 불가(patch_ast_node)" };

  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKind(ts, filename)
  );

  const nameOf = (node: any): string | undefined => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      return node.name.text;
    }
    if (ts.isVariableStatement(node)) {
      const d = node.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name)) return d.name.text; // export const foo = ...
    }
    return undefined;
  };

  const symbols: string[] = [];
  const hits: { start: number; end: number }[] = [];
  sf.statements.forEach((node: any) => {
    const n = nameOf(node);
    if (!n) return;
    symbols.push(n);
    if (n === targetSymbol) hits.push({ start: node.getStart(sf), end: node.getEnd() });
  });

  if (hits.length === 0) return { ok: false, error: `최상위 심볼 '${targetSymbol}'을 찾지 못함`, symbols };
  if (hits.length > 1) return { ok: false, error: `심볼 '${targetSymbol}'이 ${hits.length}곳에 있음(모호)`, symbols };

  const { start, end } = hits[0];
  const updated = source.slice(0, start) + newBody + source.slice(end);
  return { ok: true, updated };
}

// Python: 표준 ast로 대상 노드의 줄 범위(데코레이터 포함)를 얻어 그 줄들만 newBody로 스플라이스.
// ast.unparse는 파일 전체를 재포맷(주석·서식 소실)하므로 쓰지 않는다.
const PY_LOCATE = `
import ast, sys, json
src = open(sys.argv[1], encoding='utf-8').read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"error": "parse: " + str(e)})); sys.exit(0)
target = sys.argv[2]
syms = []
hit = None
for node in tree.body:
    name = getattr(node, 'name', None)
    if name is None and isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name):
                name = t.id
    if name is None:
        continue
    syms.append(name)
    if name == target:
        start = node.lineno
        if getattr(node, 'decorator_list', None):
            start = min(start, node.decorator_list[0].lineno)
        hit = (start, node.end_lineno)
print(json.dumps({"symbols": syms, "hit": hit}))
`;

function runPyLocate(absPath: string, target: string): Promise<{ symbols?: string[]; hit?: [number, number] | null; error?: string } | null> {
  return new Promise((res) => {
    const py = process.platform === "win32" ? "python" : "python3";
    let child;
    try {
      child = spawn(py, ["-c", PY_LOCATE, absPath, target], { windowsHide: true });
    } catch {
      return res(null);
    }
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 무시 */ } res(null); }, 8000);
    child.on("error", () => { clearTimeout(timer); res(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try { res(JSON.parse(out.trim())); } catch { res(null); }
    });
  });
}

export async function patchPython(
  absPath: string,
  source: string,
  targetSymbol: string,
  newBody: string
): Promise<PatchResult> {
  const loc = await runPyLocate(absPath, targetSymbol);
  if (!loc) return { ok: false, error: "python 미설치/실행 불가 — AST 편집 불가" };
  if (loc.error) return { ok: false, error: `python 파싱 오류: ${loc.error}` };
  if (!loc.hit) return { ok: false, error: `심볼 '${targetSymbol}'을 찾지 못함`, symbols: loc.symbols };

  const [startLine, endLine] = loc.hit; // 1-based, inclusive
  const lines = source.split("\n");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const updated = [...before, newBody.replace(/\n$/, ""), ...after].join("\n");
  return { ok: true, updated };
}
