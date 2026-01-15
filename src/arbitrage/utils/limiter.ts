export class Semaphore {
  private readonly max: number;
  private count: number;
  private readonly queue: Array<() => void>;

  constructor(max: number) {
    this.max = Math.max(1, max);
    this.count = 0;
    this.queue = [];
  }

  async acquire(): Promise<() => void> {
    if (this.count < this.max) {
      this.count += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.count += 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.count -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async with<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
