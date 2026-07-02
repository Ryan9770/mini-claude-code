#!/usr/bin/env bash
# 결정판 기준선: ROUNDS=3 × (풀 하네스 → 하네스 OFF) 순차 실행.
# GPU가 하나라 반드시 순차로 돌린다(동시 실행 시 시간 수치 오염).
# 사용: bash eval/baseline.sh   (Git Bash / WSL / 리눅스)
set -u
cd "$(dirname "$0")/.."

export MCC_BASE_URL="${MCC_BASE_URL:-http://10.1.10.111:8080/v1}"
export MCC_CONTEXT_SIZE="${MCC_CONTEXT_SIZE:-32768}"
export ROUNDS="${ROUNDS:-3}"

mkdir -p eval/.runs

echo "=== [1/2] FULL HARNESS (ROUNDS=$ROUNDS) ==="
MCC_ABLATE= npx tsx eval/run.ts > eval/.runs/night-full.log 2>&1
tail -12 eval/.runs/night-full.log

echo
echo "=== [2/2] ABLATED: antiflail,router,paralysis,skills (ROUNDS=$ROUNDS) ==="
MCC_ABLATE=antiflail,router,paralysis,skills npx tsx eval/run.ts > eval/.runs/night-ablate.log 2>&1
tail -12 eval/.runs/night-ablate.log

echo
echo "완료 — 상세 로그: eval/.runs/night-full.log, night-ablate.log"
