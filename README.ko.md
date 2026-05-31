# claude-code-monitor

[English](./README.md) | **한국어**

> **Claude Code** 로컬 웹 도구. 외부에서 띄운 세션은 JSONL tail로 **관찰**, 모니터에서 직접 띄운 세션은 브라우저 안 터미널로 **조작**까지. 전부 `localhost`에서만 동작.

![hero](./docs/screenshots/hero.png)

![status](https://img.shields.io/badge/status-experimental-orange) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

---

## ⚡ 30초 시작

### Windows

```powershell
# 1. 프로젝트 폴더로 이동
cd C:\Users\user\Documents\claude-code-monitor

# 2. 최초 1회 의존성 설치
npm install

# 3. 실행
.\start-windows.cmd
```

브라우저에서 <http://localhost:7777>을 엽니다.

`Not found: C:\Users\user\.claude\projects`가 나오면 아래 디렉터리를 한 번 생성하세요.

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\projects"
```

### macOS

```bash
# 1. 클론
git clone https://github.com/OreoChoi/claude-code-monitor.git ~/claude-code-monitor
cd ~/claude-code-monitor

# 2. 최초 1회 의존성 설치
npm install

# 3. 실행
chmod +x ~/claude-code-monitor/*.command
./start.command
```

브라우저에서 <http://localhost:7777>을 엽니다. Finder에서 `start.command`를 더블클릭해도 실행됩니다.

---

## ✨ 주요 기능

- **턴 단위 카드 스트림** — 사용자 메시지 1개 = 1턴. 클릭하면 그 턴의 모든 도구 호출·결과·텍스트가 우측 드로어로 펼쳐집니다.
- **스킬 본문 인라인 렌더링** — Claude가 `Skill`을 호출하면 로드된 `SKILL.md` 본문이 같은 카드 안에 마크다운으로 표시됩니다. 표·코드블록·리스트 다 보임.
- **"내 컨텍스트" 사이드바** — 지금 Claude가 들고 있는 게 뭔지: 프로젝트 메모리, 로드된 `CLAUDE.md`, 이번 세션에 호출된 스킬.
- **멀티 세션 탭** — 최근 30분 안에 활동한 세션들이 각자 탭으로. 탭별 독립 스트림·카운터.
- **5종 스마트 필터** — 전체 / 스킬+메모리 / 대화+스킬 / 도구만 / 대화만. 사이드바 도구 행 클릭 시 해당 도구로 핀 필터.
- **컬러 코드 도구** — Skill(보라), Bash(녹색), Read·Edit·Write(주황), Web(청록), Agent·Task(빨강).
- **AskUserQuestion 구조화 렌더링** — Claude가 선택지를 물을 때 JSON 덩어리 대신 질문·옵션 카드로 펼쳐 보여줍니다. `(Recommended)` 옵션은 보라 보더로 강조.
- **실시간 토큰 카운터** — input / output / cache_read / cache_create 누적.
- **다국어** — 한국어 / 영어 (설정에서 전환, 브라우저에 저장).
- **로컬 우선 런타임** — Node 서버 하나와 브라우저 터미널 의존성(`ws`, `node-pty`, xterm)으로 동작.

---

## 🖼 화면 미리보기

| 스킬 본문이 펼쳐진 상태 | 영어 UI |
|---|---|
| ![skill](./docs/screenshots/skill-expanded.png) | ![i18n](./docs/screenshots/i18n.png) |

더 많은 화면과 사용법 → **[사용자 가이드](./docs/GUIDE.md)**

---

## 📦 설치

### Windows

```powershell
npm install
.\start-windows.cmd
```

서버 확인:

```powershell
(Invoke-WebRequest -UseBasicParsing http://localhost:7777).StatusCode
```

기대 결과: `200`

### macOS

```bash
npm install
chmod +x ~/claude-code-monitor/*.command
./start.command
```

서버 확인:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777
```

기대 결과: `200`

브라우저에서 <http://localhost:7777> 열고, 평소처럼 Claude Code를 쓰면 이벤트가 흘러들어옵니다.

---

## 🧠 어떻게 동작하나

Claude Code는 모든 메시지·도구 호출·결과·토큰 사용량을 `~/.claude/projects/<slugified-cwd>/<session-id>.jsonl`에 한 줄씩 기록합니다. 이 도구는:

1. 500ms마다 해당 경로를 스캔해 최근 30분 안에 변경된 `.jsonl` 파일을 찾음
2. 각 활성 세션을 탭으로 등록하고, 마지막 체크 이후 추가된 바이트만 읽음
3. 새 라인을 SSE로 모든 연결된 브라우저에 broadcast
4. 브라우저가 라인을 분류해 카드로 렌더링

자세한 동작 원리·트러블슈팅·FAQ는 [GUIDE.md](./docs/GUIDE.md).

---

## 🔒 프라이버시

전부 로컬. 서버는 `localhost:7777`에만 바인딩. 텔레메트리·외부 호출·분석 없음.

## 📋 요구사항

- Node.js 18+
- Windows 또는 macOS (`.command` 런처는 macOS 전용)
- npm 의존성 설치
- Claude Code CLI 설치 (`~/.claude/projects/`가 존재해야 함)

## 📝 라이선스

MIT — [LICENSE](./LICENSE) 참조.
