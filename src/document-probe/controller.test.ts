import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesOf,
  deferred,
  edit,
  editOk,
  newSession,
  openAccepted,
  readOk,
  tick,
} from "../document/test-support.ts";
import { MAX_FCAD_BYTES } from "../occt/file-limits.ts";
import { ProbeController, type ProbeFile } from "./controller.ts";

function setup() {
  const { session, transport } = newSession();
  const questions: string[] = [];
  const saved: { name: string; bytes: Uint8Array }[] = [];
  let answer: (question: string) => Promise<boolean> = async () => true;
  const controller = new ProbeController(session, {
    confirmDiscard: (question) => {
      questions.push(question);
      return answer(question);
    },
    saveFile: (name, bytes) => saved.push({ name, bytes }),
  });
  return {
    session,
    transport,
    controller,
    questions,
    saved,
    answerWith: (next: (question: string) => Promise<boolean>) => {
      answer = next;
    },
  };
}

function file(name: string, bytes: Uint8Array, reads = { count: 0 }): ProbeFile {
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () => {
      reads.count += 1;
      return bytes.slice().buffer;
    },
  };
}

/** A document with an accepted edit, so it differs from what was opened. */
async function dirtyDocument(context: ReturnType<typeof setup>) {
  await openAccepted(context.session, context.transport, "plate.fcad", bytesOf(1, 2, 3));
  await edit(context.session, context.transport, editOk(bytesOf(4, 5)));
  assert.equal(context.session.snapshot!.dirty, true);
}

test("a clean document is replaced without a question", async () => {
  const context = setup();
  await openAccepted(context.session, context.transport, "a.fcad", bytesOf(1));
  const pending = context.controller.openFile(file("b.fcad", bytesOf(2)));
  await tick();
  context.transport.calls.at(-1)!.resolve(readOk());
  const result = await pending;
  assert.equal(result.kind === "open" && result.outcome.status, "accepted");
  assert.deepEqual(context.questions, []);
  assert.equal(context.session.snapshot!.name, "b.fcad");
});

test("Cancel changes nothing: no read, no Rust call, same revision and bytes", async () => {
  const context = setup();
  await dirtyDocument(context);
  const before = context.session.snapshot;
  const calls = context.transport.calls.length;
  context.answerWith(async () => false);
  const reads = { count: 0 };
  const result = await context.controller.openFile(file("other.fcad", bytesOf(9), reads));
  assert.deepEqual(result, { kind: "cancelled" });
  assert.equal(context.questions.length, 1);
  assert.match(context.questions[0]!, /plate\.fcad/);
  assert.equal(reads.count, 0, "the file is not even read");
  assert.equal(context.transport.calls.length, calls);
  assert.equal(context.session.snapshot, before);
  assert.deepEqual([...context.session.copyBytes()!], [4, 5]);
});

test("Discard replaces the dirty document", async () => {
  const context = setup();
  await dirtyDocument(context);
  context.answerWith(async () => true);
  const pending = context.controller.openFile(file("other.fcad", bytesOf(9)));
  await tick();
  await tick();
  context.transport.calls.at(-1)!.resolve(readOk({ content_version: "other" }));
  const result = await pending;
  assert.equal(result.kind === "open" && result.outcome.status, "accepted");
  assert.equal(context.session.snapshot!.name, "other.fcad");
  assert.equal(context.session.snapshot!.dirty, false);
  assert.deepEqual([...context.session.copyBytes()!], [9]);
});

test("if an edit lands while the question is open, the user is asked again", async () => {
  const context = setup();
  await openAccepted(context.session, context.transport, "plate.fcad", bytesOf(1, 2, 3));
  await edit(context.session, context.transport, editOk(bytesOf(4)));
  const first = deferred<boolean>();
  let asked = 0;
  context.answerWith(async () => {
    asked += 1;
    if (asked === 1) return first.promise;
    return false;
  });
  const pending = context.controller.openFile(file("other.fcad", bytesOf(9)));
  await tick();
  const editing = context.session.setExpression({ object: "o", slot: { kind: "extrude_distance" }, value_mm: 2 });
  await tick();
  context.transport.calls.at(-1)!.resolve(editOk(bytesOf(6)));
  await editing;
  first.resolve(true); // authorised revision 2; revision 3 is now on screen
  assert.deepEqual(await pending, { kind: "cancelled" }, "the second question was answered Cancel");
  assert.equal(asked, 2);
  assert.equal(context.session.snapshot!.revision, 3);
  assert.deepEqual([...context.session.copyBytes()!], [6]);
});

test("a newer request takes over a question that is still open", async () => {
  const context = setup();
  await dirtyDocument(context);
  const first = deferred<boolean>();
  let asked = 0;
  context.answerWith(async () => {
    asked += 1;
    return asked === 1 ? first.promise : false;
  });
  const older = context.controller.openFile(file("older.fcad", bytesOf(1)));
  await tick();
  const newer = context.controller.openFile(file("newer.fcad", bytesOf(2)));
  first.resolve(true);
  assert.deepEqual(await older, { kind: "cancelled" }, "the older request gave way");
  assert.deepEqual(await newer, { kind: "cancelled" });
  assert.equal(context.session.snapshot!.name, "plate.fcad");
});

test("an oversized file is refused before it is read and does not disturb an open in progress", async () => {
  const context = setup();
  const slow = deferred<ArrayBuffer>();
  const pending = context.controller.openFile({ name: "slow.fcad", size: 3, arrayBuffer: () => slow.promise });
  await tick();
  const reads = { count: 0 };
  const huge: ProbeFile = {
    name: "huge.fcad",
    size: MAX_FCAD_BYTES + 1,
    arrayBuffer: async () => {
      reads.count += 1;
      return new ArrayBuffer(0);
    },
  };
  const result = await context.controller.openFile(huge);
  assert.equal(result.kind, "rejected");
  assert.match(result.kind === "rejected" ? result.message : "", /32 MiB/);
  assert.equal(reads.count, 0, "rejected before arrayBuffer");
  slow.resolve(bytesOf(1, 2, 3).buffer);
  await tick();
  context.transport.calls.at(-1)!.resolve(readOk());
  assert.equal((await pending).kind, "open");
  assert.equal(context.session.snapshot!.name, "slow.fcad");
});

test("end() while a file is still being read wins over that late read", async () => {
  const context = setup();
  const slow = deferred<ArrayBuffer>();
  const opening = context.controller.openFile({ name: "slow.fcad", size: 3, arrayBuffer: () => slow.promise });
  await tick();
  assert.deepEqual(await context.controller.end(), { kind: "ended" });
  slow.resolve(bytesOf(1, 2, 3).buffer);
  const result = await opening;
  assert.equal(result.kind === "open" && result.outcome.status, "superseded");
  assert.equal(context.session.snapshot, null);
  assert.equal(context.transport.calls.length, 0);
});

test("End asks about unsaved changes; Cancel keeps the document, Discard ends the session", async () => {
  const context = setup();
  await dirtyDocument(context);
  const before = context.session.snapshot;
  context.answerWith(async () => false);
  assert.deepEqual(await context.controller.end(), { kind: "cancelled" });
  assert.equal(context.session.snapshot, before);
  assert.equal(context.transport.disposed, 0);

  context.answerWith(async () => true);
  assert.deepEqual(await context.controller.end(), { kind: "ended" });
  assert.equal(context.session.snapshot, null);
  assert.equal(context.transport.disposed, 1);
  assert.equal(context.questions.length, 2);
});

test("End of a clean document asks nothing", async () => {
  const context = setup();
  await openAccepted(context.session, context.transport);
  assert.deepEqual(await context.controller.end(), { kind: "ended" });
  assert.deepEqual(context.questions, []);
});

test("dispose releases the session without asking", async () => {
  const context = setup();
  await dirtyDocument(context);
  context.controller.dispose();
  assert.equal(context.session.snapshot, null);
  assert.equal(context.transport.disposed, 1);
  assert.deepEqual(context.questions, []);
});

test("download hands over a copy of the accepted bytes under a Unicode name and does not clear dirty", async () => {
  const context = setup();
  assert.equal(context.controller.download(), false, "nothing to download without a document");
  assert.equal(context.saved.length, 0);

  await openAccepted(context.session, context.transport, "Пластина 板 ①.fcad", bytesOf(1, 2, 3));
  await edit(context.session, context.transport, editOk(bytesOf(7, 8)));
  assert.equal(context.controller.download(), true);
  assert.equal(context.saved[0]!.name, "wasm-Пластина 板 ①.fcad");
  assert.deepEqual([...context.saved[0]!.bytes], [7, 8]);
  context.saved[0]!.bytes.fill(0);
  assert.deepEqual([...context.session.copyBytes()!], [7, 8], "the saved array is not the accepted copy");
  assert.equal(context.session.snapshot!.dirty, true, "a download is not a confirmed write");
});

test("an expression is sent as the native slot Rust provided; a value JSON cannot carry never leaves the page", async () => {
  const context = setup();
  const slot = {
    object: "01900000-0000-7000-8000-0000000000aa",
    name: "Anything",
    slot: { kind: "fixed_x", constraint: "01900000-0000-7000-8000-0000000000bb" },
    expression: { source: "0", value: 0 },
    dimension: "length",
    refusal: null,
  } as const;
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await context.controller.applyExpression(slot, value);
    assert.equal(result.kind, "rejected");
  }
  assert.equal(context.transport.calls.length, 0);

  await openAccepted(context.session, context.transport);
  const pending = context.controller.applyExpression(slot, 2.5);
  await tick();
  assert.deepEqual(context.transport.calls.at(-1)!.change, {
    object: slot.object,
    slot: slot.slot,
    value_mm: 2.5,
  });
  context.transport.calls.at(-1)!.resolve(editOk(bytesOf(3)));
  const result = await pending;
  assert.equal(result.kind === "edit" && result.outcome.status, "accepted");
});
