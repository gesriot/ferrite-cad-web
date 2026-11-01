const enabled = new URL(location.href).searchParams.get("enabled") === "1";
const controls = document.querySelector("#controls");
const result = document.querySelector("#result");
const slot = document.querySelector("#slot");
const edit = document.querySelector("#edit");
const download = document.querySelector("#download");
document.querySelector("#flag").textContent = enabled
  ? "Probe enabled. The module loads only after opening a file."
  : "Disabled. Add ?enabled=1 to opt in.";
controls.disabled = !enabled;
let worker,
  bytes,
  snapshot,
  filename,
  pending,
  sequence = 0;

function end() {
  worker?.terminate();
  worker = undefined;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Probe ended"));
    pending = undefined;
  }
  bytes = snapshot = undefined;
  document.querySelector("#file").value = "";
  slot.replaceChildren();
  slot.disabled = edit.disabled = download.disabled = true;
}

function call(operation, request) {
  worker ??= new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      end();
      result.textContent = "Worker timed out; reopen the document to restart.";
    }, 30000);
    pending = { id, resolve, reject, timer };
    worker.onmessage = ({ data }) => {
      if (data.id !== pending?.id) return;
      clearTimeout(pending.timer);
      pending = undefined;
      if (data.transportError) {
        reject(new Error(data.transportError));
        end();
      } else resolve(data);
    };
    worker.onerror = (event) => {
      reject(new Error(event.message));
      end();
    };
    worker.postMessage({ id, operation, bytes, request });
  });
}

function show(data) {
  const { objects, ...rest } = data.json;
  result.textContent = JSON.stringify(
    {
      initMs: data.initMs,
      operationMs: data.operationMs,
      ...rest,
      objectCount: objects?.length,
      objects: objects?.map(({ id, kind, name, ordinal }) => ({ id, kind, name, ordinal })),
    },
    null,
    2,
  );
}

async function busy(action) {
  controls.disabled = true;
  try {
    await action();
  } catch (error) {
    result.textContent = String(error);
  } finally {
    controls.disabled = !enabled;
  }
}

document.querySelector("#file").onchange = (event) =>
  busy(async () => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) throw new Error("Probe input exceeds 32 MiB");
    const previous = bytes;
    bytes = new Uint8Array(await file.arrayBuffer());
    let data;
    try {
      data = await call("open");
    } catch (error) {
      bytes = previous;
      throw error;
    }
    show(data);
    if (!data.json.ok || !data.json.validation.ok) {
      bytes = previous;
      return;
    }
    snapshot = data.json;
    filename = file.name;
    slot.replaceChildren(
      ...snapshot.expression_slots.map((s, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `${s.name ?? s.object}: ${s.slot.kind} (${s.dimension})`;
        return option;
      }),
    );
    slot.disabled = edit.disabled = snapshot.expression_slots.length === 0;
    download.disabled = false;
  });

edit.onclick = () =>
  busy(async () => {
    const expression = snapshot.expression_slots[Number(slot.value)];
    const data = await call("set_expression", {
      object: expression.object,
      slot: expression.slot,
      value_mm: Number(document.querySelector("#value").value),
    });
    show(data);
    if (data.json.ok && data.json.validation.ok && data.bytes.length) {
      bytes = data.bytes;
      snapshot = data.json;
    }
  });
download.onclick = () => {
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `wasm-${filename}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.querySelector("#end").onclick = () => {
  end();
  result.textContent = "Probe ended. No document held.";
};
window.addEventListener("pagehide", end);
