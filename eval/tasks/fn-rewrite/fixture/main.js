// 점수 분석 유틸 — analyze만 고치고 나머지 함수는 보존할 것
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function analyze(scores) {
  const sorted = scores.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((acc, x) => acc + x, 0);
  const mean = total / n;
  return "MEAN=" + mean;
}

function label(v) {
  return "결과: " + v;
}

console.log(label(analyze([10, 20, 30, 100])));
