---
name: docs-sync
description: claude-code-monitor의 사용자용 문서(README/스샷/GUIDE) 동기화를 자동화한다. 새 기능을 추가하거나 UI를 변경한 뒤 호출하면 무엇이 어긋났는지 진단하고, 필요한 곳만 골라 스샷을 재생성하고 README·docs/GUIDE.md를 갱신한다. "스샷 갱신", "문서 업데이트", "가이드 동기화", "릴리즈 준비" 같은 표현에서 트리거.
---

# docs-sync

`claude-code-monitor`의 사용자 대상 문서를 일관되게 유지하기 위한 스킬.
이 프로젝트의 문서 구조는 의도된 결정이며, 새 기능이 들어올 때마다 같은 자리에 같은 형태로 반영해야 한다.

## 문서 구조 (불변)

```
README.md / README.ko.md      ← 마케팅 + 30초 사용법
├── 상단: hero 스샷 1장 (docs/screenshots/hero.png)
├── 한 줄 소개
├── ✨ Features (각 항목 옆에 미니 스샷 320px)
├── 📦 Install (3가지: npx / clone+double-click / terminal)
├── 🚀 First run (3 steps)
└── 👉 Full guide → docs/GUIDE.md

docs/GUIDE.md                 ← 깊이 있는 사용법
├── 1. 이건 뭐예요? / What is this?
├── 2. 시작하기 (5분)
├── 3. 화면 둘러보기
├── 4. 기능별 사용법
├── 5. FAQ
├── 6. 종료/재시작
├── 7. 알려진 한계
└── 8. 문제 해결

docs/screenshots/             ← 모든 캡처 산출물 (1440x900 @2x)
├── hero.png                  ← README 상단용
├── dashboard.png             ← 메인 화면
├── skill-expanded.png        ← Skill 본문 마크다운
├── sidebar-context.png       ← My context 사이드바
├── filters.png               ← 필터 5종 적용
├── multi-session.png         ← 여러 탭
├── tool-pin.png              ← 툴 핀 필터
└── i18n.png                  ← 한/영 토글

scripts/screenshot.mjs        ← Playwright 캡처 스크립트
scripts/seed/*.jsonl          ← 캡처용 시드 JSONL (재현 가능)
```

## 절차 (호출 시 이걸 그대로 따른다)

### Step 1. 변경 범위 진단

```
git status
git diff --stat HEAD
git log --oneline -10
```

판단 기준:
- `monitor.mjs`의 HTML/CSS/JS 영역(189–1730줄) 변경 → **UI 변경** ⇒ 스샷 갱신 필요
- 백엔드만 변경 → 스샷 갱신 보통 불필요. README 한 줄 갱신만으로 충분할 수 있음
- 기능 추가/제거 → README의 Features 리스트 + docs/GUIDE.md 4섹션 갱신 필수

### Step 2. 시드 JSONL 보강 (필요 시)

새 기능이 특정 이벤트 타입에 의존한다면 `scripts/seed/`에 케이스 JSONL을 추가/수정.
시드는 **재현 가능**해야 한다 — 외부 의존 없이 고정된 카드가 나오게.

### Step 3. 캡처 대상 선정

전부 다 다시 찍지 말 것. 영향받은 캡처만:
- 기능 추가: `dashboard.png` + 그 기능 전용 캡처 1장
- 필터/사이드바 변경: 해당 캡처만
- 색·여백 등 글로벌 디자인 변경: hero 포함 전체

### Step 4. 캡처 실행

```bash
npm run screenshot                    # 전체
npm run screenshot -- --only=hero     # 1장
npm run screenshot -- --only=hero,filters,dashboard
```

서버가 떠 있어야 함. 안 떠 있으면 먼저:
```bash
pkill -f "claude-code-monitor/monitor.mjs"
nohup node monitor.mjs > /tmp/claude-code-monitor.log 2>&1 & disown
```

### Step 5. 문서 갱신

- **README.md / README.ko.md**: Features 섹션의 해당 항목과 옆 미니 스샷 경로 갱신
- **docs/GUIDE.md**: "4. 기능별 사용법" 안에서 해당 서브섹션 갱신
- 양쪽 언어 모두 — 한쪽만 손대지 말 것 (i18n 일관성)

### Step 6. 검증

```bash
ls -la docs/screenshots/              # 새 파일이 생겼는지
git diff README.md README.ko.md docs/GUIDE.md
```

서버 재실행 후 200 응답 확인:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7777
```

### Step 7. 보고

사용자에게 다음을 표로 보고:
| 항목 | 변경 전 → 변경 후 |
|------|-------------------|
| 스샷 N장 갱신 | … |
| README 섹션 | … |
| GUIDE 섹션 | … |

## 절대 하지 말 것

- 한쪽 언어 README만 갱신하기 (한/영 동기화 필수)
- 스샷을 손으로 캡처해서 올리기 (재현성 깨짐 — 항상 스크립트 사용)
- 기능 리스트만 늘리고 GUIDE는 안 건드리기
- `docs/GUIDE.md` 목차 구조를 바꾸기 (8섹션 고정. 새 기능은 기존 섹션 안에서 추가)
- 의존성을 추가해서 zero-dep 원칙 깨기 (Playwright는 `devDependencies`로만)
- 컴파일/서버 재실행 검증 생략하기 (CLAUDE.md 규칙)

## 호출되는 전형적 상황

- "방금 추가한 기능 문서에 반영해줘"
- "스샷 다시 찍어줘"
- "릴리즈 직전 정리"
- "이거 README에 넣자"
- "가이드 업데이트"
