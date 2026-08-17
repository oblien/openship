/**
 * One resource-heavy build / execute_release at a time on this box.
 * Queued callers wait; they do not overlap.
 */
export class BuildMutex {
  private tail: Promise<void> = Promise.resolve();
  private held = false;

  get locked(): boolean {
    return this.held;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => mine);
    await previous;
    this.held = true;
    try {
      return await fn();
    } finally {
      this.held = false;
      release();
    }
  }
}

export const buildMutex = new BuildMutex();
