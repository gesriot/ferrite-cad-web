import assert from "node:assert/strict";
import test from "node:test";
import type { ExpressionChange } from "./protocol.ts";
import { FakeWorker, inspectionJson, refusalJson, settled, tick } from "./test-support.ts";
import { DocumentTransportError, WorkerDocumentTransport } from "./transport.ts";

function harness(timeoutMs?: number) {
  const workers: FakeWorker[] = [];
  const transport = new WorkerDocumentTransport({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    timeoutMs,
  });
  return { workers, transport };
}

const change: ExpressionChange = {
  object: "01900000-0000-7000-8000-000000000001",
  slot: { kind: "extrude_distance" },
  value_mm: 16,
};
const fcad = () => Uint8Array.of(1, 2, 3, 4);

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DocumentTransportError, String(error));
    return error.reason;
  }
  throw new Error("expected a transport failure");
}

test("the Worker is created on the first call, not with the transport", async () => {
  const { workers, transport } = harness();
  assert.equal(workers.length, 0);
  const pending = transport.open(fcad());
  assert.equal(workers.length, 1);
  workers[0]!.reply(0, inspectionJson());
  await pending;
  transport.dispose();
});

test("a successful read keeps the native inspection and never rounds a string ordinal", async () => {
  const { workers, transport } = harness();
  const pending = transport.open(fcad());
  workers[0]!.reply(0, inspectionJson());
  const reply = await pending;
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.equal(reply.inspection.objects[0]!.ordinal, "9223372036854775807");
  assert.notEqual(String(Number(reply.inspection.objects[0]!.ordinal)), reply.inspection.objects[0]!.ordinal);
  assert.deepEqual(reply.inspection.objects[0]!.payload, { anything: ["the", "inspector", "does not use"] });
  assert.equal(reply.inspection.expression_slots[0]!.expression.source, "10");
  assert.deepEqual(reply.timing, { initMs: 1, operationMs: 2 });
  assert.equal("reencoded_bytes" in reply.inspection.objects[0]!, false);
});

test("a native refusal resolves with the native kind and message, untouched", async () => {
  const { workers, transport } = harness();
  const pending = transport.open(fcad());
  workers[0]!.reply(0, refusalJson("something-new", "Any wording; it is never classified: timeout, crash, transport"));
  const reply = await pending;
  assert.deepEqual(reply.ok === false && reply.refusal, {
    kind: "something-new",
    message: "Any wording; it is never classified: timeout, crash, transport",
  });
  assert.equal(workers[0]!.terminated, 0, "a refusal is not a transport failure");
});

test("ok:true with validation.ok:false is a successful read that carries the diagnostics", async () => {
  const { workers, transport } = harness();
  const diagnostics = [{ severity: "error", code: "revolve.axis", message: "native", object: null }];
  const pending = transport.open(fcad());
  workers[0]!.reply(0, inspectionJson({ validation: { ok: false, diagnostics } }));
  const reply = await pending;
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.inspection.validation.ok, false);
    assert.deepEqual(reply.inspection.validation.diagnostics, diagnostics);
  }
});

test("the caller's buffer survives the call and the Worker receives its own copy", async () => {
  const { workers, transport } = harness();
  const mine = fcad();
  const pending = transport.open(mine);
  assert.equal(mine.buffer.byteLength, 4, "the transfer must not detach the caller's FCAD");
  const posted = workers[0]!.posted[0]!;
  assert.deepEqual([...new Uint8Array(posted.bytes)], [1, 2, 3, 4]);
  workers[0]!.reply(0, inspectionJson());
  await pending;
  const view = new Uint8Array(new ArrayBuffer(8), 2, 4);
  view.set([9, 8, 7, 6]);
  const second = transport.setExpression(view, change);
  assert.equal(view.byteLength, 4);
  assert.deepEqual([...new Uint8Array(workers[0]!.posted[1]!.bytes)], [9, 8, 7, 6]);
  workers[0]!.reply(1, inspectionJson(), Uint8Array.of(5));
  await second;
});

test("a Buffer view is copied without transferring its surrounding allocation", async () => {
  const { workers, transport } = harness();
  const backing = Buffer.alloc(16, 90);
  const bytes = backing.subarray(4, 7);
  bytes.set([1, 2, 3]);
  const pending = transport.open(bytes);
  assert.equal(backing.byteLength, 16);
  assert.deepEqual([...new Uint8Array(workers[0]!.posted[0]!.bytes)], [1, 2, 3]);
  workers[0]!.reply(0, inspectionJson());
  await pending;
});

test("a queued edit owns the slot as it was when requested", async () => {
  const { workers, transport } = harness();
  const first = transport.open(fcad());
  const slot = { kind: "fixed_x", constraint: "original" };
  const second = transport.setExpression(fcad(), { ...change, slot });
  slot.constraint = "different";
  workers[0]!.reply(0, inspectionJson());
  await first;
  const posted = workers[0]!.posted[1]!;
  assert.equal(posted.operation === "set_expression" && posted.request.slot.constraint, "original");
  workers[0]!.reply(1, refusalJson());
  await second;
});

test("setExpression sends only the fields Rust accepts", async () => {
  const { workers, transport } = harness();
  const pending = transport.setExpression(fcad(), { ...change, extra: "never sent" } as ExpressionChange);
  const request = workers[0]!.posted[0]!;
  assert.equal(request.operation, "set_expression");
  assert.deepEqual(request.operation === "set_expression" && request.request, change);
  workers[0]!.reply(0, refusalJson());
  await pending;
});

test("requests run one at a time, in order, and each reply finds its own request", async () => {
  const { workers, transport } = harness();
  const first = transport.open(fcad());
  const second = transport.setExpression(fcad(), change);
  assert.equal(workers[0]!.posted.length, 1, "the second request waits for the first");
  workers[0]!.reply(0, inspectionJson({ content_version: "first" }));
  assert.equal(((await first) as { inspection: { content_version: string } }).inspection.content_version, "first");
  assert.equal(workers[0]!.posted.length, 2);
  assert.ok(workers[0]!.posted[1]!.id > workers[0]!.posted[0]!.id);
  workers[0]!.reply(1, inspectionJson({ content_version: "second" }), Uint8Array.of(1));
  assert.equal(((await second) as { inspection: { content_version: string } }).inspection.content_version, "second");
});

test("a reply for a request that is not in flight is ignored", async () => {
  const { workers, transport } = harness();
  const pending = transport.open(fcad());
  workers[0]!.send({ id: 999, json: inspectionJson({ content_version: "stray" }), bytes: new ArrayBuffer(0), initMs: 0, operationMs: 0 });
  workers[0]!.reply(0, inspectionJson({ content_version: "right" }));
  assert.equal(((await pending) as { inspection: { content_version: string } }).inspection.content_version, "right");
});

test("a Worker error rejects the request and the queue, frees the Worker, and the next call starts a new one", async () => {
  const { workers, transport } = harness();
  const first = transport.open(fcad());
  const queued = transport.open(fcad());
  workers[0]!.installed[0]!.onerror?.({ message: "boom" });
  assert.equal(await reason(first), "worker-error");
  assert.equal(await reason(queued), "worker-error");
  assert.equal(workers[0]!.terminated, 1);
  // A message that still arrives from the dead Worker publishes nothing.
  workers[0]!.reply(0, inspectionJson({ content_version: "late" }));
  const next = transport.open(fcad());
  assert.equal(workers.length, 2, "an explicit later call creates a new Worker");
  workers[0]!.reply(0, inspectionJson({ content_version: "late again" }));
  workers[1]!.reply(0, inspectionJson({ content_version: "fresh" }));
  assert.equal(((await next) as { inspection: { content_version: string } }).inspection.content_version, "fresh");
});

test("messageerror frees the Worker and rejects what was pending", async () => {
  const { workers, transport } = harness();
  const pending = transport.open(fcad());
  workers[0]!.installed[0]!.onmessageerror?.({});
  assert.equal(await reason(pending), "message-error");
  assert.equal(workers[0]!.terminated, 1);
});

test("a timeout frees the Worker, and a late answer from it is never published", async () => {
  const { workers, transport } = harness(15);
  const pending = transport.open(fcad());
  assert.equal(await reason(pending), "timeout");
  assert.equal(workers[0]!.terminated, 1);
  workers[0]!.reply(0, inspectionJson({ content_version: "too late" }));
  const next = transport.open(fcad());
  workers[1]!.reply(0, inspectionJson({ content_version: "fresh" }));
  assert.equal(((await next) as { inspection: { content_version: string } }).inspection.content_version, "fresh");
});

test("the timeout counts from when a request is posted, not from when it was queued", async () => {
  const { workers, transport } = harness(200);
  const first = transport.open(fcad());
  const queued = transport.open(fcad());
  await new Promise((resolve) => setTimeout(resolve, 120));
  workers[0]!.reply(0, inspectionJson());
  await first;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(workers[0]!.posted.length, 2);
  workers[0]!.reply(1, inspectionJson());
  await queued;
  assert.equal(workers[0]!.terminated, 0);
});

test("dispose rejects the request in flight and the queue, and a later call starts a new Worker", async () => {
  const { workers, transport } = harness();
  const first = transport.open(fcad());
  const queued = transport.setExpression(fcad(), change);
  transport.dispose();
  assert.equal(await reason(first), "disposed");
  assert.equal(await reason(queued), "disposed");
  assert.equal(workers[0]!.terminated, 1);
  transport.dispose();
  assert.equal(workers[0]!.terminated, 1, "disposing again frees nothing twice");
  const again = transport.open(fcad());
  assert.equal(workers.length, 2);
  workers[1]!.reply(0, inspectionJson());
  assert.equal((await again).ok, true);
});

test("a reported transport error releases the Worker and is not a Rust refusal", async () => {
  const { workers, transport } = harness();
  const pending = transport.open(fcad());
  workers[0]!.send({ id: workers[0]!.posted[0]!.id, transportError: "RuntimeError: unreachable" });
  assert.equal(await reason(pending), "worker-reported");
  assert.equal(workers[0]!.terminated, 1);
});

test("malformed replies are transport failures", async () => {
  const cases: [string, (worker: FakeWorker) => void][] = [
    ["not an object", (worker) => worker.send("hello")],
    ["no id", (worker) => worker.send({ json: {} })],
    ["bytes missing", (worker) => worker.send({ id: worker.posted[0]!.id, json: inspectionJson(), initMs: 0, operationMs: 0 })],
    ["json is not an object", (worker) => worker.reply(0, 42)],
    ["ok is neither true nor false", (worker) => worker.reply(0, { ok: "yes" })],
    ["a required field is missing", (worker) => worker.reply(0, inspectionJson({ model_version: undefined }))],
    ["a slot lost its expression", (worker) => worker.reply(0, inspectionJson({ expression_slots: [{ object: "x" }] }))],
    ["open carries FCAD bytes", (worker) => worker.reply(0, inspectionJson(), Uint8Array.of(1))],
  ];
  for (const [label, corrupt] of cases) {
    const { workers, transport } = harness();
    const pending = transport.open(fcad());
    corrupt(workers[0]!);
    assert.equal(await reason(pending), "malformed-reply", label);
    assert.equal(workers[0]!.terminated, 1, label);
  }
  const { workers, transport } = harness();
  const edit = transport.setExpression(fcad(), change);
  workers[0]!.reply(0, inspectionJson());
  assert.equal(await reason(edit), "malformed-reply", "a written edit without its FCAD bytes");
});

test("a Worker that cannot start or be written to fails the call, and the next call may try again", async () => {
  let attempts = 0;
  const transport = new WorkerDocumentTransport({
    createWorker: () => {
      attempts += 1;
      throw new Error("no worker here");
    },
  });
  assert.equal(await reason(transport.open(fcad())), "start-failed");
  assert.equal(await reason(transport.open(fcad())), "start-failed");
  assert.equal(attempts, 2);

  const worker = new FakeWorker();
  worker.postError = new Error("DataCloneError");
  const sending = new WorkerDocumentTransport({ createWorker: () => worker });
  assert.equal(await reason(sending.open(fcad())), "worker-error");
  assert.equal(worker.terminated, 1);
});

test("every promise settles across crash, timeout, messageerror and dispose", async () => {
  const { workers, transport } = harness(20);
  const first = settled(transport.open(fcad()), transport.open(fcad()), transport.setExpression(fcad(), change));
  workers[0]!.installed[0]!.onerror?.({});
  const second = settled(transport.open(fcad()), transport.open(fcad()));
  await tick();
  transport.dispose();
  const third = settled(transport.open(fcad())); // nobody answers: the timeout settles it
  const results = [...(await first), ...(await second), ...(await third)];
  assert.equal(results.length, 6);
  assert.ok(results.every((result) => result.status === "rejected"));
});
