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

function recentRuns(n: number): RunRecord[] {
  if (!existsSync(runsFile)) return [];
  return readFileSync(runsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l) as RunRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r !== null);
}

const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

// /evolve: 최근 실행 로그를 분석해 새 교훈을 제안하고, 승인 시 learnings.md에 반영.
export async function evolve(): Promise<void> {
  const runs = recentRuns(50);
  if (runs.length < 3) {
    console.log(`평가할 실행 기록이 부족합니다(${runs.length}건). 작업을 더 수행한 뒤 /evolve를 다시 실행하세요.\n`);
    return;
  }

  const deltaSummary = runs
    .map((r) => {
      const base = `- 목표:${r.goal} | 스텝 ${r.steps} | 도구 ${JSON.stringify(r.tools)} | 오류 ${r.errors.length} | 거부 ${r.rejections} | 결과 ${r.outcome}`;
      return r.errors.length ? `${base}\n   오류: ${r.errors.slice(0, 3).join(" / ")}` : base;
    })
    .join("\n");

  const current = loadLearnings();

  console.log(`\n🧬 최근 실행 ${runs.length}건을 분석해 개선점을 도출합니다...\n`);
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
            "다음 작업부터 적용할 '교훈'을 간결한 불릿으로 제안하라. 각 교훈은 일반적이고 실행 가능해야 한다 " +
            "(예: '윈도우에서는 python3 대신 python을 쓴다', '큰 파일은 처음부터 여러 파일로 분리한다'). " +
            "이미 있는 교훈과 중복되면 빼라. 새로 추가할 불릿만 출력하고, 추가할 게 없으면 정확히 NONE만 출력하라.",
        },
        {
          role: "user",
          content: `[현재 교훈]\n${current || "(없음)"}\n\n[최근 실행 로그(델타)]\n${deltaSummary}`,
        },
      ],
    });
    proposal = (res.choices[0].message.content ?? "").trim();
  } catch (err: any) {
    console.log(`분석 실패: ${String(err?.message ?? err).slice(0, 160)}\n`);
    return;
  }

  if (!proposal || proposal.toUpperCase() === "NONE") {
    console.log("추가할 교훈이 없습니다. 하네스가 이미 잘 동작 중이거나 데이터가 부족합니다.\n");
    return;
  }

  console.log("제안된 새 교훈:\n");
  console.log(proposal + "\n");
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
  const existing = current || "# LEARNINGS (사용 델타 자동 진화)";
  const bullets = proposal
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("-") ? l : `- ${l}`));
  writeFileSync(learningsFile, `${existing}\n${bullets.join("\n")}\n`, "utf-8");

  console.log(`\n✅ LEARNINGS 갱신됨: ${learningsFile}`);
  console.log("   다음 세션부터 시스템 프롬프트에 반영됩니다. (되돌리려면 .bak 파일 복원)\n");
}
