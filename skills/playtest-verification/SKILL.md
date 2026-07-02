---
name: playtest-verification
description: 헤드리스 브라우저(Playwright)로 게임을 실제 실행·조작해 검증하는 방법. 게임 플레이테스트, 게임 QA, 동작 검증, "게임이 실제로 되는지 확인/테스트"가 필요할 때 반드시 이 스킬을 사용할 것. playtester 에이전트 전용.
---

# Playtest Verification

검증의 핵심은 "코드가 있다"가 아니라 "**실제로 플레이된다**"를 확인하는 것이다. 코드 읽기로 통과시키지 않는다.

## 검증 절차 (Playwright 헤드리스)

1. **로딩**: 페이지를 띄우고 캔버스/요소가 렌더되는지 확인.
2. **콘솔 에러 = 실패**: `page.on('console')`/`page.on('pageerror')`로 에러를 수집. 하나라도 있으면 blocker.
3. **입력 시뮬레이션**: `page.keyboard.press/down`, `page.mouse`로 조작을 보내 플레이어 반응을 확인.
4. **승패 도달성**: 명세의 승리/패배 조건에 실제로 도달 가능한지 시도(도달 불가 = 치명적).
5. **스크린샷**: `page.screenshot()`으로 시각 증거를 남긴다.

## 최소 검증 스크립트 골격
```js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type()==='error' && errors.push(m.text()));
  await p.goto('file:///절대경로/index.html');
  await p.waitForTimeout(500);
  await p.keyboard.press('Space');           // 입력 반영 확인
  await p.screenshot({ path: 'playtest.png' });
  console.log(errors.length ? 'FAIL: '+errors.join(' | ') : 'no console errors');
  await b.close();
})();
```

## 출력 (`_workspace/{phase}_playtest_report.md`)
- 체크리스트(로딩/콘솔/입력/승패/시각) 결과
- 버그: `번호. [blocker/major/minor] 재현 단계 — 증상`
- 스크린샷 경로
- 문제 없으면 마지막 줄에 정확히 `PLAYABLE`

## 원칙 (왜)
- **실제 실행**: LLM이 만든 게임은 "그럴듯하지만 안 도는" 경우가 많다. 실행만이 진실을 말한다.
- **콘솔 에러 무관용**: 조용한 JS 에러가 게임을 멈춘다. 에러 0이 기본선.
- **증거 첨부**: 스크린샷이 있어야 통과/실패를 사람이 재확인한다.
