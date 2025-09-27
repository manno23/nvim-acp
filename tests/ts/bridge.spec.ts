import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { encode, decode } from "@msgpack/msgpack";
import { WebSocketServer } from "ws";

type ResponseMessage = {
  id: number;
  result?: unknown;
  error?: { message: string };
};

type EventMessage = {
  method: string;
  params: Record<string, any>;
};

type BridgeMessage = ResponseMessage | EventMessage;

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timeout");
    }
    await delay(10);
  }
}

function startBridge(t: test.TestContext, env: Record<string, string>) {
  const child = spawn(process.execPath, ["bridge/dist/bridge/src/bridge.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });

  const responses = new Map<number, ResponseMessage>();
  const events: EventMessage[] = [];
  let buffer = Buffer.alloc(0);

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.byteLength >= 4) {
      const frameLength = buffer.readUInt32BE(0);
      if (buffer.byteLength < 4 + frameLength) {
        break;
      }
      const frame = buffer.subarray(4, 4 + frameLength);
      buffer = buffer.subarray(4 + frameLength);
      const message = decode(frame) as BridgeMessage;
      if (typeof (message as ResponseMessage).id === "number") {
        responses.set((message as ResponseMessage).id, message as ResponseMessage);
      } else {
        events.push(message as EventMessage);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  function send(obj: unknown) {
    const payload = Buffer.from(encode(obj));
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(payload.byteLength, 0);
    child.stdin.write(Buffer.concat([prefix, payload]));
  }

  async function waitForResponse(id: number, timeoutMs = 5000) {
    await waitFor(() => responses.has(id), timeoutMs);
    return responses.get(id)!;
  }

  async function waitForEvents(predicate: (event: EventMessage) => boolean, count: number, timeoutMs = 5000) {
    await waitFor(() => events.filter(predicate).length >= count, timeoutMs);
    return events.filter(predicate).slice(0, count);
  }

  function shutdown() {
    if (!child.killed) {
      child.stdin.end();
      child.kill();
    }
  }

  t.after(() => {
    shutdown();
  });

  return {
    send,
    waitForResponse,
    waitForEvents,
    responses,
    events,
    shutdown,
  };
}

function onceListening(wss: WebSocketServer) {
  return new Promise<void>((resolve) => {
    if (wss.address()) {
      resolve();
      return;
    }
    wss.once("listening", () => resolve());
  });
}

function wsAddress(wss: WebSocketServer) {
  const address = wss.address();
  if (typeof address === "string" || !address) {
    throw new Error("expected TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

test("bridge mints job capability handles and preserves events", { timeout: 10_000 }, async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());

  const jobId = "job-mint";
  let submitPayload: any;

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "call") {
        return;
      }
      if (msg.method === "submit") {
        submitPayload = msg.payload;
        ws.send(
          JSON.stringify({
            type: "return",
            callId: msg.callId,
            payload: { job: { id: jobId } },
          }),
        );
        ws.send(
          JSON.stringify({
            type: "event",
            callId: msg.callId,
            event: {
              kind: "jobEvent",
              event: {
                kind: "progress",
                timestamp: new Date().toISOString(),
                progress: { current: 1, total: 4, phase: "checking" },
              },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: "event",
            callId: msg.callId,
            event: {
              kind: "jobResult",
              result: {
                status: "success",
                message: "done",
              },
            },
          }),
        );
      }
    });
  });

  await onceListening(wss);
  const url = wsAddress(wss);

  const bridge = startBridge(t, { ACP_WS_URL: url });
  bridge.send({ id: 1, method: "connect", params: {} });
  await bridge.waitForResponse(1);

  const requestPayload = {
    id: 2,
    method: "submit",
    params: {
      request: {
        action: "contact_points",
        parameters: { uri: "file:///test.lua" },
      },
    },
  } as const;
  bridge.send(requestPayload);

  const response = await bridge.waitForResponse(2);
  assert.deepEqual(response.result, { job: { id: jobId } });
  assert.deepEqual(submitPayload, requestPayload.params.request);

  const [progressEvent, resultEvent] = await bridge.waitForEvents(
    (evt) => evt.method === "event",
    2,
  );

  assert.equal(progressEvent.params.jobId, jobId);
  assert.equal(resultEvent.params.jobId, jobId);
  assert.deepEqual(progressEvent.params.event?.progress, { current: 1, total: 4, phase: "checking" });
  assert.equal(resultEvent.params.result?.status, "success");
});

test("bridge preserves capability identity for cancel", { timeout: 10_000 }, async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());

  const jobId = "job-cancel";
  let cancelPayload: any;
  let submitCallId: string | undefined;

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "call") {
        return;
      }
      if (msg.method === "submit") {
        submitCallId = msg.callId;
        ws.send(
          JSON.stringify({
            type: "return",
            callId: msg.callId,
            payload: { job: { id: jobId } },
          }),
        );
      }
      if (msg.method === "cancel") {
        cancelPayload = msg.payload;
        ws.send(
          JSON.stringify({
            type: "return",
            callId: msg.callId,
            payload: { status: "canceled" },
          }),
        );
        if (submitCallId) {
          ws.send(
            JSON.stringify({
              type: "event",
              callId: submitCallId,
              event: {
                kind: "jobResult",
                result: { status: "canceled", message: "user" },
              },
            }),
          );
        }
      }
    });
  });

  await onceListening(wss);
  const url = wsAddress(wss);

  const bridge = startBridge(t, { ACP_WS_URL: url });
  bridge.send({ id: 1, method: "connect", params: {} });
  await bridge.waitForResponse(1);

  bridge.send({
    id: 2,
    method: "submit",
    params: {
      request: { action: "long", parameters: {} },
    },
  });
  await bridge.waitForResponse(2);

  bridge.send({ id: 3, method: "cancel", params: { jobId } });
  await bridge.waitForResponse(3);

  assert.deepEqual(cancelPayload, { jobId });

  const [resultEvent] = await bridge.waitForEvents((evt) => evt.method === "event", 1);
  assert.equal(resultEvent.params.jobId, jobId);
  assert.equal(resultEvent.params.result?.status, "canceled");
});

test("bridge propagates fact subscriptions with intact payloads", { timeout: 10_000 }, async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  t.after(() => wss.close());

  const subscriptionId = "facts-1";
  let subscribePayload: any;

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "call") {
        return;
      }
      if (msg.method === "subscribeFacts") {
        subscribePayload = msg.payload;
        ws.send(
          JSON.stringify({
            type: "return",
            callId: msg.callId,
            payload: { subscription: { id: subscriptionId } },
          }),
        );
        ws.send(
          JSON.stringify({
            type: "event",
            callId: msg.callId,
            event: {
              kind: "fact",
              fact: { scope: "workspace", id: "alpha", content: { k: 1 } },
            },
          }),
        );
      }
      if (msg.method === "close") {
        ws.send(
          JSON.stringify({
            type: "return",
            callId: msg.callId,
            payload: { closed: true },
          }),
        );
      }
    });
  });

  await onceListening(wss);
  const url = wsAddress(wss);

  const bridge = startBridge(t, { ACP_WS_URL: url });
  bridge.send({ id: 1, method: "connect", params: {} });
  await bridge.waitForResponse(1);

  bridge.send({
    id: 2,
    method: "subscribeFacts",
    params: {
      meta: { scope: "workspace", cursor: "0" },
      filters: [{ kind: "language", value: "lua" }],
    },
  });

  const subscribeResponse = await bridge.waitForResponse(2);
  assert.deepEqual(subscribeResponse.result, { subscription: { id: subscriptionId } });
  assert.deepEqual(subscribePayload, {
    meta: { scope: "workspace", cursor: "0" },
    filters: [{ kind: "language", value: "lua" }],
  });

  const [factEvent] = await bridge.waitForEvents((evt) => evt.method === "fact", 1);
  assert.equal(factEvent.params.subscriptionId, subscriptionId);
  assert.deepEqual(factEvent.params.fact, { scope: "workspace", id: "alpha", content: { k: 1 } });

  bridge.send({ id: 3, method: "closeFacts", params: { subscriptionId } });
  await bridge.waitForResponse(3);
});
