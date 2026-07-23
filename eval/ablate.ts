// 자동 ablation 검증 루프 — L4 힐 클라이밍의 '측정 게이트'.
//
// 후보 개선책(ablate 토글)을 ON(기능 있음) vs OFF(기능 제거) 두 조건으로 같은 과제를
// N회씩 자동 실행하고, 저분산 '메커니즘 지표'로 효과 있음 / 없음 / 역효과를 판정한다.
// = 이번 세션에 사람이 손으로 하던 A/B 측정(AST·repfix 등)의 자동화.
//
// 원칙(측정된 하네스):
//  - 통과율은 고분산 → 부차 신호. 메커니즘 실패 카운트(편집실패·파싱실패·반복)를 1차 판정에 쓴다.
//  - 보수적 판정: 명확한 감소가 있을 때만 '효과 있음'. 노이즈면 '채택 근거 불충분'.
//  - 이 스크립트는 하네스를 바꾸지 않는다 — 판정만 낸다(repfix 교훈).
//
// 사용:  ROUNDS=5 npx tsx eval/ablate.ts <flag> [task-filter]
//        예) ROUNDS=5 npx tsx eval/ablate.ts ast fn-rewrite
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const evalDir = dirname(fileURLToPath(import.meta.url));

export interface CondResult {
  label: string;
  ablate: string;
  total: number; // 총 라운드 수
  passes: number;
  editFail: number;
  parseFail: number;
  loops: number;
  editTries: number;
  mechFail: number; // editFail + parseFail + loops (1차 신호)
}

// results.json → 조건 요약(모든 과제·라운드 합산).
export function summarize(label: string, ablate: string, resultsJson: any): CondResult {
  const results: any[] = resultsJson?.results ?? [];
  const rounds = results.flatMap((r) => r.rounds ?? []);
  const sum = (f: (x: any) => number) => rounds.reduce((n, x) => n + (f(x) || 0), 0);
  const editFail = sum((x) => x.editFail);
  const parseFail = sum((x) => x.parseFail);
  const loops = sum((x) => x.loops);
  return {
    label,
    ablate: ablate || "(없음)",
    total: rounds.length,
    passes: results.reduce((n, r) => n + (r.passes ?? 0), 0),
    editFail,
    parseFail,
    loops,
    editTries: sum((x) => x.editTries),
    mechFail: editFail + parseFail + loops,
  };
}

export interface Verdict {
  verdict: "효과 있음" | "역효과 의심" | "효과 없음";
  reason: string;
  passNote: string;
}

// 보수적 판정: 메커니즘 실패의 절대·상대 감소가 둘 다 임계 이상일 때만 '효과 있음'.
export function judge(on: CondResult, off: CondResult): Verdict {
  const dMech = off.mechFail - on.mechFail; // 양수 = ON(기능)이 실패를 줄임
  const relDrop = off.mechFail > 0 ? dMech / off.mechFail : 0;
  const onRate = on.total ? on.passes / on.total : 0;
  const offRate = off.total ? off.passes / off.total : 0;
  const dPass = onRate - offRate;

  // 통과율은 고분산 — 큰 차이(≥0.3)일 때만 보조 근거로 언급.
  const passNote =
    Math.abs(dPass) >= 0.3
      ? `통과율 ${(onRate * 100).toFixed(0)}% vs ${(offRate * 100).toFixed(0)}% (Δ${(dPass * 100).toFixed(0)}%p) — 큰 차이라 참고할 만함`
      : `통과율 ${(onRate * 100).toFixed(0)}% vs ${(offRate * 100).toFixed(0)}% (Δ${(dPass * 100).toFixed(0)}%p) — 노이즈 범위, 판정 근거로 안 씀`;

  let verdict: Verdict["verdict"];
  let reason: string;
  if (dMech >= 2 && relDrop >= 0.3) {
    verdict = "효과 있음";
    reason = `메커니즘 실패 ${off.mechFail} → ${on.mechFail} (−${dMech}, −${(relDrop * 100).toFixed(0)}%). 기능이 실패 메커니즘을 유의하게 줄임 → 채택 후보.`;
  } else if (-dMech >= 2 && off.mechFail > 0 && -relDrop >= 0.3) {
    verdict = "역효과 의심";
    reason = `메커니즘 실패 ${off.mechFail} → ${on.mechFail} (+${-dMech}). 기능이 실패를 늘림 → 채택 보류/재검토.`;
  } else {
    verdict = "효과 없음";
    reason = `메커니즘 실패 ${off.mechFail} → ${on.mechFail} (Δ${dMech >= 0 ? "−" : "+"}${Math.abs(dMech)}). 노이즈 범위 → 채택 근거 불충분(repfix처럼 보류).`;
  }
  return { verdict, reason, passNote };
}

function runProc(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: evalDir, env, shell: true, windowsHide: true, stdio: "inherit" });
    child.on("close", (code) => res(code));
    child.on("error", () => res(-1));
  });
}

async function runCondition(label: string, ablate: string, taskArg: string[], outDir: string): Promise<CondResult> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  console.log(`\n\n██████ 조건 [${label}] — MCC_ABLATE=[${ablate || "없음"}] ██████`);
  await runProc("npx", ["tsx", JSON.stringify(join(evalDir, "run.ts")), ...taskArg], {
    ...process.env,
    MCC_ABLATE: ablate,
    EVAL_OUT: outDir,
  });
  const rf = join(outDir, "results.json");
  if (!existsSync(rf)) return summarize(label, ablate, {});
  return summarize(label, ablate, JSON.parse(readFileSync(rf, "utf-8")));
}

async function main() {
  const flag = process.argv[2];
  const taskFilter = process.argv[3];
  if (!flag) {
    console.error("사용법: ROUNDS=5 npx tsx eval/ablate.ts <flag> [task-filter]\n  예) ROUNDS=5 npx tsx eval/ablate.ts ast fn-rewrite");
    process.exit(2);
  }
  const base = (process.env.MCC_ABLATE_BASE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const onAblate = base.filter((f) => f !== flag).join(","); // 기능 ON: flag 제거
  const offAblate = [...new Set([...base, flag])].join(","); // 기능 OFF: flag 어블레이션
  const taskArg = taskFilter ? [JSON.stringify(taskFilter)] : [];

  console.log(`🧪 자동 ablation 검증 — 토글 '${flag}'  (ON=기능있음 vs OFF=기능제거)`);
  console.log(`   과제: ${taskFilter ?? "전체"} · 반복 ROUNDS=${process.env.ROUNDS ?? 1} · endpoint ${process.env.MCC_BASE_URL ?? "(기본)"}`);

  const on = await runCondition("ON 기능있음", onAblate, taskArg, join(evalDir, ".ablate", `${flag}-on`));
  const off = await runCondition("OFF 기능제거", offAblate, taskArg, join(evalDir, ".ablate", `${flag}-off`));
  const v = judge(on, off);

  const row = (c: CondResult) =>
    `  ${c.label.padEnd(12)} 통과 ${c.passes}/${c.total}  편집실패 ${c.editFail}/${c.editTries}  파싱실패 ${c.parseFail}  반복 ${c.loops}  (메커니즘실패 ${c.mechFail})`;
  console.log(`\n\n══════════ 판정: 토글 '${flag}' ══════════`);
  console.log(row(on));
  console.log(row(off));
  console.log(`\n▶ 판정: ${v.verdict}`);
  console.log(`  근거: ${v.reason}`);
  console.log(`  통과율: ${v.passNote}`);
  console.log(`\n⚠️ 이 판정은 자동 채택하지 않는다 — 근거로 삼아 사람이 결정한다(측정된 하네스).\n`);
}

// 직접 실행일 때만 main (테스트에서 judge/summarize를 import할 수 있게).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
