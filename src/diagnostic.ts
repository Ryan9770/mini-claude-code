/**
 * 컴파일 및 테스트 검증 게이트의 방대한 콘솔 출력(Stack Trace 등)에서
 * 외부 라이브러리 노이즈를 걷어내고 에이전트 수정에 꼭 필요한 핵심 에러 라인만 추출해 요약합니다.
 */
export function compressDiagnostic(output: string): string {
  if (!output) return "";
  
  const lines = output.split(/\r?\n/);
  const cleanLines: string[] = [];
  
  // Jest/Vitest 비교 디프(Diff)를 수집하기 위한 상태 변수
  let isCapturingDiff = false;
  let diffLinesCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1) Jest/Vitest 디프 섹션 포착 (Expected / Received 혹은 + / - 디프 매칭)
    const isDiffStart =
      trimmed.includes("- Expected") ||
      trimmed.includes("+ Received") ||
      trimmed.startsWith("Difference:") ||
      trimmed.startsWith("Expected:") ||
      trimmed.startsWith("Received:") ||
      (trimmed.startsWith("expect(") && trimmed.includes(")."));

    if (isDiffStart) {
      isCapturingDiff = true;
      diffLinesCount = 0;
    }

    if (isCapturingDiff) {
      if (diffLinesCount < 15) {
        cleanLines.push(line);
        diffLinesCount++;
      } else {
        isCapturingDiff = false;
      }
      continue;
    }

    // 2) 외부 노드 모듈 및 런타임 내부 라이브러리 스택 트레이스 제외
    if (
      line.includes("node_modules") ||
      line.includes("node:internal") ||
      line.includes("node:events") ||
      line.includes("node_modules\\") ||
      line.includes("async_hooks")
    ) {
      continue;
    }

    // 3) 핵심 에러 키워드 및 타입스크립트/파이썬 파일 에러 라인 매칭
    const isErrorPattern =
      /\bTS\d{4}:/.test(line) || // TSXXXX 에러 코드
      /error/i.test(line) ||
      /fail/i.test(line) ||
      /exception/i.test(line) ||
      /assertion/i.test(line) ||
      /typeerror/i.test(line) ||
      /syntaxerror/i.test(line) ||
      /referenceerror/i.test(line) ||
      /^\s*at\s+.*\(.*:\d+:\d+\)/.test(line) || // JS/TS 로컬 파일 경로가 적힌 스택 트레이스 프레임
      /^\s*File\s+".*",\s*line\s*\d+/.test(line); // Python traceback 에러 라인

    // 4) 로컬 프로젝트 파일 좌표 포함 여부
    const isLocalFileInfo =
      /^(src|eval|tests|workspace|harness)\//.test(trimmed) ||
      /^(src|eval|tests|workspace|harness)\\/.test(trimmed) ||
      /\.(ts|tsx|js|jsx|py):\d+/.test(line);

    if (
      isErrorPattern ||
      isLocalFileInfo ||
      trimmed.startsWith("●") || // Jest 개별 실패 지표
      trimmed.startsWith("Expected") ||
      trimmed.startsWith("Actual")
    ) {
      cleanLines.push(line);
    }
  }

  // 필터링 결과가 아예 없다면 원본의 앞부분을 잘라서 반환
  if (cleanLines.length === 0) {
    return output.slice(0, 3000);
  }

  // 중복 빈 줄 제거 및 최대 50줄로 정리
  const finalOutput = cleanLines
    .filter((l, idx, arr) => l.trim() !== "" || (idx > 0 && arr[idx - 1].trim() !== ""))
    .slice(0, 50)
    .join("\n");

  return `⚠️ [검증 실패 요약 (콘솔 노이즈 제거됨)]\n${finalOutput}\n(자세한 사항은 상단의 전체 에러를 참고하여 위 실패 지점을 수정하십시오.)`;
}
