/**
 * Builders for tests: replies in the shape of the Rust facade, and a Worker
 * double that behaves like a real one where it matters (a transfer detaches).
 * These replace Rust only to control *ordering*; no rule of the format lives here.
 */
import { DocumentSession, type EditOutcome, type OpenOutcome } from "./session.ts";
import {
  parseEditReply,
  parseOpenReply,
  type EditReply,
  type ExpressionChange,
  type OpenReply,
  type WorkerReply,
  type WorkerRequest,
} from "./protocol.ts";
import { DocumentTransportError, type RustDocumentTransport, type WorkerPort } from "./transport.ts";

export function inspectionJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    document_id: "01900000-0000-7000-8000-00000000d0c1",
    objects: [
      {
        id: "01900000-0000-7000-8000-000000000001",
        parent: null,
        kind: "feature.extrude",
        name: "Extrude",
        ordinal: "9223372036854775807",
        payload: { anything: ["the", "inspector", "does not use"] },
        payload_hash: "aa",
        reencoded_hash: "bb",
        reencoded_bytes: [1, 2, 3],
      },
    ],
    dependencies: [
      {
        dependent: "01900000-0000-7000-8000-000000000001",
        dependency: "01900000-0000-7000-8000-000000000002",
        role: "profile",
      },
    ],
    expression_slots: [
      {
        object: "01900000-0000-7000-8000-000000000001",
        name: "Extrude",
        slot: { kind: "extrude_distance" },
        expression: { source: "10", value: 10 },
        dimension: "length",
        refusal: null,
      },
    ],
    content_version: "c0",
    model_version: "m0",
    validation: { ok: true, diagnostics: [] },
    ...overrides,
  };
}

export function refusalJson(kind = "input", message = "invalid input: native wording"): Record<string, unknown> {
  return { ok: false, kind, message };
}

/** A Worker double: records posts, detaches transferred buffers, answers on demand. */
export class FakeWorker implements WorkerPort {
  onmessage: WorkerPort["onmessage"] = null;
  onmessageerror: WorkerPort["onmessageerror"] = null;
  onerror: WorkerPort["onerror"] = null;
  readonly posted: WorkerRequest[] = [];
  terminated = 0;
  postError: Error | undefined;
  /** The handlers as they were installed, so a test can deliver a late event after termination. */
  readonly installed: Pick<WorkerPort, "onmessage" | "onmessageerror" | "onerror">[] = [];

  postMessage(message: WorkerRequest, transfer: Transferable[]): void {
    if (this.postError) throw this.postError;
    this.installed.push({ onmessage: this.onmessage, onmessageerror: this.onmessageerror, onerror: this.onerror });
    // Structured clone with transfer is what a real postMessage does to the buffer.
    this.posted.push(structuredClone(message, { transfer }));
  }

  terminate(): void {
    this.terminated += 1;
  }

  reply(index: number, json: unknown, bytes: Uint8Array = new Uint8Array(0)): void {
    const id = this.posted[index]?.id;
    const copy = bytes.slice().buffer;
    const reply: WorkerReply = { id: id as number, json, bytes: copy, initMs: 1, operationMs: 2 };
    this.installed[index]?.onmessage?.({ data: reply });
  }

  send(data: unknown): void {
    this.installed.at(-1)?.onmessage?.({ data });
  }
}

export const settled = async (...promises: Promise<unknown>[]) => Promise.allSettled(promises);

/** Let every queued microtask and the next timer tick run. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const timing = { initMs: 0, operationMs: 0 };

export interface Call {
  readonly kind: "open" | "edit";
  readonly bytes: Uint8Array;
  readonly change?: ExpressionChange;
  settled: boolean;
  resolve(reply: OpenReply | EditReply): void;
  reject(error: unknown): void;
}

/** A transport that answers only when told to, so a test controls which reply arrives when. */
export class FakeTransport implements RustDocumentTransport {
  readonly calls: Call[] = [];
  disposed = 0;
  /** A real transport rejects what is pending on dispose; a stubborn one answers late anyway. */
  rejectOnDispose = true;
  /** Simulates a transport that takes ownership of (and detaches) the buffer it is handed. */
  detachInput = false;

  open(bytes: Uint8Array): Promise<OpenReply> {
    return this.#call("open", bytes) as Promise<OpenReply>;
  }

  setExpression(bytes: Uint8Array, change: ExpressionChange): Promise<EditReply> {
    return this.#call("edit", bytes, change) as Promise<EditReply>;
  }

  dispose(): void {
    this.disposed += 1;
    if (!this.rejectOnDispose) return;
    for (const call of this.calls) {
      if (!call.settled) call.reject(new DocumentTransportError("disposed", "disposed"));
    }
  }

  #call(kind: "open" | "edit", bytes: Uint8Array, change?: ExpressionChange): Promise<unknown> {
    if (this.detachInput) structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return new Promise((resolve, reject) => {
      const call: Call = {
        kind,
        bytes,
        change,
        settled: false,
        resolve: (reply) => {
          call.settled = true;
          resolve(reply);
        },
        reject: (error) => {
          call.settled = true;
          reject(error);
        },
      };
      this.calls.push(call);
    });
  }
}

export const readOk = (overrides: Record<string, unknown> = {}): OpenReply =>
  parseOpenReply(inspectionJson(overrides), new Uint8Array(0), timing);
export const editOk = (bytes: Uint8Array, overrides: Record<string, unknown> = {}): EditReply =>
  parseEditReply(inspectionJson(overrides), bytes.slice(), timing);
export const refused = (kind = "input", message = "native refusal"): OpenReply =>
  parseOpenReply(refusalJson(kind, message), new Uint8Array(0), timing);
export const invalid = (): Record<string, unknown> => ({
  validation: {
    ok: false,
    diagnostics: [{ severity: "error", code: "revolve.axis", message: "native diagnostic", object: null }],
  },
});

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function newSession() {
  const transport = new FakeTransport();
  return { transport, session: new DocumentSession(transport) };
}

export const change: ExpressionChange = {
  object: "01900000-0000-7000-8000-000000000001",
  slot: { kind: "extrude_distance" },
  value_mm: 16,
};

export const bytesOf = (...values: number[]) => Uint8Array.from(values);


/** Open a file and let Rust accept it. */
export async function openAccepted(
  session: DocumentSession,
  transport: FakeTransport,
  name = "plate.fcad",
  bytes = bytesOf(1, 2, 3),
  overrides: Record<string, unknown> = {},
): Promise<OpenOutcome> {
  const pending = session.open(name, async () => bytes);
  await tick();
  transport.calls.at(-1)!.resolve(readOk(overrides));
  return pending;
}

export async function edit(session: DocumentSession, transport: FakeTransport, reply: OpenReply | EditReply): Promise<EditOutcome> {
  const pending = session.setExpression(change);
  await tick();
  transport.calls.at(-1)!.resolve(reply);
  return pending;
}
