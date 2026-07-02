---
name: gameplay-implementation
description: 2D 웹게임을 Vanilla HTML/CSS/JS로 구현하는 방법(게임 루프·입력·충돌·상태머신·파일 분리). 게임 코드 구현, 캔버스 게임 만들기, 게임 로직/물리/충돌 구현이 필요할 때 반드시 이 스킬을 사용할 것. gameplay-programmer 에이전트 전용.
---

# Gameplay Implementation

동작하지 않는 게임 코드는 미완성이다. **실제로 플레이되는 것**이 목표다.

## 파일 구조 (분리 필수)
```
game/
├── index.html   ← 캔버스 + 스크립트 로드
├── style.css    ← 레이아웃
└── game.js      ← 로직 (커지면 input.js/entities.js/render.js로 분리)
```
한 파일에 몰아넣지 않는다 — 큰 단일 출력은 도중에 깨진다.

## 게임 루프 (고정 타임스텝)
프레임레이트와 물리를 분리해 일관성을 확보한다:
```js
let last = performance.now(), acc = 0; const STEP = 1000/60;
function frame(now){ acc += now - last; last = now;
  while (acc >= STEP){ update(STEP/1000); acc -= STEP; }
  render(); requestAnimationFrame(frame);
}
```

## 입력
키 상태를 객체로 관리(`keydown`→true, `keyup`→false)하고, update에서 그 상태를 읽는다. 이벤트에서 직접 이동시키지 않는다(끊김 방지).

## 상태 머신 (FSM)
`title → playing → gameover` 같은 상태를 변수 하나로 관리하고, update/render를 상태별로 분기한다. 흐름 이탈을 막는다.

## 충돌
2D는 보통 AABB(사각형 겹침)면 충분하다. 원형이 필요하면 거리 비교.

## 원칙 (왜)
- **파일 분리·고정 타임스텝·FSM**: 로컬 모델의 큰-출력 붕괴와 프레임 의존 버그, 흐름 이탈을 구조적으로 막는다.
- **게으름 금지**: TODO·빈 함수·"여기 구현"은 미완성이다. 요청 기능은 실제로 채운다.
- **검증 후 보고**: 실행해서 콘솔 에러가 없는지 확인한 뒤 보고한다. 안 돌려본 코드는 믿지 않는다.
