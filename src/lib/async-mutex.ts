// Keyed mutex for the single-threaded Needle WASM runtime.
//
// The engine caches exactly ONE tools prefix: a request whose tools match the
// previously served request skips the multi-second init prefill, anything
// else pays it. Under concurrent mixed-tools load, strict FIFO alternates
// variants and every request misses. This mutex therefore grants the lock to
// the first queued waiter whose key matches the last-served key, falling back
// to the FIFO head after MAX_AFFINITY_SKIPS consecutive affinity grants so no
// waiter starves. Callers without a key share the default class ("") and see
// plain FIFO.
//
// ENGAGEMENT NOTE: affinity only reorders waiters that are actually queued,
// and a queued waiter needs a hold that yields to the event loop. Today's
// engine is fully synchronous inside the hold, so warm requests serialize
// before a queue can form and affinity never engages (measured 2026-11-18:
// identical mixed-load slow_inits with and without keying). The mutex still
// provides exclusion; the affinity stands ready for streaming/async engines.
export const MAX_AFFINITY_SKIPS = 4;

interface Waiter {
  key: string;
  grant: () => void;
}

export class AsyncMutex {
  // Stays true across the grant handoff (a granted waiter resumes in a later
  // microtask), so a newcomer can never slip in ahead of it.
  private locked = false;
  private waiters: Waiter[] = [];
  private lastKey = "";
  private affinitySkips = 0;

  get isLocked(): boolean {
    return this.locked || this.waiters.length > 0;
  }

  get queueLength(): number {
    return this.waiters.length;
  }

  async runExclusive<T>(fn: () => Promise<T>, key: string = ""): Promise<T> {
    // The check-and-enqueue below is synchronous, hence atomic: no await
    // runs between the idle check and the state mutation.
    if (!this.locked) {
      this.locked = true;
      this.lastKey = key;
    } else {
      let grant!: () => void;
      const granted = new Promise<void>((resolve) => { grant = resolve; });
      this.waiters.push({ key, grant });
      await granted;
      this.lastKey = key;
    }
    try {
      return await fn();
    } finally {
      this.grantNext();
    }
  }

  private grantNext(): void {
    if (this.waiters.length === 0) {
      this.locked = false;
      return;
    }
    // Ownership transfers to the picked waiter; locked stays true.
    let index = 0;
    if (this.affinitySkips < MAX_AFFINITY_SKIPS) {
      const match = this.waiters.findIndex((w) => w.key === this.lastKey);
      if (match > 0) {
        index = match;
        this.affinitySkips++;
      } else {
        this.affinitySkips = 0;
      }
    } else {
      // Starvation bound reached: serve the FIFO head unconditionally.
      this.affinitySkips = 0;
    }
    const [next] = this.waiters.splice(index, 1);
    next.grant();
  }
}
