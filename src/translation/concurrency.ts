interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export class AbortableSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Semaphore capacity must be a positive integer");
    }
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }

    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(abortReason(signal));
        },
      };

      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.capacity && this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter) {
        return;
      }

      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }

      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
