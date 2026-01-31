# Implementation Plan: Claude Code Memory Plugin

## 1. 개발 단계 개요

```
Phase 0: 프로젝트 설정 (1일)
    ↓
Phase 1: Core Storage Layer (2일)
    ↓
Phase 2: Embedding & Retrieval (2일)
    ↓
Phase 3: Hook Integration (2일)
    ↓
Phase 4: Commands & CLI (1일)
    ↓
Phase 5: Testing & Polish (2일)
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
│   │   ├── event-store.ts       # DuckDB 이벤트 저장소
│   │   ├── vector-store.ts      # LanceDB 벡터 저장소
│   │   ├── embedder.ts          # 임베딩 생성
│   │   ├── retriever.ts         # 기억 검색
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
```

### 1.2 Event Store 구현 (src/core/event-store.ts)

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
