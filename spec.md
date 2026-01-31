# Specification: Claude Code Memory Plugin

## 1. 개요

### 1.1 플러그인 정보

| 항목 | 값 |
|------|-----|
| **이름** | `code-memory` |
| **버전** | `1.0.0` |
| **설명** | 대화 기억을 통해 사용자 맞춤형 경험을 제공하는 Claude Code 플러그인 |
| **핵심 가치** | "사용할수록 똑똑해지는 Agent" |

### 1.2 핵심 기능

1. **대화 기억 저장**: 모든 사용자 prompt와 agent 응답을 영구 저장
2. **지능형 검색**: 새로운 prompt와 관련된 과거 기억을 의미 기반 검색
3. **컨텍스트 주입**: 관련 기억을 현재 대화에 자동 주입
4. **학습 및 진화**: 패턴 인식을 통한 개인화

---

## 2. 아키텍처

### 2.1 시스템 구조

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Session                       │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│ SessionStart│      │UserPrompt   │      │ Stop/       │
│    Hook     │      │Submit Hook  │      │ SessionEnd  │
└─────────────┘      └─────────────┘      └─────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Memory Service (Core)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Ingester │  │ Embedder │  │ Retriever│  │ Ranker   │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Storage Layer                             │
│  ┌───────────────────┐      ┌───────────────────┐          │
│  │    LanceDB        │      │     DuckDB        │          │
│  │ (Vector Store)    │      │ (Event Store)     │          │
│  └───────────────────┘      └───────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 데이터 흐름

```
1. [SessionStart]
   → 이전 세션 요약 로드
   → 사용자 선호도/패턴 로드

2. [UserPromptSubmit]
   → 현재 prompt 임베딩 생성
   → 관련 기억 검색 (top-k)
   → 기억을 시스템 프롬프트로 주입

3. [Stop/AgentResponse]
   → 전체 대화 쌍 (prompt + response) 저장
   → 비동기 임베딩 생성 및 인덱싱

4. [SessionEnd]
   → 세션 요약 생성 및 저장
   → 장기 기억으로 통합
```

### 2.3 Memory Graduation Pipeline (L0 → L4)

AXIOMMIND 기반 다단계 메모리 승격 구조:

| 레벨 | 이름 | 설명 | 저장소 | 상태 |
|------|------|------|--------|------|
| **L0** | EventStore | 원본 대화 로그 (불변) | DuckDB `events` | 즉시 저장 |
| **L1** | Structured | LLM 추출 구조화 데이터 | DuckDB `insights` | 비동기 처리 |
| **L2** | Candidates | 타입 검증 대상 | TypeScript 검증 | 배치 처리 |
| **L3** | Verified | 검증 완료 지식 | DuckDB `verified_knowledge` | 검증 후 |
| **L4** | Active | 검색 가능 메모리 | LanceDB | 인덱싱 후 |

```
User Prompt → L0 (즉시) → L1 (비동기) → L2 (배치) → L3 (검증) → L4 (검색 가능)
                ↑                                              ↓
                └──────────── 검색 시 L4에서 조회 ─────────────┘
```

### 2.4 AXIOMMIND 7가지 필수 원칙

본 플러그인은 다음 원칙을 준수합니다:

| # | 원칙 | 구현 |
|---|------|------|
| 1 | 진실의 원천은 이벤트 로그 | `events` 테이블에서 모든 파생 데이터 재구성 가능 |
| 2 | 추가전용 구조 | `EventStore.append()` 만 제공, UPDATE/DELETE 없음 |
| 3 | 멱등성 보장 | `dedupe_key = session_id + content_hash` |
| 4 | 증거 범위는 파이프라인이 확정 | `EvidenceAligner`가 정확한 스팬 계산 |
| 5 | Task는 엔티티 | `canonical_key`로 동일 개념 통합 |
| 6 | 벡터 저장소 정합성 | DuckDB → outbox → LanceDB 단방향 |
| 7 | DuckDB JSON 사용 | JSONB 대신 표준 JSON |

---

## 3. 데이터 모델

### 3.1 Event Schema (DuckDB) - AXIOMMIND 스타일

```sql
-- ============================================================
-- L0 EventStore: Single Source of Truth (불변, append-only)
-- ============================================================

CREATE TABLE events (
    id              UUID PRIMARY KEY,
    event_type      VARCHAR NOT NULL,    -- 'user_prompt' | 'agent_response' | 'session_summary'
    session_id      VARCHAR NOT NULL,
    timestamp       TIMESTAMP NOT NULL,
    content         TEXT NOT NULL,
    canonical_key   VARCHAR NOT NULL,    -- 정규화된 키 (NFKC, lowercase, no punctuation)
    metadata        JSON,
    dedupe_key      VARCHAR UNIQUE       -- 멱등성 보장 (content_hash + session_id)
);

-- 중복 방지 테이블 (event_dedup)
CREATE TABLE event_dedup (
    dedupe_key      VARCHAR PRIMARY KEY,
    event_id        UUID NOT NULL REFERENCES events(id),
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Projection offset 추적 (증분 처리용)
CREATE TABLE projection_offsets (
    projection_name VARCHAR PRIMARY KEY,
    last_event_id   UUID,
    last_timestamp  TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 세션 메타데이터
-- ============================================================

CREATE TABLE sessions (
    id              VARCHAR PRIMARY KEY,
    started_at      TIMESTAMP NOT NULL,
    ended_at        TIMESTAMP,
    project_path    VARCHAR,
    summary         TEXT,
    tags            JSON
);

-- ============================================================
-- 추출된 인사이트 (파생 데이터, 재구성 가능)
-- ============================================================

CREATE TABLE insights (
    id              UUID PRIMARY KEY,
    insight_type    VARCHAR NOT NULL,    -- 'preference' | 'pattern' | 'expertise'
    content         TEXT NOT NULL,
    canonical_key   VARCHAR NOT NULL,    -- 정규화된 키
    confidence      FLOAT,
    source_events   JSON,                -- 원본 이벤트 ID 목록
    created_at      TIMESTAMP,
    last_updated    TIMESTAMP
);

-- ============================================================
-- Embedding Outbox (Single-Writer Pattern)
-- ============================================================

CREATE TABLE embedding_outbox (
    id              UUID PRIMARY KEY,
    event_id        UUID NOT NULL REFERENCES events(id),
    content         TEXT NOT NULL,
    status          VARCHAR DEFAULT 'pending',  -- 'pending' | 'processing' | 'done' | 'failed'
    retry_count     INT DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW(),
    processed_at    TIMESTAMP,
    error_message   TEXT
);

-- ============================================================
-- Memory Resolutions (Condition → Task 해결)
-- ============================================================

CREATE TABLE memory_resolutions (
    id              UUID PRIMARY KEY,
    condition_id    UUID NOT NULL,       -- 원본 조건/참조
    resolved_to_id  UUID,                -- 해결된 대상
    resolution_type VARCHAR,             -- 'confirmed' | 'rejected' | 'pending'
    confidence      FLOAT,
    resolved_at     TIMESTAMP
);

-- ============================================================
-- Effective View (Condition 해결 반영)
-- ============================================================

CREATE VIEW v_memory_context_effective AS
SELECT
    e.id,
    e.session_id,
    e.content,
    e.canonical_key,
    e.event_type,
    e.timestamp,
    COALESCE(r.resolved_to_id, e.id) as effective_id,
    CASE
        WHEN r.resolution_type = 'confirmed' THEN 'resolved'
        WHEN r.resolution_type = 'pending' THEN 'pending'
        ELSE 'direct'
    END as resolution_status
FROM events e
LEFT JOIN memory_resolutions r ON e.id = r.condition_id;
```

### 3.2 Vector Schema (LanceDB)

```python
# 대화 임베딩 테이블
conversations_schema = {
    "id": str,              # UUID
    "event_id": str,        # events 테이블 참조
    "session_id": str,
    "event_type": str,      # 'user_prompt' | 'agent_response'
    "content": str,         # 원본 텍스트 (검색 결과 표시용)
    "vector": list[float],  # 임베딩 벡터 (384 또는 1536 차원)
    "timestamp": str,
    "metadata": dict        # 추가 메타데이터
}

# 인사이트 임베딩 테이블
insights_schema = {
    "id": str,
    "insight_id": str,      # insights 테이블 참조
    "content": str,
    "vector": list[float],
    "insight_type": str,
    "confidence": float
}
```

### 3.3 TypeScript 타입 정의 (Idris2 영감)

```typescript
// 불변성과 타입 안전성을 강조한 설계

// 이벤트 타입 (Union Type으로 완전성 보장)
type EventType = 'user_prompt' | 'agent_response' | 'session_summary';

// 이벤트 구조 (Readonly로 불변성 강제)
interface MemoryEvent {
  readonly id: string;
  readonly eventType: EventType;
  readonly sessionId: string;
  readonly timestamp: Date;
  readonly content: string;
  readonly contentHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

// 검색 결과 (신뢰도 점수 포함)
interface MemoryMatch {
  readonly event: MemoryEvent;
  readonly score: number;        // 0.0 ~ 1.0
  readonly relevanceReason: string;
}

// 컨텍스트 주입 결과
interface ContextInjection {
  readonly memories: ReadonlyArray<MemoryMatch>;
  readonly systemPromptAddition: string;
  readonly totalTokensUsed: number;
}

// 저장 결과 (성공/실패 명시적 표현)
type SaveResult =
  | { success: true; eventId: string }
  | { success: false; error: string; isDuplicate: boolean };
```

---

## 4. Hook 명세

### 4.1 SessionStart Hook

**목적**: 세션 시작 시 관련 컨텍스트 로드

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "code-memory session-start",
        "timeout": 5000
      }
    ]
  }
}
```

**입력**:
```json
{
  "session_id": "sess_abc123",
  "cwd": "/path/to/project"
}
```

**출력**:
```json
{
  "context": "## Previous Session Context\n- Last worked on: API authentication\n- User preference: Prefers TypeScript\n- Recent patterns: Uses Zod for validation"
}
```

### 4.2 UserPromptSubmit Hook

**목적**: 사용자 입력 시 관련 기억 검색 및 주입

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "code-memory search",
        "timeout": 3000
      }
    ]
  }
}
```

**입력**:
```json
{
  "session_id": "sess_abc123",
  "prompt": "How do I add rate limiting to the API?"
}
```

**출력**:
```json
{
  "context": "## Relevant Memories\n\n### Previous Discussion (2 weeks ago)\nYou implemented rate limiting for the /users endpoint using express-rate-limit...\n\n### Your Preferences\n- Prefers middleware-based solutions\n- Uses Redis for distributed rate limiting"
}
```

### 4.3 Stop Hook

**목적**: Agent 응답 완료 시 대화 저장

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "code-memory save",
        "timeout": 5000
      }
    ]
  }
}
```

**입력**:
```json
{
  "session_id": "sess_abc123",
  "stop_reason": "end_turn",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

### 4.4 SessionEnd Hook

**목적**: 세션 종료 시 요약 저장

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "type": "command",
        "command": "code-memory session-end",
        "timeout": 10000
      }
    ]
  }
}
```

---

## 5. 명령어 인터페이스

### 5.1 슬래시 명령어

| 명령어 | 설명 | 예시 |
|--------|------|------|
| `/code-memory:search` | 기억 수동 검색 | `/code-memory:search rate limiting` |
| `/code-memory:history` | 최근 대화 이력 | `/code-memory:history 10` |
| `/code-memory:insights` | 추출된 인사이트 보기 | `/code-memory:insights` |
| `/code-memory:forget` | 특정 기억 삭제 | `/code-memory:forget <id>` |
| `/code-memory:export` | 기억 내보내기 | `/code-memory:export json` |
| `/code-memory:stats` | 통계 보기 | `/code-memory:stats` |

### 5.2 CLI 명령어 (Hook에서 호출)

```bash
# 세션 시작
code-memory session-start --session-id <id> --cwd <path>

# 기억 검색
code-memory search --query <text> --limit 5 --threshold 0.7

# 대화 저장
code-memory save --stdin  # JSON 입력 수신

# 세션 종료
code-memory session-end --session-id <id>

# 데이터베이스 초기화
code-memory init

# 임베딩 재생성
code-memory reindex
```

---

## 6. 설정

### 6.1 plugin.json

```json
{
  "name": "code-memory",
  "description": "Learn from conversations to provide personalized assistance",
  "version": "1.0.0",
  "author": {
    "name": "Buzzni"
  },
  "homepage": "https://github.com/buzzni/code-memory",
  "repository": {
    "type": "git",
    "url": "https://github.com/buzzni/code-memory.git"
  },
  "license": "MIT",
  "engines": {
    "claude-code": ">=1.0.33"
  },
  "keywords": ["memory", "learning", "personalization", "context"]
}
```

### 6.2 사용자 설정 (config.json)

```json
{
  "storage": {
    "path": "~/.claude-code/memory",
    "maxSizeMB": 500
  },
  "embedding": {
    "provider": "local",           // "local" | "openai"
    "model": "all-MiniLM-L6-v2",   // local 모델
    "openaiModel": "text-embedding-3-small",
    "batchSize": 32
  },
  "retrieval": {
    "topK": 5,
    "minScore": 0.7,
    "maxTokens": 2000              // 주입할 최대 토큰 수
  },
  "matching": {
    "minCombinedScore": 0.92,      // 확정 매칭 최소 점수 (AXIOMMIND)
    "minGap": 0.03,                // 1위-2위 간 최소 점수 차이
    "suggestionThreshold": 0.75,   // 제안 모드 임계값
    "weights": {
      "semanticSimilarity": 0.4,   // 벡터 유사도 가중치
      "ftsScore": 0.25,            // 전문 검색 가중치
      "recencyBonus": 0.2,         // 최신성 가산점
      "statusWeight": 0.15         // 상태별 가중치
    }
  },
  "privacy": {
    "excludePatterns": [           // 저장 제외 패턴
      "password",
      "secret",
      "api_key"
    ],
    "anonymize": false
  },
  "features": {
    "autoSave": true,
    "sessionSummary": true,
    "insightExtraction": true,
    "crossProjectLearning": false, // 프로젝트 간 학습
    "singleWriterMode": true       // Outbox 패턴 사용 (권장)
  }
}
```

### 6.3 Matching Thresholds (AXIOMMIND 기반)

검색 결과의 신뢰도를 3단계로 분류:

| 신뢰도 | 조건 | 동작 |
|--------|------|------|
| **high** | score ≥ 0.92 AND gap ≥ 0.03 | 확정 매칭, 자동 컨텍스트 주입 |
| **suggested** | 0.75 ≤ score < 0.92 | 제안 모드, 사용자 확인 권장 |
| **none** | score < 0.75 | 매칭 없음 |

```typescript
// Matching 결과 타입
interface MatchResult {
  readonly match: MemoryMatch | null;
  readonly confidence: 'high' | 'suggested' | 'none';
  readonly gap?: number;  // top-1과 top-2 간 점수 차이
  readonly alternatives?: ReadonlyArray<MemoryMatch>;  // suggested일 때 대안들
}
```

---

## 7. 보안 및 프라이버시

### 7.1 데이터 보호

1. **로컬 저장**: 모든 데이터는 사용자 로컬에만 저장
2. **민감 정보 필터링**: password, secret, api_key 등 자동 제외
3. **선택적 익명화**: 개인 식별 정보 마스킹 옵션

### 7.2 데이터 삭제

```bash
# 특정 기억 삭제
code-memory forget --id <event_id>

# 세션 전체 삭제
code-memory forget --session <session_id>

# 기간별 삭제
code-memory forget --before "2024-01-01"

# 전체 초기화
code-memory reset --confirm
```

---

## 8. 성능 요구사항

| 항목 | 목표 | 비고 |
|------|------|------|
| **검색 지연** | < 500ms | 10만 건 기준 |
| **저장 지연** | < 100ms | 비동기 처리 |
| **메모리 사용** | < 200MB | 실행 시 |
| **디스크 사용** | < 500MB | 기본 제한 |
| **시작 시간** | < 2s | 세션 시작 |

---

## 9. 의존성

### 9.1 런타임 의존성

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `lancedb` | ^0.5.0 | 벡터 저장소 |
| `duckdb` | ^0.10.0 | 이벤트 저장소 |
| `sentence-transformers` | ^2.2.0 | 로컬 임베딩 (Python) |
| `@xenova/transformers` | ^2.15.0 | 로컬 임베딩 (JS) |
| `zod` | ^3.22.0 | 스키마 검증 |
| `commander` | ^12.0.0 | CLI 파싱 |

### 9.2 개발 의존성

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `typescript` | ^5.4.0 | 타입 시스템 |
| `vitest` | ^1.4.0 | 테스트 |
| `tsx` | ^4.7.0 | TS 실행 |
| `esbuild` | ^0.20.0 | 빌드 |

---

## 10. 향후 확장

### Phase 2 (v1.1.0)
- [ ] 그래프 기반 관계 저장 (Neo4j/Graphiti)
- [ ] 멀티 프로젝트 학습
- [ ] 팀 기억 공유 (암호화)

### Phase 3 (v2.0.0)
- [ ] 자동 인사이트 추출 (LLM 기반)
- [ ] 코드 스니펫 특화 기억
- [ ] IDE 통합 (VSCode extension)

---

## 11. 성공 지표

| 지표 | 측정 방법 | 목표 |
|------|----------|------|
| **관련성** | 사용자 피드백 | 80%+ 유용 |
| **속도** | 응답 지연 | < 500ms |
| **채택률** | 활성 사용자 | 1000+ |
| **재사용률** | 기억 활용 빈도 | 50%+ 세션 |
