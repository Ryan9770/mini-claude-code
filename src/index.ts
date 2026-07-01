#!/usr/bin/env node
// 미니 클로드 코드 — 대화형 CLI 진입점
import { config } from "./config.js";
import { runAgent, addMainTools } from "./agent.js";
import { ralphLoop } from "./ralph.js";
import { buildWithCritic } from "./critic.js";
import { getSkills, skillsDir } from "./skills.js";
import { buildIndex, skillLibDir } from "./skill-router.js";
import { evolve } from "./evolve.js";
import { initMcp, getMcpTools, mcpServerInfo, closeMcp } from "./mcp.js";
import { rl, beginAbortable, endAbortable, requestAbort } from "./io.js";

let busy = false; // 작업 실행 중인지
let lastInterrupt = 0; // 동시 중복 SIGINT(같은 Ctrl+C가 rl+process 둘 다 깨우는 것) 무시용

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

  console.log(`  명령: /ralph | /critic | /skills | /evolve | /mcp | exit  (작업 중 Ctrl+C=취소)\n`);

  while (true) {
    let input: string;
    try {
      input = (await rl.question("👤 > ")).trim();
    } catch {
      break; // EOF(Ctrl+D)·입력 스트림 종료 시 깔끔하게 종료
    }
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    try {
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
      busy = true;
      beginAbortable();
      try {
        await runAgent(input);
      } finally {
        busy = false;
        endAbortable();
      }
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
