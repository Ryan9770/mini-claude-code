# 결정판 기준선: ROUNDS=3 × (풀 하네스 → 하네스 OFF) 순차 실행 (PowerShell용)
# GPU가 하나라 반드시 순차로 돌린다(동시 실행 시 시간 수치 오염).
# 사용: powershell -ExecutionPolicy Bypass -File eval\baseline.ps1
#   또는 PS 창에서: .\eval\baseline.ps1
Set-Location (Join-Path $PSScriptRoot "..")

if (-not $env:MCC_BASE_URL)     { $env:MCC_BASE_URL     = "http://10.1.10.111:8080/v1" }
if (-not $env:MCC_CONTEXT_SIZE) { $env:MCC_CONTEXT_SIZE = "32768" }
if (-not $env:ROUNDS)           { $env:ROUNDS           = "3" }

New-Item -ItemType Directory -Force eval\.runs | Out-Null

Write-Host "=== [1/2] FULL HARNESS (ROUNDS=$($env:ROUNDS)) ==="
$env:MCC_ABLATE = ""
npx tsx eval/run.ts *> eval\.runs\night-full.log
Get-Content eval\.runs\night-full.log -Tail 12

Write-Host ""
Write-Host "=== [2/2] ABLATED: antiflail,router,paralysis,skills (ROUNDS=$($env:ROUNDS)) ==="
$env:MCC_ABLATE = "antiflail,router,paralysis,skills"
npx tsx eval/run.ts *> eval\.runs\night-ablate.log
Get-Content eval\.runs\night-ablate.log -Tail 12

Write-Host ""
Write-Host "완료 — 상세 로그: eval\.runs\night-full.log, night-ablate.log"
