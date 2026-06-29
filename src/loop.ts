// 루프 종료/수렴 엔진: 반복 루프(Ralph 등)의 종료를 체계적으로 판단한다.
//
// 기존 루프는 "고정 횟수" 또는 "특정 문자열"로만 멈췄다. 이 엔진은 세 축으로 종료를 결정한다:
//   1) 예산(budget)    — 최대 반복 횟수, 최대 경과 시간
//   2) 정체(stall)     — 반복했는데 작업 디렉터리에 변화가 없으면(파일 무변경) 막힌 것으로 보고 중단
//   3) 성공(success)   — 호출자가 done=true를 보고하면 즉시 종료
//
// 정체 감지는 watchDir의 파일 지문(경로·크기·mtime 해시)을 반복마다 비교해 수행한다.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", "__pycache__", ".cache", "_workspace_prev",
]);

// 디렉터리의 현재 상태 지문 — 파일이 추가/수정/삭제되면 값이 바뀐다.
export function fingerprintDir(dir: string, maxFiles = 5000): string {
  const parts: string[] = [];
  let count = 0;
  const walk = (d: string) => {
    if (count > maxFiles) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count > maxFiles) return;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) walk(full);
      } else if (e.isFile()) {
        try {
          const s = statSync(full);
          parts.push(`${full}:${s.size}:${s.mtimeMs}`);
          count++;
        } catch {
          /* 무시 */
        }
      }
    }
  };
  walk(dir);
  parts.sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

export type StopReason = "success" | "max_iterations" | "timeout" | "stalled" | "running";

export interface ConvergenceOptions {
  maxIterations: number;
  maxSeconds?: number; // 벽시계 시간 예산(선택)
  maxStallRounds?: number; // 연속 정체 허용 횟수 (기본 2)
  watchDir?: string; // 정체 감지 대상 (기본 cwd)
}

// 반복 루프의 진행/종료를 제어하는 컨트롤러.
export class ConvergenceController {
  private iter = 0;
  private stalls = 0;
  private done = false;
  private readonly start = Date.now();
  private lastFp: string;
  private readonly maxIterations: number;
  private readonly maxSeconds?: number;
  private readonly maxStallRounds: number;
  private readonly watchDir: string;
  stopReason: StopReason = "running";

  constructor(opts: ConvergenceOptions) {
    this.maxIterations = opts.maxIterations;
    this.maxSeconds = opts.maxSeconds;
    this.maxStallRounds = opts.maxStallRounds ?? 2;
    this.watchDir = opts.watchDir ?? process.cwd();
    this.lastFp = fingerprintDir(this.watchDir);
  }

  // 반복 시작 전 호출 — 계속할지 결정한다.
  begin(): { proceed: boolean; iteration: number; reason: StopReason } {
    if (this.done) return this.halt("success");
    if (this.iter >= this.maxIterations) return this.halt("max_iterations");
    // maxSeconds: undefined=무제한, 0=제로예산. truthiness가 아니라 명시 비교를 쓴다.
    if (this.maxSeconds !== undefined && this.elapsedSec >= this.maxSeconds) return this.halt("timeout");
    if (this.stalls >= this.maxStallRounds) return this.halt("stalled");
    this.iter++;
    return { proceed: true, iteration: this.iter, reason: "running" };
  }

  // 반복 종료 후 호출 — 성공 여부 기록 + 작업공간 변화 측정.
  end(result: { done?: boolean }): { changed: boolean } {
    this.done = !!result.done;
    const fp = fingerprintDir(this.watchDir);
    const changed = fp !== this.lastFp;
    if (!changed && !this.done) this.stalls++;
    else this.stalls = 0;
    this.lastFp = fp;
    return { changed };
  }

  private halt(reason: StopReason) {
    this.stopReason = reason;
    return { proceed: false, iteration: this.iter, reason };
  }

  get elapsedSec(): number {
    return Math.round((Date.now() - this.start) / 1000);
  }
  get iterations(): number {
    return this.iter;
  }
}
