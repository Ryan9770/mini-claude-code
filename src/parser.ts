// Heuristic Loose Parser: 소형 모델이 뱉은 손상된 JSON이나 비정규식 도구 호출 텍스트 복구
import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

/**
 * 텍스트에서 느슨하게 JSON 객체를 파싱합니다.
 * 흔한 소형 모델의 JSON 에러(trailing comma, 이스케이프 누락, 양끝 따옴표 등)를 보정합니다.
 */
export function parseLooseJson(text: string): any {
  let cleaned = text.trim();
  
  // 마크다운 코드 블록 제거
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9-]*\n/, "").replace(/\n```$/, "").trim();
  }

  // 흔한 에러 수정 휴리스틱
  // 1) 후행 쉼표(Trailing comma) 제거: ,} -> } 및 ,] -> ]
  cleaned = cleaned.replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]");

  // 2) 줄바꿈 문자열(\n) 이스케이프 보정: 문자열 값 내부에 실물 개행이 들어간 경우 이스케이프 처리
  // (JSON.parse는 실제 개행이 문자열 안에 있으면 에러가 난다)
  // 단, JSON 구조의 뼈대 줄바꿈과 값 안의 줄바꿈을 구분하기는 어려우므로, 안전하게 시도해보고 안 되면 줄번호/이스케이프 처리
  
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // 3) 값 내의 무분별한 실물 개행 문자 보호 시도
    // 단순한 문자열 치환 시도: 따옴표 안의 개행을 \n으로 변환
    try {
      let insideQuote = false;
      let chars = [...cleaned];
      for (let i = 0; i < chars.length; i++) {
        if (chars[i] === '"' && chars[i-1] !== '\\') {
          insideQuote = !insideQuote;
        }
        if (insideQuote && chars[i] === '\n') {
          chars[i] = '\\n';
        }
      }
      return JSON.parse(chars.join(""));
    } catch {
      // 복구 실패 시 원본 에러 투척
      throw e;
    }
  }
}

/**
 * 모델이 OpenAI 도구 호출 형식을 맞추지 못하고, 대화 본문 텍스트에 도구를 노출하거나
 * 마크다운 코드 블록으로 JSON을 적어 보냈을 때 이를 감지하여 강제로 구조화된 도구 호출 형태로 파싱합니다.
 */
export function extractToolCalls(text: string, availableTools: string[]): ChatCompletionMessageToolCall[] {
  const calls: ChatCompletionMessageToolCall[] = [];
  const uniqId = () => "call_loose_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

  // 1. 마크다운 코드 블록 내의 JSON을 추출하여 도구 호출인지 검사
  // 패턴: ```json ... ```
  const mdJsonRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = mdJsonRe.exec(text)) !== null) {
    try {
      const obj = parseLooseJson(match[1]);
      // 만약 단일 도구 객체라면: {"name": "...", "arguments": {...}}
      if (obj && typeof obj.name === "string" && availableTools.includes(obj.name)) {
        calls.push({
          id: uniqId(),
          type: "function",
          function: {
            name: obj.name,
            arguments: typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments || {}),
          }
        });
      }
      // 만약 tool_calls 래퍼라면: {"tool_calls": [...]}
      else if (obj && Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (tc.function?.name && availableTools.includes(tc.function.name)) {
            calls.push({
              id: uniqId(),
              type: "function",
              function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}),
              }
            });
          }
        }
      }
      // 또는 그냥 인자 딕셔너리 형태인데 키 명칭이 도구명일 때: {"edit_file": {...}}
      else if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (availableTools.includes(k) && typeof v === "object") {
            calls.push({
              id: uniqId(),
              type: "function",
              function: {
                name: k,
                arguments: JSON.stringify(v),
              }
            });
          }
        }
      }
    } catch {
      // JSON이 아니거나 에러인 경우 무시
    }
  }

  // 2. 텍스트 내에서 Python 스타일의 함수 호출을 휴리스틱하게 감지
  // 패턴 예: write_file(path="hello.py", content="print(1)")
  // 복잡한 인자 파싱을 위해 정규식 매칭
  for (const tname of availableTools) {
    const fnRe = new RegExp(`\\b${tname}\\s*\\(([^)]*)\\)`, "g");
    while ((match = fnRe.exec(text)) !== null) {
      const argStr = match[1].trim();
      const parsedArgs: Record<string, string> = {};
      
      // 키=값 매칭 파싱 (단순 문자열 매칭)
      // 예: path="hello.py", content="print('hello')"
      const argPairRe = /(\w+)\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+))/g;
      let argMatch;
      let hasArgs = false;
      while ((argMatch = argPairRe.exec(argStr)) !== null) {
        hasArgs = true;
        const key = argMatch[1];
        const val = argMatch[2] ?? argMatch[3] ?? argMatch[4];
        // 이스케이프 해제 처리
        parsedArgs[key] = val ? val.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\') : "";
      }

      if (hasArgs) {
        calls.push({
          id: uniqId(),
          type: "function",
          function: {
            name: tname,
            arguments: JSON.stringify(parsedArgs)
          }
        });
      }
    }
  }

  // 3. 텍스트 전체가 하나의 단일 JSON 구조로 들어왔을 가능성 검사
  if (calls.length === 0) {
    try {
      const obj = parseLooseJson(text);
      if (obj && typeof obj.name === "string" && availableTools.includes(obj.name)) {
        calls.push({
          id: uniqId(),
          type: "function",
          function: {
            name: obj.name,
            arguments: typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments || {}),
          }
        });
      }
    } catch {
      // 실패 시 통과
    }
  }

  return calls;
}
