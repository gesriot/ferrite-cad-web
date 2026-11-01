/**
 * Typed transport to the Rust document module running in a Worker.
 *
 * The three outcomes of a call stay separate:
 *  - the promise **rejects** with `DocumentTransportError` when the Worker or its
 *    frame failed (crash, `messageerror`, timeout, `dispose`, a malformed reply);
 *  - it resolves `{ ok: false }` when Rust **refused** the call;
 *  - it resolves `{ ok: true }` when Rust read the file. That says nothing about
 *    validity: the caller must check `inspection.validation.ok`.
 *
 * There is no global Worker. Each transport creates its Worker on the first
 * call, runs one request at a time, and after any failure or `dispose()` frees
 * the Worker; the next explicit call starts a fresh one.
 */
import {
  parseEditReply,
  parseOpenReply,
  parseWorkerReply,
  ProtocolError,
  type EditReply,
  type ExpressionChange,
  type OpenReply,
  type ReplyTiming,
  type WorkerReply,
  type WorkerRequest,
} from "./protocol.ts";

export type TransportFailureReason =
  | "start-failed"
  | "worker-error"
  | "message-error"
  | "worker-reported"
  | "malformed-reply"
  | "timeout"
  | "disposed";

export class DocumentTransportError extends Error {
  readonly reason: TransportFailureReason;
  constructor(reason: TransportFailureReason, message: string) {
    super(message);
    this.name = "DocumentTransportError";
    this.reason = reason;
  }
}

export interface RustDocumentTransport {
  /** Ask Rust to read an FCAD. The transport neither keeps nor transfers `bytes`. */
  open(bytes: Uint8Array): Promise<OpenReply>;
  /** Ask Rust to set one expression to a constant and return the rewritten FCAD. */
  setExpression(bytes: Uint8Array, change: ExpressionChange): Promise<EditReply>;
  /** Fail whatever is pending and free the Worker. A later call starts a new one. */
  dispose(): void;
}

/** The part of `Worker` the transport uses; narrow enough for a test double. */
export interface WorkerPort {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  onerror: ((event: { readonly message?: string; preventDefault?(): void }) => void) | null;
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface WorkerTransportOptions {
  createWorker(): WorkerPort;
  /** Upper bound for one request once it is posted; the module's first load counts. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

type SuccessReply = Extract<WorkerReply, { json: unknown }>;

interface Job {
  readonly id: number;
  readonly request: WorkerRequest;
  readonly transfer: Transferable[];
  /** Parses and resolves; throws `ProtocolError` for a malformed reply. */
  accept(reply: SuccessReply): void;
  fail(error: DocumentTransportError): void;
  timer?: ReturnType<typeof setTimeout>;
}

function reasonText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function timingOf(reply: SuccessReply): ReplyTiming {
  return { initMs: reply.initMs, operationMs: reply.operationMs };
}

export class WorkerDocumentTransport implements RustDocumentTransport {
  readonly #createWorker: () => WorkerPort;
  readonly #timeoutMs: number;
  #worker: WorkerPort | undefined;
  /** Advances whenever a Worker is released; handlers of an older one are ignored. */
  #generation = 0;
  #nextId = 0;
  #inflight: Job | undefined;
  #queue: Job[] = [];

  constructor(options: WorkerTransportOptions) {
    this.#createWorker = options.createWorker;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  open(bytes: Uint8Array): Promise<OpenReply> {
    // Transfer a private copy: the caller's buffer must survive the call.
    const buffer = new Uint8Array(bytes).buffer;
    return this.#submit(
      (id) => ({ id, operation: "open", bytes: buffer }),
      [buffer],
      (reply) => parseOpenReply(reply.json, new Uint8Array(reply.bytes), timingOf(reply)),
    );
  }

  setExpression(bytes: Uint8Array, change: ExpressionChange): Promise<EditReply> {
    const buffer = new Uint8Array(bytes).buffer;
    // Only the three fields Rust accepts; it denies unknown ones.
    const request: ExpressionChange = {
      object: change.object,
      slot: structuredClone(change.slot),
      value_mm: change.value_mm,
    };
    return this.#submit(
      (id) => ({ id, operation: "set_expression", bytes: buffer, request }),
      [buffer],
      (reply) => parseEditReply(reply.json, new Uint8Array(reply.bytes), timingOf(reply)),
    );
  }

  dispose(): void {
    this.#release("disposed", "The document transport was disposed");
  }

  #submit<R>(
    build: (id: number) => WorkerRequest,
    transfer: Transferable[],
    parse: (reply: SuccessReply) => R,
  ): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const id = ++this.#nextId;
      this.#queue.push({
        id,
        request: build(id),
        transfer,
        accept: (reply) => resolve(parse(reply)),
        fail: reject,
      });
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#inflight || this.#queue.length === 0) return;
    let worker = this.#worker;
    if (!worker) {
      try {
        worker = this.#start();
      } catch (cause) {
        this.#release("start-failed", `The document Worker could not start: ${reasonText(cause)}`);
        return;
      }
    }
    const job = this.#queue.shift() as Job;
    const generation = this.#generation;
    this.#inflight = job;
    job.timer = setTimeout(() => {
      if (generation === this.#generation && this.#inflight === job) {
        this.#release("timeout", `The document Worker did not answer within ${this.#timeoutMs} ms`);
      }
    }, this.#timeoutMs);
    try {
      worker.postMessage(job.request, job.transfer);
    } catch (cause) {
      this.#release("worker-error", `The request could not be sent: ${reasonText(cause)}`);
    }
  }

  #start(): WorkerPort {
    const worker = this.#createWorker();
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    worker.onmessage = (event) => {
      if (current()) this.#receive(event.data);
    };
    worker.onmessageerror = () => {
      if (current()) {
        this.#release("message-error", "The document Worker sent a message that could not be read");
      }
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (current()) {
        this.#release("worker-error", event.message || "The document Worker crashed or failed to load");
      }
    };
    this.#worker = worker;
    return worker;
  }

  #receive(data: unknown): void {
    const job = this.#inflight;
    let reply: WorkerReply;
    try {
      reply = parseWorkerReply(data);
    } catch (cause) {
      this.#release("malformed-reply", reasonText(cause));
      return;
    }
    // Not the request in flight: a late or foreign answer is never published.
    if (!job || reply.id !== job.id) return;
    if ("transportError" in reply) {
      this.#release("worker-reported", reply.transportError);
      return;
    }
    try {
      job.accept(reply);
    } catch (cause) {
      this.#release(
        "malformed-reply",
        cause instanceof ProtocolError ? cause.message : reasonText(cause),
      );
      return;
    }
    clearTimeout(job.timer);
    this.#inflight = undefined;
    this.#pump();
  }

  /** Drop the Worker and reject the request in flight and everything queued behind it. */
  #release(reason: TransportFailureReason, message: string): void {
    const error = new DocumentTransportError(reason, message);
    const worker = this.#worker;
    this.#generation += 1;
    this.#worker = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onmessageerror = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        // A Worker that cannot be terminated is already unusable.
      }
    }
    const jobs = [...(this.#inflight ? [this.#inflight] : []), ...this.#queue];
    this.#inflight = undefined;
    this.#queue = [];
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.fail(error);
    }
  }
}
