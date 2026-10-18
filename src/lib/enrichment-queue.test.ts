import { describe, expect, it, vi } from 'vitest';
import { createEnrichmentQueue } from './enrichment-queue.js';

describe('createEnrichmentQueue', () => {
  it('keeps streamed enrichment work serial while the active task is pending', async () => {
    vi.useFakeTimers();
    let finishFirst!: () => void;
    let active = 0;
    let maxActive = 0;
    const calls: number[] = [];
    const queue = createEnrichmentQueue({ delayMs: 100 });
    const task = (value: number, wait = false) => async () => {
      calls.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (wait) await new Promise<void>((resolve) => { finishFirst = resolve; });
      active -= 1;
    };

    queue.enqueue(task(1, true));
    await vi.advanceTimersByTimeAsync(0);
    for (let value = 2; value <= 421; value += 1) queue.enqueue(task(value));
    await vi.advanceTimersByTimeAsync(500);

    expect(calls).toEqual([1]);
    expect(maxActive).toBe(1);

    finishFirst();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);

    queue.clear();
    vi.useRealTimers();
  });
});
