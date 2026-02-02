#!/usr/bin/env node
/**
 * User Prompt Submit Hook
 * Called when user submits a prompt - retrieves relevant memories using fast keyword search
 *
 * Uses SQLite FTS5 for fast keyword-based search (no ML model needed)
 * Much faster than vector search (~100ms vs 3-5s)
 */

import { getLightweightMemoryService } from '../services/memory-service.js';
import type { UserPromptSubmitInput, UserPromptSubmitOutput } from '../core/types.js';

// Configuration
const MAX_MEMORIES = parseInt(process.env.CLAUDE_MEMORY_MAX_COUNT || '5');
const MIN_SCORE = parseFloat(process.env.CLAUDE_MEMORY_MIN_SCORE || '0.3');
const ENABLE_SEARCH = process.env.CLAUDE_MEMORY_SEARCH !== 'false';

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: UserPromptSubmitInput = JSON.parse(inputData);

  // Use lightweight service (SQLite only, no embedder/vector - FAST!)
  const memoryService = getLightweightMemoryService(input.session_id);

  try {
    // Store the user prompt for future retrieval
    await memoryService.storeUserPrompt(
      input.session_id,
      input.prompt
    );

    let context = '';

    // Fast keyword search if enabled
    if (ENABLE_SEARCH && input.prompt.length > 10) {
      const results = await memoryService.keywordSearch(input.prompt, {
        topK: MAX_MEMORIES,
        minScore: MIN_SCORE
      });

      if (results.length > 0) {
        // Increment access count for found memories
        const eventIds = results.map(r => r.event.id);
        await memoryService.incrementMemoryAccess(eventIds);

        // Format context
        const memories = results.map(r => {
          const preview = r.event.content.length > 300
            ? r.event.content.substring(0, 300) + '...'
            : r.event.content;
          return `- [${r.event.eventType}] ${preview}`;
        });

        context = `💡 **Related memories found:**\n\n${memories.join('\n\n')}`;
      }
    }

    const output: UserPromptSubmitOutput = { context };
    console.log(JSON.stringify(output));
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
    console.log(JSON.stringify({ context: '' }));
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

main().catch(console.error);
