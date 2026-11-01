/**
 * The committed Rust module, driven through the whole new path:
 * DocumentSession -> WorkerDocumentTransport -> a loopback Worker that runs the
 * real request handler -> the shared ABI framing -> `document.wasm`.
 *
 * This is not a native test. Native parity (101 inputs, edits, refusals against
 * the native host facade) is `scripts/test-document-wasm.mjs` and the "Document
 * WASM probe" workflow. Versions pinned here were produced by that native host
 * facade at the pinned commit; the old TypeScript FCAD reader is no oracle.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDocumentAbi, type DocumentWasmModule } from "./abi.ts";
import type { NativeSlot, WorkerRequest } from "./protocol.ts";
import { DocumentSession } from "./session.ts";
import { tick } from "./test-support.ts";
import { DocumentTransportError, WorkerDocumentTransport, type WorkerPort } from "./transport.ts";
import { createRequestHandler } from "./worker-host.ts";

const kernelDirectory = new URL("../../public/document-probe/kernel/", import.meta.url);
const wasmBinary = readFileSync(new URL("document.wasm", kernelDirectory));
const corpus = (name: string) => new Uint8Array(readFileSync(new URL(`../../test-data/current-contract/${name}.fcad`, import.meta.url)));

async function loadModule(): Promise<DocumentWasmModule> {
  const { default: create } = (await import(new URL("document.mjs", kernelDirectory).href)) as {
    default: (options: { wasmBinary: Uint8Array }) => Promise<DocumentWasmModule>;
  };
  return create({ wasmBinary });
}

interface Loopback {
  readonly worker: WorkerPort;
  /** Every request the real handler answered. */
  readonly handled: WorkerRequest[];
  terminated: boolean;
  crashNext: boolean;
}

/** A Worker whose other side is the real handler. A transfer detaches, as in a browser. */
function loopbackTransport(timeoutMs?: number) {
  const workers: Loopback[] = [];
  const transport = new WorkerDocumentTransport({
    timeoutMs,
    createWorker: () => {
      const handle = createRequestHandler(() => createDocumentAbi(loadModule));
      const state: Loopback = {
        handled: [],
        terminated: false,
        crashNext: false,
        worker: {
          onmessage: null,
          onmessageerror: null,
          onerror: null,
          postMessage(message, transfer) {
            const request = structuredClone(message, { transfer });
            state.handled.push(request);
            if (state.crashNext) {
              state.crashNext = false;
              setTimeout(() => state.worker.onerror?.({ message: "Worker crashed" }), 0);
              return;
            }
            void handle(request).then(({ reply, transfer: back }) => {
              const data = structuredClone(reply, { transfer: back });
              setTimeout(() => {
                if (!state.terminated) state.worker.onmessage?.({ data });
              }, 0);
            });
          },
          terminate() {
            state.terminated = true;
          },
        },
      };
      workers.push(state);
      return state.worker;
    },
  });
  return { transport, workers, session: new DocumentSession(transport) };
}

async function openFile(session: DocumentSession, name: string, file: string | Uint8Array) {
  const bytes = typeof file === "string" ? corpus(file) : file;
  return { bytes, outcome: await session.open(name, async () => bytes) };
}

const lengthSlot = (slots: readonly NativeSlot[]) => {
  const slot = slots.find((candidate) => candidate.slot.kind === "extrude_distance");
  assert.ok(slot, "the document has an extrude distance");
  return slot;
};

test("plate: 10 -> 16 through session, transport, Worker handler and the real module", async () => {
  const { session } = loopbackTransport();
  const { bytes, outcome } = await openFile(session, "Пластина.fcad", "current-plate");
  assert.equal(outcome.status, "accepted");
  const opened = session.snapshot!;
  assert.deepEqual([...session.copyBytes()!], [...bytes], "the original bytes, not re-encoded payloads");
  assert.equal(opened.inspection.content_version, "4f171176b0b3abcf4b738f3fcd77b91afb321a9e9fb4aa6c1becff207bdc3bce");
  assert.equal(opened.inspection.model_version, "cc8b8b9797584c7f9d06749a38e46e2644207302e3186ea4edbfc8b0e6fd0eb7");
  const slot = lengthSlot(opened.inspection.expression_slots);
  assert.deepEqual(slot.expression, { source: "10", value: 10 });
  assert.equal(slot.name, "Extrude");
  assert.equal(slot.refusal, null);
  assert.deepEqual(
    opened.inspection.dependencies.map(({ role }) => role),
    ["plane", "profile", "body_tip"],
  );

  const edited = await session.setExpression({ object: slot.object, slot: slot.slot, value_mm: 16 });
  assert.equal(edited.status, "accepted");
  const after = session.snapshot!;
  assert.equal(after.revision, 2);
  assert.equal(after.dirty, true);
  assert.equal(after.inspection.validation.ok, true);
  const changed = lengthSlot(after.inspection.expression_slots);
  assert.deepEqual(changed.expression, { source: "16", value: 16 });
  assert.equal(changed.object, slot.object, "same object ID");
  assert.deepEqual(after.inspection.dependencies, opened.inspection.dependencies, "same dependencies");
  assert.deepEqual(
    after.inspection.objects.map(({ id, kind, name, ordinal }) => ({ id, kind, name, ordinal })),
    opened.inspection.objects.map(({ id, kind, name, ordinal }) => ({ id, kind, name, ordinal })),
  );
  assert.equal(after.inspection.document_id, opened.inspection.document_id);
  assert.equal(after.inspection.model_version, "459ce40863c3f4c8a30c5abd1d48ac99227cbb051e6a8489ed4a9fce7fa5210c");
  assert.notEqual(after.inspection.content_version, opened.inspection.content_version);

  // The downloaded bytes reopen in a brand-new session and a brand-new Worker.
  const saved = session.copyBytes()!;
  assert.notDeepEqual([...saved], [...bytes]);
  const fresh = loopbackTransport();
  const reopened = await openFile(fresh.session, "wasm-Пластина.fcad", saved);
  assert.equal(reopened.outcome.status, "accepted");
  const again = fresh.session.snapshot!;
  assert.deepEqual(lengthSlot(again.inspection.expression_slots).expression, { source: "16", value: 16 });
  assert.equal(again.inspection.model_version, after.inspection.model_version);
  assert.equal(again.inspection.content_version, after.inspection.content_version);
  assert.deepEqual(again.inspection.dependencies, opened.inspection.dependencies);
  assert.equal(again.dirty, false);
  fresh.session.end();
  session.end();
});

test("L profile: 12.7 -> 10.1 keeps the exact stored source and value", async () => {
  const { session } = loopbackTransport();
  assert.equal((await openFile(session, "l.fcad", "current-l")).outcome.status, "accepted");
  const opened = session.snapshot!;
  assert.equal(opened.inspection.model_version, "d754f8cfe6c52c10e3a5ae0c2d63ae42eae7dcdfea605e96f5bab292a1aa94b6");
  const slot = lengthSlot(opened.inspection.expression_slots);
  assert.deepEqual(slot.expression, { source: "12.7", value: 12.7 });

  const edited = await session.setExpression({ object: slot.object, slot: slot.slot, value_mm: 10.1 });
  assert.equal(edited.status, "accepted");
  const after = session.snapshot!;
  assert.deepEqual(lengthSlot(after.inspection.expression_slots).expression, { source: "10.1", value: 10.1 });
  assert.equal(after.inspection.model_version, "ae580d282801b62633027adcece60565932bd92aac8981f2df31ea645af8073a");
  assert.deepEqual(after.inspection.dependencies, opened.inspection.dependencies);

  const fresh = loopbackTransport();
  assert.equal((await openFile(fresh.session, "l-out.fcad", session.copyBytes()!)).outcome.status, "accepted");
  assert.deepEqual(lengthSlot(fresh.session.snapshot!.inspection.expression_slots).expression, { source: "10.1", value: 10.1 });
  assert.equal(fresh.session.snapshot!.inspection.model_version, after.inspection.model_version);
  fresh.session.end();
  session.end();
});

test("slots and refusals come from Rust: datum offset, a constraint slot and an angle edit without any whitelist", async () => {
  const cases: [string, string, number, string][] = [
    ["offset-plane", "datum_offset", 7, "7"],
    ["regression-regression-valid-constrained", "fixed_x", 2.5, "2.5"],
    ["valid-revolve-partial", "revolve_angle", 0.5, "0.5"],
  ];
  for (const [file, kind, value, source] of cases) {
    const { session } = loopbackTransport();
    assert.equal((await openFile(session, `${file}.fcad`, file)).outcome.status, "accepted", file);
    const slot = session.snapshot!.inspection.expression_slots.find((candidate) => candidate.slot.kind === kind)!;
    assert.ok(slot, `${file} has a ${kind} slot`);
    const outcome = await session.setExpression({ object: slot.object, slot: slot.slot, value_mm: value });
    assert.equal(outcome.status, "accepted", file);
    const changed = session.snapshot!.inspection.expression_slots.find(
      (candidate) => candidate.slot.kind === kind && candidate.object === slot.object,
    )!;
    assert.deepEqual(changed.expression, { source, value });
    assert.deepEqual(changed.slot, slot.slot, "the slot, including any constraint, is the native object");
    session.end();
  }
});

test("a negative height is a native refusal and the accepted bytes stay", async () => {
  const { session } = loopbackTransport();
  const { bytes } = await openFile(session, "plate.fcad", "current-plate");
  const before = session.snapshot!;
  const slot = lengthSlot(before.inspection.expression_slots);
  const outcome = await session.setExpression({ object: slot.object, slot: slot.slot, value_mm: -1 });
  assert.equal(outcome.status, "refused");
  assert.deepEqual(outcome.status === "refused" && outcome.refusal, {
    kind: "input",
    message: "invalid input: extrude distance must be positive, found -1",
  });
  assert.equal(session.snapshot, before);
  assert.deepEqual([...session.copyBytes()!], [...bytes]);
  assert.equal(session.snapshot!.dirty, false);
  session.end();
});

test("revolve-line-missing-curve.fcad is read by Rust but invalid: nothing is accepted, the plate stays", async () => {
  const { session } = loopbackTransport();
  const invalid = await openFile(session, "revolve.fcad", "revolve-line-missing-curve");
  assert.equal(invalid.outcome.status, "invalid");
  assert.equal(session.snapshot, null);
  assert.equal(session.copyBytes(), null);
  if (invalid.outcome.status === "invalid") {
    const [diagnostic] = invalid.outcome.inspection.validation.diagnostics;
    assert.equal(invalid.outcome.inspection.validation.ok, false);
    assert.equal(diagnostic!.code, "revolve.axis");
    assert.equal(diagnostic!.severity, "error");
    assert.equal(
      diagnostic!.message,
      "revolve axis 01a169b8-22e5-77e3-8df4-279efc190bb9 is not a Line of its profile sketch",
    );
  }

  const { bytes } = await openFile(session, "plate.fcad", "current-plate");
  const plate = session.snapshot!;
  assert.equal((await openFile(session, "revolve.fcad", "revolve-line-missing-curve")).outcome.status, "invalid");
  assert.equal(session.snapshot, plate);
  assert.deepEqual([...session.copyBytes()!], [...bytes]);
  session.end();
});

test("a file Rust cannot read is a native refusal, and the open document stays", async () => {
  const { session } = loopbackTransport();
  const { bytes } = await openFile(session, "plate.fcad", "current-plate");
  const outcome = (await openFile(session, "chamfer.fcad", "chamfer-negative-distance")).outcome;
  assert.equal(outcome.status, "refused");
  assert.equal(outcome.status === "refused" && outcome.refusal.kind, "input");
  assert.match(outcome.status === "refused" ? outcome.refusal.message : "", /^invalid input: reading object .* of type feature\.chamfer$/);
  assert.deepEqual([...session.copyBytes()!], [...bytes]);

  const garbage = (await openFile(session, "garbage.fcad", Uint8Array.of(0, 1, 2, 3))).outcome;
  assert.equal(garbage.status, "refused");
  assert.deepEqual([...session.copyBytes()!], [...bytes]);
  session.end();
});

test("a crash and a timeout free the Worker, keep the accepted FCAD, and the next edit uses it on a new Worker", async () => {
  const { session, workers } = loopbackTransport(5000);
  const { bytes } = await openFile(session, "plate.fcad", "current-plate");
  const accepted = session.snapshot!;
  const slot = lengthSlot(accepted.inspection.expression_slots);
  const change = { object: slot.object, slot: slot.slot, value_mm: 16 };

  workers[0]!.crashNext = true;
  const crashed = await session.setExpression(change);
  assert.equal(crashed.status, "transport-failed");
  assert.equal(crashed.status === "transport-failed" && crashed.failure.reason, "worker-error");
  assert.ok(crashed.status === "transport-failed" && crashed.failure instanceof DocumentTransportError);
  assert.equal(workers[0]!.terminated, true);
  assert.equal(session.snapshot, accepted, "a crash is not Close");
  assert.deepEqual([...session.copyBytes()!], [...bytes]);

  const recovered = await session.setExpression(change);
  assert.equal(recovered.status, "accepted");
  assert.equal(workers.length, 2, "a new Worker, created by the explicit next operation");
  assert.deepEqual(
    [...new Uint8Array(workers[1]!.handled[0]!.bytes)],
    [...bytes],
    "the recovered edit started from the accepted bytes",
  );
  assert.deepEqual(lengthSlot(session.snapshot!.inspection.expression_slots).expression, { source: "16", value: 16 });
  session.end();
  await tick();
  assert.equal(workers[1]!.terminated, true, "end() releases the Worker");

  const slow = loopbackTransport(1);
  const failing = await openFile(slow.session, "plate.fcad", "current-plate");
  assert.equal(failing.outcome.status, "transport-failed");
  assert.equal(failing.outcome.status === "transport-failed" && failing.outcome.failure.reason, "timeout");
  assert.equal(slow.session.snapshot, null);
});

test("end() during an edit releases the Worker and the late answer restores nothing", async () => {
  const { session, workers } = loopbackTransport();
  await openFile(session, "plate.fcad", "current-plate");
  const slot = lengthSlot(session.snapshot!.inspection.expression_slots);
  const editing = session.setExpression({ object: slot.object, slot: slot.slot, value_mm: 16 });
  session.end();
  assert.equal((await editing).status, "superseded");
  assert.equal(session.snapshot, null);
  assert.equal(workers[0]!.terminated, true);
  await tick();
  assert.equal(session.snapshot, null);
});

test("two sessions run in separate Workers and never see each other's document", async () => {
  const a = loopbackTransport();
  const b = loopbackTransport();
  await openFile(a.session, "a.fcad", "current-plate");
  await openFile(b.session, "b.fcad", "current-l");
  assert.equal(a.session.snapshot!.inspection.model_version.startsWith("cc8b"), true);
  assert.equal(b.session.snapshot!.inspection.model_version.startsWith("d754"), true);
  b.session.end();
  assert.equal(a.workers[0]!.terminated, false);
  assert.equal(a.session.snapshot!.name, "a.fcad");
  a.session.end();
});
