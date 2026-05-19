# DESIGN.md

이 파일은 `claude-code-monitor`의 **UI/UX 의사결정 로그**입니다.
Notion·Figma 대신 레포 안에서 git 히스토리로 함께 버전관리합니다.

- 채우는 사람: 본인 1명
- 채우는 시점: 화면을 손대기 **전**에 가설을 적고, 손댄 **후**에 결정 로그를 남김
- 빈 칸은 비워두면 됨. 강제 채우기 금지

---

## 1. 제품 한 줄

> Claude Code CLI 세션의 JSONL을 tail해서, 지금 클로드가 **무엇을 보고 무엇을 하고 있는지** 브라우저로 실시간 관찰하는 로컬 단일파일 도구.

핵심 가치: **"클로드의 머릿속을 옆에서 보는 느낌"** — 디버깅·관찰·신뢰 형성.

---

## 2. 현재 UI 인벤토리 (as of 2026-05-12)

### 레이아웃
```
┌─ Header ────────────────────────────────────────┐
│ ● Claude Code Monitor   sess▢   [filter▼] [Clear] [KR/EN] · conn │
├─ Tabs ──────────────────────────────────────────┤
│ [proj1·abc123 ×] [proj2·def456 ×] ...           │
├─ Main ───────────────────────┬─ Side ───────────┤
│                              │ info (stats)     │
│  ── new turn ──              │ ctx-memory       │
│  [user card]                 │ ctx-claude       │
│  [assistant md card]         │ ctx-skills       │
│  [thinking card]             │ tools (count)    │
│  [tool_use collapsible]      │ pinHint          │
│  [tool_result collapsible]   │ tokens           │
│  [skill body md card]        │                  │
└──────────────────────────────┴──────────────────┘
```

### 카드 종류
| 클래스 | 트리거 | 렌더링 |
|---|---|---|
| `user` | 유저 메시지 | 일반 텍스트 + `── new turn ──` 디바이더 선행 |
| `assistant` | 어시스턴트 텍스트 | 마크다운(GFM) |
| `thinking` | extended thinking | 회색조 텍스트 |
| `tool_use` | 툴 호출 | 접힘, 툴 색상 태그(Skill/Bash/Read/Edit/Web/Agent) |
| `tool_result` | 툴 결과 | 접힘, 직전 `tool_use`와 페어 |
| `tool_result-skill` | Skill 본문 | `SKILL.md` 본문을 마크다운 렌더 |

### 사이드바 블록
| ID | 내용 | 출처 |
|---|---|---|
| `info` | 현재 세션 메타(프로젝트, 세션ID 등) | 파일명 + JSONL 첫 줄 |
| `ctx-memory` | 프로젝트 메모리 항목 | `MEMORY.md` 인덱스 |
| `ctx-claude` | 로드된 `CLAUDE.md` 경로 | 시스템 메시지 파싱 |
| `ctx-skills` | 이번 세션에서 호출된 스킬 | tool_use 누적 |
| `tools` | 툴별 호출 횟수 (클릭 시 핀 필터) | tool_use 누적 |
| `tokens` | input/output/cache_read/cache_create 누적 | usage 메타 |

### 필터
- All events
- Skills + memory only
- Conversation + Skills
- Tools only
- Conversation only

### 의존성
- Zero deps. 단일 `monitor.mjs` 855줄. 인라인 `<style>`/`<script>`.

---

## 3. 사용자 시나리오 (1인용)

| 시나리오 | 사용자 행동 | 현재 충족도 |
|---|---|---|
| "지금 클로드가 뭘 하고 있나" | 탭 열고 카드 스트림 보기 | ◎ |
| "방금 호출한 스킬 본문이 뭐였지" | 스킬 카드 펼치기 | ◎ |
| "이 세션 토큰 얼마 썼지" | 사이드바 tokens 확인 | ◎ |
| "Edit만 골라 보고 싶다" | 사이드바 Edit 행 클릭 → 핀 필터 | ◎ |
| "어제 세션 다시 보고 싶다" | — | ✗ (30분 이내만) |
| "어떤 user 메시지가 어떤 결과 냈지" | 턴 디바이더로 구분 | ○ (충분히 명확하진 않음) |
| "여러 세션을 가로질러 비교" | — | ✗ |
| "특정 텍스트 검색" | — | ✗ |
| "결과를 외부에 공유" | — | ✗ |

---

## 4. 다음 화면 가설 (TBD)

> 가설마다 **무엇을·왜·성공기준**만 한 줄씩. 채택 시 결정 로그(섹션 6)로 이동.

### H1. (제목)
- **무엇을:**
- **왜:**
- **성공기준:**
- **상태:** 가설 / 검증중 / 채택 / 폐기

### H2. (제목)
- **무엇을:**
- **왜:**
- **성공기준:**
- **상태:**

### H3. (제목)
- **무엇을:**
- **왜:**
- **성공기준:**
- **상태:**

---

## 5. 디자인 원칙

1. **로컬 온리** — 어떤 데이터도 외부 전송 금지. `localhost` 바인딩만
2. **의존성은 목적이 분명할 때만** — 관찰은 zero-dep, 터미널 통합처럼 우회 불가한 경우에 한해 추가 (`node-pty`, `ws`, `xterm` 등). 추가할 때마다 DESIGN.md 결정 로그에 이유 박제
3. **관찰 + 조작 양립** — 외부에서 띄운 Claude Code 세션은 JSONL tail로 관찰만, 모니터에서 직접 spawn한 세션은 PTY 부착해서 조작도. 두 종류 한 UI에 공존
4. **한 화면 안에서 끝낸다** — 페이지 전환·모달 최소화
5. **클로드의 시점을 그대로** — 시간순·원본순 보존, 임의 재정렬 금지
6. **백엔드 1파일 기조 유지 시도** — `monitor.mjs`는 가능한 한 단일파일. 프론트엔드 자산(xterm bundle 등)은 외부 파일 허용

---

## 6. 결정 로그

> 형식: `날짜 · 결정 · 이유 · 영향받은 영역`

| 날짜 | 결정 | 이유 | 영역 |
|---|---|---|---|
| 2026-05-12 | DESIGN.md를 레포에 둠 | Notion/Figma 없이 git으로 의사결정 박제 | meta |
| 2026-05-18 | Zero-dep / 단일파일 / "관찰만" 원칙 완화 | 터미널 통합(`node-pty`+`xterm.js`)이 외부 의존성 없이는 불가. 관찰만으로는 워크플로우 절반밖에 못 잡음 | 원칙 |
| 2026-05-18 | claude PTY 통합 진행 | UI 탭마다 `claude` spawn 가능. 외부 spawn 세션은 관찰만 유지 (외부 프로세스 stdin attach 불가) | 기능 |

---

## 7. 의도적으로 안 한 것 (Non-goals)

- 멀티 유저·계정·인증
- 클라우드 동기화
- React/Vue/Svelte 도입
- 무거운 빌드 스텝 (xterm 정도는 사전 번들/CDN 허용, webpack 풀스택 도입 X)
- 세션 히스토리 영구 저장 (현재 30분 윈도우 의도)
- 일반 shell 터미널 (zsh/bash 등) — `claude` 전용으로 한정

---

## 8. 작업 루프

```
[claude.ai Projects] ─ 문제 정의·토론 ─┐
                                       │
[v0.dev] ─ 변형 3안 비교 ──────────────┤
                                       ▼
[DESIGN.md] ─ 가설 채택·결정 박제 ─→ [Claude Code /plan] ─ 구현
                                                              │
                                       [/ultrareview] ←───────┘
```

이 파일은 화면 손대기 **전**에 5분, 손댄 **후**에 1분만 쓰면 충분.
