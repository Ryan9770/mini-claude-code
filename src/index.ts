#!/usr/bin/env node
// 미니 클로드 코드 — 대화형 CLI 진입점
import { config } from "./config.js";
import { runAgent, runChat, classifyIntent, classifyAgentTask, addMainTools } from "./agent.js";
import { ralphLoop } from "./ralph.js";
import { buildWithCritic } from "./critic.js";
import { getSkills, getSkillBody, skillsDir } from "./skills.js";
import { buildIndex, skillLibDir, getLibrarySkillBody } from "./skill-router.js";
import { evolve } from "./evolve.js";
import { initMcp, getMcpTools, mcpServerInfo, closeMcp } from "./mcp.js";
import { rl, beginAbortable, endAbortable, requestAbort } from "./io.js";

let busy = false; // 작업 실행 중인지
let lastInterrupt = 0; // 동시 중복 SIGINT(같은 Ctrl+C가 rl+process 둘 다 깨우는 것) 무시용
let mode: "auto" | "agent" | "chat" = "auto"; // 입력 라우팅: 자동 판단 / 강제 에이전트 / 강제 챗봇

// 입력을 대상 모드로 실행(취소·busy 처리 공통). chat=도구 없는 단발 대화, agent=에이전트 루프.
async function runRouted(input: string, target: "agent" | "chat"): Promise<void> {
  if (!input) return;
  busy = true;
  beginAbortable();
  try {
    if (target === "chat") await runChat(input);
    else {
      // 코드 수정·구현 요청은 critic 루프(컨텍스트 격리)로 — 증명된 레버를 기본 경로로.
      // 조회·검색·배치·단순 파일작업은 plain(빠름) 유지. MCC_AGENT_ROUTE로 강제 가능.
      const route = classifyAgentTask(input);
      if (route === "critic") {
        console.log("  🔬 라우팅 → critic 루프(격리된 구현→리뷰→수정)");
        await buildWithCritic(input);
      } else {
        await runAgent(input);
      }
    }
  } finally {
    busy = false;
    endAbortable();
  }
}

// Ctrl+C: 작업 중이면 그 작업만 취소, 유휴면 종료. (rl과 process 양쪽에 걸어 어느 상태든 잡음)
function onInterrupt() {
  const now = Date.now();
  if (now - lastInterrupt < 400) return; // 한 번의 입력이 두 핸들러를 깨운 경우 1회만 처리
  lastInterrupt = now;
  if (busy && requestAbort()) {
    console.log("\n⛔ 현재 작업을 취소합니다... (잠시 후 프롬프트로 복귀)");
  } else {
    rl.close();
    void closeMcp().finally(() => {
      console.log("\n종료합니다. 👋");
      process.exit(0);
    });
  }
}

async function main() {
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  console.log("┌─────────────────────────────────────────┐");
  console.log("│   mini-claude-code (local LLM agent)     │");
  console.log("└─────────────────────────────────────────┘");
  console.log(`  model   : ${config.model}`);
  console.log(`  endpoint: ${config.baseURL}`);
  console.log(`  workdir : ${config.workdir}`);
  console.log(`  skills  : ${getSkills().length}개 로드됨 (${skillsDir()})`);
  const lib = skillLibDir();
  if (lib) console.log(`  router  : 라이브러리 ${buildIndex().length}개 스킬 인덱싱됨 → 프롬프트별 동적 선택 (${lib})`);

  // MCP 서버 연결 → 도구를 메인 세션에 병합
  const mcp = await initMcp();
  addMainTools(getMcpTools());
  if (mcp.servers) console.log(`  mcp     : ${mcp.servers}개 서버, ${mcp.tools}개 도구`);

  console.log(`  모드: /auto(기본) · /agent · /chat  — 현재: ${mode}  (/chat <메시지> = 단발 강제)`);
  console.log(`  명령: /ralph | /critic | /skills | /evolve | /mcp | exit  (작업 중 Ctrl+C=취소)`);
  console.log(`  스킬: /<스킬명> [요청]  — 스킬 직접 발동 (예: /ml-experiment 분류 모델 실험)  (/skills=목록)\n`);

  while (true) {
    let input: string;
    try {
      input = (await rl.question(`👤(${mode}) > `)).trim();
    } catch {
      break; // EOF(Ctrl+D)·입력 스트림 종료 시 깔끔하게 종료
    }
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    try {
      // ── 모드 전환(스티키) ──
      if (input === "/auto") { mode = "auto"; console.log("🔀 모드: auto — 프롬프트를 보고 자동 판단\n"); continue; }
      if (input === "/agent") { mode = "agent"; console.log("🔀 모드: agent — 항상 에이전트(도구+루프)\n"); continue; }
      if (input === "/chat") { mode = "chat"; console.log("🔀 모드: chat — 도구 없는 순수 대화\n"); continue; }
      // ── 단발 강제(모드는 그대로): /agent <메시지> · /chat <메시지> ──
      if (input.startsWith("/agent ")) { await runRouted(input.slice(7).trim(), "agent"); continue; }
      if (input.startsWith("/chat ")) { await runRouted(input.slice(6).trim(), "chat"); continue; }

      if (input === "/evolve") {
        await evolve();
        continue;
      }
      if (input === "/mcp") {
        const info = mcpServerInfo();
        if (!info.tools) {
          console.log(`연결된 MCP 도구 없음. ${skillsDir().replace(/skills$/, "mcp.json")} 에 서버를 설정하세요.`);
        } else {
          console.log(`MCP 도구 ${info.tools}개:`);
          for (const n of info.names) console.log(`  - ${n}`);
        }
        continue;
      }
      if (input.startsWith("/critic")) {
        const goal = input.slice("/critic".length).trim();
        if (!goal) {
          console.log("사용법: /critic <목표>  (구현→리뷰→수정 루프)");
          continue;
        }
        console.log("⚠️  자율 루프입니다. 승인 프롬프트에서 'a'를 누르면 끊김 없이 진행됩니다. (Ctrl+C=취소)");
        busy = true;
        beginAbortable();
        try {
          await buildWithCritic(goal);
        } finally {
          busy = false;
          endAbortable();
        }
        continue;
      }
      if (input === "/skills") {
        const skills = getSkills();
        if (!skills.length) {
          console.log(`스킬 없음. ${skillsDir()} 에 스킬 폴더(SKILL.md 포함)를 넣으세요.`);
        } else {
          console.log("사용 가능한 스킬:");
          for (const s of skills) console.log(`  - ${s.name}: ${s.description}`);
        }
        continue;
      }
      if (input.startsWith("/ralph")) {
        let rest = input.slice("/ralph".length).trim();
        // 선택: 맨 앞 숫자를 최대 반복 횟수로 해석 (예: /ralph 40 목표...). 0 = 무제한(수렴/시간으로 종료).
        let maxIters: number | undefined;
        const m = rest.match(/^(\d+)\s+(.*)$/s);
        if (m) {
          const n = parseInt(m[1], 10);
          maxIters = n === 0 ? Number.POSITIVE_INFINITY : n;
          rest = m[2];
        }
        if (!rest) {
          console.log("사용법: /ralph [최대반복|0=무제한] <목표>  (예: /ralph 0 workspace에 스네이크 게임 완성)");
          continue;
        }
        console.log("⚠️  자율 루프는 여러 번 파일 변경·명령 실행을 시도합니다. 승인 프롬프트에서 'a'를 누르면 이후 자동 허용됩니다. (Ctrl+C=취소)");
        busy = true;
        beginAbortable();
        try {
          await ralphLoop(rest, maxIters);
        } finally {
          busy = false;
          endAbortable();
        }
        continue;
      }
      // ── 제네릭 스킬 트리거: /<스킬명> [요청] → 해당 스킬을 직접 발동 ──
      // 하네스/로컬 스킬 문서에 '/skill-name으로 트리거'로 안내돼 있으므로 슬래시 강제 발동을 지원한다.
      // (약한 모델이 use_skill을 스스로 고르길 기다리지 않고 확실히 발동 — 오케스트레이터 스킬에 특히 유용)
      if (input.startsWith("/")) {
        const name = input.slice(1).split(/\s+/)[0];
        const rest = input.slice(1 + name.length).trim();
        const body = getSkillBody(name) ?? getLibrarySkillBody(name);
        if (body) {
          const goal = rest || "이 스킬의 목적에 맞는 작업을 시작하라.";
          const prompt =
            `아래 스킬 지침을 그대로 따라 작업을 수행하라.\n\n[스킬: ${name}]\n${body}\n\n[사용자 요청]\n${goal}`;
          console.log(`  🎯 스킬 직접 발동 → ${name}`);
          busy = true;
          beginAbortable();
          try {
            await runAgent(prompt); // 스킬 본문이 오케스트레이션을 지시하므로 plain 에이전트로 실행
          } finally {
            busy = false;
            endAbortable();
          }
          continue;
        }
        console.log(`알 수 없는 명령/스킬: /${name}  — /skills로 로컬 목록 확인 (라이브러리 스킬도 /이름으로 발동 가능)`);
        continue;
      }

      // 일반 입력: auto면 의도 분류로 라우팅, 아니면 지정 모드로.
      const target = mode === "auto" ? await classifyIntent(input) : mode;
      if (mode === "auto") console.log(`  🔀 자동 판단 → ${target}`);
      await runRouted(input, target);
    } catch (err: any) {
      console.error(`\n❌ 에러: ${err.message}`);
      console.error(`   로컬 모델 서버(${config.baseURL})가 실행 중인지 확인하세요.\n`);
    }
  }

  rl.close();
  await closeMcp(); // MCP 자식 프로세스 정리
  console.log("종료합니다. 👋");
  process.exit(0); // 남은 핸들이 있어도 확실히 종료
}

main();
