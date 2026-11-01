/**
 * Owner of the last *accepted* document revision: its FCAD bytes, the native
 * inspection, the name, the revision number, and whether it differs from what
 * was opened. It has no React, DOM, File, download or dialog; it talks to Rust
 * only through a `RustDocumentTransport`.
 *
 * A revision is accepted only when Rust read the file **and** reported
 * `validation.ok`. Everything else (a refusal, an invalid document, a crashed or
 * timed-out Worker, a failed file read, a superseded transition) leaves the
 * accepted revision, and therefore its download, exactly as it was.
 *
 * Intent is separate from the accepted state. `open()` registers its intent
 * before it awaits the file, `end()` registers its own, and a transition may
 * publish only if no newer intent has arrived and the document it was issued for
 * is still the accepted one. A late file read or a late answer from Rust
 * therefore cannot bring back a document after `end()` or overwrite a newer open.
 * Nothing here is global: two sessions never share a thing.
 */
import { DocumentTransportError, type RustDocumentTransport } from "./transport.ts";
import type {
  EditReply,
  ExpressionChange,
  NativeInspection,
  OpenReply,
  ReplyTiming,
  RustRefusal,
} from "./protocol.ts";

/** Immutable view of the accepted revision. Safe to hold; it never changes. */
export interface DocumentSnapshot {
  readonly name: string;
  /** 1 for a freshly opened document, +1 for every accepted edit. */
  readonly revision: number;
  /** Derived from the accepted bytes against the opened bytes. Downloading never clears it. */
  readonly dirty: boolean;
  readonly byteLength: number;
  /** Deeply frozen. */
  readonly inspection: NativeInspection;
}

export type TransitionOutcome =
  /** Rust read it, it is valid, and it is now the accepted revision. */
  | { readonly status: "accepted"; readonly snapshot: DocumentSnapshot; readonly timing: ReplyTiming }
  /** Rust declined; native `kind` and `message` are kept as they came. */
  | { readonly status: "refused"; readonly refusal: RustRefusal; readonly timing: ReplyTiming }
  /** Rust read the file, but `validation.ok` is false. Nothing was published. */
  | { readonly status: "invalid"; readonly inspection: NativeInspection; readonly timing: ReplyTiming }
  /** The Worker or its frame failed. The accepted revision is untouched. */
  | { readonly status: "transport-failed"; readonly failure: DocumentTransportError }
  /** A newer open or `end()` took over, so this transition published nothing. */
  | { readonly status: "superseded" };

export type OpenOutcome =
  | TransitionOutcome
  /** Publication was declined; the previously accepted document is untouched. */
  | { readonly status: "cancelled" }
  /** The file could not be read, so Rust was never asked. */
  | { readonly status: "read-failed"; readonly error: unknown };

export type EditOutcome =
  | TransitionOutcome
  /** An edit of this document is already in flight. */
  | { readonly status: "busy" }
  | { readonly status: "no-document" };

interface Accepted {
  /** Identity of the document; replaced by every open and cleared by `end()`. */
  readonly token: object;
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** The bytes as opened; the same array as `bytes` until the first edit. */
  readonly opened: Uint8Array<ArrayBuffer>;
  readonly snapshot: DocumentSnapshot;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function transportFailure(error: unknown): DocumentTransportError {
  return error instanceof DocumentTransportError
    ? error
    : new DocumentTransportError("worker-error", error instanceof Error ? error.message : String(error));
}

export class DocumentSession {
  readonly #transport: RustDocumentTransport;
  #accepted: Accepted | undefined;
  /** Advances for every open and for `end()`; only the latest open may publish. */
  #intent = 0;
  /** Document whose edit is in flight. */
  #editing: object | undefined;

  constructor(transport: RustDocumentTransport) {
    this.#transport = transport;
  }

  /** The accepted revision, or null when no document is held. Identity is stable until it changes. */
  get snapshot(): DocumentSnapshot | null {
    return this.#accepted?.snapshot ?? null;
  }

  /** A copy of the accepted FCAD for saving. Writing it somewhere is not tracked. */
  copyBytes(): Uint8Array<ArrayBuffer> | null {
    return this.#accepted ? this.#accepted.bytes.slice() : null;
  }

  /**
   * Replace the document with a file. The intent is registered synchronously,
   * before `read()` is awaited, so a newer open or `end()` issued while the
   * file is still being read wins even if this read finishes last.
   */
  async open(
    name: string,
    read: () => Promise<Uint8Array>,
    authorizeReplacement?: (current: DocumentSnapshot | null) => Promise<boolean>,
  ): Promise<OpenOutcome> {
    const intent = ++this.#intent;
    const live = () => intent === this.#intent;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      // Uint8Array subclasses such as Node Buffer may implement slice as a view.
      bytes = new Uint8Array(await read());
    } catch (error) {
      return live() ? { status: "read-failed", error } : { status: "superseded" };
    }
    if (!live()) return { status: "superseded" };

    let reply: OpenReply;
    try {
      // The transport gets a copy: whatever it does to it cannot reach `bytes`.
      reply = await this.#transport.open(bytes.slice());
    } catch (error) {
      return live() ? { status: "transport-failed", failure: transportFailure(error) } : { status: "superseded" };
    }
    if (!live()) return { status: "superseded" };
    if (!reply.ok) return { status: "refused", refusal: reply.refusal, timing: reply.timing };
    if (!reply.inspection.validation.ok) {
      return { status: "invalid", inspection: reply.inspection, timing: reply.timing };
    }
    if (authorizeReplacement) {
      // Reading and validation can take time. Permission to replace revision N
      // cannot discard an edit accepted meanwhile as revision N+1. Check again
      // after each asynchronous decision, then publish without another await.
      for (;;) {
        const current = this.snapshot;
        const allowed = await authorizeReplacement(current);
        if (!live()) return { status: "superseded" };
        if (!allowed) return { status: "cancelled" };
        if (this.snapshot === current) break;
      }
    }
    return {
      status: "accepted",
      snapshot: this.#accept(name, bytes, bytes, 1, reply.inspection),
      timing: reply.timing,
    };
  }

  /**
   * Set an expression of the accepted document to a constant. The edit starts
   * from the accepted bytes and publishes only if that document is still the
   * accepted one when Rust answers. Rust decides whether the change is allowed.
   */
  async setExpression(change: ExpressionChange): Promise<EditOutcome> {
    const current = this.#accepted;
    if (!current) return { status: "no-document" };
    if (this.#editing === current.token) return { status: "busy" };
    this.#editing = current.token;
    const live = () => this.#accepted?.token === current.token;
    try {
      let reply: EditReply;
      try {
        reply = await this.#transport.setExpression(current.bytes.slice(), change);
      } catch (error) {
        return live() ? { status: "transport-failed", failure: transportFailure(error) } : { status: "superseded" };
      }
      if (!live()) return { status: "superseded" };
      if (!reply.ok) return { status: "refused", refusal: reply.refusal, timing: reply.timing };
      if (!reply.inspection.validation.ok) {
        return { status: "invalid", inspection: reply.inspection, timing: reply.timing };
      }
      const snapshot = this.#accept(
        current.snapshot.name,
        new Uint8Array(reply.bytes),
        current.opened,
        current.snapshot.revision + 1,
        reply.inspection,
        current.token,
      );
      return { status: "accepted", snapshot, timing: reply.timing };
    } finally {
      if (this.#editing === current.token) this.#editing = undefined;
    }
  }

  /** Forget the document, supersede every transition in flight and release the Worker. */
  end(): void {
    this.#intent += 1;
    this.#accepted = undefined;
    this.#editing = undefined;
    this.#transport.dispose();
  }

  #accept(
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
    opened: Uint8Array<ArrayBuffer>,
    revision: number,
    inspection: NativeInspection,
    token: object = {},
  ): DocumentSnapshot {
    const snapshot: DocumentSnapshot = Object.freeze({
      name,
      revision,
      dirty: !sameBytes(bytes, opened),
      byteLength: bytes.length,
      inspection: deepFreeze(structuredClone(inspection)),
    });
    this.#accepted = { token, bytes, opened, snapshot };
    return snapshot;
  }
}
