---
name: git-commit
description: 변경사항을 분석해 Conventional Commits 형식의 깔끔한 커밋 메시지를 작성하고 커밋한다.
---

# Git Commit 스킬

다음 절차를 따른다:

1. `git status`와 `git diff --staged`(스테이징 안 됐으면 `git diff`)를 run_command로 실행해 변경 내용을 파악한다.
2. 변경을 논리 단위로 묶고, Conventional Commits 형식으로 메시지를 만든다:
   - `feat: ...` 새 기능 / `fix: ...` 버그수정 / `docs:` 문서 / `refactor:` / `test:` / `chore:`
   - 제목은 50자 이내, 명령형. 필요하면 본문에 '왜'를 한두 줄.
3. 스테이징되지 않았으면 `git add -A` 후, `git commit -m "<message>"`로 커밋한다.
4. 마지막에 만든 커밋 메시지를 사용자에게 보고한다.
