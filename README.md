# mini-claude-code

**로컬 LLM 기반의 미니 에이전트형 코딩 도구.** Claude Code의 핵심인 *에이전트 루프(LLM ↔ 도구 실행 반복)* 를 TypeScript로 직접 구현하고, 로컬 소형 모델의 약점을 보완하는 하네스 엔지니어링을 얹은 학습·실험용 프로젝트입니다.

OpenAI 호환 엔드포인트(llama.cpp · Ollama · vLLM · LM Studio)면 어떤 로컬 모델이든 붙습니다.

---

## 특징

- 🔁 **에이전트 루프** — 자연어 요청 → 도구 호출 → 실행 → 결과 반영을 작업 완료까지 반복 (스트리밍 출력)
- 💬 **챗봇/에이전트 모드 분리** — 순수 대화(도구·루프 없음)와 에이전트를 분리, 기본은 프롬프트 보고 자동 라우팅(`/chat`·`/agent`로 수동 오버라이드, 히스토리 분리)
- 🧰 **도구 세트** — read / write / edit / list / make_dir / glob / grep / run_command / use_skill / **web_search · fetch_url**(브라우저 불필요 웹조사) / **ask_user**(모호할 때 사용자에게 질문)
- 🛡️ **3티어 안전(HITL)** — 위험도별 승인, `rm -rf` 등 파괴적 명령은 자동 허용을 무시하고 강제 확인, 시스템 파괴 명령은 차단
- 🧠 **컨텍스트 관리** — 서버 컨텍스트 한계에 맞춘 자동 압축, 컨텍스트 초과 시 강제 압축 복구
- 🔂 **Ralph 루프** — 자율 반복으로 큰 작업을 점진 수렴(종료/수렴 엔진: 예산·정체감지·타임아웃)
- 🧩 **서브에이전트 & Critic** — Explore/Code/Review 격리 위임, 생성→리뷰→수정 루프
- 🚦 **검증 게이트** — Critic 루프에서 테스트/타입체크(`MCC_VERIFY_CMD`)의 *종료코드*로 성공을 객관 판정. 실패 시 실제 오류를 주고 수정→재검증(리뷰 승인만으로는 통과 못 함)
- 🚀 **git 자율 푸시 + 사전 게이트** — `git push`를 가로채 **비밀 스캔(API 키·토큰·개인키)·강제푸시 금지·기본브랜치 직접푸시 금지·검증 통과**를 확인. *게이트를 통과하면 확인 없이 자율 푸시*, 막히면 이유를 모델에 돌려 고치게 함(우회 escape: `MCC_ALLOW_FORCE`/`MCC_ALLOW_MAIN`)
- 🙋 **모호하면 질문(HITL)** — 갈피를 못 잡으면 `ask_user`로 번호 선택지를 제시해 사용자에게 묻고, 분석마비가 감지되면 죽이지 않고 사용자에게 핸드오프
- 🕐 **현재 시각 인식** — 시스템 클럭을 프롬프트에 주입해, 로컬 모델이 학습 컷오프 기준으로 현재를 미래·가상으로 오인하는 것을 방지(최신 정보는 web_search로 실제 조회)
- 🔎 **LSP 경량 진단** — `write_file`/`edit_file` 직후 그 파일의 문법을 검사해(JS/TS는 TypeScript API, Python·JSON도) 오류를 도구 결과에 즉시 첨부 → 약한 모델이 방금 깨뜨린 것을 바로 보고 수정
- ✂️ **edit_file 회복력** — `old_string`이 공백(들여쓰기/줄바꿈)만 다르면 실제 텍스트에 재매칭해 성공시키고, 못 찾으면 *실제 파일 내용*을 돌려줘 약한 모델의 환각 재시도를 끊음
- 📊 **eval + ablation** — 고정 과제 묶음으로 성공률·스텝·시간을 측정하고, 기능을 껐다 켜(`MCC_ABLATE`) 기여도를 실증(`eval/`)
- 📚 **스킬 시스템** — Anthropic `SKILL.md` 형식 호환, 점진적 공개
- 🎯 **스킬 라우터** — 프롬프트를 읽고 대규모 스킬 라이브러리(harness 등)에서 관련 스킬만 동적 선택(어휘 검색 + 점수 게이트) → 소형 모델의 스킬 과부하 방지
- 🔌 **MCP 클라이언트** — 외부 MCP 서버 도구 연결(Context7·Playwright 등)
- 🧬 **사용 델타 자기개선** — 실행 로그를 분석해 교훈을 누적(`/evolve`)
- 🩹 **로컬 모델 보완** — 반복 붕괴·의도 루프·**스텝 간 분석마비** 감지 후 중단·복구, **삽질 방지 규칙**(값싼 검증 우선·결과 품질 확인·한 접근 커밋), `run_command` **프로세스 트리 종료**(Ctrl+C로 손자 프로세스까지), Windows Git Bash 라우팅

---

## 동작 원리

```
사용자 입력
  → LLM에게 [시스템 프롬프트 + 대화 + 도구 스키마] 전송
  → LLM이 tool_calls 생성 (read_file / edit_file / run_command ...)
  → 하네스가 도구 실행 → 결과를 대화에 추가
  → LLM이 결과 보고 다음 행동 결정 (작업 끝까지 반복)
```

| 모듈 | 역할 |
|---|---|
| `src/agent.ts` | 에이전트 루프 · 스트리밍 · 세션 · 컨텍스트 압축 (핵심) |
| `src/tools.ts` | 도구 스키마 + 실행 로직 |
| `src/io.ts` | 공용 입력 + 권한 확인(`confirm` / `confirmDangerous`) |
| `src/config.ts` | 모델·엔드포인트·예산 설정 |
| `src/dangerous.ts` | 위험 명령 분류기(3티어) |
| `src/loop.ts` | 종료/수렴 엔진(`ConvergenceController`) |
| `src/ralph.ts` · `src/critic.ts` · `src/subagent.ts` | 자율 반복 · 생성-검증 · 서브에이전트 |
| `src/skills.ts` · `src/skill-router.ts` | 스킬 로더 · 프롬프트 기반 동적 스킬 선택(라우터) |
| `src/mcp.ts` · `src/evolve.ts` | MCP · 자기개선 |
| `src/index.ts` | 대화형 CLI |

---

## 빠른 시작

### 1) 로컬 모델 서빙 (OpenAI 호환 엔드포인트)

예) **llama.cpp**:
```bash
./build/bin/llama-server -m <모델>.gguf \
  --host 0.0.0.0 --port 8080 \
  --n-gpu-layers 99 --ctx-size 65536 -fa on --jinja
```
또는 **Ollama**(`http://localhost:11434/v1`), **vLLM**(`:8000/v1`), **LM Studio**(`:1234/v1`).

> 에이전트 코딩에는 tool calling이 안정적인 모델을 권장합니다(예: Qwen Coder, Devstral, Gemma 4 등).

### 2) 설치 & 실행

```bash
npm install

# 작업할 프로젝트 폴더에서 실행 (현재 폴더가 작업 루트가 됨)
MCC_BASE_URL=http://localhost:8080/v1 npm run dev
```

```
👤 > 현재 폴더 구조를 살펴보고 어떤 프로젝트인지 알려줘
👤 > hello.py 만들어서 "Hello" 출력하게 하고 실행해서 확인해줘
```

---

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `MCC_BASE_URL` | `http://localhost:8080/v1` | 추론 서버(OpenAI 호환) 엔드포인트 |
| `MCC_MODEL` | `gemma4` | 모델명 (llama-server는 무시·임의값 OK) |
| `MCC_API_KEY` | `local` | 로컬 서버는 미검증, SDK 요구값 |
| `MCC_CONTEXT_SIZE` | `16384` | **서버 `--ctx-size`와 일치시킬 것** (압축 기준) |
| `MCC_SHELL` | (자동) | run_command 셸 강제 지정 |
| `MCC_SKILLS_DIR` | `<프로젝트>/skills` | 로컬(상시 로드) 스킬 디렉터리 |
| `MCC_SKILL_LIB` | `<프로젝트>/harness/ko` | 대규모 스킬 라이브러리(라우터가 동적 선택). 미존재 시 라우터 비활성 |
| `MCC_SKILL_MIN_SCORE` | `8` | 스킬 라우터 최소 점수(미만이면 '관련 없음'으로 주입 안 함) |
| `MCC_TEMPERATURE` | `0.15` | 샘플링 온도(에이전트 코딩은 결정성 위해 낮게) |
| `MCC_MIN_P` | `0.1` | min_p 꼬리 컷(llama.cpp 확장) — Q4 blur가 뽑는 저확률 외국문자 토큰 억제. `0`이면 끔 |
| `MCC_FREQ_PENALTY` | `0` | frequency_penalty(너무 높으면 파일명 등 정당한 반복이 손상됨 — eval로 0 확정) |
| `MCC_MAX_TOKENS` | `8192` | 한 응답 최대 출력 토큰(너무 작으면 긴 도구 인자가 잘려 JSON 깨짐) |
| `MCC_VERIFY_CMD` | (없음) | Critic 검증 게이트 명령(예: `npx tsc --noEmit && npm test`). 종료코드로 성공 판정 |
| `MCC_REVIEW_PROVIDER` | (없음) | 2티어 검증: 클라우드 리뷰어 프리셋 `gemini`/`openai`/`anthropic` (또는 `MCC_REVIEW_BASE_URL`로 커스텀) |
| `MCC_REVIEW_MODEL` | (없음) | 리뷰어 모델명(예: `gemini-2.5-pro`, `gpt-4o`) — 키·모델 없으면 로컬 모델이 리뷰(기존 동작) |
| `MCC_REVIEW_API_KEY` | (없음) | 리뷰어 API 키. **생성은 로컬 그대로, critic의 리뷰만 클라우드 강모델에 위탁** |
| `MCC_MAX_STEPS` | `25` | 작업당 최대 루프 스텝(대형 일괄 작업은 상향) |
| `MCC_ALLOW_FORCE` | (없음) | `1`이면 `git push --force` 게이트 차단 해제 |
| `MCC_ALLOW_MAIN` | (없음) | `1`이면 `main`/`master` 직접 푸시 게이트 차단 해제 |
| `MCC_ABLATE` | (없음) | 측정용 기능 무력화(쉼표): `antiflail`/`router`/`paralysis`/`skills`/`lsp`/`editfix`/`gitgate` |
| `MCC_HOME` | `~/.mcc` | 런타임 상태 저장(mcp.json·learnings·runs·인덱스 캐시) |

> ⚠️ `MCC_CONTEXT_SIZE`가 서버 실제 컨텍스트보다 크면 400(컨텍스트 초과)이 납니다. 항상 일치시키세요.

---

## 명령어

| 명령 | 설명 |
|---|---|
| (일반 입력) | 현재 모드로 처리 (기본 `auto`: 도구가 필요한지 자동 판단해 에이전트/챗봇 라우팅) |
| `/auto` · `/agent` · `/chat` | 모드 전환 — 자동 판단 / 항상 에이전트(도구+루프) / 도구 없는 순수 대화 |
| `/agent <메시지>` · `/chat <메시지>` | 모드는 그대로 두고 이 한 번만 강제 |
| `/ralph [N\|0] <목표>` | 자율 반복 루프(N=최대횟수, 0=무제한·수렴/시간으로 종료) |
| `/critic <목표>` | 생성→리뷰→수정 루프 |
| `/skills` | 로드된 스킬 목록 |
| `/evolve` | 실행 로그 분석 → 교훈 도출(자기개선) |
| `/mcp` | 연결된 MCP 도구 목록 |
| `exit` | 종료 |

---

## 안전 정책 (HITL)

`run_command`의 모든 명령은 위험도에 따라 통제됩니다.

| 티어 | 예시 | 처리 |
|---|---|---|
| 일반 | `ls`, `npm test`, `git status`, `git commit` | y / n / a 확인 (`a`=이후 자동 허용) |
| 🚨 DANGER | `rm -rf <dir>`, `git push --force`, `git reset --hard`, `sudo`, `curl\|bash` | **approve-all 무시**, `yes` 직접 입력해야 실행 |
| 🛑 BLOCK | `rm -rf /`, `dd of=/dev/sda`, `mkfs`, 포크 폭탄 | 실행 거부 |

작업 디렉터리 밖 파일 접근도 차단됩니다(`safePath`).

> ⚠️ 분류기는 정규식 휴리스틱이라 **심층 방어이지 샌드박스가 아닙니다.** 신뢰할 수 없는 입력·프로덕션에서는 컨테이너 격리를 사용하세요 → [CONTAINER.md](CONTAINER.md)

---

## 스킬 (Skills)

Anthropic `SKILL.md` 형식 호환. **로컬 스킬**은 `<프로젝트>/skills/<name>/SKILL.md` 에 폴더를 넣으면 인식됩니다.

- **점진적 공개**: 시작 시 (name, description)만 노출 → 모델이 `use_skill("이름")`을 부르면 전체 지침 로드
- 형식:
  ```markdown
  ---
  name: skill-name
  description: 이 스킬이 무엇을 하는지 한 줄 (트리거·검색 판단용)
  ---
  # 지침 본문
  ```

### 스킬 라우터 (대규모 라이브러리)

로컬 스킬(상시 로드)과 별개로, 수백 개짜리 스킬 라이브러리(`<프로젝트>/harness/ko` 등)를 두면 **매 작업마다 프롬프트를 읽고 관련 스킬만 골라** 노출합니다.

- 전부 주입하면 소형 모델이 스킬 과부하로 붕괴하므로, **어휘 검색 + 점수 게이트**로 상위 몇 개만 선택
- 점수가 임계(`MCC_SKILL_MIN_SCORE`) 미만이면 "관련 스킬 없음"으로 보고 아무것도 주입하지 않음(오도 방지)
- 선택된 스킬도 본문은 `use_skill`로 로드 → 로컬 스킬과 동일 경로
- 포함 라이브러리 예: [revfactory/harness](https://github.com/revfactory/harness)(Apache-2.0)의 한국어 스킬 세트

> `run_command`는 취소(Ctrl+C)·타임아웃 시 **자식 프로세스 트리 전체**를 종료합니다(Windows `taskkill /T`, POSIX 프로세스 그룹) — 셸이 띄운 서버·손자 프로세스가 고아로 남지 않도록.

## MCP (Model Context Protocol)

외부 MCP 서버 도구를 `mcp__<서버>__<도구>` 로 노출. 설정 `~/.mcc/mcp.json`:
```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
  }
}
```
시작 시 자동 연결, `/mcp`로 확인. 미설정/실패 시 조용히 비활성화됩니다.

---

## 고급: 자율 워크플로우

- **Ralph 루프** — 매 반복 컨텍스트를 리셋하고 상태는 `PROGRESS.md`로 인계. 종료는 완료 신호·정체(파일 무변경)·시간 예산으로 판단(`src/loop.ts`).
- **Critic 루프** — `code` 구현 → **검증 게이트**(`MCC_VERIFY_CMD` 종료코드) → `review` 검토 → 실패 시 실제 오류/피드백으로 수정 반복. 검증 통과 + `APPROVED`라야 성공(`src/critic.ts`).
- **서브에이전트** — `explore`(읽기전용, 웹조사 가능)/`code`/`review`를 격리 컨텍스트로 위임. 통신은 공유 파일시스템.
- **HITL 에스컬레이션** — 모델이 모호할 때 `ask_user`로 사용자에게 번호 선택지를 묻고, 스텝 간 분석마비가 감지되면(같은 사고 반복) 자동으로 사용자에게 진행/중단을 물어봄.
- **/evolve** — `~/.mcc/runs.jsonl`의 실행 델타를 분석해 교훈을 `~/.mcc/learnings.md`에 누적, 다음 세션 프롬프트에 주입.

---

## 한계

- 로컬 소형 모델은 멀티스텝 자율 작업에서 한계가 있습니다. 본 하네스의 보완 장치(압축·반복 감지·수렴 엔진·HITL)는 그 약점을 줄이지만 완전히 없애지는 못합니다.
- 위험 명령 분류기는 샌드박스가 아닙니다(우회 가능). 격리가 필요하면 컨테이너로 실행하세요.
- 멀티모달(비전) 입력 경로는 아직 하네스에 연결되지 않았습니다.

---

## 라이선스

MIT
