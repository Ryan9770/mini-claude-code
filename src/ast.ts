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

// JS/TS: 최상위 함수/클래스/const + 클래스 멤버(메서드·프로퍼티·접근자·생성자)에서
// targetSymbol을 찾아 newBody로 교체. 멤버는 'Class.method' 형태로 지정한다.
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

  // 클래스 멤버로 취급할 노드 종류(SyntaxKind로 비교 — 타입가드 이름 불확실성 회피)
  const memberKinds = new Set<number>([
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.PropertyDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.Constructor,
  ]);
  const nameText = (name: any): string | undefined => {
    if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))) {
      return name.text;
    }
    return undefined;
  };

  // 이름 있는 '치환 가능' 노드 수집: 정규화 이름(qname)·기본 이름(bare)·범위·최상위 여부
  type Hit = { qname: string; bare: string; start: number; end: number; top: boolean };
  const all: Hit[] = [];
  const add = (qname: string, bare: string, node: any, top: boolean) =>
    all.push({ qname, bare, start: node.getStart(sf), end: node.getEnd(), top });

  sf.statements.forEach((node: any) => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const nm = node.name.text;
      add(nm, nm, node, true);
      if (ts.isClassDeclaration(node)) {
        node.members?.forEach((m: any) => {
          if (!memberKinds.has(m.kind)) return;
          const mn = m.kind === ts.SyntaxKind.Constructor ? "constructor" : nameText(m.name);
          if (mn) add(`${nm}.${mn}`, mn, m, false);
        });
      }
    } else if (ts.isVariableStatement(node)) {
      const d = node.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name)) add(d.name.text, d.name.text, node, true); // export const foo = ...
    }
  });

  const symbols = all.map((h) => h.qname);
  // 매칭: 점 포함이면 정규화 이름 정확 매칭. 아니면 최상위 우선, 없으면 멤버 기본 이름으로.
  let hits: Hit[];
  if (targetSymbol.includes(".")) {
    hits = all.filter((h) => h.qname === targetSymbol);
  } else {
    hits = all.filter((h) => h.top && h.bare === targetSymbol);
    if (hits.length === 0) hits = all.filter((h) => h.bare === targetSymbol);
  }

  if (hits.length === 0) return { ok: false, error: `심볼 '${targetSymbol}'을 찾지 못함`, symbols };
  if (hits.length > 1)
    return { ok: false, error: `심볼 '${targetSymbol}'이 여러 곳(${hits.length})에 있음(모호) — 'Class.method' 형태로 지정하라`, symbols };

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

def rng(node):
    start = node.lineno
    if getattr(node, 'decorator_list', None):
        start = min(start, node.decorator_list[0].lineno)
    return [start, node.end_lineno]

def assign_name(node):
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name):
                return t.id
    return None

syms = []
tops = []      # (name, rng)
members = []   # (qname, bare, rng)
for node in tree.body:
    name = getattr(node, 'name', None) or assign_name(node)
    if name is not None:
        syms.append(name); tops.append((name, rng(node)))
    if isinstance(node, ast.ClassDef):
        for m in node.body:
            mn = getattr(m, 'name', None) or assign_name(m)
            if mn is None:
                continue
            q = node.name + "." + mn
            syms.append(q); members.append((q, mn, rng(m)))

if '.' in target:
    hits = [r for (q, b, r) in members if q == target]
else:
    hits = [r for (n, r) in tops if n == target]
    if not hits:
        hits = [r for (q, b, r) in members if b == target]

out = {"symbols": syms}
if len(hits) == 1:
    out["hit"] = hits[0]
else:
    out["hit"] = None
    if len(hits) > 1:
        out["ambiguous"] = len(hits)
print(json.dumps(out))
`;

function runPyLocate(absPath: string, target: string): Promise<{ symbols?: string[]; hit?: [number, number] | null; ambiguous?: number; error?: string } | null> {
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
  if (loc.ambiguous)
    return { ok: false, error: `심볼 '${targetSymbol}'이 여러 곳(${loc.ambiguous})에 있음(모호) — 'Class.method' 형태로 지정하라`, symbols: loc.symbols };
  if (!loc.hit) return { ok: false, error: `심볼 '${targetSymbol}'을 찾지 못함`, symbols: loc.symbols };

  const [startLine, endLine] = loc.hit; // 1-based, inclusive
  const lines = source.split("\n");
  const origIndent = lines[startLine - 1].match(/^[ \t]*/)?.[0] ?? "";
  let body = newBody.replace(/\n$/, "");
  // 파이썬은 들여쓰기가 문법이다. 메서드(원본이 들여써짐)인데 모델이 새 본문을 col 0로 썼으면
  // 원본 들여쓰기를 입혀 클래스 안에 맞게 재배치한다(모델의 들여쓰기 재현 부담 완화).
  if (origIndent && !/^[ \t]/.test(body)) {
    body = body
      .split("\n")
      .map((l) => (l.trim() ? origIndent + l : l))
      .join("\n");
  }
  const updated = [...lines.slice(0, startLine - 1), body, ...lines.slice(endLine)].join("\n");
  return { ok: true, updated };
}
