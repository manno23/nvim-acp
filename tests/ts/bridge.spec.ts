import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { encode, decode } from "@msgpack/msgpack";
import { startMockServer } from "../../mock/src/mock-server.js";

interface ResponseMessage {
  id: number;
  result?: unknown;
  error?: { message: string };
}

interface EventMessage {
  method: string;
  params: Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout");
    }
    await delay(20);
  }
}

test("bridge submit flow", async (t) => {
  const server = startMockServer(0);
  const url = await server.ready;
  t.after(async () => {
    await server.close();
  });

  const child = spawn(process.execPath, ["bridge/dist/bridge/src/bridge.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ACP_WS_URL: url },
  });

  t.after(() => {
    child.kill();
  });

  let buffer = Buffer.alloc(0);
  const responses = new Map<number, ResponseMessage>();
  const events: EventMessage[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.byteLength >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.byteLength < 4 + length) {
        break;
      }
      const frame = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      const message = decode(frame) as ResponseMessage | EventMessage;
      if (typeof (message as ResponseMessage).id === "number") {
        responses.set((message as ResponseMessage).id, message as ResponseMessage);
      } else {
        events.push(message as EventMessage);
      }
    }
  });

  function writeMessage(obj: unknown) {
    const payload = Buffer.from(encode(obj));
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(payload.byteLength, 0);
    child.stdin.write(Buffer.concat([prefix, payload]));
  }

  writeMessage({ id: 1, method: "connect", params: {} });
  await waitFor(() => responses.has(1));

  writeMessage({
    id: 2,
    method: "submit",
    params: { request: { action: "contact_points", parameters: {} } },
  });
  await waitFor(() => responses.has(2));

  await waitFor(() => events.some((e) => e.method === "event" && (e.params as any).result));
  const resultEvent = events.find((e) => e.method === "event" && (e.params as any).result)!;
  assert.equal((resultEvent.params as any).result.status, "success");

  child.stdin.end();
  child.kill();
  await delay(200);
});
