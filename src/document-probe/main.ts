/**
 * Browser entry of the document probe: DOM, Worker construction, dialog and
 * download. Everything else is the shared `DocumentSession` through the
 * `ProbeController`; this page keeps no copy of the document.
 */
import type { NativeSlot } from "../document/protocol.ts";
import { DocumentSession, type DocumentSnapshot } from "../document/session.ts";
import { WorkerDocumentTransport, type WorkerPort } from "../document/transport.ts";
import { ProbeController, type ProbeResult } from "./controller.ts";

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

const enabled = new URL(location.href).searchParams.get("enabled") === "1";
const controls = element<HTMLFieldSetElement>("#controls");
const fileInput = element<HTMLInputElement>("#file");
const slotSelect = element<HTMLSelectElement>("#slot");
const slotDetail = element<HTMLElement>("#slot-detail");
const valueInput = element<HTMLInputElement>("#value");
const editButton = element<HTMLButtonElement>("#edit");
const downloadButton = element<HTMLButtonElement>("#download");
const endButton = element<HTMLButtonElement>("#end");
const documentLine = element<HTMLElement>("#document");
const result = element<HTMLElement>("#result");
const dialog = element<HTMLDialogElement>("#discard");
const dialogText = element<HTMLElement>("#discard-text");

element<HTMLElement>("#flag").textContent = enabled
  ? "Probe enabled. The module loads only after opening a file."
  : "Disabled. Add ?enabled=1 to opt in.";
controls.disabled = !enabled;

let settleQuestion: ((discard: boolean) => void) | undefined;

function confirmDiscard(question: string): Promise<boolean> {
  settleQuestion?.(false);
  dialogText.textContent = question;
  return new Promise<boolean>((resolve) => {
    const onClose = () => settle(dialog.returnValue === "discard");
    const settle = (discard: boolean) => {
      dialog.removeEventListener("close", onClose);
      if (settleQuestion === settle) settleQuestion = undefined;
      if (dialog.open) dialog.close();
      resolve(discard);
    };
    settleQuestion = settle;
    dialog.returnValue = "";
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

function saveFile(name: string, bytes: Uint8Array<ArrayBuffer>): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const session = new DocumentSession(
  new WorkerDocumentTransport({
    // The Worker exists only after the first request; nothing is fetched before.
    createWorker: () =>
      new Worker(new URL("../document/worker.ts", import.meta.url), {
        type: "module",
      }) as unknown as WorkerPort,
  }),
);
const controller = new ProbeController(session, { confirmDiscard, saveFile });

function slotLabel(slot: NativeSlot): string {
  const constraint = slot.slot.constraint ? ` [${slot.slot.constraint}]` : "";
  return `${slot.name ?? slot.object}: ${slot.slot.kind}${constraint} (${slot.dimension})`;
}

function selectedSlot(snapshot: DocumentSnapshot | null): NativeSlot | undefined {
  return snapshot?.inspection.expression_slots[Number(slotSelect.value)];
}

function renderSlotDetail(): void {
  const slot = selectedSlot(session.snapshot);
  slotDetail.textContent = slot
    ? `Stored expression "${slot.expression.source}" = ${slot.expression.value}` +
      (slot.refusal ? `. Rust note: ${slot.refusal}` : "")
    : "";
}

/** The freshly opened revision whose stored value already filled the input. */
let prefilled: DocumentSnapshot | undefined;

/** Reflect the session's accepted revision. The page keeps nothing of its own. */
function render(): void {
  const snapshot = session.snapshot;
  const previous = slotSelect.value;
  if (!snapshot) prefilled = undefined;
  const fresh = snapshot !== null && snapshot.revision === 1 && snapshot !== prefilled;
  const slots = snapshot?.inspection.expression_slots ?? [];
  slotSelect.replaceChildren(
    ...slots.map((slot, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = slotLabel(slot);
      return option;
    }),
  );
  // A new document starts at its first slot; a refreshed one keeps the user's choice.
  if (!fresh && previous !== "" && Number(previous) < slots.length) slotSelect.value = previous;
  slotSelect.disabled = editButton.disabled = slots.length === 0;
  downloadButton.disabled = !snapshot;
  documentLine.textContent = snapshot
    ? `Document: ${snapshot.name} · revision ${snapshot.revision} · ${snapshot.dirty ? "unsaved changes" : "unchanged since opened"}`
    : "No document held.";
  if (snapshot && fresh) {
    prefilled = snapshot;
    const first = snapshot.inspection.expression_slots[0];
    if (first) valueInput.value = String(first.expression.value);
  }
  renderSlotDetail();
}

function held(): string {
  const snapshot = session.snapshot;
  return snapshot
    ? `Revision ${snapshot.revision} of ${snapshot.name} is still the accepted document.`
    : "No document is held.";
}

function show(value: unknown): void {
  result.textContent = JSON.stringify(value, null, 2);
}

function describe(outcome: ProbeResult): unknown {
  switch (outcome.kind) {
    case "cancelled":
      return { status: "cancelled", note: `Nothing changed. ${held()}` };
    case "rejected":
      return { status: "not sent to Rust", message: outcome.message, note: held() };
    case "ended":
      return { status: "ended", note: "Probe ended. No document held." };
    default:
      break;
  }
  const inner = outcome.outcome;
  switch (inner.status) {
    case "cancelled":
      return { status: "cancelled", note: `Nothing changed. ${held()}` };
    case "accepted": {
      const { objects, ...rest } = inner.snapshot.inspection;
      return {
        status: "accepted",
        name: inner.snapshot.name,
        revision: inner.snapshot.revision,
        dirty: inner.snapshot.dirty,
        ...inner.timing,
        ...rest,
        objectCount: objects.length,
        objects: objects.map(({ id, kind, name, ordinal }) => ({ id, kind, name, ordinal })),
      };
    }
    case "refused":
      return {
        status: "refused by Rust",
        kind: inner.refusal.kind,
        message: inner.refusal.message,
        ...inner.timing,
        note: held(),
      };
    case "invalid":
      return {
        status: "read by Rust, but validation failed; not accepted",
        validation: inner.inspection.validation,
        ...inner.timing,
        note: held(),
      };
    case "transport-failed":
      return {
        status: "transport failure",
        reason: inner.failure.reason,
        message: inner.failure.message,
        note: `${held()} The Worker was released; the next action starts a new one.`,
      };
    case "read-failed":
      return { status: "file could not be read", message: String(inner.error), note: held() };
    case "superseded":
      return { status: "superseded", note: "A newer action replaced this one; it changed nothing." };
    case "busy":
      return { status: "busy", note: "An edit is still running." };
    case "no-document":
      return { status: "no document", note: "Open a file first." };
  }
}

async function finish(run: Promise<ProbeResult>): Promise<void> {
  try {
    show(describe(await run));
  } catch (error) {
    show({ status: "unexpected error", message: String(error) });
  }
  render();
}

fileInput.onchange = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  await finish(controller.openFile(file));
  if (fileInput.files?.[0] === file) fileInput.value = "";
};

slotSelect.onchange = () => {
  const slot = selectedSlot(session.snapshot);
  if (slot) valueInput.value = String(slot.expression.value);
  renderSlotDetail();
};

editButton.onclick = async () => {
  const slot = selectedSlot(session.snapshot);
  if (!slot) return;
  const text = valueInput.value.trim();
  editButton.disabled = true;
  await finish(controller.applyExpression(slot, text === "" ? Number.NaN : Number(text)));
};

downloadButton.onclick = () => {
  controller.download();
};

endButton.onclick = () => finish(controller.end());

// An unsaved edit is only in this page's memory: ask the browser before it goes.
window.addEventListener("beforeunload", (event) => {
  if (!session.snapshot?.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", () => controller.dispose());
