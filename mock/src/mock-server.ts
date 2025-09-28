import { randomUUID } from "node:crypto";
import process from "node:process";
import WebSocket, { WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import {
  newWebSocketRpcSession,
  RpcTarget,
} from "../../bridge/src/capnweb-shim.js";
import type {
  Acp,
  ActionEvent,
  ActionRequest,
  ActionResult,
  FactFilter,
  FactMeta,
  FactRecord,
  FactsObserver,
  FactsSubscription,
  Job,
  JobObserver,
} from "../../bridge/src/acp.js";

interface MockServerHandle {
  readonly url: string;
  readonly ready: Promise<string>;
  readonly timeline: string[];
  readonly logs: string[];
  close: () => Promise<void>;
}

function logTimeline(timeline: string[], logs: string[], entry: string, detail: string) {
  timeline.push(entry);
  logs.push(detail);
  process.stdout.write(`${detail}\n`);
}

class MockJob extends RpcTarget implements Job {
  #observer?: JobObserver;
  #progressTimer?: NodeJS.Timeout;
  #resultTimer?: NodeJS.Timeout;
  #canceled = false;

  constructor(
    private readonly id: string,
    private readonly request: ActionRequest,
    private readonly timeline: string[],
    private readonly logs: string[],
    private readonly onDispose: (id: string) => void,
  ) {
    super();
  }

  async watch(observer: JobObserver): Promise<void> {
    logTimeline(
      this.timeline,
      this.logs,
      `watch:${this.id}`,
      `[mock][job ${this.id}] observer attached for ${this.request.action}`,
    );
    const retained = typeof (observer as any).dup === "function" ? (observer as any).dup() : observer;
    this.#observer = retained;
    this.scheduleProgress();
  }

  async cancel(): Promise<void> {
    this.#canceled = true;
    logTimeline(
      this.timeline,
      this.logs,
      `cancel:${this.id}`,
      `[mock][job ${this.id}] cancel invoked`,
    );
    this.clearTimers();
    await this.#observer?.result({ status: "canceled", message: "canceled by client" });
    this.dispose();
  }

  private scheduleProgress() {
    this.clearTimers();
    this.#progressTimer = setTimeout(async () => {
      if (this.#canceled || !this.#observer) {
        return;
      }
      const event: ActionEvent = {
        kind: "progress",
        timestamp: new Date().toISOString(),
        progress: { current: 1, total: 2, phase: "mock" },
        message: `processing ${this.request.action}`,
      };
      logTimeline(
        this.timeline,
        this.logs,
        `event:${this.id}:progress`,
        `[mock][job ${this.id}] emitting progress`,
      );
      try {
        await this.#observer.event(event);
      } catch (error) {
        logTimeline(
          this.timeline,
          this.logs,
          `event_error:${this.id}`,
          `[mock][job ${this.id}] observer event failed: ${error}`,
        );
      }
    }, 10);

    this.#resultTimer = setTimeout(async () => {
      if (this.#canceled || !this.#observer) {
        return;
      }
      const result: ActionResult = {
        status: "success",
        message: `mock complete: ${this.request.action}`,
        artifacts: [
          {
            id: randomUUID(),
            uri: "file:///tmp/mock.txt",
            mediaType: "text/plain",
          },
        ],
      };
      logTimeline(
        this.timeline,
        this.logs,
        `result:${this.id}`,
        `[mock][job ${this.id}] emitting success result`,
      );
      try {
        await this.#observer.result(result);
      } catch (error) {
        logTimeline(
          this.timeline,
          this.logs,
          `result_error:${this.id}`,
          `[mock][job ${this.id}] observer result failed: ${error}`,
        );
      }
      this.dispose();
    }, 30);
  }

  private clearTimers() {
    if (this.#progressTimer) {
      clearTimeout(this.#progressTimer);
      this.#progressTimer = undefined;
    }
    if (this.#resultTimer) {
      clearTimeout(this.#resultTimer);
      this.#resultTimer = undefined;
    }
  }

  dispose() {
    this.clearTimers();
    if (this.#observer && typeof (this.#observer as any)[Symbol.dispose] === "function") {
      (this.#observer as any)[Symbol.dispose]();
    }
    this.onDispose(this.id);
  }
}

class MockFactsSubscription extends RpcTarget implements FactsSubscription {
  #observer?: FactsObserver;
  #timer?: NodeJS.Timeout;
  #closed = false;

  constructor(
    private readonly id: string,
    private readonly meta: FactMeta,
    private readonly filters: FactFilter[],
    private readonly timeline: string[],
    private readonly logs: string[],
    private readonly onDispose: (id: string) => void,
  ) {
    super();
  }

  async observe(observer: FactsObserver): Promise<void> {
    logTimeline(
      this.timeline,
      this.logs,
      `facts_observe:${this.id}`,
      `[mock][facts ${this.id}] observer attached for scope ${this.meta.scope}`,
    );
    const retained = typeof (observer as any).dup === "function" ? (observer as any).dup() : observer;
    this.#observer = retained;
    this.scheduleFacts();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    logTimeline(
      this.timeline,
      this.logs,
      `facts_close:${this.id}`,
      `[mock][facts ${this.id}] close invoked`,
    );
    this.clearTimer();
    await this.#observer?.closed("client closed");
    this.dispose();
  }

  private scheduleFacts() {
    this.clearTimer();
    this.#timer = setInterval(async () => {
      if (!this.#observer || this.#closed) {
        return;
      }
      const record: FactRecord = {
        id: randomUUID(),
        scope: this.meta.scope,
        payload: {
          filters: this.filters.map((f) => `${f.kind}:${f.value ?? ""}`),
        },
      };
      logTimeline(
        this.timeline,
        this.logs,
        `fact:${this.id}`,
        `[mock][facts ${this.id}] emitting fact ${record.id}`,
      );
      await this.#observer.fact(record);
    }, 50);
  }

  private clearTimer() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  dispose() {
    this.clearTimer();
    if (this.#observer && typeof (this.#observer as any)[Symbol.dispose] === "function") {
      (this.#observer as any)[Symbol.dispose]();
    }
    this.onDispose(this.id);
  }
}

class MockAcp extends RpcTarget implements Acp {
  readonly jobs = new Map<string, MockJob>();
  readonly subscriptions = new Map<string, MockFactsSubscription>();

  constructor(private readonly timeline: string[], private readonly logs: string[]) {
    super();
  }

  submit(request: ActionRequest): Job {
    const jobId = randomUUID();
    logTimeline(
      this.timeline,
      this.logs,
      `submit:${jobId}:${request.action}`,
      `[mock] submit ${request.action} -> job ${jobId}`,
    );
    const job = new MockJob(jobId, request, this.timeline, this.logs, (id) => this.jobs.delete(id));
    this.jobs.set(jobId, job);
    return job;
  }

  subscribeFacts(meta: FactMeta, filters: FactFilter[]): FactsSubscription {
    const subscriptionId = randomUUID();
    logTimeline(
      this.timeline,
      this.logs,
      `subscribe:${subscriptionId}:${meta.scope}`,
      `[mock] subscribe ${meta.scope} -> subscription ${subscriptionId}`,
    );
    const subscription = new MockFactsSubscription(
      subscriptionId,
      meta,
      filters,
      this.timeline,
      this.logs,
      (id) => this.subscriptions.delete(id),
    );
    this.subscriptions.set(subscriptionId, subscription);
    return subscription;
  }
}

export function startMockServer(port = Number(process.env.MOCK_ACP_PORT ?? 8765)): MockServerHandle {
  const server = new WebSocketServer({ port });
  const timeline: string[] = [];
  const logs: string[] = [];
  const api = new MockAcp(timeline, logs);
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

  server.on("connection", (socket, request: IncomingMessage) => {
    const auth = request.headers.authorization;
    if (process.env.ACP_TOKEN && auth !== `Bearer ${process.env.ACP_TOKEN}`) {
      socket.close(4401, "unauthorized");
      return;
    }
    logTimeline(timeline, logs, "connection", "[mock] accepted bridge connection");
    newWebSocketRpcSession(socket as any, api);

    socket.on("close", () => {
      logTimeline(timeline, logs, "disconnect", "[mock] bridge disconnected");
      for (const job of api.jobs.values()) {
        job.dispose();
      }
      for (const sub of api.subscriptions.values()) {
        sub.dispose();
      }
      api.jobs.clear();
      api.subscriptions.clear();
    });
  });

  return {
    get url() {
      return `ws://127.0.0.1:${resolvedPort}`;
    },
    ready,
    timeline,
    logs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("mock-server.js");
if (invokedDirectly) {
  startMockServer();
}
