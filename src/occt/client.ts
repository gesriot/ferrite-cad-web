export type WorkerOk<T> = { id: number; revision?: number; ok: true; result: T };
export type WorkerFail = { id: number; revision?: number; ok: false; error: string };

export class StaleWorkerResult extends Error {
  /** Worker reported success. A commit with this set has already replaced `current`. */
  readonly committed: boolean;
  readonly result: unknown;
  constructor(committed = false, result: unknown = null) {
    super("STALE");
    this.name = "StaleWorkerResult";
    this.committed = committed;
    this.result = result;
  }
}

export class OcctSession {
  /** Document epoch captured when a call is sent. A newer epoch rejects the reply. */
  generation = 0;
  private worker: Worker;
  private seq = 0;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, { revision: number; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL("./occt.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerOk<unknown> | WorkerFail>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (this.closed) {
        pending.reject(new StaleWorkerResult(false));
        return;
      }
      const fresh = message.revision === pending.revision && pending.revision === this.generation;
      if (!fresh) {
        pending.reject(new StaleWorkerResult(message.ok, message.ok ? message.result : null));
        return;
      }
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    };
    this.worker.onmessageerror = () => {
      this.fail(new Error("Worker could not read the message"));
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      const message = event.message || "Worker crashed";
      this.fail(new Error(message));
    };
  }

  get dead() {
    return this.closed;
  }

  call<T>(op: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error("document session stopped"));
    const run = this.tail.then(() => this.send<T>(op, payload, transfer));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private send<T>(op: string, payload: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("document session stopped"));
    const id = ++this.seq;
    const revision = this.generation;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { revision, resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, op, revision, ...payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker.terminate();
  }

  close() {
    this.fail(new Error("document session stopped"));
  }
}