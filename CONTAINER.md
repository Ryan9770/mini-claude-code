# 컨테이너 격리 실행 가이드

`mini-claude-code`는 에이전트가 **임의의 셸 명령을 실행**합니다. `src/dangerous.ts`의 HITL 분류기는
명백한 파괴적 명령을 잡지만, **정규식 휴리스틱이라 우회가 가능**합니다(변수 확장·base64·별칭 등).

> **진짜 격리는 "에이전트가 무엇을 하든 호스트가 안전한" 상태입니다.** 그 답은 컨테이너/VM입니다.
> 에이전트가 `rm -rf /`를 우회해 실행해도 **컨테이너만 파괴되고 호스트는 멀쩡**합니다.

---

## 왜 컨테이너인가

| 위협 | 호스트 직접 실행 | 컨테이너 실행 |
|---|---|---|
| `rm -rf /` 우회 | 호스트 파일 삭제 💥 | 컨테이너만 영향, 재생성하면 끝 |
| 호스트 파일 탐색 | 전체 디스크 접근 | 마운트한 `/work`만 보임 |
| 자원 폭주(포크폭탄 등) | 호스트 마비 | `pids_limit`/`mem_limit`로 제한 |
| 권한 상승(sudo) | 시스템 장악 가능 | `cap_drop`/`no-new-privileges`로 차단 |
| 데이터 유출(curl) | 호스트 자격증명 접근 | 네트워크/마운트 최소화로 완화 |

---

## 빠른 시작 (docker compose)

```bash
# 1) 작업 폴더 준비 (에이전트 결과가 여기에만 쌓임)
mkdir -p workspace

# 2) docker-compose.yml 의 MCC_BASE_URL 을 Spark 주소로 수정
#    예: http://192.168.1.50:8080/v1

# 3) 빌드 + 대화형 실행 (run 사용 — up 아님!)
docker compose run --rm mcc
```

`run --rm`은 종료 시 컨테이너를 자동 삭제합니다. 대화형 CLI라 `up`이 아니라 `run`(또는 `-it`)을 써야 합니다.

---

## 빠른 시작 (docker 단독)

```bash
# 빌드
docker build -t mini-claude-code .

# 실행 (대화형 -it 필수)
docker run --rm -it \
  -e MCC_BASE_URL="http://192.168.1.50:8080/v1" \
  -e MCC_MODEL="gemma4" \
  -v "$(pwd)/workspace:/work" \
  -v "$HOME/.mcc:/home/agent/.mcc" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 8g --pids-limit 512 \
  mini-claude-code
```

---

## 모델 서버 연결 주의

하네스는 컨테이너 안, **모델(llama-server)은 Spark**에 있으므로 컨테이너에서 그 주소에 도달해야 합니다.

- **Spark의 실제 LAN IP 사용** (권장): `MCC_BASE_URL=http://192.168.1.50:8080/v1`
  - llama-server를 `--host 0.0.0.0`으로 띄워야 외부에서 접근 가능 (이미 그렇게 실행 중).
- **하네스와 모델이 같은 호스트**일 때: 컨테이너에서 호스트는 `localhost`가 아니라
  - Linux: `--add-host=host.docker.internal:host-gateway` 후 `http://host.docker.internal:8080/v1`
  - Docker Desktop(Mac/Win): `http://host.docker.internal:8080/v1` 기본 동작

연결 확인:
```bash
docker run --rm mini-claude-code node -e "fetch(process.env.MCC_BASE_URL.replace('/v1','')+'/health').then(r=>r.text()).then(t=>console.log('OK',t)).catch(e=>console.log('FAIL',e.message))"
```

---

## 하드닝 단계 (위협 수준에 맞춰 선택)

### 기본 (compose에 이미 포함)
- `cap_drop: ALL` — 리눅스 capability 전부 제거
- `no-new-privileges` — setuid 등 권한 상승 차단
- `mem_limit` / `pids_limit` — 자원 폭주·포크폭탄 완화
- 비루트 사용자(`agent`, uid 1001)로 실행

### 강화: 읽기 전용 루트 + tmpfs
컨테이너 파일시스템 자체를 읽기 전용으로:
```yaml
read_only: true
tmpfs: ["/tmp", "/home/agent/.npm", "/work"]   # 쓰기 필요한 곳만 tmpfs
```
단, `/work`를 tmpfs로 하면 결과가 호스트에 남지 않습니다. 결과 보존이 필요하면 `/work`는 볼륨 유지.

### 강화: 네트워크 차단 (데이터 유출 방지)
에이전트가 외부로 데이터를 보내지 못하게 하되, 모델 서버만 허용하려면:
```bash
# 완전 차단 (단, 이러면 Spark 모델에도 못 감 → 모델이 같은 네트워크일 때만)
docker run --network none ...

# 권장: 전용 네트워크 + egress 방화벽으로 모델 서버 IP만 허용 (고급)
```
> 모델이 원격(Spark)이면 네트워크를 완전히 끊을 수 없으므로, **egress를 모델 서버 IP:포트로만 제한**하는 방화벽 규칙이 현실적인 절충입니다.

### 최강: VM 격리
컨테이너는 커널을 호스트와 공유합니다. 커널 취약점까지 방어하려면
**gVisor(`--runtime=runsc`)** 또는 **전용 VM**(예: Spark에 격리 사용자/경량 VM)을 사용하세요.

---

## 컨테이너 안에서 권한 프롬프트는 어떻게?

`-it`로 실행하면 컨테이너 안의 CLI가 호스트 터미널에 그대로 연결되어,
`y/n/a` 및 위험 명령의 `yes` 확인이 **평소처럼 동작**합니다. 즉 **HITL + 컨테이너 격리를 동시에** 얻습니다.

자동화(무인) 실행이라 프롬프트를 받을 수 없다면, 그때야말로 컨테이너 격리가 **유일한 안전장치**이므로
하드닝(읽기전용·네트워크 제한·자원 제한)을 반드시 함께 적용하세요.

---

## 요약

- **개발·실험**: 호스트 직접 실행 + HITL 분류기로 충분 (편리)
- **신뢰 불가 입력 / 자율 무인 실행 / 프로덕션**: 컨테이너 격리 필수
  ```bash
  docker compose run --rm mcc
  ```
- **최고 보안**: 컨테이너 + 읽기전용 + egress 제한 + gVisor/VM
