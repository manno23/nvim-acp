import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { IncomingMessage } from "http";

interface ClientState {
  jobs: Map<string, {
    callId: string;
    timer?: NodeJS.Timeout;
  }>;
  subscriptions: Map<string, {
    callId: string;
    timer?: NodeJS.Timeout;
  }>;
}

export interface MockServerHandle {
  readonly url: string;
  readonly ready: Promise<string>;
  close: () => Promise<void>;
}

export function startMockServer(port = Number(process.env.MOCK_ACP_PORT ?? 8765)): MockServerHandle {
  const server = new WebSocketServer({ port });
  let resolvedPort = port;
  let resolveReady: (url: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });

  server.on("listening", () => {
    const address = server.address();
    if (typeof address === "object" && address) {
      resolvedPort = address.port;
    }
    const url = `ws://127.0.0.1:${resolvedPort}`;
    process.stdout.write(`mock acp server listening on ${url}\n`);
    resolveReady(url);
  });

  server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const auth = request.headers.authorization;
    if (process.env.ACP_TOKEN && auth !== `Bearer ${process.env.ACP_TOKEN}`) {
      socket.close(4401, "unauthorized");
      return;
    }

    const state: ClientState = { jobs: new Map(), subscriptions: new Map() };

    socket.on("message", (raw: RawData) => {
      const message = JSON.parse(raw.toString()) as {
        type: string;
        callId: string;
        interfaceId: string;
        method: string;
        payload: any;
      };

      if (message.type !== "call") {
        return;
      }

      if (message.interfaceId === "acp.Acp" && message.method === "submit") {
        const jobId = randomUUID();
        state.jobs.set(jobId, { callId: message.callId });
        socket.send(JSON.stringify({
          type: "return",
          callId: message.callId,
          payload: { job: { id: jobId } },
        }));
        const timer = setTimeout(() => {
          socket.send(JSON.stringify({
            type: "event",
            callId: message.callId,
            event: {
              kind: "jobEvent",
              event: {
                kind: "progress",
                timestamp: new Date().toISOString(),
                progress: { current: 50, total: 100, phase: "mock" },
              },
            },
          }));
          socket.send(JSON.stringify({
            type: "event",
            callId: message.callId,
            event: {
              kind: "jobResult",
              result: {
                status: "success",
                message: "mock complete",
                artifacts: [
                  {
                    id: randomUUID(),
                    uri: "file:///tmp/mock.txt",
                    mediaType: "text/plain",
                  },
                ],
              },
            },
          }));
        }, 100);
        state.jobs.get(jobId)!.timer = timer;
        return;
      }

      if (message.interfaceId === "acp.Job" && message.method === "cancel") {
        const jobId = message.payload.jobId as string;
        const job = state.jobs.get(jobId);
        if (job?.timer) {
          clearTimeout(job.timer);
        }
        socket.send(JSON.stringify({
          type: "return",
          callId: message.callId,
          payload: { status: "canceled" },
        }));
        if (job) {
          socket.send(JSON.stringify({
            type: "event",
            callId: job.callId,
            event: {
              kind: "jobResult",
              result: { status: "canceled", message: "canceled by user" },
            },
          }));
        }
        return;
      }

      if (message.interfaceId === "acp.Acp" && message.method === "subscribeFacts") {
        const subscriptionId = randomUUID();
        state.subscriptions.set(subscriptionId, { callId: message.callId });
        socket.send(JSON.stringify({
          type: "return",
          callId: message.callId,
          payload: { subscription: { id: subscriptionId } },
        }));
        const timer = setInterval(() => {
          socket.send(JSON.stringify({
            type: "event",
            callId: message.callId,
            event: {
              kind: "fact",
              fact: {
                id: randomUUID(),
                scope: message.payload.meta?.scope ?? "default",
              },
            },
          }));
        }, 200);
        state.subscriptions.get(subscriptionId)!.timer = timer;
        return;
      }

      if (message.interfaceId === "acp.FactsSubscription" && message.method === "close") {
        const subscriptionId = message.payload.subscriptionId as string;
        const subscription = state.subscriptions.get(subscriptionId);
        if (subscription?.timer) {
          clearInterval(subscription.timer);
        }
        socket.send(JSON.stringify({
          type: "return",
          callId: message.callId,
          payload: { closed: true },
        }));
        state.subscriptions.delete(subscriptionId);
      }
    });

    socket.on("close", () => {
      for (const [, job] of state.jobs) {
        if (job.timer) {
          clearTimeout(job.timer);
        }
      }
      for (const [, sub] of state.subscriptions) {
        if (sub.timer) {
          clearInterval(sub.timer);
        }
      }
    });
  });

  return {
    get url() {
      return `ws://127.0.0.1:${resolvedPort}`;
    },
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  startMockServer();
}
