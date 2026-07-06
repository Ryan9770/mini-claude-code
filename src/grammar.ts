// OpenAI ChatCompletionTool 스키마를 llama.cpp GBNF 문법으로 변환하는 컴파일러
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 도구 스키마 리스트를 GBNF 문법 문자열로 컴파일합니다.
 * 에이전트가 텍스트 응답(자연어) 또는 정의된 도구 호출 JSON 구조 중 하나만 출력하도록 강제합니다.
 */
export function compileToolsToGbnf(tools: ChatCompletionTool[]): string {
  if (!tools || tools.length === 0) {
    return "root ::= [^\n]*"; // 도구가 없으면 자유 텍스트만 허용
  }

  // 각 도구별 arguments JSON 스키마를 GBNF 규칙으로 빌드
  const rules: string[] = [];
  const toolUnion: string[] = [];

  for (const tool of tools) {
    const name = tool.function.name;
    const params = tool.function.parameters as any;
    const ruleName = `tool-${name.replace(/[^a-zA-Z0-9-]/g, "-")}`;
    
    // GBNF 규칙 생성
    const toolRule = buildToolRule(ruleName, name, params);
    rules.push(toolRule.body);
    toolUnion.push(toolRule.name);
  }

  // root 규칙 정의
  // (1) 자유 텍스트 (줄바꿈 포함 자유 문자열)
  // (2) 또는 정의된 도구 호출 JSON 포맷
  // OpenAI/llama-server 호환을 위한 도구 호출 JSON 구조 강제:
  // {"tool_calls": [{"id": "...", "type": "function", "function": {"name": "...", "arguments": "..."}}]}
  const rootRule = 
    `root ::= free-text | tool-call-wrapper\n` +
    `free-text ::= [\\s\\S]*\n` +
    `tool-call-wrapper ::= "{\\"tool_calls\\":[{" ws "id" ws ":" ws string ws "," ws "type" ws ":" ws "\\"function\\"" ws "," ws "function" ws ":" ws tool-function-union ws "}]}"\n` +
    `tool-function-union ::= ${toolUnion.join(" | ")}\n` +
    `id ::= "\\"call_\\" [a-zA-Z0-9]{16}\"\n` + // call_ + 16자리 영숫자
    `ws ::= [ \\t\\n\\r]*\n` +
    `string ::= "\\"" ([^"\\\\] | "\\\\" [\"\\\\\\/bfnrt] | "\\\\" [0-9a-fA-F]{4})* "\\""\n` +
    `number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?\n` +
    `boolean ::= "true" | "false"\n` +
    `null ::= "null"`;

  return [rootRule, ...rules].join("\n");
}

interface ToolRuleResult {
  name: string;
  body: string;
}

function buildToolRule(ruleName: string, toolName: string, schema: any): ToolRuleResult {
  const funcRuleName = `${ruleName}-func`;
  const argsRuleName = `${ruleName}-args`;
  
  // arguments 객체 파싱 및 GBNF 규칙화
  const argsGbnf = compileSchema(schema);
  
  // function 객체 정의: {"name": "toolName", "arguments": "JSON_string"}
  // 주의: arguments는 문자열 안에 이스케이프된 JSON 형태로 들어가는 경우가 많음. 
  // GBNF에서 이스케이프된 JSON 문자열 처리는 복잡하므로, 인자값 객체 자체를 매칭하거나 유연하게 잡을 수 있도록 설계.
  const body = 
    `${funcRuleName} ::= "{\\"name\\":\\"${toolName}\\"" ws "," ws "\\"arguments\\":\\"" ${argsRuleName} "\\"}"\n` +
    `${argsRuleName} ::= ${argsGbnf}`;

  return {
    name: funcRuleName,
    body
  };
}

function compileSchema(schema: any): string {
  if (!schema) return "string";

  const type = schema.type;
  if (type === "object") {
    const props = schema.properties || {};
    const required = schema.required || [];
    
    if (Object.keys(props).length === 0) {
      return `"{\\"}"`;
    }

    // 각 property 컴파일
    const propRules: string[] = [];
    for (const [key, val] of Object.entries(props)) {
      const isReq = required.includes(key);
      const valRule = compileSchema(val);
      // JSON 안의 키는 이스케이프될 수 있으므로 따옴표 처리
      const keyStr = `\\\\\\"${key}\\\\\\"`;
      
      if (isReq) {
        propRules.push(`ws "${keyStr}" ws ":" ws ${valRule}`);
      } else {
        // 옵셔널 필드는 단순화를 위해 GBNF 정의에서 생략 가능하게 하거나 간소화
        propRules.push(`(ws "${keyStr}" ws ":" ws ${valRule})?`);
      }
    }

    // JSON 객체 이스케이프된 GBNF 표현
    // arguments는 문자열 리터럴 안에 에스케이프되어 들어가므로 따옴표 `\"`는 `\\\\\\"` 형태로 변환되어 매칭되어야 함.
    return `"\\\\\\{" ${propRules.join(` (ws "," ws )? `)} "\\\\\\}"`;
  } 
  
  if (type === "string") {
    if (schema.enum) {
      const enumVals = schema.enum.map((v: string) => `"\\\\\\"${v}\\\\\\""`).join(" | ");
      return `(${enumVals})`;
    }
    // 이스케이프된 문자열 내부 값 매칭
    return `[a-zA-Z0-9_\\\\-\\\\.\\\\\\/\\\\s:\\\\(\\)\\\\[\\\\]\\\\{\\}]*`;
  }
  
  if (type === "number" || type === "integer") {
    return "number";
  }
  
  if (type === "boolean") {
    return "boolean";
  }
  
  if (type === "array") {
    const itemsRule = compileSchema(schema.items || { type: "string" });
    return `"\\\\\\\\[" ws (${itemsRule} (ws "," ws ${itemsRule})*)? ws "\\\\\\\\]"`;
  }

  return "string";
}
