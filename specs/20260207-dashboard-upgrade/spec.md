# Dashboard Upgrade Spec

## Overview
대시보드에 인터랙티브 기능 추가. 메모리 이벤트 클릭 시 상세 모달, stat 카드 클릭 시 관련 데이터 목록, 사이드바 네비게이션으로 페이지 전환.

## User Stories

### US-1: 메모리 이벤트 상세 모달
- **As a** 사용자
- **I want** 메모리 이벤트를 클릭하면 전체 내용을 모달로 볼 수 있다
- **So that** 잘린 preview가 아닌 전체 content와 context를 확인할 수 있다

### US-2: Stat 카드 클릭 → 관련 데이터 표시
- **As a** 사용자
- **I want** Total Events, Active Sessions, Shared Items, Vector Nodes 카드를 클릭하면 해당 데이터 목록을 볼 수 있다
- **So that** 대시보드 숫자의 실제 데이터를 탐색할 수 있다

### US-3: 사이드바 네비게이션 페이지 전환
- **As a** 사용자
- **I want** Knowledge Graph, Memory Banks, Configuration을 클릭하면 메인 콘텐츠 영역이 해당 뷰로 전환된다
- **So that** 대시보드 외의 기능에도 접근할 수 있다

## Acceptance Criteria

### AC-1: 메모리 이벤트 모달
- [ ] 이벤트 아이템 클릭 시 모달 오픈
- [ ] 모달에 전체 content 표시 (잘림 없이)
- [ ] eventType, timestamp, sessionId 메타데이터 표시
- [ ] context (앞뒤 이벤트) 표시
- [ ] ESC 키 또는 오버레이 클릭으로 모달 닫기
- [ ] 로딩 상태 표시

### AC-2: Stat 카드 클릭
- [ ] **Total Events** 클릭 → 전체 이벤트 목록 모달 (타입별 필터, 페이지네이션)
- [ ] **Active Sessions** 클릭 → 세션 목록 모달 (세션 ID, 이벤트 수, 시작/종료 시간)
- [ ] **Shared Items** 클릭 → 공유 아이템 상세 모달 (Troubleshooting, Best Practices, Common Errors 카운트)
- [ ] **Vector Nodes** 클릭 → 벡터 노드 정보 모달 (벡터 수, 메모리 사용량)

### AC-3: 사이드바 네비게이션
- [ ] **Overview** → 현재 대시보드 (기존 동작 유지)
- [ ] **Knowledge Graph** → 가장 많이 접근된 메모리, 토픽별 분포 표시
- [ ] **Memory Banks** → 레벨별 메모리 목록 (L0~L4), 졸업 기준 표시
- [ ] **Configuration** → 졸업 기준 설정, 시스템 정보 표시
- [ ] active nav-item 하이라이트 전환
- [ ] 페이지 전환 시 부드러운 트랜지션

## Technical Constraints
- 순수 HTML/CSS/JS (프레임워크 없음)
- 기존 `app.js`, `style.css`, `index.html` 수정
- 기존 API 엔드포인트 최대한 활용
- ApexCharts는 Overview 페이지에서만 사용

## API Endpoints (기존)

| Endpoint | Method | 용도 |
|----------|--------|------|
| `/api/events/:id` | GET | 이벤트 상세 (content + context) |
| `/api/events` | GET | 이벤트 목록 (level, sort, limit, offset) |
| `/api/sessions` | GET | 세션 목록 (page, pageSize) |
| `/api/sessions/:id` | GET | 세션 상세 |
| `/api/stats` | GET | 전체 통계 |
| `/api/stats/shared` | GET | 공유 스토어 통계 |
| `/api/stats/most-accessed` | GET | 가장 많이 접근된 메모리 |
| `/api/stats/levels/:level` | GET | 레벨별 이벤트 |
| `/api/stats/graduation` | GET | 졸업 기준 정보 |
| `/api/stats/helpfulness` | GET | 도움됨 통계 |
| `/api/stats/timeline` | GET | 활동 타임라인 |
| `/api/search?q=` | GET | 메모리 검색 |

## UI Components (신규)

### 1. Detail Modal (`#detail-modal`)
- overlay + centered content box
- header: 타입 배지 + 타임스탬프 + 닫기 버튼
- body: 전체 content (코드 블록 포맷팅)
- footer: context 이벤트 목록
- 애니메이션: fadeIn/fadeOut

### 2. List Modal (`#list-modal`)
- stat 카드 클릭 시 사용하는 범용 목록 모달
- header: 제목 + 닫기 버튼
- body: 스크롤 가능한 아이템 목록
- 각 아이템 클릭 시 detail modal 열기 가능

### 3. Page Views
- `#view-overview` - 기존 대시보드 (기본)
- `#view-knowledge-graph` - Knowledge Graph 뷰
- `#view-memory-banks` - Memory Banks 뷰
- `#view-configuration` - Configuration 뷰
- 한 번에 하나만 visible (display: none/block 전환)

## Design Guidelines
- 기존 Deep Space 테마 유지
- 모달: `var(--bg-panel)` 배경, `var(--glass-border)` 테두리
- 애니메이션: 200~300ms ease 트랜지션
- 모바일 대응: 모달 full-width on mobile
