# Code Memory

Claude Code 플러그인으로, 대화 내용을 기억하여 사용할수록 똑똑해지는 AI 어시스턴트를 만듭니다.

## 개요

Code Memory는 Claude Code에서 사용자와 AI 간의 모든 대화를 저장하고, 새로운 질문을 할 때 관련된 과거 대화를 자동으로 검색하여 컨텍스트로 제공합니다. 이를 통해:

- **연속성 있는 대화**: 이전 세션에서 논의한 내용을 기억
- **프로젝트 맥락 이해**: 프로젝트별로 축적된 지식 활용
- **개인화된 응답**: 사용자의 선호도와 패턴 학습

## Features

- **Conversation Memory**: 사용자 프롬프트와 AI 응답 저장
- **Semantic Search**: 벡터 임베딩을 통한 의미 기반 검색
- **AXIOMMIND Architecture**: 7가지 원칙 기반 안정적 메모리 관리
- **Memory Graduation**: L0→L4 단계별 메모리 승격
- **Evidence Alignment**: 응답이 실제 기억에 기반했는지 검증
- **History Import**: 기존 Claude Code 세션 기록 임포트

## 설치 방법

### 1. 의존성 설치

```bash
cd code-memory
npm install
```

### 2. 빌드

```bash
npm run build
```

### 3. Claude Code에 플러그인 등록

빌드된 플러그인을 Claude Code 설정에 추가합니다:

```bash
# Claude Code 설정 디렉토리에 플러그인 복사
cp -r dist/.claude-plugin ~/.claude/plugins/code-memory/
```

## 사용 방법

### 자동 동작 (Hooks)

플러그인은 Claude Code 세션에 자동으로 연결되어 동작합니다:

| Hook | 동작 |
|------|------|
| **SessionStart** | 세션 시작 시 프로젝트 관련 컨텍스트 로드 |
| **UserPromptSubmit** | 프롬프트 입력 시 관련 기억 검색 및 저장 |
| **Stop** | AI 응답 완료 시 응답 내용 저장 |
| **SessionEnd** | 세션 종료 시 요약 생성 및 저장 |

### Slash 명령어

Claude Code 내에서 사용할 수 있는 명령어:

```bash
# 메모리 검색 - 관련 기억 찾기
/memory-search "authentication 구현 방법"

# 대화 기록 보기
/memory-history
/memory-history --limit 50
/memory-history --session <session-id>

# 통계 확인
/memory-stats

# 기존 대화 기록 임포트
/memory-import                            # 현재 프로젝트
/memory-import --all                      # 모든 프로젝트
/memory-import --project /path/to/project # 특정 프로젝트

# 임포트 가능한 세션 목록
/memory-list

# 메모리 삭제
/memory-forget --session <id> --confirm
```

### CLI 명령어

터미널에서 직접 사용:

```bash
# 메모리 검색
npx code-memory search "React 컴포넌트 패턴"
npx code-memory search "API 에러 처리" --top-k 10

# 대화 기록 조회
npx code-memory history
npx code-memory history --limit 50 --type user_prompt

# 통계 확인
npx code-memory stats

# 기존 세션 임포트
npx code-memory import                    # 현재 프로젝트
npx code-memory import --all              # 모든 프로젝트
npx code-memory import --all --verbose    # 상세 로그

# 임포트 가능한 세션 목록
npx code-memory list
npx code-memory list --project /path/to/project

# 임베딩 수동 처리
npx code-memory process
```

## 기존 대화 기록 임포트

이미 Claude Code를 사용해왔다면, 기존 대화 기록을 임포트하여 바로 활용할 수 있습니다:

```bash
# 1. 먼저 임포트 가능한 세션 확인
npx code-memory list

# 2. 현재 프로젝트의 모든 세션 임포트
npx code-memory import

# 3. 또는 모든 프로젝트의 세션 임포트
npx code-memory import --all --verbose
```

### 임포트 결과 예시

```
📥 Importing all sessions from all projects

⏳ Processing embeddings...

✅ Import Complete

Sessions processed: 15
Total messages: 342
Imported prompts: 156
Imported responses: 186
Skipped duplicates: 0
Embeddings processed: 342
```

### 중복 처리

임포트는 콘텐츠 해시 기반으로 중복을 자동 감지합니다. 여러 번 실행해도 같은 내용이 중복 저장되지 않습니다.

## 동작 원리

### 1. 메모리 저장

```
사용자 프롬프트 입력
        ↓
    EventStore에 저장 (DuckDB, append-only)
        ↓
    Outbox에 임베딩 요청 등록
        ↓
    Vector Worker가 임베딩 생성
        ↓
    VectorStore에 저장 (LanceDB)
```

### 2. 메모리 검색

```
새 프롬프트 입력
        ↓
    임베딩 생성
        ↓
    VectorStore에서 유사 벡터 검색
        ↓
    AXIOMMIND Matcher로 신뢰도 계산
        ↓
    컨텍스트로 Claude에 제공
```

### 3. 메모리 승격 (Graduation)

자주 참조되는 메모리는 더 높은 레벨로 승격됩니다:

| Level | 이름 | 설명 | 승격 조건 |
|-------|------|------|-----------|
| L0 | EventStore | 원본 이벤트 | 기본 저장 |
| L1 | Structured | 구조화된 패턴 | 3회 이상 접근 |
| L2 | Candidates | 검증된 스키마 | 5회 이상, 다중 세션 참조 |
| L3 | Verified | 교차 검증됨 | 높은 신뢰도 |
| L4 | Active | 활성 지식 | 10회 이상, 3개 이상 세션 |

## 매칭 신뢰도

검색 결과는 신뢰도에 따라 분류됩니다:

| 신뢰도 | 점수 | Gap | 동작 |
|--------|------|-----|------|
| **High** | ≥0.92 | ≥0.03 | 자동으로 컨텍스트에 포함 |
| **Suggested** | ≥0.75 | <0.03 | 대안 제시 |
| **None** | <0.75 | - | 매칭 없음 |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code Hooks                       │
│  SessionStart │ UserPromptSubmit │ Stop │ SessionEnd        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Memory Service                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Retriever  │  │   Matcher   │  │  Graduation │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                      ▼
┌───────────────┐                    ┌───────────────┐
│  EventStore   │ ──── Outbox ────▶ │  VectorStore  │
│   (DuckDB)    │                    │   (LanceDB)   │
└───────────────┘                    └───────────────┘
```

## AXIOMMIND 7 원칙

1. **Single Source of Truth**: DuckDB EventStore가 유일한 진실의 원천
2. **Append-Only**: 이벤트는 수정/삭제 없이 추가만
3. **Idempotency**: dedupe_key로 중복 이벤트 감지
4. **Evidence Alignment**: 주장이 실제 소스에 기반했는지 검증
5. **Entity-Based Tasks**: canonical_key로 일관된 엔티티 식별
6. **Vector Store Consistency**: DuckDB → LanceDB 단방향 흐름
7. **Standard JSON**: 모든 데이터는 이식 가능한 JSON 형식

## 저장 위치

메모리는 기본적으로 다음 위치에 저장됩니다:

```
~/.claude-code/memory/
├── events.duckdb     # 이벤트 저장소
└── vectors/          # 벡터 임베딩
```

Claude Code 세션 기록 위치:

```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

## 개발

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 테스트
npm test

# 타입 체크
npm run typecheck

# 개발 모드 실행
npm run dev
```

## 기술 스택

- **DuckDB**: 이벤트 저장소 (append-only SQL)
- **LanceDB**: 벡터 저장소 (고성능 벡터 검색)
- **@xenova/transformers**: 로컬 임베딩 생성
- **Zod**: 런타임 타입 검증
- **Commander**: CLI 인터페이스
- **TypeScript**: 타입 안전한 코드

## License

MIT
