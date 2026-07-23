// L4 힐 클라이밍 — 트레이스 분석 엔진.
//
// 누적 실행 로그(runs.jsonl)에서 '저분산 메커니즘 지표'(편집 매칭 실패·파싱 실패·반복 루프·
// 거부·미완주 결과)를 집계해, 반복되는 실패 패턴을 '증거 딸린 진단 이슈'로 랭크한다.
// = 사람이 손으로 하던 '로그 grep → 병목 진단'을 자동화한 것.
//
// 설계 원칙:
//  - 결정론적: LLM 반성(/evolve)과 달리 규칙 기반이라 노이즈가 없다. pass rate(고분산) 대신
//    발생 즉시 기록되는 원인 카운트(저분산)를 본다.
//  - ①/② 분류: 각 이슈에 '레버'(①하네스로 우회 가능 / ②모델 몫)를 붙여 대응 방향을 가른다.
//  - **하네스를 바꾸지 않는다**: 이슈만 등록한다. 채택은 ablation 측정 뒤(측정된 하네스 원칙).
//    (repfix처럼 '그럴듯한 개입'을 측정 없이 넣지 않기 위함.)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RunRecord } from "./evolve.js";

const mccDir = process.env.MCC_HOME ?? join(homedir(), ".mcc");
const runsFile = join(mccDir, "runs.jsonl");

// eval/metrics.ts의 classifyError와 동일 분류(단일 진실원과 정렬 — 바꿀 땐 둘 다).
function classifyError(s: string): "edit" | "parse" | "loop" | "other" {
  if (/old_string|유일해야/.test(s)) return "edit";
  if (/REPETITION_LOOP/.test(s)) return "loop";
  if (/Failed to parse|Unexpected token|status code 500|\bJSON\b/i.test(s)) return "parse";
  return "other";
}

function readRuns(): RunRecord[] {
  if (!existsSync(runsFile)) return [];
  return readFileSync(runsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as RunRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r !== null);
}

export type Lever = "①하네스" | "②모델" | "①②혼합" | "?";

export interface Issue {
  severity: number; // 빈도 기반 점수(정렬용)
  title: string;
  evidence: string;
  lever: Lever;
  hint: string; // 후보 대응(측정 대상). 자동 적용하지 않는다.
}

export interface Diagnosis {
  total: number; // 전체 누적 실행 수
  window: number; // 분석 대상(최근 N)
  outcomes: Record<string, number>;
  mech: { editFail: number; parseFail: number; loops: number; rejections: number; editTries: number };
  topErrors: [string, number][]; // 반복되는 원시 오류 문자열
  issues: Issue[];
}

// 오류 문자열을 대략적 지문으로 정규화(숫자·경로 제거) → 재발 오류 집계용.
function errFingerprint(s: string): string {
  return s
    .replace(/['"`].*?['"`]/g, "…")
    .replace(/\d+/g, "#")
    .replace(/[/\\][^\s]+/g, "/…")
    .slice(0, 80)
    .trim();
}

export function diagnose(limit = 200): Diagnosis {
  const all = readRuns();
  const runs = all.slice(-limit); // 최근 것 우선
  const outcomes: Record<string, number> = {};
  const mech = { editFail: 0, parseFail: 0, loops: 0, rejections: 0, editTries: 0 };
  const errFreq = new Map<string, number>();

  for (const r of runs) {
    outcomes[r.outcome || "?"] = (outcomes[r.outcome || "?"] ?? 0) + 1;
    mech.rejections += r.rejections ?? 0;
    mech.editTries += (r.tools?.edit_file ?? 0) + (r.tools?.patch_ast_node ?? 0);
    for (const e of r.errors ?? []) {
      const k = classifyError(String(e));
      if (k === "edit") mech.editFail++;
      else if (k === "parse") mech.parseFail++;
      else if (k === "loop") mech.loops++;
      const fp = errFingerprint(String(e));
      if (fp) errFreq.set(fp, (errFreq.get(fp) ?? 0) + 1);
    }
  }

  const w = runs.length || 1;
  const incomplete = Object.entries(outcomes)
    .filter(([o]) => o !== "done")
    .reduce((a, [, n]) => a + n, 0);

  const issues: Issue[] = [];
  const push = (severity: number, title: string, evidence: string, lever: Lever, hint: string) => {
    if (severity >= 2) issues.push({ severity, title, evidence, lever, hint });
  };

  // ── 규칙 기반 이슈 감지 (각 규칙은 '증거 + 레버 + 후보 대응') ──
  push(
    mech.loops,
    "반복 스파이럴(②) 빈발",
    `REPETITION_LOOP ${mech.loops}건 / ${w}런 (${((mech.loops / w) * 100).toFixed(0)}%)`,
    "②모델",
    "사고 중 재현 오염 → 모델(Q8/QAT)이 레버. 텍스트 넛지는 측정상 무효(repfix 폐기)로 재도입 금지.",
  );
  push(
    mech.editFail,
    "edit_file 매칭 실패(①) 빈발",
    `edit ${mech.editFail}건 / 편집시도 ${mech.editTries}`,
    "①하네스",
    "patch_ast_node(심볼 이름)·경로/공백 수리로 우회 가능. 신규 완화책은 ablation으로 검증 후 채택.",
  );
  push(
    mech.parseFail,
    "응답 파싱/JSON 실패(①) 빈발",
    `parse ${mech.parseFail}건 / ${w}런`,
    "①하네스",
    "큰 출력 청킹·도구 인자 분할·스트림 파서 점검. 서버 500과 구분해 확인.",
  );
  push(
    mech.rejections,
    "도구 거부 빈발",
    `거부 ${mech.rejections}건 / ${w}런`,
    "?",
    "위험 명령 오분류 또는 잘못된 도구 선택 여부 점검(라이브락 가드 이후 재확인).",
  );
  push(
    (outcomes["paralysis_user_stop"] ?? 0) + (outcomes["error_abort"] ?? 0) + (outcomes["max_steps"] ?? 0),
    "미완주(분석마비·중단·스텝초과)",
    `incomplete ${incomplete}/${w} — paralysis ${(outcomes["paralysis_user_stop"] ?? 0)}, error_abort ${(outcomes["error_abort"] ?? 0)}, max_steps ${(outcomes["max_steps"] ?? 0)}`,
    "①②혼합",
    "①(도구 실패)과 ②(스파이럴)가 섞임 — 위 편집/반복 이슈 해소가 대개 선행 조건.",
  );

  // 재발하는 원시 오류(지문 ≥2회) — 규칙에 안 걸린 미지의 패턴 포착.
  const topErrors = [...errFreq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  issues.sort((a, b) => b.severity - a.severity);
  return { total: all.length, window: runs.length, outcomes, mech, topErrors, issues };
}

export function formatDiagnosis(d: Diagnosis): string {
  if (d.window === 0) {
    return "분석할 실행 기록이 없습니다(runs.jsonl 비어 있음). 작업을 몇 건 수행한 뒤 다시 실행하세요.";
  }
  const L: string[] = [];
  L.push(`\n🔧 트레이스 진단 엔진 — 최근 ${d.window}런 분석 (전체 누적 ${d.total})`);
  L.push("─".repeat(52));

  const oc = Object.entries(d.outcomes).sort((a, b) => b[1] - a[1]);
  L.push("결과 분포: " + oc.map(([o, n]) => `${o} ${n}`).join(" · "));
  L.push(
    `메커니즘 지표: 편집실패 ${d.mech.editFail}/${d.mech.editTries}시도 · 파싱실패 ${d.mech.parseFail} · 반복 ${d.mech.loops} · 거부 ${d.mech.rejections}`,
  );

  L.push("\n📋 진단 이슈 (심각도순 — 증거·레버·후보 대응):");
  if (!d.issues.length) {
    L.push("  (임계치 이상 반복 실패 패턴 없음 — 건강함)");
  } else {
    d.issues.forEach((it, i) => {
      L.push(`\n  ${i + 1}. [${it.lever}] ${it.title}  (심각도 ${it.severity})`);
      L.push(`     증거: ${it.evidence}`);
      L.push(`     후보: ${it.hint}`);
    });
  }

  if (d.topErrors.length) {
    L.push("\n🔁 재발 오류(지문 ≥2회):");
    for (const [fp, n] of d.topErrors) L.push(`     ${n}× ${fp}`);
  }

  L.push(
    "\n⚠️ 이 이슈들은 '후보'다. 자동으로 하네스를 바꾸지 않는다 — 채택 전 ablation(MCC_ABLATE)으로 " +
      "효과를 측정하라(측정된 하네스 원칙). ②모델 레버는 하네스로 못 고친다.\n",
  );
  return L.join("\n");
}

// /engine: 진단 리포트를 출력한다(하네스는 변경하지 않음).
export function runEngine(limit = 200): void {
  console.log(formatDiagnosis(diagnose(limit)));
}
