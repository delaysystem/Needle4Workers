// Minimal promise-chain mutex (FIFO) for the single-threaded Needle WASM runtime.
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private running = 0;
  private queued = 0;

  get isLocked(): boolean {
    return this.running > 0 || this.queued > 0;
  }

  get queueLength(): number {
    return this.queued;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    this.queued--;
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      release();
    }
  }
}
