import { readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import ts from "typescript";

/**
 * JS/TS 파일에서 특정 심볼(함수, 클래스, 메소드 등)을 AST 기반으로 찾아 새로운 본문으로 교체합니다.
 * 기존의 텍스트 기반 old_string 치환이 지닌 Indent/Newline 매칭 실패 문제를 해결합니다.
 */
export async function patchJsTsAst(
  filePath: string,
  targetSymbol: string,
  newBody: string
): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  let targetNode: ts.Node | null = null;

  function findNode(node: ts.Node) {
    if (targetNode) return;

    // 1. 일반 함수 선언문: function foo() {}
    if (ts.isFunctionDeclaration(node) && node.name?.text === targetSymbol) {
      targetNode = node;
      return;
    }
    // 2. 클래스 선언문: class Foo {}
    if (ts.isClassDeclaration(node) && node.name?.text === targetSymbol) {
      targetNode = node;
      return;
    }
    // 3. 메소드 선언문: foo() {} (클래스 내부)
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === targetSymbol) {
      targetNode = node;
      return;
    }
    // 4. 변수 할당식 함수: const foo = () => {}
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === targetSymbol) {
      // 변수 선언문 자체를 타겟팅
      targetNode = node;
      return;
    }

    ts.forEachChild(node, findNode);
  }

  findNode(sourceFile);

  if (!targetNode) {
    throw new Error(`JS/TS AST: 파일 내에서 심볼 '${targetSymbol}'을(를) 찾을 수 없습니다.`);
  }

  // 코멘트를 훼손시키지 않기 위해 getStart(sourceFile)부터 getEnd()까지의 텍스트 영역만 치환
  const start = (targetNode as ts.Node).getStart(sourceFile);
  const end = (targetNode as ts.Node).getEnd();

  const prefix = content.slice(0, start);
  const suffix = content.slice(end);

  const updatedContent = prefix + newBody + suffix;
  await writeFile(filePath, updatedContent, "utf-8");

  return `SUCCESS: JS/TS 파일 '${filePath}'의 심볼 '${targetSymbol}'을(를) AST 기반으로 수정 완료했습니다.`;
}

/**
 * Python 파일의 AST를 분석하고 특정 함수/클래스를 찾아 교체하기 위해 백그라운드로 Python 스크립트를 구동시킵니다.
 */
export function patchPythonAst(
  filePath: string,
  targetSymbol: string,
  newBody: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // 인라인 Python 스크립트를 구성하여 안전하게 AST 치환 처리
    // Python 3.8+의 node.lineno 및 node.end_lineno 활용
    const pyScript = `
import ast
import sys

file_path = sys.argv[1]
target = sys.argv[2]
new_body = sys.argv[3]

with open(file_path, 'r', encoding='utf-8') as f:
    source = f.read()

try:
    tree = ast.parse(source, filename=file_path)
except Exception as e:
    print(f"오류: 파이썬 구문 에러: {e}")
    sys.exit(1)

target_node = None
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == target:
        target_node = node
        break

if not target_node:
    print(f"오류: 파이썬 AST 내에서 심볼 '{target}'을 찾을 수 없습니다.")
    sys.exit(2)

lines = source.splitlines(keepends=True)
# 1-indexed lineno 변환
start_line = target_node.lineno - 1

# decorator가 존재할 경우 데코레이터 시작 라인부터 교체하도록 보정
if hasattr(target_node, 'decorator_list') and target_node.decorator_list:
    start_line = target_node.decorator_list[0].lineno - 1

end_line = target_node.end_lineno

# 치환 및 저장
prefix_lines = lines[:start_line]
suffix_lines = lines[end_line:]
updated_code = "".join(prefix_lines) + new_body + "\\n" + "".join(suffix_lines)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(updated_code)

print("SUCCESS")
`;

    const pyCmd = process.platform === "win32" ? "python" : "python3";
    const child = exec(
      `"${pyCmd}" -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}" "${filePath.replace(/\\/g, '/')}" "${targetSymbol}" "${newBody.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Python AST 수정 에러: ${stderr || stdout || err.message}`));
        }
        const out = stdout.trim();
        if (out.startsWith("SUCCESS")) {
          resolve(`SUCCESS: Python 파일 '${filePath}'의 심볼 '${targetSymbol}'을(를) AST 기반으로 수정 완료했습니다.`);
        } else {
          reject(new Error(out || "알 수 없는 Python AST 처리 에러"));
        }
      }
    );
  });
}
