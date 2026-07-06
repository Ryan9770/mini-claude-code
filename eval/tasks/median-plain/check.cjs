// 채점기: node main.js를 실행해 'MEDIAN=<값>'을 파싱하고 정확히 7.5인지 검사한다.
// 핵심 함정: JS .sort()는 비교함수 없으면 문자열(사전순) 정렬 → 여러 자리 숫자에서 조용히 틀림.
//   [10,2,33,4,5,100] 숫자정렬=[2,4,5,10,33,100] → 중앙값 (5+10)/2 = 7.5 (정답)
//   사전순 .sort() → [10,100,2,33,4,5] → (2+33)/2 = 17.5 (오답)  / 정수나눗셈 → 7 (오답)
// 정적 리뷰로는 못 잡고, 실행해야만 드러나는 버그 → 게이트 가치 격리용.
const { execFileSync } = require("node:child_process");

let out;
try {
  out = execFileSync("node", ["main.js"], { timeout: 10_000 }).toString();
} catch (e) {
  console.log(`FAIL: main.js 실행 오류 → ${String(e.message).slice(0, 80)}`);
  process.exit(1);
}
const m = out.match(/MEDIAN\s*=\s*(-?\d+(?:\.\d+)?)/);
if (!m) {
  console.log(`FAIL: 'MEDIAN=<값>' 출력 없음 → "${out.trim().slice(0, 60)}"`);
  process.exit(1);
}
const val = Number(m[1]);
if (Math.abs(val - 7.5) < 1e-9) {
  console.log("PASS: MEDIAN=7.5 (정렬·평균 정확)");
  process.exit(0);
}
console.log(`FAIL: MEDIAN=${val} (기대 7.5 — .sort() 사전순 또는 정수나눗셈 버그 의심)`);
process.exit(1);
