// eval 러너: 고정 과제 묶음을 격리 실행하고 '객관 채점기(exit code)'로 성공률을 측정한다.
//
// 과제 구조:  eval/tasks/<name>/task.json  { prompt, checker, timeoutSec? }
//             eval/tasks/<name>/fixture/   (선택) 시작 파일들 → 워크스페이스로 복사
//             채점기(check.js 등)는 워크스페이스 '밖'(과제 폴더)에 둬서 에이전트가 못 건드림
//
// 실행:  npx tsx eval/run.ts                      # 전체 과제
//        npx tsx eval/run.ts hello-js             # 특정 과제만
//        MCC_ABLATE=antiflail,router,paralysis npx tsx eval/run.ts   # 어블레이션
//
// 결과: 콘솔 표 + eval/.runs/<ts>/results.json (성공·스텝·시간·outcome)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateHome } from "./metrics.js";

const evalDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(evalDir, "..");
const tasksDir = join(evalDir, "tasks");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runsDir = join(evalDir, ".runs", stamp);

interface Task {
  name: string;
  prompt: string;
  checker: string; // 워크스페이스를 cwd로 실행, exit 0 = 통과
  timeoutSec?: number;
  env?: Record<string, string>; // 과제별 환경변수(예: 대형 과제의 MCC_MAX_STEPS)
}
interface RoundResult {
  success: boolean;
  steps: number | null; // 라운드 총 스텝(메인+서브에이전트 합)
  outcome: string;
  seconds: number;
  checkerNote: string;
  // 메커니즘 지표: 통과율(고분산)보다 민감한 직접 신호 — 기능 A/B는 이걸로 판정
  agents: number; // 텔레메트리 레코드 수(2+ = critic 서브에이전트 라운드)
  editFail: number; // edit_file 매칭 실패 건수
  parseFail: number; // 응답 파싱/JSON 실패 건수
  loops: number; // REPETITION_LOOP 건수
  editTries: number; // edit_file+patch_ast_node 호출 수(실패율 분모)
}
interface Result {
  task: string;
  rounds: RoundResult[];
  passes: number; // rounds 중 통과 횟수
}

// 반복 횟수: 로컬 모델은 런 간 분산이 크므로(동일 과제가 25s 성공 ↔ 300s 타임아웃)
// N회 반복해 통과율로 본다. ROUNDS=3 npx tsx eval/run.ts
const ROUNDS = Math.max(1, Number(process.env.ROUNDS ?? 1));

const median = (xs: number[]): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

// 프로세스 트리 종료(Windows 대응) — 타임아웃 시 손자까지 정리
function killTree(pid: number | undefined): void {
  if (pid == null) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch { /* 무시 */ }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* 무시 */ }
  }
}

function runProc(
  cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd, env, shell: true, windowsHide: true,
      detached: process.platform !== "win32",
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); process.stdout.write(d); });
    child.stderr?.on("data", (d) => { out += d.toString(); });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child.pid);
      res({ code: null, out, timedOut: true });
    }, timeoutMs);
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ code, out, timedOut: false });
    });
    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res({ code: -1, out, timedOut: false });
    });
  });
}

async function main() {
  // 선택: 특정 과제만 (쉼표 목록 지원 — 예: npx tsx eval/run.ts big-list,csv-sum)
  const only = process.argv[2] ? new Set(process.argv[2].split(",").map((s) => s.trim())) : null;
  const taskNames = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(tasksDir, e.name, "task.json")))
    .map((e) => e.name)
    .filter((n) => !only || only.has(n));
  if (!taskNames.length) {
    console.error(only ? `과제 '${only}' 없음` : "과제 없음(eval/tasks/)");
    process.exit(2);
  }

  const ablate = process.env.MCC_ABLATE ?? "";
  console.log(`\n📏 eval 시작 — 과제 ${taskNames.length}개 × ${ROUNDS}회, ablate=[${ablate || "없음(풀 하네스)"}]`);
  console.log(`   endpoint: ${process.env.MCC_BASE_URL ?? "(config 기본값)"}\n`);

  const results: Result[] = [];
  for (const name of taskNames) {
    const task: Task = JSON.parse(readFileSync(join(tasksDir, name, "task.json"), "utf-8"));
    const timeoutMs = (task.timeoutSec ?? 300) * 1000;
    const rounds: RoundResult[] = [];

    for (let round = 1; round <= ROUNDS; round++) {
      const ws = join(runsDir, name, `round-${round}`, "workspace");
      const home = join(runsDir, name, `round-${round}`, "mcc-home"); // runs.jsonl 격리
      mkdirSync(ws, { recursive: true });
      mkdirSync(home, { recursive: true });
      const fixture = join(tasksDir, name, "fixture");
      if (existsSync(fixture)) cpSync(fixture, ws, { recursive: true });

      console.log(`\n════════ ▶ ${name} [${round}/${ROUNDS}] (제한 ${timeoutMs / 1000}s) ════════`);
      const t0 = Date.now();
      const agent = await runProc(
        "npx", ["tsx", JSON.stringify(join(evalDir, "entry.ts")), JSON.stringify(task.prompt)],
        ws,
        {
          ...process.env,
          // 과제별 env. 값의 {TASK_DIR}는 과제 폴더 절대경로로 치환 —
          // 예: MCC_VERIFY_CMD="node \"{TASK_DIR}/check.cjs\"" (검증 게이트 = 채점기 = 실행 가능한 명세)
          ...Object.fromEntries(
            Object.entries(task.env ?? {}).map(([k, v]) => [
              k,
              v.replaceAll("{TASK_DIR}", join(tasksDir, name)),
            ])
          ),
          MCC_EVAL: "1",
          MCC_HOME: home,
        },
        timeoutMs
      );
      const seconds = Math.round((Date.now() - t0) / 1000);

      // 채점 (워크스페이스를 cwd로, 채점기는 과제 폴더에 있음 — 에이전트가 못 건드림)
      const check = await runProc(
        "node", [JSON.stringify(join(tasksDir, name, task.checker))], ws, process.env, 30_000
      );
      // 메커니즘 지표 집계(메인+서브에이전트 레코드 전부 — critic 라운드도 기록됨)
      const rec = aggregateHome(home);
      rounds.push({
        success: check.code === 0,
        steps: rec.steps,
        outcome: agent.timedOut ? "timeout" : rec.outcome,
        seconds,
        checkerNote: check.out.trim().slice(0, 120) || "(채점기 출력 없음)",
        agents: rec.agents,
        editFail: rec.editFail,
        parseFail: rec.parseFail,
        loops: rec.loops,
        editTries: rec.editTries,
      });
      console.log(`\n   ${check.code === 0 ? "✅ PASS" : "❌ FAIL"} — ${rounds.at(-1)!.checkerNote}`);
    }
    results.push({ task: name, rounds, passes: rounds.filter((r) => r.success).length });
  }

  // 요약 표 + 결과 저장
  const totalPass = results.reduce((n, r) => n + r.passes, 0);
  const totalRuns = results.reduce((n, r) => n + r.rounds.length, 0);
  console.log(`\n\n══════════ 결과: ${totalPass}/${totalRuns} 통과 (ablate=[${ablate || "-"}], ${ROUNDS}회 반복) ══════════`);
  const w = Math.max(...results.map((r) => r.task.length), 4);
  console.log(`${"task".padEnd(w)}  통과   스텝(중앙)  시간(중앙)  편집✗/시도  파싱✗  반복  outcomes`);
  for (const r of results) {
    const stepMed = median(r.rounds.map((x) => x.steps ?? NaN));
    const secMed = median(r.rounds.map((x) => x.seconds));
    const outcomes = r.rounds.map((x) => x.outcome).join(",");
    const sum = (f: (x: RoundResult) => number) => r.rounds.reduce((n, x) => n + f(x), 0);
    const edit = `${sum((x) => x.editFail)}/${sum((x) => x.editTries)}`;
    console.log(
      `${r.task.padEnd(w)}  ${r.passes}/${r.rounds.length}   ${String(Number.isFinite(stepMed) ? stepMed : "?").padStart(6)}     ${String(Math.round(secMed) + "s").padStart(6)}   ${edit.padStart(8)}  ${String(sum((x) => x.parseFail)).padStart(5)}  ${String(sum((x) => x.loops)).padStart(4)}  ${outcomes}`
    );
  }
  // 메커니즘 지표 총계 — 통과율(고분산) 대신 기능 A/B 판정에 쓰는 직접 신호
  const all = results.flatMap((r) => r.rounds);
  const tot = (f: (x: RoundResult) => number) => all.reduce((n, x) => n + f(x), 0);
  console.log(
    `\n📎 메커니즘 지표 총계 — 편집실패 ${tot((x) => x.editFail)}/${tot((x) => x.editTries)}시도, ` +
      `파싱실패 ${tot((x) => x.parseFail)}, 반복루프 ${tot((x) => x.loops)}`
  );
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, "results.json"),
    JSON.stringify({ ts: stamp, ablate, rounds: ROUNDS, model: process.env.MCC_MODEL ?? "", baseURL: process.env.MCC_BASE_URL ?? "", reviewer: process.env.MCC_REVIEW_MODEL ?? "", results }, null, 2),
    "utf-8"
  );
  console.log(`\n결과 저장: eval/.runs/${stamp}/results.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
