# 사용자 가이드

[English](./GUIDE.en.md) | **한국어**

`claude-code-monitor`를 처음 써보는 사람을 위한 가이드입니다.
README는 30초 안에 띄우는 방법만 다뤘다면, 여기는 **각 기능을 어떻게 활용하는지**가 본론.

---

## 1. 이건 뭐예요?

Claude Code CLI 세션의 JSONL을 tail해서, 지금 클로드가 **무엇을 보고 무엇을 하고 있는지** 브라우저로 실시간 관찰하는 로컬 도구.

### 이런 때 쓰세요

- **클로드가 뭘 하는지 옆에서 보고 싶다** — 어떤 도구를 부르고, 어떤 스킬을 로드하고, 어떤 메모리를 참조하는지 한눈에
- **토큰을 얼마나 쓰는지 추적** — input/output/cache_read/cache_create 세션별 누적
- **디버깅** — "방금 그 호출이 뭔가 이상한데?" → 카드 펼쳐서 인풋·결과 원본 확인
- **로컬 사이드카** — 노트북 한쪽에 띄워두고 작업

### 이건 아닙니다

- ❌ Claude CLI 래퍼/프록시 (CLI는 그대로, 파일만 관찰)
- ❌ 클라우드 동기화 (로컬 onlyu)
- ❌ 세션 영구 보관 (현재 30분 윈도우만 표시)
- ❌ 멀티 유저/인증/팀 공유

---

## 2. 시작하기 (5분)

### 요구사항

| 항목 | 요구 |
|---|---|
| OS | macOS 또는 Linux (`.command` 런처는 macOS 전용) |
| Node.js | 18 이상 |
| Claude Code CLI | 설치돼 있어야 함 (`~/.claude/projects/`가 존재) |
| 포트 | 7777 (고정) |

### 설치 3가지 방법

**A. npx (가장 빠름, 설치 없음)**
```bash
npx -y github:OreoChoi/claude-code-monitor
```

**B. 클론 + 더블클릭 (macOS, 매번 쓸 거면 추천)**
```bash
git clone https://github.com/OreoChoi/claude-code-monitor.git ~/claude-code-monitor
chmod +x ~/claude-code-monitor/*.command
# Finder에서 start.command 더블클릭 → 백그라운드 실행
# stop.command 더블클릭으로 종료
```

**C. 터미널 직접 실행**
```bash
node ~/claude-code-monitor/monitor.mjs
```

### 첫 실행

1. 위 셋 중 하나로 서버 실행
2. 브라우저에서 <http://localhost:7777> 열기
3. 평소처럼 Claude Code 사용 (`claude` 명령으로 아무 프로젝트나 진입)
4. 페이지에 카드가 흘러들어오면 성공

> 카드가 안 떠도 당황 X. 활성 세션이 최근 30분 안에 변경되어야 잡힙니다. Claude Code에 메시지 한 번 입력하면 바로 활성화.

---

## 3. 화면 둘러보기

![overview](./screenshots/hero.png)

### 상단 헤더
- `Claude Monitor` 로고 옆에는 현재 보고 있는 세션의 **프로젝트 경로 / 세션 ID**
- 우측: **필터 셀렉트** / `지우기`(현재 탭 스트림 비움) / `세션`(과거 세션 브라우저) / `설정` 톱니 / 연결 상태(`live`)

### 탭 영역
- 활성 세션마다 탭 1개
- 우측 상단 숫자 = 그 탭의 카드 개수
- × 누르면 탭만 닫힘 (서버 세션은 그대로)

### 좌측 사이드바
| 블록 | 내용 |
|---|---|
| **세션** | 현재 탭의 프로젝트 경로, 세션 ID |
| **내 컨텍스트 → CLAUDE.md** | 이번 세션에 로드된 CLAUDE.md 파일들(user / project / project-local) |
| **내 컨텍스트 → 로드된 스킬** | 이번 세션에 호출된 스킬 목록 |
| **도구 호출 (클릭으로 필터)** | 도구별 호출 횟수. 행 클릭 → 그 도구만 핀 필터 |
| **토큰 (이번 세션)** | input / output / cache_read / cache_create 누적 |

### 메인 영역 — 턴 카드
사용자 메시지 1개 = 1턴 카드. 카드에는 다음이 보입니다:
- 사용자 메시지 본문
- 그 턴에서 호출된 도구 개수 / 사용된 스킬 칩 / 소요 시간
- 직후 어시스턴트 텍스트 한 줄 미리보기

**카드 클릭** → 우측에 thread 드로어가 열려 그 턴의 **모든 이벤트**(도구 호출·결과·텍스트·thinking)가 시간순으로 펼쳐집니다.

### 카드 종류

| 클래스 | 트리거 | 표시 |
|---|---|---|
| `user` | 사용자 메시지 | 일반 텍스트 + 새 턴 시작 |
| `assistant text` | Claude 텍스트 | GFM 마크다운 렌더 |
| `tool_use` | 도구 호출 | 접힘. 색상 좌측 보더로 도구 종류 표시 |
| `tool_use` · AskUserQuestion | 사용자에게 묻는 호출 | 펼치면 질문·옵션이 카드 형태로 구조화 렌더 (4.9 참조) |
| `tool_result` | 도구 결과 | 접힘. 직전 `tool_use`와 페어 |
| `tool_result-skill` | Skill 본문 | `SKILL.md` 본문 마크다운 렌더 |

---

## 4. 기능별 사용법

### 4.1 멀티 세션 탭

여러 프로젝트에서 동시에 `claude`를 띄우면 각각 탭으로 잡힙니다. 클릭으로 전환, ×로 닫기.

탭 상태는 `localStorage`에 저장돼서 새로고침해도 그대로.

### 4.2 스킬 본문 펼쳐보기

![skill expanded](./screenshots/skill-expanded.png)

1. 턴 카드의 `simplify` 같은 보라색 칩을 보면 → 그 턴에서 스킬이 호출됐다는 표시
2. 턴 카드 클릭 → thread 드로어 열림
3. 드로어 안의 보라색 보더 카드(`Skill`)를 클릭 → 카드 안에 `SKILL.md` 본문이 마크다운으로 펼쳐짐
4. 표·코드 블록·리스트 모두 렌더됨

### 4.3 "내 컨텍스트"로 클로드가 뭘 로드했는지 확인

사이드바 **내 컨텍스트** 블록을 보면:
- 어떤 `CLAUDE.md` 파일들이 이 세션에 들어가 있는지
- 어떤 스킬이 로드됐는지

세션 시작 시점에 한 번 빌드되며, 새 스킬이 호출되면 그때 추가됩니다.

### 4.4 필터 5종

![filters](./screenshots/filters.png)

상단 셀렉트로 전환:

| 필터 | 보이는 것 |
|---|---|
| **전체** | 모든 카드 |
| **스킬+메모리만** | Skill 호출과 메모리 관련 이벤트만 |
| **대화+스킬** | 사용자/어시스턴트 텍스트 + Skill 본문 |
| **도구만** | tool_use / tool_result만 |
| **대화만** | 사용자/어시스턴트 텍스트만 |

대화 흐름만 빠르게 훑고 싶을 땐 **대화만**, 도구 호출 패턴만 보고 싶을 땐 **도구만**.

### 4.5 툴 핀 필터 (사이드바 클릭)

사이드바 **도구 호출** 섹션에서 행을 클릭하면 → **그 도구만** 보이게 핀 필터. 한 번 더 누르면 해제.

예: `Edit` 행 클릭 → 이번 세션의 모든 `Edit` 호출만 보임.

### 4.6 턴 디바이더로 질문-결과 매칭

각 사용자 메시지가 시각적으로 분리된 새 턴을 시작합니다. "이 질문이 어떤 동작을 트리거했지?"를 찾을 때 유용.

### 4.7 토큰 사용량 추적

사이드바 **토큰** 블록에 4가지 값이 누적됩니다:

| 항목 | 의미 |
|---|---|
| `input` | 모델에 보낸 새 토큰 |
| `output` | 모델이 생성한 토큰 |
| `cache_read` | 프롬프트 캐시에서 읽은 토큰 (저렴) |
| `cache_create` | 프롬프트 캐시를 새로 생성한 토큰 |

긴 세션에서 `cache_read`가 크면 캐시가 잘 듣고 있다는 신호.

### 4.8 한/영 전환

설정(우측 상단 톱니 아이콘) → **언어** 드롭다운 → 한국어/English.

UI 텍스트만 바뀝니다. 사용자/어시스턴트가 친 본문은 원본 유지.

선택은 `localStorage`에 저장.

### 4.9 AskUserQuestion 구조화 렌더링

![askq](./screenshots/askq.png)

Claude가 `AskUserQuestion` 도구로 사용자에게 선택지를 물을 때, 원본 페이로드는 깊게 중첩된 JSON(`{questions: [{question, header, options: [{label, description}, ...]}, ...]}`)이라 그대로 펼치면 가독성이 떨어집니다. 모니터는 이 도구 호출만 별도 렌더러로 처리합니다.

펼치면 다음과 같이 보입니다:

- 각 질문에 `Q1` / `Q2` 인덱스 + 질문별 **헤더 칩**(예: `SCOPE`, `RETRY`) + **단일 선택 / 다중 선택** 배지
- 질문 본문은 굵게
- 옵션은 각각 카드로 분리되어 `label`(굵게)과 `description`(보조 텍스트)으로 표시
- 라벨이 `(Recommended)` 또는 `(추천)`으로 끝나는 옵션은 **보라색 보더 + "추천" 배지** 강조 (텍스트의 `(Recommended)`는 자동 제거됨)

다른 도구 호출은 기존대로 JSON `<pre>`로 표시됩니다.

---

## 5. 자주 묻는 질문

**카드가 안 떠요**
- 활성 세션이 없는 상태. Claude Code에서 메시지를 한 번 입력하면 활성화됩니다.
- 세션의 mtime이 30분 이내여야 잡힙니다. 더 길게 보고 싶으면 `/config`로 윈도우 조정 가능 (1분~24시간).

**포트 7777이 이미 쓰여요**
- 다른 인스턴스가 떠있는지 확인: `lsof -ti :7777`
- 죽이고 재실행: `lsof -ti :7777 | xargs kill -9 && node monitor.mjs`

**과거 세션도 보고 싶어요**
- 우측 상단 **세션** 버튼 → 모든 세션 브라우저가 열려서 30분 윈도우 밖 세션도 골라 열 수 있습니다.

**데이터가 외부로 나가나요?**
- 안 나갑니다. `localhost:7777`에만 바인딩, 텔레메트리 없음. 브라우저는 본인 머신에서만 가져옵니다.

**thinking이 비어 보여요**
- Anthropic이 의도적으로 thinking 블록을 암호화해서 클라이언트에 보내는 경우가 있습니다(redacted thinking). 평문 thinking만 표시 가능.

**탭이 사라졌어요**
- 세션 mtime이 30분 이상 안 변하면 자동 만료됩니다. 다시 활성화하면 탭이 돌아옵니다.

---

## 6. 종료 / 재시작

**종료**
- macOS 더블클릭으로 띄운 경우: `stop.command` 더블클릭
- 터미널 직접 실행: `Ctrl-C`
- 백그라운드로 띄운 경우: `pkill -f "claude-code-monitor/monitor.mjs"`

**재시작 (코드 수정 후)**
```bash
pkill -f "claude-code-monitor/monitor.mjs"
nohup node monitor.mjs > /tmp/claude-code-monitor.log 2>&1 & disown
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777   # 200이면 OK
```

---

## 7. 알려진 한계

- **500ms 폴링** — 이벤트가 최대 ~1초 지연되어 표시됩니다. 토큰 단위 스트리밍은 불가 (Claude Code가 완료된 메시지만 JSONL에 기록하기 때문)
- **30분 윈도우 외 세션은 메인 화면에 안 보임** — 세션 브라우저로 명시적으로 열어야 함
- **macOS 위주 테스트** — Linux에서 Node 스크립트는 동작하지만 `.command` 런처는 macOS 전용
- **모델 내부 상태는 노출 불가** — Anthropic이 암호화한 redacted thinking은 읽을 수 없음

---

## 8. 문제 해결

**로그 위치**
- 백그라운드 실행 시: `/tmp/claude-code-monitor.log`
- 포그라운드(터미널) 실행 시: 터미널에 stderr/stdout으로 출력

**서버 헬스체크**
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777   # 200 기대
curl -s http://localhost:7777/health
curl -s http://localhost:7777/sessions
```

**연결 상태 확인 (브라우저)**
- 우측 상단 `live` 배지가 녹색이면 SSE 연결 정상
- 빨간색이면 서버 종료됨 → 재실행

**이슈 리포트**
- 버그/제안: https://github.com/OreoChoi/claude-code-monitor/issues
