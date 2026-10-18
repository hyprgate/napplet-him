export interface EnrichmentQueue {
  enqueue(task: () => Promise<void>): void;
  clear(): void;
}

export interface EnrichmentQueueOptions {
  delayMs?: number;
}

export function createEnrichmentQueue(options: EnrichmentQueueOptions = {}): EnrichmentQueue {
  const delayMs = options.delayMs ?? 100;
  const tasks: Array<() => Promise<void>> = [];
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delay: number): void => {
    if (active || timer || tasks.length === 0) return;
    timer = setTimeout(runNext, delay);
  };

  const runNext = (): void => {
    timer = null;
    if (active) return;
    const task = tasks.shift();
    if (!task) return;
    active = true;
    void Promise.resolve()
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        active = false;
        schedule(delayMs);
      });
  };

  return {
    enqueue(task): void {
      tasks.push(task);
      schedule(0);
    },
    clear(): void {
      tasks.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
