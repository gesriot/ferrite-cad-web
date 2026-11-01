/**
 * The thin browser adapter around a `DocumentSession`: it owns what the session
 * must not know about — a `File`, the 32 MiB bound checked before the file is
 * read, the Cancel/Discard question, and handing bytes to a download. It holds
 * no document state; the session's snapshot is the only copy.
 *
 * The question is asked before the session is touched, so Cancel changes
 * nothing. A discard answer authorises dropping the revision that was shown
 * when it was asked: if an edit lands while the question is open, it is asked
 * again rather than silently covering a revision the user never saw.
 */
import type { NativeSlot } from "../document/protocol.ts";
import type { DocumentSession, DocumentSnapshot, EditOutcome, OpenOutcome } from "../document/session.ts";
import { assertCadFileSize, readCadFile } from "../occt/file-limits.ts";

export interface ProbeFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ProbePorts {
  /** Ask whether unsaved changes may be dropped. Resolves false for Cancel. */
  confirmDiscard(question: string): Promise<boolean>;
  /** Hand bytes to the browser as a download. */
  saveFile(name: string, bytes: Uint8Array<ArrayBuffer>): void;
}

export type ProbeResult =
  /** Cancel was chosen, or a newer request took over while the question was open. */
  | { readonly kind: "cancelled" }
  /** The input never reached the session. */
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "open"; readonly outcome: OpenOutcome }
  | { readonly kind: "edit"; readonly outcome: EditOutcome }
  | { readonly kind: "ended" };

export class ProbeController {
  readonly #session: DocumentSession;
  readonly #ports: ProbePorts;
  /** Latest request that may need a question; an older one that is still waiting gives way. */
  #request = 0;

  constructor(session: DocumentSession, ports: ProbePorts) {
    this.#session = session;
    this.#ports = ports;
  }

  async openFile(file: ProbeFile): Promise<ProbeResult> {
    try {
      assertCadFileSize(file.size);
    } catch (error) {
      return { kind: "rejected", message: error instanceof Error ? error.message : String(error) };
    }
    const request = ++this.#request;
    const permission = await this.#mayDiscard(request, "Opening another file");
    if (!permission || request !== this.#request) return { kind: "cancelled" };
    // The session registers this open before the file is read.
    const outcome = await this.#session.open(file.name, () => readCadFile(file), async (current) => {
      if (request !== this.#request) return false;
      if (current === permission.snapshot || !current?.dirty) return true;
      const allowed = await this.#ports.confirmDiscard(
        `Opening another file will discard the unsaved changes to ${current.name}.`,
      );
      return allowed && request === this.#request;
    });
    return { kind: "open", outcome };
  }

  async applyExpression(slot: NativeSlot, value: number): Promise<ProbeResult> {
    // JSON cannot carry NaN or Infinity; every other value is Rust's to judge.
    if (!Number.isFinite(value)) return { kind: "rejected", message: "Enter a finite number." };
    const outcome = await this.#session.setExpression({
      object: slot.object,
      slot: slot.slot,
      value_mm: value,
    });
    return { kind: "edit", outcome };
  }

  /** Offer the accepted bytes to the browser. This does not clear `dirty`. */
  download(): boolean {
    const snapshot = this.#session.snapshot;
    const bytes = this.#session.copyBytes();
    if (!snapshot || !bytes) return false;
    this.#ports.saveFile(`wasm-${snapshot.name}`, bytes);
    return true;
  }

  async end(): Promise<ProbeResult> {
    const request = ++this.#request;
    for (;;) {
      const permission = await this.#mayDiscard(request, "Ending the probe");
      if (!permission || request !== this.#request) return { kind: "cancelled" };
      // An edit can resolve between #mayDiscard and this continuation too.
      if (this.#session.snapshot !== permission.snapshot) continue;
      this.#session.end();
      return { kind: "ended" };
    }
  }

  /** Leaving the page: nothing can be asked, so release the Worker unconditionally. */
  dispose(): void {
    this.#request += 1;
    this.#session.end();
  }

  async #mayDiscard(
    request: number,
    action: string,
  ): Promise<{ snapshot: DocumentSnapshot | null } | null> {
    for (;;) {
      const shown = this.#session.snapshot;
      if (!shown?.dirty) return request === this.#request ? { snapshot: shown } : null;
      const discard = await this.#ports.confirmDiscard(
        `${action} will discard the unsaved changes to ${shown.name}.`,
      );
      if (!discard || request !== this.#request) return null;
      if (this.#session.snapshot === shown) return { snapshot: shown };
    }
  }
}
