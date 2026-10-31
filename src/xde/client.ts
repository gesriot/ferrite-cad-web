import type { DefinitionMesh, PortableScene, XdeReport } from "./types";

type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export type ReadResult = {
  report: XdeReport;
  meshes: DefinitionMesh[];
  scene: PortableScene | null;
  sceneError: string | null;
  sceneNotes: string[];
  placement: {
    mode: string;
    occurrences: number;
    labelsWritten: number;
    rawBoundaryDifferences: number;
    rows: Array<{ index: number; parent: number; entry: string; kind: string; candidate: string[]; getLocation: string[]; shapeLocation: string[] }>;
    world: Array<{ index: number; parent: number; entry: string; world: string[] }>;
  } | null;
  readMs: number;
  initMs: number;
  heapBytes: number | null;
  temporaryFiles: string[];
  session: number;
};
export type ExportResult = { bytes: Uint8Array; byteLength: number; temporaryFiles: string[]; session: number };

/** Enough for the wasm download plus one assembly. Cancel stops sooner. */
export const XDE_REQUEST_TIMEOUT_MS = 120_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type XdePort = {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  terminate: () => void;
  onmessage: ((event: { data: Reply }) => void) | null;
  onerror: ((event: { message?: string; preventDefault?: () => void }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
};

/**
 * Browser owner of one XDE worker. A new worker is a new WASM instance.
 * `end` terminates it and rejects anything still waiting. The next call starts
 * another worker. Replies from a worker that is no longer current are ignored.
 * This client is not imported by the part editor.
 */
export class XdeClient {
  private worker: XdePort | null = null;
  private seq = 0;
  private session = 0;
  private pending = new Map<number, Pending>();
  private readonly spawn: () => XdePort;
  private readonly timeoutMs: number;

  constructor(spawn?: () => XdePort, timeoutMs = XDE_REQUEST_TIMEOUT_MS) {
    this.spawn = spawn ?? defaultSpawn;
    this.timeoutMs = timeoutMs;
  }

  get sessionId() {
    return this.session;
  }

  get pendingCount() {
    return this.pending.size;
  }

  get hasWorker() {
    return this.worker !== null;
  }

  read(bytes: Uint8Array<ArrayBufferLike>, options: { experimental?: boolean } = {}): Promise<ReadResult> {
    const copy = new Uint8Array(bytes);
    return this.call<Omit<ReadResult, "session">>("read", { bytes: copy, experimental: options.experimental === true }, [copy.buffer]).then((result) => ({ ...result, session: this.session }));
  }

  shift(definitionName: string, dz: number): Promise<ReadResult> {
    return this.call<Omit<ReadResult, "session">>("shift", { definitionName, dz }).then((result) => ({ ...result, session: this.session }));
  }

  exportStep(): Promise<ExportResult> {
    return this.call<Omit<ExportResult, "session">>("export").then((result) => ({ ...result, session: this.session }));
  }

  projectStep(bytes: Uint8Array<ArrayBufferLike>): Promise<{ scene: PortableScene | null; sceneError: string | null; sceneNotes: string[]; session: number }> {
    const copy = new Uint8Array(bytes);
    return this.call<{ scene: PortableScene | null; sceneError: string | null; sceneNotes: string[] }>("project", { bytes: copy }, [copy.buffer]).then((result) => ({
      ...result,
      session: this.session,
    }));
  }

  end(): void {
    this.fail(new Error("XDE session ended"));
  }

  private fail(error: Error) {
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.terminate();
    } catch {
      // The worker may already be gone.
    }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const item of waiting) {
      clearTimeout(item.timer);
      item.reject(error);
    }
  }

  private call<T>(op: string, payload: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<T> {
    const worker = this.ensure();
    const id = ++this.seq;
    const session = this.session;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.session !== session || !this.pending.has(id)) return;
        this.fail(new Error("XDE request timed out"));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        worker.postMessage({ id, op, ...payload }, transfer ?? []);
      } catch (error) {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        clearTimeout(item.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensure(): XdePort {
    if (this.worker) return this.worker;
    this.session += 1;
    const session = this.session;
    const worker = this.spawn();
    worker.onmessage = (event) => {
      if (this.worker !== worker || this.session !== session) return;
      const item = this.pending.get(event.data.id);
      if (!item) return;
      this.pending.delete(event.data.id);
      clearTimeout(item.timer);
      if (event.data.ok) item.resolve(event.data.result);
      else item.reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      if (this.worker !== worker || this.session !== session) return;
      this.fail(new Error(event.message || "XDE worker crashed"));
    };
    worker.onmessageerror = () => {
      if (this.worker !== worker || this.session !== session) return;
      this.fail(new Error("XDE worker could not receive a message"));
    };
    this.worker = worker;
    return worker;
  }
}

function defaultSpawn(): XdePort {
  return new Worker(new URL("./xde.worker.ts", import.meta.url), { type: "module" }) as unknown as XdePort;
}
