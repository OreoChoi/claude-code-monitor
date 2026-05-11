# claude-code-monitor

[English](./README.md) | **한국어**

**Claude Code** CLI 세션을 실시간으로 스트리밍해서 보여주는, 로컬 전용 초소형 웹 UI.

Claude Code가 이미 기록하고 있는 JSONL 세션 파일(`~/.claude/projects/*/<session>.jsonl`)을 tail해서 파싱한 뒤, Server-Sent Events로 브라우저에 푸시합니다. 네트워크로 아무것도 보내지 않고, Claude CLI를 감싸지도 않습니다 — 로컬 파일을 관찰만 합니다.

![status](https://img.shields.io/badge/status-experimental-orange) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

## 기능

- **멀티 세션 탭** — 최근 30분 안에 활동한 모든 Claude Code 세션이 각자의 탭으로 표시. 클릭으로 전환, ×로 닫기. 탭별로 독립된 카드 스트림과 카운터.
- **스킬 호출 본문 표시** — Claude가 `Skill`을 호출하면 로드된 `SKILL.md` 본문이 마크다운으로 바로 아래에 렌더링됨 (표, 코드 블록, 리스트 포함).
- **"내 컨텍스트" 사이드바** — 지금 Claude가 가지고 있는 컨텍스트 표시: 프로젝트 메모리 항목들, 로드된 `CLAUDE.md` 파일들, 이번 세션에 호출된 스킬들.
- **스마트 필터** — *전체*, *스킬+메모리만*, *대화+스킬*, *도구 호출만*, *대화만*. 사이드바의 도구 행을 클릭하면 그 도구만 핀 필터링.
- **턴 구분선** — 사용자 메시지마다 `── 새로운 대화 ──` 구분선이 들어가서, 어떤 질문이 어떤 동작을 트리거했는지 한눈에 보임.
- **마크다운 렌더링** — Claude의 텍스트 응답이 GFM 마크다운(표·코드블록·리스트·링크·볼드·이탤릭)으로 렌더링됨. 외부 의존성 없는 자체 파서.
- **컬러 코드 도구 호출** — Skill(보라), Bash(녹색), Read/Edit/Write(주황), WebSearch/WebFetch(청록), Agent/Task(빨강).
- **실시간 토큰 카운터** — input / output / cache_read / cache_create를 세션별로 누적.
- **도구 호출 빈도** — 사이드바에 각 도구별 호출 횟수.
- **다국어** — 우측 상단에서 한국어/영어 토글 (localStorage 보존).
- **무의존성** — 단일 Node 스크립트, `npm install` 불필요.

## 요구사항

- macOS 또는 Linux (`.command` 런처는 macOS 전용; Node 스크립트 자체는 어디서든 동작)
- Node.js 18+
- Claude Code CLI 설치 (`~/.claude/projects/`가 존재해야 함)

## 설치

```bash
git clone https://github.com/OreoChoi/claude-code-monitor.git ~/claude-code-monitor
chmod +x ~/claude-code-monitor/*.command
```

## 사용법

### A. 더블클릭 (macOS)

1. Finder에서 `~/claude-code-monitor/` 열기
2. **`start.command`** 더블클릭 → 백그라운드 실행
3. 브라우저에서 <http://localhost:7777> 접속
4. 평소처럼 Claude Code 사용 → 이벤트가 페이지로 스트리밍됨
5. 종료하려면 **`stop.command`** 더블클릭

### B. 터미널

```bash
node ~/claude-code-monitor/monitor.mjs
# 그다음 http://localhost:7777 접속
```

종료는 `Ctrl-C`.

### C. npx (설치 없이)

```bash
npx -y github:OreoChoi/claude-code-monitor
```

## 동작 방식

Claude Code는 모든 assistant 메시지, 도구 호출, 도구 결과, 토큰 사용량을 한 줄에 한 JSON으로 다음 경로에 기록합니다:

```
~/.claude/projects/<slugified-cwd>/<session-id>.jsonl
```

모니터는:

1. 500ms마다 `~/.claude/projects/`를 스캔해서 최근 30분 안에 수정된 `.jsonl`을 찾음
2. 각 활성 세션을 탭으로 등록하고, 마지막 체크 이후 추가된 바이트만 읽음
3. 새 라인을 SSE로 모든 브라우저에 broadcast
4. 브라우저는 각 라인을 분류해서(user, assistant text, thinking, tool_use, tool_result, skill body) 카드로 렌더링

모델이 `Skill`을 호출하면, Claude Code가 별도의 메타 user 메시지로 전달하는 본문(`sourceToolUseID`로 도구 호출과 연결됨)을 감지해서 마크다운 카드로 도구 호출 바로 아래에 표시합니다.

"내 컨텍스트" 패널은 세션 등록 시점에 `~/.claude/CLAUDE.md`, 프로젝트 `CLAUDE.md`, 프로젝트의 `memory/MEMORY.md`를 읽어서 구성합니다.

## 한계

- 500ms 폴링 — 이벤트가 최대 ~1초 지연 표시
- 토큰 단위 스트리밍은 표시 안 함; Claude Code가 메시지 완료 후 기록하기 때문
- 모델 내부 상태(어텐션, 암호화된 사고)는 노출 불가. Anthropic이 의도적으로 redacted thinking을 암호화해서 클라이언트에 보내기 때문. 표면 동작과 (가끔 오는) 평문 사고 블록만 가능.
- macOS에서만 테스트됨; Linux에선 Node 스크립트는 동작하지만 `.command` 런처는 안 됨

## 프라이버시

모든 게 로컬입니다. 서버는 `localhost:7777`에만 바인딩. 텔레메트리·외부 호출·분석 없음. 브라우저는 본인 머신에서 가져옴.

## 라이선스

MIT — [LICENSE](./LICENSE) 참조.
