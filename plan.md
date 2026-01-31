# Implementation Plan: Claude Code Memory Plugin

## 1. 개발 단계 개요

AXIOMMIND 파이프라인 구현 단계에 맞춰 구성:

```
┌─────────────────────────────────────────────────────────────────┐
│  P0: 필수 품질 (Must Have)                                      │
│  ├── EventStore (append-only, dedupe)                          │
│  ├── EvidenceAligner (증거 스팬 정렬)                           │
│  ├── Task Entity System (canonical_key)                        │
│  ├── Vector Outbox (single-writer)                             │
│  ├── Basic Hooks (SessionStart, Stop)                          │
│  └── CLI 기본 명령어                                            │
├─────────────────────────────────────────────────────────────────┤
│  P1: 운영 (Operations)                                          │
│  ├── build_runs 테이블 (파이프라인 실행 추적)                    │
│  ├── conflict_ledger (충돌 기록)                                │
│  ├── decision_ledger (의사결정 기록)                            │
│  ├── 메트릭 스켈레톤                                            │
│  └── 에러 복구 메커니즘                                          │
├─────────────────────────────────────────────────────────────────┤
│  P2: 검색 (Retrieval)                                           │
│  ├── 하이브리드 검색 (Vector + FTS)                             │
│  ├── 골드셋 평가 시스템                                          │
│  ├── 인사이트 추출 (LLM 기반)                                   │
│  └── L2→L3→L4 승격 파이프라인                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 구현 Phase 매핑

| AXIOMMIND | 플러그인 Phase | 핵심 산출물 |
|-----------|---------------|-------------|
| **P0** | Phase 0-1 | EventStore, VectorWorker, 기본 Hook |
| **P0** | Phase 2-3 | Embedder, Retriever, Hook 통합 |
| **P1** | Phase 4 | CLI, 운영 도구, 메트릭 |
| **P2** | Phase 5 | 하이브리드 검색, 평가, 최적화 |

```
Phase 0: 프로젝트 설정
    ↓
Phase 1: Core Storage Layer (P0 - EventStore, Outbox)
    ↓
Phase 2: Embedding & Retrieval (P0 - Vector, Matcher)
    ↓
Phase 3: Hook Integration (P0 - 기본 동작)
    ↓
Phase 4: Commands & CLI (P1 - 운영)
    ↓
Phase 5: Testing & Polish (P2 - 검색 최적화)
```

---

## Phase 0: 프로젝트 설정

### 0.1 디렉토리 구조 생성

```
code-memory/
├── .claude-plugin/
│   └── plugin.json              # 플러그인 메타데이터
├── commands/
│   ├── search.md                # /code-memory:search
│   ├── history.md               # /code-memory:history
│   ├── insights.md              # /code-memory:insights
│   ├── forget.md                # /code-memory:forget
│   └── stats.md                 # /code-memory:stats
├── hooks/
│   └── hooks.json               # Hook 설정
├── src/
│   ├── cli/
│   │   ├── index.ts             # CLI 엔트리포인트
│   │   ├── commands/
│   │   │   ├── session-start.ts
│   │   │   ├── session-end.ts
│   │   │   ├── search.ts
│   │   │   ├── save.ts
│   │   │   └── init.ts
│   │   └── utils.ts
│   ├── core/
│   │   ├── canonical-key.ts     # 정규화된 키 생성 (AXIOMMIND)
│   │   ├── event-store.ts       # DuckDB 이벤트 저장소
│   │   ├── vector-store.ts      # LanceDB 벡터 저장소
│   │   ├── vector-worker.ts     # Single-writer 패턴 워커 (AXIOMMIND)
│   │   ├── embedder.ts          # 임베딩 생성
│   │   ├── matcher.ts           # 가중치 기반 매칭 (AXIOMMIND)
│   │   ├── evidence-aligner.ts  # 증거 스팬 정렬 (AXIOMMIND 원칙4)
│   │   ├── retriever.ts         # 기억 검색
│   │   ├── projector.ts         # 이벤트→엔티티 투영 (AXIOMMIND)
│   │   ├── graduation.ts        # L0→L4 승격 파이프라인 (AXIOMMIND)
│   │   └── types.ts             # 타입 정의
│   ├── hooks/
│   │   ├── session-start.ts
│   │   ├── user-prompt-submit.ts
│   │   ├── stop.ts
│   │   └── session-end.ts
│   └── index.ts
├── tests/
│   ├── event-store.test.ts
│   ├── vector-store.test.ts
│   ├── retriever.test.ts
│   └── integration.test.ts
├── scripts/
│   └── build.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── spec.md
├── plan.md
└── context.md
```

### 0.2 초기 설정 작업

```bash
# 1. package.json 생성
npm init -y

# 2. TypeScript 및 핵심 의존성 설치
npm install -D typescript @types/node tsx esbuild vitest

# 3. 런타임 의존성
npm install zod commander duckdb lancedb

# 4. 임베딩 (선택)
npm install @xenova/transformers  # 또는 Python sentence-transformers
```

### 0.3 TypeScript 설정

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## Phase 1: Core Storage Layer

### 1.1 타입 정의 (src/core/types.ts)

```typescript
// Idris2 영감: 완전하고 불변한 타입 정의

import { z } from 'zod';

// 이벤트 타입 스키마
export const EventTypeSchema = z.enum([
  'user_prompt',
  'agent_response',
  'session_summary'
]);
export type EventType = z.infer<typeof EventTypeSchema>;

// 메모리 이벤트 스키마
export const MemoryEventSchema = z.object({
  id: z.string().uuid(),
  eventType: EventTypeSchema,
  sessionId: z.string(),
  timestamp: z.date(),
  content: z.string(),
  contentHash: z.string(),
  metadata: z.record(z.unknown()).optional()
});
export type MemoryEvent = z.infer<typeof MemoryEventSchema>;

// 세션 스키마
export const SessionSchema = z.object({
  id: z.string(),
  startedAt: z.date(),
  endedAt: z.date().optional(),
  projectPath: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional()
});
export type Session = z.infer<typeof SessionSchema>;

// 검색 결과
export const MemoryMatchSchema = z.object({
  event: MemoryEventSchema,
  score: z.number().min(0).max(1),
  relevanceReason: z.string().optional()
});
export type MemoryMatch = z.infer<typeof MemoryMatchSchema>;

// 설정 스키마
export const ConfigSchema = z.object({
  storage: z.object({
    path: z.string().default('~/.claude-code/memory'),
    maxSizeMB: z.number().default(500)
  }),
  embedding: z.object({
    provider: z.enum(['local', 'openai']).default('local'),
    model: z.string().default('all-MiniLM-L6-v2'),
    batchSize: z.number().default(32)
  }),
  retrieval: z.object({
    topK: z.number().default(5),
    minScore: z.number().default(0.7),
    maxTokens: z.number().default(2000)
  })
});
export type Config = z.infer<typeof ConfigSchema>;

// AXIOMMIND: Matching 결과 타입
export const MatchConfidenceSchema = z.enum(['high', 'suggested', 'none']);
export type MatchConfidence = z.infer<typeof MatchConfidenceSchema>;

export const MatchResultSchema = z.object({
  match: MemoryMatchSchema.nullable(),
  confidence: MatchConfidenceSchema,
  gap: z.number().optional(),
  alternatives: z.array(MemoryMatchSchema).optional()
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

// AXIOMMIND: Matching Thresholds
export const MATCH_THRESHOLDS = {
  minCombinedScore: 0.92,
  minGap: 0.03,
  suggestionThreshold: 0.75
} as const;
```

### 1.2 Canonical Key 구현 (src/core/canonical-key.ts) - AXIOMMIND

```typescript
/**
 * AXIOMMIND canonical_key.py 포팅
 * 동일한 제목은 항상 동일한 키를 생성하는 결정론적 정규화
 */

import { createHash } from 'crypto';

const MAX_KEY_LENGTH = 200;

/**
 * 텍스트를 정규화된 canonical key로 변환
 *
 * 정규화 단계:
 * 1. NFKC 유니코드 정규화
 * 2. 소문자 변환
 * 3. 구두점 제거
 * 4. 연속 공백 정리
 * 5. 컨텍스트 추가 (선택)
 * 6. 긴 키 truncate + MD5
 */
export function makeCanonicalKey(
  title: string,
  context?: { project?: string; sessionId?: string }
): string {
  // Step 1: NFKC 정규화
  let normalized = title.normalize('NFKC');

  // Step 2: 소문자 변환
  normalized = normalized.toLowerCase();

  // Step 3: 구두점 제거 (유니코드 호환)
  normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, '');

  // Step 4: 연속 공백 정리
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Step 5: 컨텍스트 추가
  let key = normalized;
  if (context?.project) {
    key = `${context.project}::${key}`;
  }

  // Step 6: 긴 키 처리
  if (key.length > MAX_KEY_LENGTH) {
    const hashSuffix = createHash('md5').update(key).digest('hex').slice(0, 8);
    key = key.slice(0, MAX_KEY_LENGTH - 9) + '_' + hashSuffix;
  }

  return key;
}

/**
 * 두 텍스트가 동일한 canonical key를 가지는지 확인
 */
export function isSameCanonicalKey(a: string, b: string): boolean {
  return makeCanonicalKey(a) === makeCanonicalKey(b);
}

/**
 * Dedupe key 생성 (content + session으로 유일성 보장)
 */
export function makeDedupeKey(content: string, sessionId: string): string {
  const contentHash = createHash('sha256').update(content).digest('hex');
  return `${sessionId}:${contentHash}`;
}
```

### 1.3 Event Store 구현 (src/core/event-store.ts)

```typescript
// AXIOMMIND 스타일: append-only, 멱등성, 단일 진실 공급원

import { Database } from 'duckdb';
import { createHash } from 'crypto';
import { MemoryEvent, EventType } from './types';

export class EventStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    // 이벤트 테이블 (불변, append-only)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id VARCHAR PRIMARY KEY,
        event_type VARCHAR NOT NULL,
        session_id VARCHAR NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        content TEXT NOT NULL,
        metadata JSON,
        content_hash VARCHAR UNIQUE
      )
    `);

    // 중복 방지 테이블
    this.db.run(`
      CREATE TABLE IF NOT EXISTS event_dedup (
        content_hash VARCHAR PRIMARY KEY,
        event_id VARCHAR NOT NULL
      )
    `);

    // 세션 테이블
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR PRIMARY KEY,
        started_at TIMESTAMP NOT NULL,
        ended_at TIMESTAMP,
        project_path VARCHAR,
        summary TEXT
      )
    `);
  }

  // 멱등성 보장 저장
  async append(event: Omit<MemoryEvent, 'id' | 'contentHash'>): Promise<{
    success: boolean;
    eventId?: string;
    isDuplicate?: boolean;
  }> {
    const contentHash = this.hashContent(event.content);

    // 중복 확인
    const existing = this.db.prepare(`
      SELECT event_id FROM event_dedup WHERE content_hash = ?
    `).get(contentHash);

    if (existing) {
      return { success: true, eventId: existing.event_id, isDuplicate: true };
    }

    const id = crypto.randomUUID();

    this.db.run(`
      INSERT INTO events (id, event_type, session_id, timestamp, content, metadata, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, event.eventType, event.sessionId, event.timestamp, event.content,
        JSON.stringify(event.metadata), contentHash]);

    this.db.run(`
      INSERT INTO event_dedup (content_hash, event_id) VALUES (?, ?)
    `, [contentHash, id]);

    return { success: true, eventId: id, isDuplicate: false };
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // 세션별 이벤트 조회
  async getSessionEvents(sessionId: string): Promise<MemoryEvent[]> {
    return this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId);
  }

  // 최근 이벤트 조회
  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    return this.db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `).all(limit);
  }
}
```

### 1.3 Vector Store 구현 (src/core/vector-store.ts)

```typescript
import * as lancedb from 'lancedb';

export class VectorStore {
  private db: lancedb.Connection;
  private table: lancedb.Table | null = null;

  constructor(private dbPath: string) {}

  async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);

    // 테이블이 없으면 생성 (첫 데이터 삽입 시)
    try {
      this.table = await this.db.openTable('conversations');
    } catch {
      // 테이블이 없으면 나중에 생성
      this.table = null;
    }
  }

  async upsert(data: {
    id: string;
    eventId: string;
    sessionId: string;
    eventType: string;
    content: string;
    vector: number[];
    timestamp: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.table) {
      // 첫 데이터로 테이블 생성
      this.table = await this.db.createTable('conversations', [data]);
      return;
    }

    await this.table.add([data]);
  }

  async search(queryVector: number[], options: {
    limit?: number;
    minScore?: number;
    filter?: string;
  } = {}): Promise<Array<{
    id: string;
    eventId: string;
    content: string;
    score: number;
  }>> {
    if (!this.table) {
      return [];
    }

    const { limit = 5, minScore = 0.7 } = options;

    const results = await this.table
      .search(queryVector)
      .limit(limit)
      .execute();

    return results
      .filter(r => r._distance <= (1 - minScore))  // distance to score
      .map(r => ({
        id: r.id,
        eventId: r.eventId,
        content: r.content,
        score: 1 - r._distance
      }));
  }

  async delete(eventId: string): Promise<void> {
    if (!this.table) return;
    await this.table.delete(`eventId = "${eventId}"`);
  }
}
```

### 1.4 Vector Worker 구현 (src/core/vector-worker.ts) - AXIOMMIND Single-Writer

```typescript
/**
 * AXIOMMIND vector_worker.py 포팅
 * Single-Writer 패턴으로 LanceDB 동시성 문제 해결
 *
 * 원리:
 * 1. 이벤트 저장 시 embedding_outbox에 작업 추가 (빠름)
 * 2. 별도 워커가 outbox를 순차적으로 처리 (단일 쓰기)
 * 3. 처리 완료 시 outbox에서 삭제
 */

import { Database } from 'duckdb';
import { VectorStore } from './vector-store';
import { Embedder } from './embedder';

interface OutboxItem {
  id: string;
  eventId: string;
  content: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  retryCount: number;
  createdAt: Date;
}

export class VectorWorker {
  private isRunning = false;
  private pollInterval = 1000; // 1초

  constructor(
    private db: Database,
    private vectorStore: VectorStore,
    private embedder: Embedder
  ) {}

  /**
   * Outbox에 임베딩 작업 추가 (빠른 반환)
   */
  async enqueue(eventId: string, content: string): Promise<string> {
    const id = crypto.randomUUID();

    this.db.run(`
      INSERT INTO embedding_outbox (id, event_id, content, status, retry_count, created_at)
      VALUES (?, ?, ?, 'pending', 0, NOW())
    `, [id, eventId, content]);

    return id;
  }

  /**
   * 워커 시작 (백그라운드에서 실행)
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.isRunning) {
      await this.processOutbox();
      await this.sleep(this.pollInterval);
    }
  }

  /**
   * 워커 중지
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * Outbox 처리 (핵심 로직)
   */
  private async processOutbox(batchSize: number = 32): Promise<number> {
    // 1. Pending 항목 가져오기 + 락 획득 (atomic update)
    const pending = this.db.prepare(`
      UPDATE embedding_outbox
      SET status = 'processing'
      WHERE id IN (
        SELECT id FROM embedding_outbox
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT ?
      )
      RETURNING *
    `).all(batchSize) as OutboxItem[];

    if (pending.length === 0) {
      return 0;
    }

    try {
      // 2. 배치 임베딩 생성
      const contents = pending.map(p => p.content);
      const vectors = await this.embedder.embedBatch(contents);

      // 3. LanceDB에 저장 (단일 쓰기 - 동시성 안전)
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        await this.vectorStore.upsert({
          id: crypto.randomUUID(),
          eventId: item.eventId,
          sessionId: '', // 필요시 조회
          eventType: '',
          content: item.content.slice(0, 1000), // 미리보기용
          vector: vectors[i],
          timestamp: new Date().toISOString()
        });
      }

      // 4. 성공한 항목 삭제
      const ids = pending.map(p => `'${p.id}'`).join(',');
      this.db.run(`DELETE FROM embedding_outbox WHERE id IN (${ids})`);

      return pending.length;

    } catch (error) {
      // 5. 실패 시 retry_count 증가
      const ids = pending.map(p => `'${p.id}'`).join(',');
      this.db.run(`
        UPDATE embedding_outbox
        SET status = CASE WHEN retry_count >= 3 THEN 'failed' ELSE 'pending' END,
            retry_count = retry_count + 1,
            error_message = ?
        WHERE id IN (${ids})
      `, [String(error)]);

      return 0;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 1.5 Matcher 구현 (src/core/matcher.ts) - AXIOMMIND Weighted Scoring

```typescript
/**
 * AXIOMMIND task_matcher.py 포팅
 * 가중치 기반 스코어링 + 엄격한 매칭 임계값
 */

import { MemoryMatch, MatchResult, MATCH_THRESHOLDS } from './types';

interface ScoringWeights {
  semanticSimilarity: number;
  ftsScore: number;
  recencyBonus: number;
  statusWeight: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  semanticSimilarity: 0.4,
  ftsScore: 0.25,
  recencyBonus: 0.2,
  statusWeight: 0.15
};

interface RawSearchResult {
  id: string;
  eventId: string;
  content: string;
  vectorScore: number;      // 벡터 유사도 (0-1)
  ftsScore?: number;        // 전문 검색 점수 (0-1)
  timestamp: Date;
  eventType: string;
}

/**
 * 가중치 결합 점수 계산
 */
export function calculateWeightedScore(
  result: RawSearchResult,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  // 최신성 가산점 (30일 이내 = 1.0, 이후 감소)
  const daysSince = (Date.now() - result.timestamp.getTime()) / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - daysSince / 30);

  // 상태별 가중치 (agent_response > user_prompt)
  const statusScore = result.eventType === 'agent_response' ? 1.0 : 0.8;

  const score =
    result.vectorScore * weights.semanticSimilarity +
    (result.ftsScore ?? 0) * weights.ftsScore +
    recencyScore * weights.recencyBonus +
    statusScore * weights.statusWeight;

  return Math.min(1, Math.max(0, score)); // 0-1 범위로 클램프
}

/**
 * 엄격한 매칭: top-1이 확실히 우세할 때만 확정
 *
 * AXIOMMIND 규칙:
 * - combined score >= 0.92 AND gap >= 0.03 → 'high' (확정)
 * - 0.75 <= score < 0.92 → 'suggested' (제안)
 * - score < 0.75 → 'none' (매칭 없음)
 */
export function matchWithConfidence(
  candidates: MemoryMatch[]
): MatchResult {
  if (candidates.length === 0) {
    return { match: null, confidence: 'none' };
  }

  // 점수순 정렬
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top = sorted[0];

  // 임계값 미달
  if (top.score < MATCH_THRESHOLDS.suggestionThreshold) {
    return { match: null, confidence: 'none' };
  }

  // 확정 매칭 체크
  if (top.score >= MATCH_THRESHOLDS.minCombinedScore) {
    // 단일 후보
    if (sorted.length === 1) {
      return { match: top, confidence: 'high' };
    }

    // 2위와의 gap 체크
    const gap = top.score - sorted[1].score;
    if (gap >= MATCH_THRESHOLDS.minGap) {
      return { match: top, confidence: 'high', gap };
    }
  }

  // 제안 모드 (확실하지 않음)
  return {
    match: top,
    confidence: 'suggested',
    gap: sorted.length > 1 ? top.score - sorted[1].score : undefined,
    alternatives: sorted.slice(1, 4) // 상위 3개 대안
  };
}

/**
 * 검색 결과를 MemoryMatch로 변환
 */
export function toMemoryMatch(
  result: RawSearchResult,
  weights?: ScoringWeights
): MemoryMatch {
  const score = calculateWeightedScore(result, weights);

  return {
    event: {
      id: result.eventId,
      eventType: result.eventType as any,
      sessionId: '',
      timestamp: result.timestamp,
      content: result.content,
      contentHash: ''
    },
    score,
    relevanceReason: `Weighted score: ${(score * 100).toFixed(1)}% ` +
      `(vector: ${(result.vectorScore * 100).toFixed(0)}%)`
  };
}
```

### 1.6 Evidence Aligner 구현 (src/core/evidence-aligner.ts) - AXIOMMIND 원칙4

```typescript
/**
 * AXIOMMIND 원칙 4: 증거 범위는 파이프라인이 확정
 *
 * LLM이 추출한 대략적인 인용문을 원본 텍스트에서
 * 정확한 (start, end) 위치로 변환
 */

interface EvidenceSpan {
  start: number;
  end: number;
  confidence: number;
  matchType: 'exact' | 'fuzzy' | 'none';
  originalQuote: string;
  alignedText: string;
}

interface FuzzyMatch {
  start: number;
  end: number;
  score: number;
  text: string;
}

export class EvidenceAligner {
  private fuzzyThreshold: number;

  constructor(fuzzyThreshold: number = 0.85) {
    this.fuzzyThreshold = fuzzyThreshold;
  }

  /**
   * LLM 인용문을 원본 텍스트에서 정확한 스팬으로 변환
   */
  align(sourceText: string, llmQuote: string): EvidenceSpan | null {
    // 1. 정확한 매칭 시도
    const exactPos = sourceText.indexOf(llmQuote);
    if (exactPos >= 0) {
      return {
        start: exactPos,
        end: exactPos + llmQuote.length,
        confidence: 1.0,
        matchType: 'exact',
        originalQuote: llmQuote,
        alignedText: llmQuote
      };
    }

    // 2. 정규화 후 매칭 (공백, 대소문자 무시)
    const normalizedMatch = this.normalizedSearch(sourceText, llmQuote);
    if (normalizedMatch && normalizedMatch.score >= 0.95) {
      return {
        start: normalizedMatch.start,
        end: normalizedMatch.end,
        confidence: normalizedMatch.score,
        matchType: 'exact',
        originalQuote: llmQuote,
        alignedText: normalizedMatch.text
      };
    }

    // 3. Fuzzy 매칭 (Levenshtein 거리)
    const fuzzyMatch = this.fuzzySearch(sourceText, llmQuote);
    if (fuzzyMatch && fuzzyMatch.score >= this.fuzzyThreshold) {
      return {
        start: fuzzyMatch.start,
        end: fuzzyMatch.end,
        confidence: fuzzyMatch.score,
        matchType: 'fuzzy',
        originalQuote: llmQuote,
        alignedText: fuzzyMatch.text
      };
    }

    // 4. 매칭 실패
    return null;
  }

  /**
   * 정규화된 검색 (공백/대소문자 무시)
   */
  private normalizedSearch(text: string, query: string): FuzzyMatch | null {
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedText = normalize(text);
    const normalizedQuery = normalize(query);

    const pos = normalizedText.indexOf(normalizedQuery);
    if (pos < 0) return null;

    // 원본 텍스트에서 실제 위치 찾기
    let originalStart = 0;
    let normalizedPos = 0;
    for (let i = 0; i < text.length && normalizedPos < pos; i++) {
      if (!/\s/.test(text[i]) || (i > 0 && !/\s/.test(text[i-1]))) {
        normalizedPos++;
      }
      originalStart = i + 1;
    }

    return {
      start: originalStart,
      end: originalStart + query.length,
      score: 0.98,
      text: text.slice(originalStart, originalStart + query.length)
    };
  }

  /**
   * Fuzzy 검색 (슬라이딩 윈도우 + Levenshtein)
   */
  private fuzzySearch(text: string, query: string): FuzzyMatch | null {
    const windowSize = Math.min(query.length * 1.5, text.length);
    let bestMatch: FuzzyMatch | null = null;

    for (let i = 0; i <= text.length - query.length; i++) {
      const window = text.slice(i, i + Math.ceil(windowSize));
      const score = this.similarity(window.slice(0, query.length), query);

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          start: i,
          end: i + query.length,
          score,
          text: window.slice(0, query.length)
        };
      }
    }

    return bestMatch;
  }

  /**
   * Levenshtein 기반 유사도 (0-1)
   */
  private similarity(a: string, b: string): number {
    const distance = this.levenshteinDistance(a.toLowerCase(), b.toLowerCase());
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[j - 1] === b[i - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[b.length][a.length];
  }
}
```

### 1.7 Graduation Pipeline 구현 (src/core/graduation.ts) - AXIOMMIND L0→L4

```typescript
/**
 * AXIOMMIND Memory Graduation Pipeline
 * L0(Raw) → L1(Structured) → L2(Candidates) → L3(Verified) → L4(Active)
 */

import { EventStore } from './event-store';
import { VectorStore } from './vector-store';
import { VectorWorker } from './vector-worker';
import { MemoryEvent } from './types';

type MemoryLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

interface GraduationResult {
  eventId: string;
  fromLevel: MemoryLevel;
  toLevel: MemoryLevel;
  success: boolean;
  reason?: string;
}

interface LevelStatus {
  level: MemoryLevel;
  count: number;
  lastUpdated: Date | null;
}

export class GraduationPipeline {
  constructor(
    private eventStore: EventStore,
    private vectorStore: VectorStore,
    private vectorWorker: VectorWorker
  ) {}

  /**
   * L0 → L1: 원본 이벤트에서 구조화된 데이터 추출
   * (LLM 기반 추출은 별도 서비스에서 처리)
   */
  async promoteToL1(eventId: string): Promise<GraduationResult> {
    // L1 승격은 LLM 추출 완료 후 마킹
    // 여기서는 메타데이터만 업데이트
    return {
      eventId,
      fromLevel: 'L0',
      toLevel: 'L1',
      success: true
    };
  }

  /**
   * L1 → L2: 타입 검증 대상으로 승격
   * TypeScript 타입 체크 통과 여부 확인
   */
  async promoteToL2(eventId: string, structuredData: unknown): Promise<GraduationResult> {
    try {
      // Zod 스키마로 검증
      // const validated = SomeSchema.parse(structuredData);

      return {
        eventId,
        fromLevel: 'L1',
        toLevel: 'L2',
        success: true
      };
    } catch (error) {
      return {
        eventId,
        fromLevel: 'L1',
        toLevel: 'L2',
        success: false,
        reason: `Validation failed: ${error}`
      };
    }
  }

  /**
   * L2 → L3: 검증 완료 (모순 없음 확인)
   */
  async promoteToL3(eventId: string): Promise<GraduationResult> {
    // 기존 지식과의 모순 체크
    // 중복 체크
    // 신뢰도 계산

    return {
      eventId,
      fromLevel: 'L2',
      toLevel: 'L3',
      success: true
    };
  }

  /**
   * L3 → L4: 검색 가능 상태로 승격 (벡터 인덱싱)
   */
  async promoteToL4(eventId: string, content: string): Promise<GraduationResult> {
    try {
      // VectorWorker의 outbox에 추가 (비동기 인덱싱)
      await this.vectorWorker.enqueue(eventId, content);

      return {
        eventId,
        fromLevel: 'L3',
        toLevel: 'L4',
        success: true
      };
    } catch (error) {
      return {
        eventId,
        fromLevel: 'L3',
        toLevel: 'L4',
        success: false,
        reason: `Indexing failed: ${error}`
      };
    }
  }

  /**
   * 전체 파이프라인 실행 (L0 → L4)
   */
  async graduateFull(event: MemoryEvent): Promise<GraduationResult[]> {
    const results: GraduationResult[] = [];

    // L0 → L1 (구조화)
    const l1Result = await this.promoteToL1(event.id);
    results.push(l1Result);
    if (!l1Result.success) return results;

    // L1 → L2 (타입 검증)
    const l2Result = await this.promoteToL2(event.id, event);
    results.push(l2Result);
    if (!l2Result.success) return results;

    // L2 → L3 (모순 체크)
    const l3Result = await this.promoteToL3(event.id);
    results.push(l3Result);
    if (!l3Result.success) return results;

    // L3 → L4 (인덱싱)
    const l4Result = await this.promoteToL4(event.id, event.content);
    results.push(l4Result);

    return results;
  }

  /**
   * 각 레벨별 통계 조회
   */
  async getLevelStats(): Promise<LevelStatus[]> {
    // 실제 구현에서는 DB 쿼리
    return [
      { level: 'L0', count: 0, lastUpdated: null },
      { level: 'L1', count: 0, lastUpdated: null },
      { level: 'L2', count: 0, lastUpdated: null },
      { level: 'L3', count: 0, lastUpdated: null },
      { level: 'L4', count: 0, lastUpdated: null }
    ];
  }
}
```

---

## Phase 2: Embedding & Retrieval

### 2.1 Embedder 구현 (src/core/embedder.ts)

```typescript
import { pipeline, Pipeline } from '@xenova/transformers';

export class Embedder {
  private model: Pipeline | null = null;
  private modelName: string;

  constructor(modelName: string = 'Xenova/all-MiniLM-L6-v2') {
    this.modelName = modelName;
  }

  async initialize(): Promise<void> {
    this.model = await pipeline('feature-extraction', this.modelName);
  }

  async embed(text: string): Promise<number[]> {
    if (!this.model) {
      await this.initialize();
    }

    const result = await this.model!(text, {
      pooling: 'mean',
      normalize: true
    });

    return Array.from(result.data);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}
```

### 2.2 Retriever 구현 (src/core/retriever.ts)

```typescript
import { Embedder } from './embedder';
import { VectorStore } from './vector-store';
import { EventStore } from './event-store';
import { MemoryMatch, Config } from './types';

export class Retriever {
  constructor(
    private embedder: Embedder,
    private vectorStore: VectorStore,
    private eventStore: EventStore,
    private config: Config
  ) {}

  async search(query: string): Promise<MemoryMatch[]> {
    // 1. 쿼리 임베딩
    const queryVector = await this.embedder.embed(query);

    // 2. 벡터 검색
    const vectorResults = await this.vectorStore.search(queryVector, {
      limit: this.config.retrieval.topK,
      minScore: this.config.retrieval.minScore
    });

    // 3. 이벤트 정보 보강
    const matches: MemoryMatch[] = [];

    for (const result of vectorResults) {
      // 원본 이벤트 조회
      const events = await this.eventStore.getSessionEvents(result.eventId);
      const event = events.find(e => e.id === result.eventId);

      if (event) {
        matches.push({
          event,
          score: result.score,
          relevanceReason: `Semantic similarity: ${(result.score * 100).toFixed(1)}%`
        });
      }
    }

    return matches;
  }

  // 컨텍스트 포맷팅
  formatContext(matches: MemoryMatch[]): string {
    if (matches.length === 0) {
      return '';
    }

    const lines = ['## Relevant Memories\n'];

    for (const match of matches) {
      const date = new Date(match.event.timestamp).toLocaleDateString();
      lines.push(`### ${match.event.eventType} (${date})`);
      lines.push(`> ${match.event.content.slice(0, 500)}...`);
      lines.push(`_Relevance: ${(match.score * 100).toFixed(0)}%_\n`);
    }

    return lines.join('\n');
  }
}
```

---

## Phase 3: Hook Integration

### 3.1 hooks.json 설정

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "npx code-memory session-start",
        "timeout": 5000
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "npx code-memory search --stdin",
        "timeout": 3000
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "npx code-memory save --stdin",
        "timeout": 5000
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "npx code-memory session-end --stdin",
        "timeout": 10000
      }
    ]
  }
}
```

### 3.2 UserPromptSubmit Hook (src/hooks/user-prompt-submit.ts)

```typescript
import { Retriever } from '../core/retriever';
import { loadServices } from '../core/services';

export async function handleUserPromptSubmit(input: {
  session_id: string;
  prompt: string;
}): Promise<{ context?: string }> {
  const { retriever } = await loadServices();

  // 관련 기억 검색
  const matches = await retriever.search(input.prompt);

  if (matches.length === 0) {
    return {};
  }

  // 컨텍스트 포맷팅
  const context = retriever.formatContext(matches);

  return { context };
}

// CLI 엔트리포인트
if (process.stdin.isTTY === false) {
  let data = '';
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', async () => {
    const input = JSON.parse(data);
    const result = await handleUserPromptSubmit(input);
    console.log(JSON.stringify(result));
  });
}
```

### 3.3 Stop Hook (src/hooks/stop.ts)

```typescript
import { EventStore } from '../core/event-store';
import { VectorStore } from '../core/vector-store';
import { Embedder } from '../core/embedder';
import { loadServices } from '../core/services';

export async function handleStop(input: {
  session_id: string;
  messages: Array<{ role: string; content: string }>;
}): Promise<void> {
  const { eventStore, vectorStore, embedder } = await loadServices();

  // 마지막 user-assistant 쌍 저장
  const messages = input.messages.slice(-2);

  for (const msg of messages) {
    const eventType = msg.role === 'user' ? 'user_prompt' : 'agent_response';

    // 1. 이벤트 저장
    const result = await eventStore.append({
      eventType,
      sessionId: input.session_id,
      timestamp: new Date(),
      content: msg.content,
      metadata: {}
    });

    // 2. 임베딩 생성 및 벡터 저장 (중복 아닌 경우)
    if (result.success && !result.isDuplicate) {
      const vector = await embedder.embed(msg.content);

      await vectorStore.upsert({
        id: crypto.randomUUID(),
        eventId: result.eventId!,
        sessionId: input.session_id,
        eventType,
        content: msg.content.slice(0, 1000),  // 미리보기용
        vector,
        timestamp: new Date().toISOString()
      });
    }
  }
}
```

---

## Phase 4: Commands & CLI

### 4.1 Search Command (commands/search.md)

```markdown
---
description: Search through your conversation memory
---

# Memory Search

Search for relevant memories based on your query.

## Usage

The user wants to search their conversation memory for: "$ARGUMENTS"

Search the memory database and return the most relevant past conversations, code snippets, and insights related to the query.

Display the results in a clear format showing:
1. The date of the memory
2. A brief excerpt of the content
3. The relevance score

If no relevant memories are found, inform the user and suggest they can build up their memory by having more conversations.
```

### 4.2 CLI Entry Point (src/cli/index.ts)

```typescript
import { Command } from 'commander';
import { handleSessionStart } from './commands/session-start';
import { handleSearch } from './commands/search';
import { handleSave } from './commands/save';
import { handleSessionEnd } from './commands/session-end';
import { handleInit } from './commands/init';

const program = new Command();

program
  .name('code-memory')
  .description('Claude Code Memory Plugin CLI')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize the memory database')
  .action(handleInit);

program
  .command('session-start')
  .description('Handle session start')
  .option('--session-id <id>', 'Session ID')
  .option('--cwd <path>', 'Current working directory')
  .action(handleSessionStart);

program
  .command('search')
  .description('Search memories')
  .option('--query <text>', 'Search query')
  .option('--stdin', 'Read from stdin')
  .option('--limit <n>', 'Max results', '5')
  .action(handleSearch);

program
  .command('save')
  .description('Save conversation')
  .option('--stdin', 'Read from stdin')
  .action(handleSave);

program
  .command('session-end')
  .description('Handle session end')
  .option('--stdin', 'Read from stdin')
  .action(handleSessionEnd);

program.parse();
```

---

## Phase 5: Testing & Polish

### 5.1 테스트 케이스 (tests/event-store.test.ts)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../src/core/event-store';
import { unlink } from 'fs/promises';

describe('EventStore', () => {
  let store: EventStore;
  const testDbPath = './test-events.db';

  beforeEach(() => {
    store = new EventStore(testDbPath);
  });

  afterEach(async () => {
    await unlink(testDbPath).catch(() => {});
  });

  it('should append events with deduplication', async () => {
    const event = {
      eventType: 'user_prompt' as const,
      sessionId: 'test-session',
      timestamp: new Date(),
      content: 'Hello, how are you?',
      metadata: {}
    };

    // 첫 번째 저장
    const result1 = await store.append(event);
    expect(result1.success).toBe(true);
    expect(result1.isDuplicate).toBe(false);

    // 중복 저장 시도
    const result2 = await store.append(event);
    expect(result2.success).toBe(true);
    expect(result2.isDuplicate).toBe(true);
    expect(result2.eventId).toBe(result1.eventId);
  });

  it('should retrieve events by session', async () => {
    const sessionId = 'test-session';

    await store.append({
      eventType: 'user_prompt',
      sessionId,
      timestamp: new Date(),
      content: 'First message',
      metadata: {}
    });

    await store.append({
      eventType: 'agent_response',
      sessionId,
      timestamp: new Date(),
      content: 'First response',
      metadata: {}
    });

    const events = await store.getSessionEvents(sessionId);
    expect(events.length).toBe(2);
  });
});
```

### 5.2 통합 테스트 (tests/integration.test.ts)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventStore } from '../src/core/event-store';
import { VectorStore } from '../src/core/vector-store';
import { Embedder } from '../src/core/embedder';
import { Retriever } from '../src/core/retriever';

describe('Integration: Memory Retrieval', () => {
  let eventStore: EventStore;
  let vectorStore: VectorStore;
  let embedder: Embedder;
  let retriever: Retriever;

  beforeAll(async () => {
    eventStore = new EventStore('./test-integration.db');
    vectorStore = new VectorStore('./test-integration-vectors');
    embedder = new Embedder();

    await vectorStore.initialize();
    await embedder.initialize();

    retriever = new Retriever(eventStore, vectorStore, embedder, {
      retrieval: { topK: 5, minScore: 0.5, maxTokens: 2000 }
    });

    // 테스트 데이터 삽입
    const testData = [
      { content: 'How to implement rate limiting in Express?', type: 'user_prompt' },
      { content: 'You can use express-rate-limit middleware...', type: 'agent_response' },
      { content: 'How to add authentication to my API?', type: 'user_prompt' },
      { content: 'Use Passport.js or JWT for authentication...', type: 'agent_response' }
    ];

    for (const data of testData) {
      const result = await eventStore.append({
        eventType: data.type as any,
        sessionId: 'test-session',
        timestamp: new Date(),
        content: data.content,
        metadata: {}
      });

      const vector = await embedder.embed(data.content);
      await vectorStore.upsert({
        id: crypto.randomUUID(),
        eventId: result.eventId!,
        sessionId: 'test-session',
        eventType: data.type,
        content: data.content,
        vector,
        timestamp: new Date().toISOString()
      });
    }
  });

  it('should find relevant memories', async () => {
    const matches = await retriever.search('rate limiting');

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].event.content).toContain('rate limiting');
  });

  it('should format context correctly', () => {
    const matches = [
      {
        event: {
          id: '1',
          eventType: 'user_prompt',
          sessionId: 'test',
          timestamp: new Date(),
          content: 'Test content',
          contentHash: 'hash'
        },
        score: 0.95,
        relevanceReason: 'High similarity'
      }
    ];

    const context = retriever.formatContext(matches);
    expect(context).toContain('Relevant Memories');
    expect(context).toContain('Test content');
  });
});
```

### 5.3 빌드 스크립트 (scripts/build.ts)

```typescript
import * as esbuild from 'esbuild';

async function build() {
  // CLI 빌드
  await esbuild.build({
    entryPoints: ['src/cli/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/cli.js',
    external: ['duckdb', 'lancedb', '@xenova/transformers']
  });

  console.log('Build complete!');
}

build().catch(console.error);
```

---

## 마일스톤 체크리스트

### Phase 0: 프로젝트 설정
- [ ] 디렉토리 구조 생성
- [ ] package.json 초기화
- [ ] 의존성 설치
- [ ] TypeScript 설정
- [ ] plugin.json 생성

### Phase 1: Core Storage Layer
- [ ] types.ts - Zod 스키마 정의
- [ ] event-store.ts - DuckDB 연동
- [ ] vector-store.ts - LanceDB 연동
- [ ] 단위 테스트

### Phase 2: Embedding & Retrieval
- [ ] embedder.ts - 로컬 임베딩
- [ ] retriever.ts - 검색 로직
- [ ] 컨텍스트 포맷터
- [ ] 단위 테스트

### Phase 3: Hook Integration
- [ ] hooks.json 설정
- [ ] session-start hook
- [ ] user-prompt-submit hook
- [ ] stop hook
- [ ] session-end hook

### Phase 4: Commands & CLI
- [ ] CLI 엔트리포인트
- [ ] search 명령어
- [ ] history 명령어
- [ ] forget 명령어
- [ ] stats 명령어

### Phase 5: Testing & Polish
- [ ] 통합 테스트
- [ ] README.md
- [ ] 에러 처리 개선
- [ ] 성능 최적화
- [ ] 첫 릴리스 준비

---

## 리스크 및 대응

| 리스크 | 영향 | 대응 |
|--------|------|------|
| 임베딩 모델 로드 시간 | 세션 시작 지연 | 모델 캐싱, 지연 로드 |
| 대용량 대화 처리 | 메모리 부족 | 스트리밍, 배치 처리 |
| DuckDB/LanceDB 호환성 | 설치 실패 | fallback 구현, 순수 JS 대안 |
| Hook 타임아웃 | 기능 미작동 | 비동기 처리, 캐싱 |

---

## 다음 단계

1. **Phase 0 완료 후**: 기본 플러그인 구조 동작 확인
2. **Phase 1-2 완료 후**: 기억 저장/검색 기능 데모
3. **Phase 3-4 완료 후**: 실제 Claude Code에서 테스트
4. **Phase 5 완료 후**: 커뮤니티 마켓플레이스 등록
