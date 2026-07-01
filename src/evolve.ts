// 사용 델타 되먹임(evolve): 실행 로그를 수집·분석해 하네스가 스스로 개선하도록 한다.
//
// 루프:
//   1) 매 작업 후 실행 기록(목표·도구사용·오류·재시도·결과)을 runs.jsonl에 누적
//   2) /evolve 시 최근 기록(델타)을 LLM이 반성 → 반복 실패/비효율에서 '교훈' 도출
//   3) 사용자 승인 후 learnings.md에 누적 (버전 백업)
//   4) 다음 세션부터 learnings.md가 시스템 프롬프트에 주입되어 행동 개선
//
// 주의: 자기수정은 드리프트 위험이 있어 '승인 게이트 + .bak 백업'을 둔다.
import {
  appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import { config } from "./config.js";
import { rl } from "./io.js";

const mccDir = process.env.MCC_HOME ?? join(homedir(), ".mcc");
const runsFile = join(mccDir, "runs.jsonl");
const learningsFile = join(mccDir, "learnings.md");
const evolveStateFile = join(mccDir, "evolve_state.json"); // 이미 분석한 실행 수(워터마크)

export interface RunRecord {
  ts: string;
  goal: string;
  steps: number;
  tools: Record<string, number>;
  errors: string[];
  rejections: number;
  outcome: string;
}

// 한 작업의 실행 기록을 누적 (델타 수집)
export function logRun(r: RunRecord): void {
  try {
    mkdirSync(mccDir, { recursive: true });
    appendFileSync(runsFile, JSON.stringify(r) + "\n", "utf-8");
  } catch {
    /* 로깅 실패는 무시 (작업 흐름을 막지 않음) */
  }
}

// 누적된 교훈을 로드 (시스템 프롬프트 주입용)
export function loadLearnings(): string {
  try {
    return existsSync(learningsFile) ? readFileSync(learningsFile, "utf-8").trim() : "";
  } catch {
    return "";
  }
}

// 전체 실행 기록 (워터마크 비교용)
function allRuns(): RunRecord[] {
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

// 워터마크: 지난번 /evolve가 분석한 실행 수 (같은 데이터 재분석 방지)
function loadProcessed(): number {
  try {
    return JSON.parse(readFileSync(evolveStateFile, "utf-8")).processedRuns ?? 0;
  } catch {
    return 0;
  }
}
function saveProcessed(n: number): void {
  try {
    mkdirSync(mccDir, { recursive: true });
    writeFileSync(evolveStateFile, JSON.stringify({ processedRuns: n }), "utf-8");
  } catch {
    /* 무시 */
  }
}

// 의미 기준 중복 제거(프로그램적): 문자 3-gram 자카드 유사도.
// 한국어는 조사 변화(old_string의 vs old_string은)로 단어 토큰이 어긋나므로 문자 n-gram이 더 견고하다.
function charGrams(s: string, n = 3): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const set = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
  return set;
}
// 겹침 계수(overlap coefficient): 작은 쪽이 얼마나 덮이는지 — 길이 차가 큰 재탕에 강함.
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}
function isDuplicate(candidate: string, existing: string[]): boolean {
  const cg = charGrams(candidate);
  return existing.some((e) => overlap(cg, charGrams(e)) >= 0.4);
}

const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

// /evolve: '지난번 이후의 새 실행'만 분석하고, 제안을 기존 교훈과 중복 제거 후 반영.
export async function evolve(): Promise<void> {
  const all = allRuns();
  const processed = loadProcessed();
  const fresh = all.slice(processed); // 워터마크 이후의 새 실행만

  if (fresh.length < 3) {
    console.log(
      `분석할 새 실행이 부족합니다(지난 /evolve 이후 ${fresh.length}건). ` +
        `작업을 더 수행한 뒤 다시 실행하세요. (전체 ${all.length}건 중 ${processed}건 분석 완료)\n`
    );
    return;
  }

  const deltaSummary = fresh
    .map((r) => {
      const base = `- 목표:${r.goal} | 스텝 ${r.steps} | 도구 ${JSON.stringify(r.tools)} | 오류 ${r.errors.length} | 거부 ${r.rejections} | 결과 ${r.outcome}`;
      return r.errors.length ? `${base}\n   오류: ${r.errors.slice(0, 3).join(" / ")}` : base;
    })
    .join("\n");

  const current = loadLearnings();

  console.log(`\n🧬 새 실행 ${fresh.length}건(전체 ${all.length})을 분석해 개선점을 도출합니다...\n`);
  let proposal = "";
  try {
    const res = await client.chat.completions.create({
      model: config.model,
      stream: false,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "너는 코딩 에이전트 하네스의 자기개선 분석가다. 아래 '실행 로그'에서 반복되는 실패·비효율 패턴을 찾아, " +
            "다음 작업부터 적용할 '교훈'을 간결한 불릿으로 제안하라. 각 교훈은 일반적이고 실행 가능해야 한다. " +
            "[현재 교훈]에 이미 있는 내용은 절대 다시 제안하지 마라(표현만 바꾼 재탕도 금지). " +
            "정말로 새롭고 추가 가치가 있는 불릿만 출력하고, 없으면 정확히 NONE만 출력하라.",
        },
        {
          role: "user",
          content: `[현재 교훈]\n${current || "(없음)"}\n\n[새 실행 로그(델타)]\n${deltaSummary}`,
        },
      ],
    });
    proposal = (res.choices[0].message.content ?? "").trim();
  } catch (err: any) {
    console.log(`분석 실패: ${String(err?.message ?? err).slice(0, 160)}\n`);
    return; // 분석 실패 시 워터마크 전진 안 함(다음에 다시 시도)
  }

  // 분석에 성공했으면 이 실행들은 '처리됨'으로 표시(같은 데이터 재분석 방지)
  saveProcessed(all.length);

  // 기존 교훈 불릿 파싱
  const existingBullets = current
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  // 제안을 불릿으로 쪼개고, (1)기존과 중복 (2)자기들끼리 중복 제거
  const kept: string[] = [];
  if (proposal && proposal.toUpperCase() !== "NONE") {
    for (const raw of proposal.split("\n")) {
      const b = raw.replace(/^[-*]\s*/, "").trim();
      if (!b || b.toUpperCase() === "NONE") continue;
      if (isDuplicate(b, existingBullets) || isDuplicate(b, kept)) continue; // 중복 탈락
      kept.push(b);
    }
  }

  if (kept.length === 0) {
    console.log("추가할 새 교훈이 없습니다. (기존 교훈과 중복이거나, 새 패턴 없음)\n");
    return;
  }

  console.log("제안된 새 교훈:\n");
  console.log(kept.map((b) => `- ${b}`).join("\n") + "\n");
  const ans = (await rl.question("이 교훈을 LEARNINGS에 추가할까요? (y/n): ")).trim().toLowerCase();
  if (ans !== "y" && ans !== "yes") {
    console.log("취소했습니다.\n");
    return;
  }

  // 버전 백업 후 누적
  mkdirSync(mccDir, { recursive: true });
  if (existsSync(learningsFile)) {
    copyFileSync(learningsFile, `${learningsFile}.${Date.now()}.bak`);
  }
  const header = current || "# LEARNINGS (사용 델타 자동 진화)";
  writeFileSync(learningsFile, `${header}\n${kept.map((b) => `- ${b}`).join("\n")}\n`, "utf-8");

  console.log(`\n✅ LEARNINGS 갱신됨: ${learningsFile}`);
  console.log("   다음 세션부터 시스템 프롬프트에 반영됩니다. (되돌리려면 .bak 파일 복원)\n");
}
