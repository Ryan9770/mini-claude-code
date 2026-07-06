import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import ts from "typescript";

// 탐색할 파일 확장자 후보군
const TS_CANDIDATES = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * 상대경로 모듈 스펙을 실제 존재하는 소스 파일 절대경로로 확인합니다.
 */
function resolveModulePath(baseDir: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // 외부 라이브러리는 제외

  // 확장자 제거 후 매칭 시도
  let cleanSpec = specifier;
  const ext = extname(specifier);
  if (ext === ".js" || ext === ".ts" || ext === ".mjs" || ext === ".cjs") {
    cleanSpec = specifier.slice(0, -ext.length);
  }

  for (const cand of TS_CANDIDATES) {
    const fullPath = join(baseDir, cleanSpec + cand);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  // 확장자 그대로 확인
  const directPath = join(baseDir, specifier);
  if (existsSync(directPath)) {
    return directPath;
  }

  return null;
}

/**
 * JS/TS AST에서 임포트한 심볼들의 선언부를 찾아 정의 텍스트를 추출합니다.
 */
async function extractTsImportDefinitions(
  resolvedPath: string,
  symbols: string[]
): Promise<string> {
  const code = await readFile(resolvedPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    resolvedPath,
    code,
    ts.ScriptTarget.Latest,
    true
  );

  const defs: string[] = [];
  const symbolSet = new Set(symbols);

  function visit(node: ts.Node) {
    // Top-level exported declarations만 검사
    const isExported = ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

    if (isExported) {
      let name: string | undefined;
      
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
      } else if (ts.isClassDeclaration(node) && node.name) {
        name = node.name.text;
      } else if (ts.isInterfaceDeclaration(node)) {
        name = node.name.text;
      } else if (ts.isTypeAliasDeclaration(node)) {
        name = node.name.text;
      } else if (ts.isVariableStatement(node)) {
        // VariableStatement의 경우 내부 선언문들을 순회
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && symbolSet.has(decl.name.text)) {
            // 변수 정의 구역 추출
            const jsDoc = (node as any).jsDoc?.[0]?.getText() ?? "";
            const sig = decl.getText();
            defs.push((jsDoc ? jsDoc + "\n" : "") + `export const ${sig}`);
          }
        }
      }

      if (name && symbolSet.has(name)) {
        // 함수/클래스/인터페이스 시그니처 및 JSDoc 포함 텍스트 추출
        // node.getText()는 JSDoc을 누락할 수 있어 jsDoc 속성을 수동으로 추가 확인
        const jsDoc = (node as any).jsDoc?.[0]?.getText() ?? "";
        let sig = node.getText(sourceFile);
        
        // 너무 거대한 클래스 본문은 요약 처리 (최대 40줄)
        const lines = sig.split("\n");
        if (lines.length > 40) {
          sig = lines.slice(0, 30).join("\n") + "\n  // ... (이하 중략)\n}";
        }

        defs.push((jsDoc && !sig.includes(jsDoc) ? jsDoc + "\n" : "") + sig);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return defs.join("\n\n");
}

/**
 * Python 정적 분석: 간단한 regex 및 라인 순회를 통해 함수/클래스 정의 및 Docstring을 가져옵니다.
 */
async function extractPyImportDefinitions(
  resolvedPath: string,
  symbols: string[]
): Promise<string> {
  const code = await readFile(resolvedPath, "utf-8");
  const lines = code.split("\n");
  const defs: string[] = [];
  const symbolSet = new Set(symbols);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // def foo(...) 또는 class Bar(...) 패턴 탐색
    const match = line.match(/^\s*(def|class)\s+([a-zA-Z0-9_]+)/);
    if (match) {
      const type = match[1];
      const name = match[2];
      
      if (symbolSet.has(name)) {
        let sig = line;
        
        // 인자가 여러 줄로 선언된 경우 콜론(:)이 나올 때까지 수집
        let j = i;
        while (!sig.includes(":") && j + 1 < lines.length) {
          j++;
          sig += "\n" + lines[j];
        }

        // 바로 아래 docstring이 있다면 함께 수집
        let doc = "";
        if (j + 1 < lines.length) {
          const next = lines[j + 1].trim();
          if (next.startsWith('"""') || next.startsWith("'''")) {
            const quote = next.startsWith('"""') ? '"""' : "'''";
            doc = lines[j + 1];
            let k = j + 1;
            if (!next.endsWith(quote) || next === quote) {
              while (k + 1 < lines.length) {
                k++;
                doc += "\n" + lines[k];
                if (lines[k].includes(quote)) break;
              }
            }
          }
        }
        
        defs.push(sig + (doc ? "\n" + doc : ""));
      }
    }
  }
  return defs.join("\n\n");
}

/**
 * 특정 소스 파일의 import 구문을 추적하여 외부 모듈의 시그니처 맵을 생성합니다.
 */
export async function getImportDefinitions(filePath: string): Promise<string> {
  try {
    if (!existsSync(filePath)) return "";
    const code = await readFile(filePath, "utf-8");
    const ext = extname(filePath).toLowerCase();
    const baseDir = dirname(filePath);
    const cheatSheet: string[] = [];

    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      const sourceFile = ts.createSourceFile(
        filePath,
        code,
        ts.ScriptTarget.Latest,
        true
      );

      for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && statement.moduleSpecifier) {
          const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
          const resolved = resolveModulePath(baseDir, specifier);
          if (!resolved) continue;

          // 가져오는 심볼 이름 수집
          const symbols: string[] = [];
          if (statement.importClause) {
            const clause = statement.importClause;
            if (clause.name) {
              symbols.push(clause.name.text); // default import
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                // alias(as)가 있으면 로컬 이름 대신 원래 이름을 타겟팅
                symbols.push(el.propertyName ? el.propertyName.text : el.name.text);
              }
            }
          }

          if (symbols.length > 0) {
            const defText = await extractTsImportDefinitions(resolved, symbols);
            if (defText.trim()) {
              cheatSheet.push(`── 의존성 가이드: ${specifier} (${symbols.join(", ")}) ──\n${defText}`);
            }
          }
        }
      }
    } 
    else if (ext === ".py") {
      // Python imports: from .foo import bar, from foo import bar
      for (const line of code.split("\n")) {
        // from module import sym1, sym2
        const match = line.match(/^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+([a-zA-Z0-9_,\s]+)/);
        if (match) {
          const mod = match[1];
          const syms = match[2].split(",").map(s => s.trim());
          
          // 상대 경로 처리 (예: .foo -> foo)
          const specifier = mod.startsWith(".") ? mod : "./" + mod.replace(/\./g, "/");
          const resolved = resolveModulePath(baseDir, specifier);
          if (!resolved) continue;

          const defText = await extractPyImportDefinitions(resolved, syms);
          if (defText.trim()) {
            cheatSheet.push(`── 의존성 가이드: ${mod} (${syms.join(", ")}) ──\n${defText}`);
          }
        }
      }
    }

    if (cheatSheet.length > 0) {
      return `\n💡 [Active Symbol 의존성 타입 가이드]\n수정 중인 파일이 가져다 쓰고 있는 핵심 선언문 구조입니다. 이 규격을 지켜 구현하십시오:\n\n` + 
        cheatSheet.join("\n\n") + "\n";
    }
  } catch {
    // 어떤 에러가 발생해도 주 루프를 중단시키지 않음
  }
  return "";
}
