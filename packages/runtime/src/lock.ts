/** Runs jobs for the same key one after another; a failed job doesn't block the next one. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const running = (this.tails.get(key) ?? Promise.resolve()).then(job, job);
    const settled = running.catch(() => undefined);
    this.tails.set(key, settled);
    void settled.then(() => { if (this.tails.get(key) === settled) this.tails.delete(key); });
    return running;
  }
}
