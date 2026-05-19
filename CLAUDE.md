# CLAUDE.md (claude-code-monitor 프로젝트)

## 프로젝트 개요
Claude Code CLI 세션을 위한 로컬 웹 도구. 두 가지 역할:
1. **관찰** — `~/.claude/projects/*/<session>.jsonl`을 폴링해 SSE로 브라우저에 전달 (외부에서 띄운 claude 포함 모든 세션)
2. **조작** — 모니터에서 직접 `claude`를 PTY로 spawn해 xterm으로 입출력 (WebSocket bridge)

브라우저: `http://localhost:7777`

## 기술 스택
- **런타임**: Node.js ≥18 (ESM, `"type": "module"`)
- **의존성**:
  - 관찰 영역: Node 표준 모듈 (`node:fs`, `node:path`, `node:http`, `node:os`, `node:child_process`)
  - 터미널 영역: `node-pty`, `ws` (런타임), `xterm`, `xterm-addon-fit` (정적 자산)
  - 의존성 추가는 DESIGN.md 결정 로그에 사유 박제 후에만
- **전송**: SSE (관찰 단방향), WebSocket (PTY 양방향)
- **프론트엔드**: `monitor.mjs` 백엔드 + HTML/CSS/JS 인라인. xterm 번들만 `node_modules`에서 정적 서빙
- **포트**: 7777 고정

## 디렉터리 구조
```
claude-code-monitor/
├── monitor.mjs          # 백엔드 서버 + 인라인 프론트엔드 HTML/JS
├── package.json         # bin: claude-code-monitor
├── start.command        # macOS 더블클릭 실행 스크립트
├── stop.command         # macOS 더블클릭 종료 스크립트
├── README.md / README.ko.md
├── DESIGN.md            # 설계 문서
├── docs/                # GUIDE, screenshots
├── scripts/             # screenshot.mjs (Playwright), seed JSONL
├── .claude/skills/      # docs-sync 등 프로젝트 스킬
└── LICENSE
```

## monitor.mjs 구조 (1800+ 줄, 단일 파일)
백엔드와 프론트엔드가 한 파일에 공존. `GET /` 요청 시 인라인 HTML 문자열을 그대로 응답.

| 영역 | 라인 | 내용 |
|------|------|------|
| 백엔드 (상단) | 1–188 | 파일 워처, JSONL 파서, 컨텍스트 인벤토리(`buildInventory`), SSE 브로드캐스트 |
| 프론트엔드 (인라인) | 189–1730 | `const HTML = String.raw\`...\`` 템플릿 — HTML + CSS + `<script>` JS 전부 |
| 백엔드 (하단) | 1732–1824 | `http.createServer()` 라우팅 |

**HTTP/WS 라우트**:
- `/` — HTML 페이지
- `/events` — SSE 스트림 (JSONL 관찰)
- `/config` — 활성 세션 윈도우(activeMs) 설정
- `/health`, `/sessions`, `/session/:id` — 상태/세션 조회
- `/pty` (POST) — 새 claude PTY spawn (cwd 지정)
- `/pty/:id` (WebSocket) — PTY ↔ 브라우저 양방향 IO
- `/assets/xterm/*` — xterm.js 정적 자산 (`node_modules/xterm/...`에서 서빙)

## 작업 종료 규칙
- `monitor.mjs` 등 서버 코드 수정 후 작업이 끝나면 항상 서버를 재실행한다.
  - 절차: `pkill -f "claude-code-monitor/monitor.mjs"` → `nohup node monitor.mjs > /tmp/claude-code-monitor.log 2>&1 & disown`
  - 재실행 후 `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777`로 200 응답 확인하고 보고한다.
- 정적 파일/문서만 수정한 경우(README 등)는 재실행 생략 가능.

## 코딩 스타일
- 의존성은 목적이 분명할 때만 추가. 추가 시 DESIGN.md 결정 로그에 사유 박제
- 백엔드 로직은 `monitor.mjs` 한 파일에 모으는 기조 유지 (불가피한 경우 분리 OK)
- 풀스택 빌드 스텝(webpack/vite 등) 도입 금지. xterm 같은 사전 번들 정적 자산은 허용
- ESM `import` 사용, CommonJS 금지
