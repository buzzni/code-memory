# Context: Claude Code Memory Plugin

## 1. 프로젝트 배경

이 문서는 Claude Code용 Memory Plugin 개발을 위한 배경 연구와 참조 자료를 정리합니다.

### 1.1 목표

사용자가 Claude Code를 사용할수록 더 똑똑해지는 Agent를 만들기 위한 플러그인 개발:
- 사용자 prompt와 agent 응답을 지속적으로 기억
- 새로운 prompt 입력 시 관련된 과거 기억을 검색하여 컨텍스트로 활용
- 시간이 지남에 따라 개인화된 경험 제공

---

## 2. Claude Code Plugin System 분석

### 2.1 플러그인 구조

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json          # 플러그인 메타데이터 (필수)
├── commands/                # 슬래시 명령어 (선택)
├── agents/                  # 전문화된 에이전트 (선택)
├── skills/                  # 에이전트 스킬 (선택)
├── hooks/                   # 이벤트 핸들러 (선택)
├── .mcp.json               # MCP 서버 구성 (선택)
└── README.md               # 문서
```

### 2.2 사용 가능한 Hook 이벤트

| Hook Event | 용도 | Memory Plugin 활용 |
|------------|------|-------------------|
| `SessionStart` | 세션 시작 시 실행 | 이전 세션 기억 로드 |
| `SessionEnd` | 세션 종료 시 실행 | 현재 세션 기억 저장 |
| `UserPromptSubmit` | 사용자 입력 시 실행 | 관련 기억 검색 및 주입 |
| `PreToolUse` | 도구 실행 전 | 도구별 과거 사용 패턴 제공 |
| `PostToolUse` | 도구 실행 후 | 도구 결과 기억 |
| `Stop` | Agent 응답 완료 시 | 전체 대화 기억 저장 |
| `PreCompact` | 컨텍스트 압축 전 | 중요 기억 보존 |

### 2.3 Hook Input/Output 형식

```json
// UserPromptSubmit hook input
{
  "session_id": "...",
  "prompt": "사용자가 입력한 텍스트",
  "timestamp": "..."
}

// Hook은 stdout으로 결과 반환
// - 빈 출력: 변경 없음
// - JSON 출력: 컨텍스트 주입 또는 수정
```

---

## 3. AI Memory System 연구

### 3.1 Memory의 종류

| 유형 | 설명 | 지속성 |
|------|------|--------|
| **Short-term Memory** | 현재 대화 컨텍스트 | 세션 내 |
| **Long-term Memory** | 사용자 선호도, 과거 인사이트 | 영구적 |
| **Episodic Memory** | 구체적인 대화/이벤트 기억 | 영구적 |
| **Semantic Memory** | 추출된 지식과 관계 | 영구적 |

### 3.2 주요 Memory 솔루션 비교

| 솔루션 | 특징 | 장점 |
|--------|------|------|
| **Mem0** | Y Combinator 투자, 그래프 기반 | 복잡한 관계 표현 |
| **LangChain Memory** | 프레임워크 내장 | 쉬운 통합 |
| **Zep/Graphiti** | 시간적 지식 그래프 | 시계열 추적 |
| **AWS AgentCore Memory** | 비동기 파이프라인 | 확장성 |
| **Google Vertex Memory Bank** | 유사도 검색 | 엔터프라이즈 |

### 3.3 Memory vs RAG

- **RAG**: 외부 문서에서 정보 검색 (stateless)
- **Memory**: 과거 상호작용에서 컨텍스트 검색 (stateful)
- **이 플러그인**: Memory 중심 + 선택적 RAG 통합

---

## 4. AXIOMMIND Memory System 참조

Gist에서 제공된 AXIOMMIND 시스템의 핵심 개념:

### 4.1 아키텍처 레이어

```
┌─────────────────────────────────────────────────────────┐
│  L0 EventStore (Single Source of Truth)                 │
│  - Append-only events table                             │
│  - Event deduplication via dedupe_key                   │
│  - Projection offset tracking                           │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Extraction/Sorting Layer (LLM Processing)              │
│  - LLM extracts structured JSON from raw input          │
│  - Evidence alignment and validation                    │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  Derived Stores (Rebuildable from Events)               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   DuckDB    │  │   LanceDB   │  │  Relational │    │
│  │  (FTS/SQL)  │  │  (Vectors)  │  │   Views     │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 4.2 핵심 원칙

- **Append-only EventStore**: 모든 변경 추적, 파생 저장소에서 언제든 재구성 가능
- **Canonical Key 정규화**: 동일 개념의 여러 표현을 단일 키로 통합
- **단일 진실 공급원(SoT)**: events 테이블만 영구 저장, 나머지는 파생
- **멱등성 보장**: `dedupe_key`로 중복 이벤트 차단

### 4.3 Canonical Key 정규화 (핵심 알고리즘)

```python
# canonical_key.py - 결정론적 키 생성
def make_canonical_key(title: str, project: str = None) -> str:
    """
    동일한 제목은 항상 동일한 키를 생성

    정규화 단계:
    1. NFKC 유니코드 정규화
    2. 소문자 변환
    3. 구두점 제거
    4. 연속 공백 정리
    5. (선택) 프로젝트/도메인 컨텍스트 추가
    6. 긴 키는 MD5 체크섬으로 truncate
    """
    import unicodedata
    import re
    import hashlib

    # Step 1-4: 정규화
    normalized = unicodedata.normalize('NFKC', title)
    normalized = normalized.lower()
    normalized = re.sub(r'[^\w\s]', '', normalized)
    normalized = re.sub(r'\s+', ' ', normalized).strip()

    # Step 5: 컨텍스트 추가
    if project:
        key = f"{project}::{normalized}"
    else:
        key = normalized

    # Step 6: 긴 키 처리
    MAX_KEY_LENGTH = 200
    if len(key) > MAX_KEY_LENGTH:
        hash_suffix = hashlib.md5(key.encode()).hexdigest()[:8]
        key = key[:MAX_KEY_LENGTH - 9] + "_" + hash_suffix

    return key
```

**Memory Plugin 적용**:
- 사용자 prompt의 canonical key로 중복 질문 감지
- 유사한 질문들을 그룹화하여 패턴 추출

### 4.4 Matching Thresholds (엄격한 매칭 기준)

```python
# task_matcher.py - 매칭 임계값
MATCH_THRESHOLDS = {
    "min_combined_score": 0.92,   # 최소 결합 점수
    "min_gap": 0.03,              # 1위와 2위 간 최소 점수 차이
    "suggestion_threshold": 0.75, # 제안 모드 임계값
}

def calculate_weighted_score(result: SearchResult) -> float:
    """
    가중치 점수 계산 (stage, status, recency)
    """
    weights = {
        "semantic_similarity": 0.4,  # 벡터 유사도
        "fts_score": 0.25,           # 전문 검색 점수
        "recency_bonus": 0.2,        # 최신성 가산점
        "status_weight": 0.15,       # 상태별 가중치
    }

    score = (
        result.vector_score * weights["semantic_similarity"] +
        result.fts_score * weights["fts_score"] +
        result.recency_score * weights["recency_bonus"] +
        result.status_score * weights["status_weight"]
    )
    return score

def match_with_confidence(query: str, candidates: list) -> MatchResult:
    """
    엄격한 매칭: top-1이 확실히 우세할 때만 확정
    """
    if len(candidates) == 0:
        return MatchResult(match=None, confidence="none")

    top = candidates[0]

    if top.score < MATCH_THRESHOLDS["suggestion_threshold"]:
        return MatchResult(match=None, confidence="none")

    if top.score >= MATCH_THRESHOLDS["min_combined_score"]:
        if len(candidates) == 1:
            return MatchResult(match=top, confidence="high")

        gap = top.score - candidates[1].score
        if gap >= MATCH_THRESHOLDS["min_gap"]:
            return MatchResult(match=top, confidence="high")

    # 점수가 높지만 확실하지 않음 → 제안 모드
    return MatchResult(match=top, confidence="suggested")
```

**Memory Plugin 적용**:
- 관련 기억 검색 시 엄격한 임계값 적용
- 애매한 매칭은 "suggested" 상태로 표시

### 4.5 Single-Writer Pattern (벡터 동시성 제어)

```python
# vector_worker.py - Outbox 패턴으로 동시성 제어

"""
LanceDB는 동시 쓰기에 취약하므로 Single-Writer 패턴 사용:
1. 이벤트 저장 시 embedding_outbox 테이블에 작업 추가
2. 별도 워커가 outbox를 순차적으로 처리
3. 처리 완료 시 outbox에서 삭제
"""

# DuckDB의 outbox 테이블
CREATE TABLE embedding_outbox (
    id              UUID PRIMARY KEY,
    event_id        UUID NOT NULL,
    content         TEXT NOT NULL,
    status          VARCHAR DEFAULT 'pending',  -- 'pending' | 'processing' | 'done'
    created_at      TIMESTAMP DEFAULT NOW(),
    processed_at    TIMESTAMP
);

# Python 워커 (단일 프로세스)
class VectorWorker:
    def __init__(self, db: DuckDB, lance: LanceDB, embedder: Embedder):
        self.db = db
        self.lance = lance
        self.embedder = embedder

    async def process_outbox(self, batch_size: int = 32):
        """
        Outbox에서 pending 항목을 가져와 순차 처리
        """
        # 1. Pending 항목 가져오기 (락 획득)
        pending = self.db.execute("""
            UPDATE embedding_outbox
            SET status = 'processing'
            WHERE id IN (
                SELECT id FROM embedding_outbox
                WHERE status = 'pending'
                ORDER BY created_at
                LIMIT ?
            )
            RETURNING *
        """, [batch_size])

        if not pending:
            return

        # 2. 배치 임베딩 생성
        contents = [p.content for p in pending]
        vectors = await self.embedder.embed_batch(contents)

        # 3. LanceDB에 저장 (단일 쓰기)
        records = [
            {"event_id": p.event_id, "content": p.content, "vector": v}
            for p, v in zip(pending, vectors)
        ]
        self.lance.add(records)

        # 4. Outbox 정리
        ids = [p.id for p in pending]
        self.db.execute("""
            DELETE FROM embedding_outbox WHERE id = ANY(?)
        """, [ids])
```

**Memory Plugin 적용**:
- 대화 저장 시 즉시 반환, 임베딩은 비동기 처리
- 동시성 문제 없이 안정적인 벡터 인덱싱

### 4.6 Blocker/Condition 분류 전략

```python
# task_resolver.py - 애매한 참조 처리

"""
Blocker 분류 전략:
1. Artifact: URL, Jira, GitHub 이슈 등 명확한 참조
2. Task: 엄격한 매칭만 허용 (score >= 0.92)
3. Condition: 애매한 참조 흡수 (나중에 해결 가능)
"""

class BlockerType(Enum):
    ARTIFACT = "artifact"    # 명확한 외부 참조
    TASK = "task"            # 확정된 작업 참조
    CONDITION = "condition"  # 애매한 조건/참조

def classify_blocker(reference: str, match_result: MatchResult) -> BlockerType:
    # URL, 이슈 번호 등은 Artifact
    if is_artifact_reference(reference):
        return BlockerType.ARTIFACT

    # 높은 신뢰도 매칭은 Task
    if match_result.confidence == "high":
        return BlockerType.TASK

    # 나머지는 Condition으로 흡수
    return BlockerType.CONDITION

# Condition은 나중에 실제 Task로 해결될 수 있음
# resolves_to edge로 연결
```

**Memory Plugin 적용**:
- 불완전한 컨텍스트도 일단 저장
- 나중에 추가 정보로 보강 가능

### 4.7 Query Patterns (효과적인 뷰 활용)

```sql
-- v_task_blockers_effective: Condition 해결을 반영한 최종 blocker 뷰
CREATE VIEW v_memory_context_effective AS
SELECT
    m.id,
    m.session_id,
    m.content,
    m.event_type,
    m.timestamp,
    -- Condition이 해결된 경우 실제 참조로 대체
    COALESCE(r.resolved_content, m.content) as effective_content,
    COALESCE(r.resolved_id, m.id) as effective_id
FROM memories m
LEFT JOIN memory_resolutions r ON m.id = r.condition_id
WHERE r.resolution_type IS NULL OR r.resolution_type = 'confirmed';

-- 4가지 주요 쿼리 패턴
-- 1. 확정된 관련 기억
SELECT * FROM v_memory_context_effective
WHERE semantic_score >= 0.92;

-- 2. 제안 상태의 기억 (확인 대기)
SELECT * FROM memories
WHERE match_confidence = 'suggested';

-- 3. 자동 플레이스홀더 감지
SELECT * FROM memories
WHERE auto_placeholder = true;

-- 4. 해결된 조건 매핑
SELECT condition_id, resolved_to_id
FROM memory_resolutions
WHERE resolution_type = 'confirmed';
```

### 4.8 Placeholder 자동 생성

```python
# 정보가 불완전할 때 플레이스홀더 생성
def create_placeholder_if_needed(event: MemoryEvent) -> Optional[Placeholder]:
    """
    컨텍스트가 불완전하면 자동 플레이스홀더 생성
    - auto_placeholder=true 플래그 설정
    - 나중에 추가 정보로 해결 가능
    """
    if is_incomplete_context(event):
        return Placeholder(
            id=generate_uuid(),
            event_id=event.id,
            placeholder_type="unknown_context",
            auto_placeholder=True,
            created_at=datetime.now()
        )
    return None
```

### 4.9 주요 모듈 요약

| 모듈 | 역할 | Memory Plugin 대응 |
|------|------|-------------------|
| `canonical_key.py` | 결정론적 키 정규화 | `normalizer.ts` |
| `event_store.py` | append-only 이벤트 저장 | `event-store.ts` |
| `task_matcher.py` | 가중치 기반 매칭 | `matcher.ts` |
| `task_resolver.py` | 상태 전이 검증 | `resolver.ts` |
| `projector_task.py` | 이벤트→엔티티 투영 | `projector.ts` |
| `vector_worker.py` | 단일 쓰기 임베딩 | `vector-worker.ts` |

---

## 5. 기술 스택 선택

### 5.1 Vector Database: LanceDB

선택 이유:
- **Embedded 모드**: SQLite처럼 서버 없이 로컬 실행
- **Apache Arrow 기반**: 빠른 디스크 접근
- **다중 모달 지원**: 텍스트, 이미지, 오디오 임베딩
- **DuckDB 호환**: SQL 쿼리 가능

```python
import lancedb

db = lancedb.connect("~/.claude-memory")
table = db.create_table("conversations", data)
results = table.search(query_embedding).limit(10).to_list()
```

### 5.2 관계형 저장소: DuckDB

선택 이유:
- **임베디드**: 파일 기반, 서버 불필요
- **분석 최적화**: OLAP 워크로드에 적합
- **SQL 지원**: 친숙한 쿼리 언어
- **Lance 포맷 호환**: LanceDB와 통합

### 5.3 Embedding Model

옵션:
1. **OpenAI text-embedding-3-small**: 고품질, API 비용
2. **sentence-transformers**: 로컬 실행, 무료
3. **Ollama embeddings**: 로컬 LLM 활용

권장: sentence-transformers (로컬 우선) + OpenAI fallback

---

## 6. Idris2 활용 고려사항

### 6.1 Idris2 개요

- **의존적 타입 시스템**: 타입 수준에서 프로그램 검증
- **Type-Driven Development**: 타입이 프로그램 설계를 가이드
- **Quantitative Type Theory (QTT)**: 선형 타입 지원

### 6.2 적용 가능 영역

1. **타입 안전한 이벤트 스키마**
   ```idris
   data MemoryEvent : Type where
     UserPrompt : (sessionId : String) -> (content : String) -> MemoryEvent
     AgentResponse : (sessionId : String) -> (content : String) -> MemoryEvent
   ```

2. **불변성 보장**
   - Append-only EventStore의 불변성을 타입 수준에서 강제

3. **정확성 증명**
   - 중복 제거 로직의 정확성 검증
   - 검색 알고리즘의 속성 증명

### 6.3 실용적 접근

Idris2를 직접 사용하기보다 **개념적 영감**으로 활용:
- TypeScript의 강타입 시스템 적극 활용
- Zod/io-ts로 런타임 타입 검증
- 불변 데이터 구조 (Immutable.js 또는 순수 함수형 패턴)

---

## 7. 참조 링크

### Claude Code Plugin 개발
- [Create plugins - Claude Code Docs](https://code.claude.com/docs/en/plugins)
- [Claude Code Plugins README](https://github.com/anthropics/claude-code/blob/main/plugins/README.md)
- [Hook Development SKILL](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/SKILL.md)
- [Claude Code Plugins Complete Guide](https://jangwook.net/en/blog/en/claude-code-plugins-complete-guide/)

### AI Memory Systems
- [Mem0: Building Production-Ready AI Agents](https://arxiv.org/pdf/2504.19413)
- [AWS AgentCore Long-term Memory](https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/)
- [Google Vertex AI Memory Bank](https://docs.cloud.google.com/agent-builder/agent-engine/memory-bank/overview)
- [LangChain Conversational Memory](https://www.pinecone.io/learn/series/langchain/langchain-conversational-memory/)

### Vector Databases
- [LanceDB](https://lancedb.com/)
- [Lance Format on GitHub](https://github.com/lance-format/lance)

### Idris2
- [Idris2 Official Site](https://www.idris-lang.org/)
- [Idris 2: Quantitative Type Theory in Practice](https://arxiv.org/abs/2104.00480)
- [Idris2 GitHub](https://github.com/idris-lang/Idris2)

---

## 8. 용어 정의

| 용어 | 정의 |
|------|------|
| **Memory** | 과거 대화에서 추출/저장된 정보 |
| **Embedding** | 텍스트를 벡터로 변환한 표현 |
| **Semantic Search** | 의미 기반 유사도 검색 |
| **EventStore** | 모든 이벤트를 시간순으로 저장하는 append-only 저장소 |
| **Hook** | 특정 이벤트 발생 시 실행되는 스크립트 |
| **MCP** | Model Context Protocol - Claude와 외부 도구 연결 |
