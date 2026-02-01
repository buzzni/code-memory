/**
 * Graduation Worker
 * Periodically evaluates memory events for promotion to higher levels
 * L0 → L1 → L2 → L3 → L4 based on access patterns and confidence
 */

import type { MemoryLevel } from './types.js';
import { EventStore } from './event-store.js';
import { GraduationPipeline } from './graduation.js';

export interface GraduationWorkerConfig {
  /** How often to run graduation evaluation (ms) */
  evaluationIntervalMs: number;
  /** Batch size for graduation evaluation */
  batchSize: number;
  /** Minimum time between evaluations of the same event (ms) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: GraduationWorkerConfig = {
  evaluationIntervalMs: 300000, // 5 minutes
  batchSize: 50,
  cooldownMs: 3600000 // 1 hour cooldown between evaluations
};

export class GraduationWorker {
  private running = false;
  private timeout: NodeJS.Timeout | null = null;
  private lastEvaluated: Map<string, number> = new Map();

  constructor(
    private eventStore: EventStore,
    private graduation: GraduationPipeline,
    private config: GraduationWorkerConfig = DEFAULT_CONFIG
  ) {}

  /**
   * Start the graduation worker
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the graduation worker
   */
  stop(): void {
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /**
   * Check if currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Force a graduation evaluation run
   */
  async forceRun(): Promise<GraduationRunResult> {
    return await this.runGraduation();
  }

  /**
   * Schedule the next graduation check
   */
  private scheduleNext(): void {
    if (!this.running) return;

    this.timeout = setTimeout(
      () => this.run(),
      this.config.evaluationIntervalMs
    );
  }

  /**
   * Run graduation evaluation
   */
  private async run(): Promise<void> {
    if (!this.running) return;

    try {
      await this.runGraduation();
    } catch (error) {
      console.error('Graduation error:', error);
    }

    this.scheduleNext();
  }

  /**
   * Perform graduation evaluation across all levels
   */
  private async runGraduation(): Promise<GraduationRunResult> {
    const result: GraduationRunResult = {
      evaluated: 0,
      graduated: 0,
      byLevel: {}
    };

    const levels: MemoryLevel[] = ['L0', 'L1', 'L2', 'L3'];
    const now = Date.now();

    for (const level of levels) {
      const events = await this.eventStore.getEventsByLevel(level, {
        limit: this.config.batchSize
      });

      let levelGraduated = 0;

      for (const event of events) {
        // Check cooldown
        const lastEval = this.lastEvaluated.get(event.id);
        if (lastEval && (now - lastEval) < this.config.cooldownMs) {
          continue;
        }

        result.evaluated++;
        this.lastEvaluated.set(event.id, now);

        const gradResult = await this.graduation.evaluateGraduation(event.id, level);

        if (gradResult.success) {
          result.graduated++;
          levelGraduated++;
        }
      }

      if (levelGraduated > 0) {
        result.byLevel[level] = levelGraduated;
      }
    }

    // Clean up old cooldown entries (keep last 1000)
    if (this.lastEvaluated.size > 1000) {
      const entries = Array.from(this.lastEvaluated.entries());
      entries.sort((a, b) => b[1] - a[1]);
      this.lastEvaluated = new Map(entries.slice(0, 1000));
    }

    return result;
  }
}

export interface GraduationRunResult {
  evaluated: number;
  graduated: number;
  byLevel: Record<string, number>;
}

/**
 * Create a Graduation Worker instance
 */
export function createGraduationWorker(
  eventStore: EventStore,
  graduation: GraduationPipeline,
  config?: Partial<GraduationWorkerConfig>
): GraduationWorker {
  return new GraduationWorker(
    eventStore,
    graduation,
    { ...DEFAULT_CONFIG, ...config }
  );
}
