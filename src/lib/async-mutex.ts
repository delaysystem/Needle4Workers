interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason?: any) => void;
  timer?: any;
}

/**
 * AsyncMutex ensures exclusive sequential execution for single-threaded non-reentrant resources
 * such as the Needle WASM runtime and its linear memory.
 */
export class AsyncMutex {
  private locked: boolean = false;
  private queue: Waiter[] = [];

  /**
   * Acquire lock. Resolves with a release function that must be called to unlock.
   * If timeoutMs is provided and the lock cannot be acquired within that duration,
   * the promise rejects with an Error.
   */
  acquire(timeoutMs?: number): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.createRelease());
    }

    if (typeof timeoutMs === "number" && timeoutMs <= 0) {
      return Promise.reject(new Error("AsyncMutex: acquire timed out immediately"));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (releaseFn: () => void) => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = undefined;
          }
          resolve(releaseFn);
        },
        reject: (err: any) => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = undefined;
          }
          reject(err);
        },
      };

      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) {
            this.queue.splice(index, 1);
            waiter.reject(new Error(`AsyncMutex: acquire timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

      this.queue.push(waiter);
    });
  }

  /**
   * Execute an asynchronous task exclusively holding the mutex.
   * Automatically releases the lock when fn completes or throws.
   */
  async runExclusive<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Checks whether the mutex is currently locked.
   */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Number of pending waiters currently in the queue.
   */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Alias for queueLength to track waiters count.
   */
  get waitingCount(): number {
    return this.queue.length;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.dispatchNext();
    };
  }

  private dispatchNext(): void {
    while (this.queue.length > 0) {
      const nextWaiter = this.queue.shift();
      if (nextWaiter) {
        nextWaiter.resolve(this.createRelease());
        return;
      }
    }
    this.locked = false;
  }
}

export default AsyncMutex;
