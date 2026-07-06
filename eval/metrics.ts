// eval 메커니즘 지표: 라운드별 runs.jsonl에서 '왜 실패했는가'를 직접 센다.
//
// 배경: 통과율은 런 간 분산이 너무 커서(동일 설정이 1/6↔5/6) 작은 개선을 못 잡는다.
// 실패 '원인 건수'(편집 매칭 실패·응답 파싱 실패·반복 루프)는 발생 즉시 기록되는
// 직접 신호라 훨씬 민감하다 — 기능(A/B)의 효과는 이 카운트로 판정한다.
// 실측 기준(2026-07-06): edit_file 매칭 실패가 1순위(~110건), JSON/채널 파싱 실패 2순위(~91건).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RoundMech {
  steps: number | null; // 라운드 총 스텝(메인+서브에이전트 레코드 합)
  outcome: string; // 마지막 레코드의 outcome
  agents: number; // 레코드 수 (1=단일 루프, 2+=critic 서브에이전트들)
  editFail: number; // edit_file 매칭 실패(old_string 미발견/비유일)
  parseFail: number; // 응답 파싱/JSON/500 실패(<|channel> 누수 등)
  loops: number; // REPETITION_LOOP 발생 수
  editTries: number; // edit_file + patch_ast_node 호출 수(실패율의 분모)
}

export function classifyError(s: string): "edit" | "parse" | "loop" | "other" {
  if (/old_string|유일해야/.test(s)) return "edit";
  if (/REPETITION_LOOP/.test(s)) return "loop";
  if (/Failed to parse|Unexpected token|status code 500|\bJSON\b/i.test(s)) return "parse";
  return "other";
}

const EMPTY: RoundMech = {
  steps: null, outcome: "no-record", agents: 0,
  editFail: 0, parseFail: 0, loops: 0, editTries: 0,
};

// 한 라운드의 MCC_HOME(runs.jsonl 격리 디렉터리)에서 모든 레코드를 집계한다.
// 서브에이전트 레코드(role=sub:*)도 포함 — critic 라운드가 더 이상 no-record가 아니다.
export function aggregateHome(home: string): RoundMech {
  let recs: any[] = [];
  try {
    recs = readFileSync(join(home, "runs.jsonl"), "utf-8")
      .trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    /* 파일 없음 = no-record */
  }
  if (!recs.length) return { ...EMPTY };

  const m: RoundMech = {
    steps: 0,
    outcome: recs[recs.length - 1].outcome ?? "?",
    agents: recs.length,
    editFail: 0, parseFail: 0, loops: 0, editTries: 0,
  };
  for (const r of recs) {
    m.steps! += r.steps ?? 0;
    m.editTries += (r.tools?.edit_file ?? 0) + (r.tools?.patch_ast_node ?? 0);
    for (const e of r.errors ?? []) {
      const k = classifyError(String(e));
      if (k === "edit") m.editFail++;
      else if (k === "parse") m.parseFail++;
      else if (k === "loop") m.loops++;
    }
  }
  return m;
}
