export type LifetimeOptions = {
  cleanupMs: number;
  requestTermination(reason: string): void;
  signal?: AbortSignal;
};

// A timeout requests process termination. It never pretends that user code stopped.
export class ExecutionLifetime {
  readonly #controller = new AbortController();
  readonly #resources: Array<(reason?: unknown) => Promise<void>> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #finished = false;
  #draining = false;
  readonly signal = this.#controller.signal;
  constructor(readonly options: LifetimeOptions) {
    if (!Number.isSafeInteger(options.cleanupMs) || options.cleanupMs <= 0)
      throw new Error("Invalid cleanup bound");
    if (options.signal) {
      if (options.signal.aborted) this.abort(options.signal.reason);
      else options.signal.addEventListener("abort", this.#parentAbort, { once: true });
    }
  }
  readonly #parentAbort = () => this.abort(this.options.signal?.reason);
  own(dispose: (reason?: unknown) => Promise<void>): void {
    if (this.#finished) throw new Error("Execution lifetime is closed");
    this.#resources.push(dispose);
  }
  abort(reason: unknown = new Error("Execution aborted")): void {
    if (this.#finished) return;
    this.#controller.abort(reason);
    this.#arm();
  }
  #arm(): void {
    if (this.#timer || this.#draining) return;
    this.#timer = setTimeout(() => this.#terminate(), this.options.cleanupMs);
    this.#timer.unref();
  }
  #terminate(): void {
    if (this.#finished || this.#draining) return;
    this.#draining = true;
    this.options.requestTermination("Background execution did not stop within its cleanup bound");
  }
  async run<T>(body: (lifetime: ExecutionLifetime) => Promise<T>): Promise<T> {
    try {
      return await body(this);
    } finally {
      this.#controller.abort(new Error("Execution scope closing"));
      this.#arm();
      try {
        // Disposers run together so one blocked resource cannot hide the others.
        const results = await Promise.allSettled(
          this.#resources.map((dispose) => dispose(this.signal.reason)),
        );
        if (results.some((result) => result.status === "rejected")) {
          this.#terminate();
          await new Promise<never>(() => {});
        }
        if (this.#draining) await new Promise<never>(() => {});
        this.#finished = true;
        if (this.#timer) clearTimeout(this.#timer);
        this.options.signal?.removeEventListener("abort", this.#parentAbort);
      } catch {
        this.#terminate();
        await new Promise<never>(() => {});
      }
    }
  }
}
