import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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

  let buffer = "";
  const responses = new Map<number, ResponseMessage>();
  const events: EventMessage[] = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) {
        index = buffer.indexOf("\n");
        continue;
      }
      const message = JSON.parse(line) as ResponseMessage | EventMessage;
      if (typeof (message as ResponseMessage).id === "number") {
        responses.set((message as ResponseMessage).id, message as ResponseMessage);
      } else {
        events.push(message as EventMessage);
      }
      index = buffer.indexOf("\n");
    }
  });

  child.stdin.write(`${JSON.stringify({ id: 1, method: "connect", params: {} })}\n`);
  await waitFor(() => responses.has(1));

  child.stdin.write(
    `${JSON.stringify({
      id: 2,
      method: "submit",
      params: { request: { action: "contact_points", parameters: {} } },
    })}\n`,
  );
  await waitFor(() => responses.has(2));

  await waitFor(() => events.some((e) => e.method === "event" && (e.params as any).result));
  const resultEvent = events.find((e) => e.method === "event" && (e.params as any).result)!;
  assert.equal((resultEvent.params as any).result.status, "success");

  child.stdin.end();
  child.kill();
  await delay(200);
});
