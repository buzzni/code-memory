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
L0 EventStore (원본)
    ↓
추출/정렬 계층 (LLM 처리)
    ↓
파생 저장소 (DuckDB, LanceDB, 관계형 뷰)
```

### 4.2 핵심 원칙

- **Append-only EventStore**: 모든 변경 추적, 재구성 가능
- **Canonical Key 정규화**: 동일 개념의 여러 표현 통합
- **단일 진실 공급원(SoT)**: events 테이블만 영구 저장
- **멱등성 보장**: 중복 처리 차단

### 4.3 주요 모듈

| 모듈 | 역할 |
|------|------|
| `event_store.py` | 중복 제거 및 이벤트 추가 |
| `task_resolver.py` | 작업 상태 관리 |
| `projector_task.py` | 이벤트 → 엔티티/관계 변환 |
| `vector_worker.py` | 임베딩 벡터화 |

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
