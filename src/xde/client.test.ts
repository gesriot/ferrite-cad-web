import assert from "node:assert/strict";
import test from "node:test";
import { XdeClient, type XdePort } from "./client.ts";

class FakePort implements XdePort {
  onmessage: XdePort["onmessage"] = null;
  onerror: XdePort["onerror"] = null;
  onmessageerror: XdePort["onmessageerror"] = null;
  terminated = false;
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}

function harness(timeoutMs = 30) {
  const ports: FakePort[] = [];
  const client = new XdeClient(() => {
    const port = new FakePort();
    ports.push(port);
    return port;
  }, timeoutMs);
  return { client, ports };
}

const readBody = { report: { nodes: [] }, readMs: 1, initMs: 1, heapBytes: null, temporaryFiles: [] };

test("a timed-out request terminates the worker and the next read can start", async () => {
  const { client, ports } = harness(20);
  await assert.rejects(client.read(new Uint8Array([1])), /timed out/);
  assert.equal(ports[0]?.terminated, true);
  assert.equal(client.pendingCount, 0);
  assert.equal(client.hasWorker, false);
  const again = client.read(new Uint8Array([2]));
  assert.equal(ports.length, 2);
  assert.equal(client.pendingCount, 1);
  ports[1]?.onmessage?.({ data: { id: 2, ok: true, result: readBody } });
  const result = await again;
  assert.equal(result.session, 2);
  assert.equal(client.pendingCount, 0);
});

test("worker error and messageerror terminate the worker and reject pending calls", async () => {
  const crashed = harness();
  const crashing = crashed.client.read(new Uint8Array([1]));
  crashed.ports[0]?.onerror?.({ message: "worker crashed", preventDefault() {} });
  await assert.rejects(crashing, /worker crashed/);
  assert.equal(crashed.ports[0]?.terminated, true);
  assert.equal(crashed.client.pendingCount, 0);

  const broken = harness();
  const hanging = broken.client.read(new Uint8Array([1]));
  broken.ports[0]?.onmessageerror?.({});
  await assert.rejects(hanging, /could not receive/);
  assert.equal(broken.ports[0]?.terminated, true);
  assert.equal(broken.client.hasWorker, false);
});

test("a reply from an ended worker cannot satisfy a newer session", async () => {
  const { client, ports } = harness(5_000);
  const first = client.read(new Uint8Array([1]));
  client.end();
  await assert.rejects(first, /session ended/);
  ports[0]?.onmessage?.({ data: { id: 1, ok: true, result: { leaked: true } } });
  assert.equal(client.pendingCount, 0);
  assert.equal(client.hasWorker, false);
  const second = client.read(new Uint8Array([2]));
  ports[0]?.onmessage?.({ data: { id: 2, ok: true, result: { leaked: true } } });
  assert.equal(client.pendingCount, 1);
  ports[1]?.onmessage?.({ data: { id: 2, ok: true, result: readBody } });
  const result = await second;
  assert.equal(result.session, 2);
  assert.deepEqual(result.report, { nodes: [] });
});
