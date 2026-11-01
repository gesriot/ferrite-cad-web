import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesOf,
  change,
  deferred,
  edit,
  editOk,
  inspectionJson,
  invalid,
  newSession,
  openAccepted,
  readOk,
  refused,
  settled,
  tick,
} from "./test-support.ts";
import { DocumentTransportError } from "./transport.ts";

test("open keeps the bytes it was given, not Rust's re-encoded payloads", async () => {
  const { session, transport } = newSession();
  const source = bytesOf(10, 20, 30, 40);
  const outcome = await openAccepted(session, transport, "Пластина 板.fcad", source);
  assert.equal(outcome.status, "accepted");
  const snapshot = session.snapshot!;
  assert.equal(snapshot.name, "Пластина 板.fcad");
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.dirty, false);
  assert.equal(snapshot.byteLength, 4);
  assert.deepEqual([...session.copyBytes()!], [10, 20, 30, 40]);
  assert.equal(snapshot.inspection.objects[0]!.ordinal, "9223372036854775807");
});

test("an accepted edit publishes bytes and inspection together", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport);
  const first = session.snapshot!;
  const outcome = await edit(
    session,
    transport,
    editOk(bytesOf(9, 9), {
      content_version: "c1",
      expression_slots: [
        { ...(inspectionJson().expression_slots as object[])[0], expression: { source: "16", value: 16 } },
      ],
    }),
  );
  assert.equal(outcome.status, "accepted");
  const second = session.snapshot!;
  assert.notEqual(second, first);
  assert.equal(second.revision, 2);
  assert.equal(second.dirty, true);
  assert.equal(second.inspection.content_version, "c1");
  assert.equal(second.inspection.expression_slots[0]!.expression.source, "16");
  assert.deepEqual([...session.copyBytes()!], [9, 9]);
  assert.deepEqual(transport.calls[1]!.change, change);
  assert.deepEqual([...transport.calls[1]!.bytes], [1, 2, 3], "the edit starts from the accepted bytes");
  assert.equal(first.revision, 1, "an old snapshot never changes");
});

test("a native refusal keeps the accepted revision and its bytes", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport);
  const before = session.snapshot;
  const outcome = await edit(session, transport, refused("input", "invalid input: extrude distance must be positive, found -1"));
  assert.deepEqual(outcome.status === "refused" && outcome.refusal, {
    kind: "input",
    message: "invalid input: extrude distance must be positive, found -1",
  });
  assert.equal(session.snapshot, before);
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3]);
});

test("ok:true with validation.ok:false is not accepted: not by open, not by edit", async () => {
  const { session, transport } = newSession();
  const invalidFirst = await openAccepted(session, transport, "bad.fcad", bytesOf(7), invalid());
  assert.equal(invalidFirst.status, "invalid");
  assert.equal(invalidFirst.status === "invalid" && invalidFirst.inspection.validation.diagnostics[0]!.code, "revolve.axis");
  assert.equal(session.snapshot, null, "an invalid file does not become the document");
  assert.equal(session.copyBytes(), null);

  await openAccepted(session, transport, "good.fcad", bytesOf(1, 2, 3));
  const good = session.snapshot;
  const replacement = await openAccepted(session, transport, "bad-again.fcad", bytesOf(8), invalid());
  assert.equal(replacement.status, "invalid");
  assert.equal(session.snapshot, good, "an invalid replacement leaves the accepted document alone");

  const edited = await edit(session, transport, editOk(bytesOf(5), invalid()));
  assert.equal(edited.status, "invalid");
  assert.equal(session.snapshot, good);
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3]);
});

test("a native refusal on open leaves the previous document and a refusal on the first open leaves none", async () => {
  const { session, transport } = newSession();
  const pending = session.open("broken.fcad", async () => bytesOf(0));
  await tick();
  transport.calls[0]!.resolve(refused("input", "invalid input: reading object"));
  const outcome = await pending;
  assert.equal(outcome.status, "refused");
  assert.equal(session.snapshot, null);
  await openAccepted(session, transport);
  const kept = session.snapshot;
  const again = session.open("broken.fcad", async () => bytesOf(0));
  await tick();
  transport.calls.at(-1)!.resolve(refused());
  assert.equal((await again).status, "refused");
  assert.equal(session.snapshot, kept);
});

test("transport failures keep the accepted revision; recovery edits the accepted bytes", async () => {
  for (const reason of ["worker-error", "message-error", "timeout", "worker-reported", "malformed-reply"] as const) {
    const { session, transport } = newSession();
    await openAccepted(session, transport, "plate.fcad", bytesOf(1, 2, 3));
    const kept = session.snapshot;

    const crashed = session.setExpression(change);
    await tick();
    transport.calls.at(-1)!.reject(new DocumentTransportError(reason, "gone"));
    const outcome = await crashed;
    assert.equal(outcome.status, "transport-failed", reason);
    assert.equal(outcome.status === "transport-failed" && outcome.failure.reason, reason);
    assert.equal(session.snapshot, kept, "a crash is not Close");
    assert.deepEqual([...session.copyBytes()!], [1, 2, 3]);
    assert.equal(transport.disposed, 0, "the session does not dispose; the transport already freed itself");

    const recovered = await edit(session, transport, editOk(bytesOf(4, 4)));
    assert.equal(recovered.status, "accepted", reason);
    assert.deepEqual([...transport.calls.at(-1)!.bytes], [1, 2, 3], "recovery uses the accepted bytes");
    assert.deepEqual([...session.copyBytes()!], [4, 4]);
  }
});

test("a failed open keeps the previous document and its download", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport, "keep.fcad", bytesOf(1, 2, 3));
  const kept = session.snapshot;
  const pending = session.open("other.fcad", async () => bytesOf(9));
  await tick();
  transport.calls.at(-1)!.reject(new DocumentTransportError("timeout", "slow"));
  assert.equal((await pending).status, "transport-failed");
  assert.equal(session.snapshot, kept);
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3]);

  const unreadable = await session.open("unreadable.fcad", async () => {
    throw new Error("disk went away");
  });
  assert.equal(unreadable.status, "read-failed");
  assert.equal(session.snapshot, kept);
});

test("a late file read after end() cannot bring a document back, and Rust is never asked", async () => {
  const { session, transport } = newSession();
  const read = deferred<Uint8Array>();
  const pending = session.open("late.fcad", () => read.promise);
  session.end();
  read.resolve(bytesOf(1, 2, 3));
  assert.equal((await pending).status, "superseded");
  assert.equal(session.snapshot, null);
  assert.equal(transport.calls.length, 0);
});

test("a late file read of an older open cannot replace a newer open, even though it finishes last", async () => {
  const { session, transport } = newSession();
  const slow = deferred<Uint8Array>();
  const older = session.open("older.fcad", () => slow.promise);
  const newer = await openAccepted(session, transport, "newer.fcad", bytesOf(2));
  assert.equal(newer.status, "accepted");
  slow.resolve(bytesOf(1));
  assert.equal((await older).status, "superseded");
  assert.equal(session.snapshot!.name, "newer.fcad");
  assert.equal(transport.calls.length, 1, "the older read never reached Rust");
});

test("the open intent is registered before the file is awaited", async () => {
  const { session } = newSession();
  let started = false;
  const read = deferred<Uint8Array>();
  const first = session.open("a.fcad", () => {
    started = true;
    return read.promise;
  });
  assert.equal(started, true, "read() runs synchronously inside open()");
  const second = session.open("b.fcad", async () => bytesOf(1));
  read.resolve(bytesOf(1));
  assert.equal((await first).status, "superseded", "a newer intent registered while the read was pending");
  second.catch(() => undefined);
  session.end();
  await settled(second);
});

test("a late Rust answer after end() does not restore the document", async () => {
  for (const rejectOnDispose of [true, false]) {
    const { session, transport } = newSession();
    transport.rejectOnDispose = rejectOnDispose;
    const pending = session.open("late.fcad", async () => bytesOf(1));
    await tick();
    session.end();
    transport.calls[0]!.resolve(readOk());
    assert.equal((await pending).status, "superseded");
    assert.equal(session.snapshot, null);
    assert.equal(session.copyBytes(), null);
  }
});

test("a late Rust answer for an older open cannot overwrite a newer one", async () => {
  const { session, transport } = newSession();
  const older = session.open("older.fcad", async () => bytesOf(1));
  await tick();
  const newer = session.open("newer.fcad", async () => bytesOf(2));
  await tick();
  transport.calls[1]!.resolve(readOk({ content_version: "newer" }));
  assert.equal((await newer).status, "accepted");
  transport.calls[0]!.resolve(readOk({ content_version: "older" }));
  assert.equal((await older).status, "superseded");
  assert.equal(session.snapshot!.name, "newer.fcad");
  assert.equal(session.snapshot!.inspection.content_version, "newer");
  assert.deepEqual([...session.copyBytes()!], [2]);
});

test("edit against open: an answer that arrives after a newer open was accepted is dropped", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport, "first.fcad", bytesOf(1));
  const editing = session.setExpression(change);
  await tick();
  await openAccepted(session, transport, "second.fcad", bytesOf(2), { content_version: "second" });
  transport.calls[1]!.resolve(editOk(bytesOf(99), { content_version: "edited-first" }));
  assert.equal((await editing).status, "superseded");
  assert.equal(session.snapshot!.name, "second.fcad");
  assert.equal(session.snapshot!.revision, 1);
  assert.deepEqual([...session.copyBytes()!], [2]);
});

test("edit against open: an open that fails does not discard an edit that finished meanwhile", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport, "first.fcad", bytesOf(1));
  const editing = session.setExpression(change);
  await tick();
  const opening = session.open("broken.fcad", async () => bytesOf(0));
  await tick();
  transport.calls[1]!.resolve(editOk(bytesOf(5)));
  transport.calls[2]!.resolve(refused());
  assert.equal((await editing).status, "accepted");
  assert.equal((await opening).status, "refused");
  assert.equal(session.snapshot!.revision, 2);
  assert.deepEqual([...session.copyBytes()!], [5]);
});

test("edit against end: an answer after end() does not resurrect the document", async () => {
  for (const rejectOnDispose of [true, false]) {
    const { session, transport } = newSession();
    transport.rejectOnDispose = rejectOnDispose;
    await openAccepted(session, transport);
    const editing = session.setExpression(change);
    await tick();
    session.end();
    transport.calls[1]!.resolve(editOk(bytesOf(7)));
    assert.equal((await editing).status, "superseded");
    assert.equal(session.snapshot, null);
    assert.equal(session.copyBytes(), null);
    assert.equal((await session.setExpression(change)).status, "no-document");
  }
});

test("a second edit while one is in flight is refused as busy; the first still completes", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport);
  const first = session.setExpression(change);
  await tick();
  assert.equal((await session.setExpression(change)).status, "busy");
  assert.equal(transport.calls.length, 2, "the busy edit never reached the transport");
  transport.calls[1]!.resolve(editOk(bytesOf(6)));
  assert.equal((await first).status, "accepted");
  assert.equal((await edit(session, transport, editOk(bytesOf(7)))).status, "accepted");
  assert.equal(session.snapshot!.revision, 3);
});

test("end() clears the session, releases the transport, and the session can be used again", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport);
  session.end();
  assert.equal(session.snapshot, null);
  assert.equal(session.copyBytes(), null);
  assert.equal(transport.disposed, 1);
  session.end();
  assert.equal(session.snapshot, null);
  assert.equal((await openAccepted(session, transport, "again.fcad", bytesOf(4))).status, "accepted");
  assert.equal(session.snapshot!.name, "again.fcad");
  assert.equal(session.snapshot!.revision, 1);
});

test("dirty is derived from the accepted bytes; downloading does not clear it", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport, "plate.fcad", bytesOf(1, 2, 3));
  assert.equal(session.snapshot!.dirty, false);
  session.copyBytes();
  assert.equal(session.snapshot!.dirty, false);
  await edit(session, transport, editOk(bytesOf(4, 5)));
  assert.equal(session.snapshot!.dirty, true);
  session.copyBytes();
  assert.equal(session.snapshot!.dirty, true, "obtaining bytes is not a confirmed write");
  await edit(session, transport, editOk(bytesOf(1, 2, 3)));
  assert.equal(session.snapshot!.dirty, false, "bytes equal to the opened file are not unsaved changes");
  assert.equal(session.snapshot!.revision, 3);
});

test("nothing handed in or out can corrupt the accepted revision", async () => {
  const { session, transport } = newSession();
  const source = bytesOf(1, 2, 3);
  await openAccepted(session, transport, "plate.fcad", source);
  source.fill(0);
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3], "the caller's array is not the accepted copy");

  session.copyBytes()!.fill(0);
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3], "a returned copy is not the accepted copy");

  const snapshot = session.snapshot!;
  assert.throws(() => {
    (snapshot as { name: string }).name = "hijacked";
  }, TypeError);
  assert.throws(() => {
    (snapshot.inspection.expression_slots[0]!.expression as { source: string }).source = "999";
  }, TypeError);
  assert.throws(() => {
    (snapshot.inspection.objects as unknown[]).push({});
  }, TypeError);
  assert.equal(snapshot.inspection.expression_slots[0]!.expression.source, "10");

  const reply = editOk(bytesOf(8, 8));
  const edited = session.setExpression(change);
  await tick();
  transport.calls.at(-1)!.resolve(reply);
  await edited;
  (reply as { bytes: Uint8Array }).bytes.fill(0);
  assert.deepEqual([...session.copyBytes()!], [8, 8], "bytes the transport retains are not the accepted copy");
});

test("a transport that detaches the buffer it is given cannot destroy the accepted FCAD", async () => {
  const { session, transport } = newSession();
  transport.detachInput = true;
  await openAccepted(session, transport, "plate.fcad", bytesOf(1, 2, 3));
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3]);
  // A refusal publishes nothing, so the accepted copy is all that is left to lose.
  assert.equal((await edit(session, transport, refused())).status, "refused");
  assert.deepEqual([...session.copyBytes()!], [1, 2, 3], "the accepted FCAD was not the buffer handed over");
  assert.equal(transport.calls[1]!.bytes.byteLength, 0, "the fake did detach what it was handed");
  const outcome = await edit(session, transport, editOk(bytesOf(4)));
  assert.equal(outcome.status, "accepted");
  const next = await edit(session, transport, editOk(bytesOf(5)));
  assert.equal(next.status, "accepted");
  assert.deepEqual([...session.copyBytes()!], [5]);
});

test("two sessions are independent", async () => {
  const a = newSession();
  const b = newSession();
  await openAccepted(a.session, a.transport, "a.fcad", bytesOf(1), { content_version: "a" });
  assert.equal(b.session.snapshot, null);
  await openAccepted(b.session, b.transport, "b.fcad", bytesOf(2), { content_version: "b" });
  const editingA = a.session.setExpression(change);
  await tick();
  b.session.end();
  assert.equal(a.transport.disposed, 0, "ending one session leaves the other's transport alone");
  assert.equal(a.session.snapshot!.name, "a.fcad");
  a.transport.calls[1]!.resolve(editOk(bytesOf(3)));
  assert.equal((await editingA).status, "accepted");
  assert.equal(b.session.snapshot, null);
  assert.deepEqual([...a.session.copyBytes()!], [3]);
  assert.equal(a.transport.calls.length, 2);
  assert.equal(b.transport.calls.length, 1);
});

test("an edit without a document is refused locally", async () => {
  const { session, transport } = newSession();
  assert.equal((await session.setExpression(change)).status, "no-document");
  assert.equal(transport.calls.length, 0);
});

test("every transition settles, whatever order the answers come in", async () => {
  const { session, transport } = newSession();
  await openAccepted(session, transport);
  const outcomes = [
    session.setExpression(change),
    session.setExpression(change),
    session.open("x.fcad", async () => bytesOf(1)),
    session.open("y.fcad", async () => bytesOf(2)),
  ];
  const all = settled(...outcomes);
  await tick();
  session.end();
  for (const call of transport.calls) if (!call.settled) call.reject(new DocumentTransportError("disposed", "x"));
  const results = await all;
  assert.ok(results.every((result) => result.status === "fulfilled"));
});
