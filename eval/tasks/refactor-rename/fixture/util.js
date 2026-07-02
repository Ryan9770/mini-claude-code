// 집계 유틸
import { getData } from "./lib.js";

export function sumData() {
  return getData().reduce((a, b) => a + b, 0);
}
