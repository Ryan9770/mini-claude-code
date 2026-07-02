// calc.js — 1부터 5까지의 합을 출력해야 한다. (기대 출력: SUM=15)
function sum(arr) {
  let s = 0;
  for (const x of arr) {
    s -= x; // 버그
  }
  return s;
}

console.log("SUM=" + sum([1, 2, 3, 4, 5]));
