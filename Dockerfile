# mini-claude-code 격리 실행용 이미지
# 에이전트가 임의 명령을 실행하므로, 컨테이너로 호스트와 격리한다.
FROM node:22-bookworm-slim

# 에이전트가 생성 코드를 테스트할 때 필요한 최소 도구 (git/python3/bash)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 하네스 빌드 (/app)
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 비루트 사용자 + 작업 디렉터리(/work). 에이전트는 /work 안에서만 파일을 만든다.
RUN useradd -m -u 1001 agent \
 && mkdir -p /work /home/agent/.mcc \
 && chown -R agent:agent /work /app /home/agent
USER agent
WORKDIR /work

# 모델 서버 주소는 실행 시 -e 로 주입 (예: http://192.168.1.50:8080/v1)
ENV MCC_HOME=/home/agent/.mcc \
    MCC_BASE_URL=http://host.docker.internal:8080/v1

# 작업 루트(process.cwd())가 /work 가 되도록 여기서 실행
ENTRYPOINT ["node", "/app/dist/index.js"]
