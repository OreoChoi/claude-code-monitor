# CLAUDE.md (claude-code-monitor 프로젝트)

## 프로젝트 개요
Claude Code CLI 세션을 실시간으로 스트리밍하는 로컬 웹 모니터. `~/.claude/projects/*/<session>.jsonl` 파일을 폴링하여 SSE로 브라우저(`http://localhost:7777`)에 전달.

## 기술 스택
- **런타임**: Node.js ≥18 (ESM, `"type": "module"`)
- **의존성**: 없음 (`node:fs`, `node:path`, `node:http`, `node:os`만 사용)
- **전송**: Server-Sent Events (SSE)
- **프론트엔드**: `monitor.mjs` 내부에 HTML/CSS/JS 인라인 임베드 (별도 빌드 없음)
- **포트**: 7777 고정

## 디렉터리 구조
```
claude-code-monitor/
├── monitor.mjs          # 단일 파일 서버 (백엔드 폴러 + 프론트엔드 HTML/JS)
├── package.json         # zero-deps, bin: claude-code-monitor
├── start.command        # macOS 더블클릭 실행 스크립트
├── stop.command         # macOS 더블클릭 종료 스크립트
├── README.md / README.ko.md
├── DESIGN.md            # 설계 문서
└── LICENSE
```

## monitor.mjs 구조 (1800+ 줄, 단일 파일)
백엔드와 프론트엔드가 한 파일에 공존. `GET /` 요청 시 인라인 HTML 문자열을 그대로 응답.

| 영역 | 라인 | 내용 |
|------|------|------|
| 백엔드 (상단) | 1–188 | 파일 워처, JSONL 파서, 컨텍스트 인벤토리(`buildInventory`), SSE 브로드캐스트 |
| 프론트엔드 (인라인) | 189–1730 | `const HTML = String.raw\`...\`` 템플릿 — HTML + CSS + `<script>` JS 전부 |
| 백엔드 (하단) | 1732–1824 | `http.createServer()` 라우팅 |

**HTTP 라우트**:
- `/` — HTML 페이지
- `/events` — SSE 스트림
- `/config` — 활성 세션 윈도우(activeMs) 설정
- `/health`, `/sessions`, `/session/:id` — 상태/세션 조회

## 작업 종료 규칙
- `monitor.mjs` 등 서버 코드 수정 후 작업이 끝나면 항상 서버를 재실행한다.
  - 절차: `pkill -f "claude-code-monitor/monitor.mjs"` → `nohup node monitor.mjs > /tmp/claude-code-monitor.log 2>&1 & disown`
  - 재실행 후 `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777`로 200 응답 확인하고 보고한다.
- 정적 파일/문서만 수정한 경우(README 등)는 재실행 생략 가능.

## 코딩 스타일
- Zero-dependency 원칙 유지 (Node 표준 모듈만 사용)
- 백엔드/프론트엔드 분리 빌드 도입 금지 — `monitor.mjs` 단일 파일 유지
- ESM `import` 사용, CommonJS 금지
