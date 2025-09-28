import process from "node:process";
import WebSocket from "ws";
import type { RawData } from "ws";
import { encode as msgpackEncode, decode as msgpackDecode } from "@msgpack/msgpack";
import {
  ActionRequest,
  ActionResult,
  ActionEvent,
  BridgeConfig,
  BridgeRequest,
  BridgeResponse,
  FactFilter,
  FactMeta,
  JobEvent,
  JobResultEvent,
} from "./acp.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

class StdoutWriter {
  private queue: Buffer[] = [];
  private paused = false;
  private readonly highWaterMark = 200;

  constructor() {
    process.stdout.on("drain", () => {
      this.paused = false;
      this.flush();
    });
  }

  write(obj: unknown) {
    const payload = Buffer.from(msgpackEncode(obj));
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(payload.byteLength, 0);
    const frame = Buffer.concat([prefix, payload]);
    if (this.paused) {
      this.enqueue(frame);
      return;
    }

    if (!process.stdout.write(frame)) {
      this.paused = true;
    }
  }

  private enqueue(payload: Buffer) {
    if (this.queue.length >= this.highWaterMark) {
      this.queue.shift();
      process.stderr.write("[acp-bridge] dropping stdout message due to backpressure\n");
    }
    this.queue.push(payload);
  }

  private flush() {
    while (!this.paused) {
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      if (!process.stdout.write(next)) {
        this.paused = true;
      }
    }
  }
}

class AcpConnection {
  private ws?: WebSocket;
  private callId = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly jobByCall = new Map<string, string>();
  private readonly factsByCall = new Map<string, string>();
  private shuttingDown = false;

  constructor(private readonly writer: StdoutWriter) {}

  async connect(config: BridgeConfig): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    const url = config.url ?? process.env.ACP_WS_URL;
    if (!url) {
      throw new Error("ACP websocket URL not provided");
    }
    const headers: Record<string, string> = {};
    const token = config.token ?? process.env.ACP_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers,
      });
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeout = config.connectTimeoutMs ?? 10_000;
      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          socket.terminate();
          reject(new Error("Timed out connecting to ACP"));
        }, timeout);
      }

      socket.once("open", () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        this.ws = socket;
        this.setupSocket(socket);
        resolve();
      });

      socket.once("error", (err: Error) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  submit(req: ActionRequest) {
    return this.sendCall("acp.Acp", "submit", req, (callId, payload) => {
      const job = (payload as { job: { id: string } }).job;
      if (job?.id) {
        this.jobByCall.set(callId, job.id);
      }
    });
  }

  cancel(jobId: string) {
    return this.sendCall("acp.Job", "cancel", { jobId });
  }

  subscribeFacts(meta: FactMeta, filters: FactFilter[]) {
    return this.sendCall("acp.Acp", "subscribeFacts", { meta, filters }, (callId, payload) => {
      const sub = (payload as { subscription: { id: string } }).subscription;
      if (sub?.id) {
        this.factsByCall.set(callId, sub.id);
      }
    });
  }

  closeFacts(subscriptionId: string) {
    return this.sendCall("acp.FactsSubscription", "close", { subscriptionId });
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "shutdown");
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Bridge shutting down"));
    }
    this.pending.clear();
  }

  private sendCall(
    interfaceId: string,
    method: string,
    payload: unknown,
    onReturn?: (callId: string, payload: unknown) => void,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected"));
    }
    const callId = `${++this.callId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(callId, {
        resolve: (value) => {
          if (onReturn) {
            onReturn(callId, value);
          }
          resolve(value);
        },
        reject,
      });
      const message = {
        type: "call",
        callId,
        interfaceId,
        method,
        payload,
      };
      this.ws?.send(JSON.stringify(message), (err?: Error) => {
        if (err) {
          this.pending.delete(callId);
          reject(err);
        }
      });
    });
  }

  private setupSocket(socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (error) {
        process.stderr.write(`acp-bridge failed to parse message: ${String(error)}\n`);
      }
    });

    socket.on("close", () => {
      if (this.shuttingDown) {
        return;
      }
      this.writer.write({ method: "disconnect", params: {} });
    });
  }

  private handleMessage(message: any) {
    const { type, callId } = message as { type: string; callId?: string };
    if (type === "return" && callId) {
      const pending = this.pending.get(callId);
      if (pending) {
        this.pending.delete(callId);
        pending.resolve(message.payload);
      }
      return;
    }

    if (type === "exception" && callId) {
      const pending = this.pending.get(callId);
      if (pending) {
        this.pending.delete(callId);
        pending.reject(new Error(message.error?.message ?? "ACP exception"));
      }
      return;
    }

    if (type === "event" && callId) {
      const payload = message.event;
      const jobId = this.jobByCall.get(callId);
      const factsId = this.factsByCall.get(callId);
      if (payload?.kind === "jobEvent" && jobId) {
        const event: JobEvent = { jobId, event: payload.event as ActionEvent } as JobEvent;
        this.writer.write({ method: "event", params: event });
      } else if (payload?.kind === "jobResult" && jobId) {
        const result: JobResultEvent = { jobId, result: payload.result as ActionResult };
        this.writer.write({ method: "event", params: result });
      } else if (payload?.kind === "fact" && factsId) {
        this.writer.write({ method: "fact", params: { subscriptionId: factsId, fact: payload.fact } });
      }
    }
  }
}

const writer = new StdoutWriter();
const connection = new AcpConnection(writer);

async function handleRequest(request: BridgeRequest) {
  switch (request.method) {
    case "connect": {
      const config = request.params ?? {};
      await connection.connect(config as BridgeConfig);
      return {};
    }
    case "submit": {
      const payload = request.params?.request as ActionRequest;
      if (!payload) {
        throw new Error("request payload required");
      }
      return connection.submit(payload);
    }
    case "cancel": {
      const jobId = request.params?.jobId;
      if (!jobId || typeof jobId !== "string") {
        throw new Error("jobId required");
      }
      return connection.cancel(jobId);
    }
    case "subscribeFacts": {
      const meta = request.params?.meta as FactMeta;
      const filters = (request.params?.filters as FactFilter[]) ?? [];
      if (!meta) {
        throw new Error("meta required");
      }
      return connection.subscribeFacts(meta, filters);
    }
    case "closeFacts": {
      const subscriptionId = request.params?.subscriptionId;
      if (!subscriptionId || typeof subscriptionId !== "string") {
        throw new Error("subscriptionId required");
      }
      return connection.closeFacts(subscriptionId);
    }
    default:
      throw new Error(`Unknown method ${request.method}`);
  }
}

let stdinBuffer = Buffer.alloc(0);

function processFrame(buffer: Uint8Array) {
  let request: BridgeRequest;
  try {
    request = msgpackDecode(buffer) as BridgeRequest;
  } catch (error) {
    writer.write({ id: -1, error: { message: `Invalid msgpack: ${String(error)}` } });
    return;
  }
  handleRequest(request)
    .then((result) => {
      const response: BridgeResponse = { id: request.id, result };
      writer.write(response);
    })
    .catch((error) => {
      const response: BridgeResponse = {
        id: request.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
      writer.write(response);
    });
}

process.stdin.on("data", (chunk: Buffer) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.byteLength >= 4) {
    const frameLength = stdinBuffer.readUInt32BE(0);
    if (stdinBuffer.byteLength < frameLength + 4) {
      break;
    }
    const frame = stdinBuffer.subarray(4, 4 + frameLength);
    processFrame(frame);
    stdinBuffer = stdinBuffer.subarray(4 + frameLength);
  }
});

process.stdin.on("end", () => {
  connection.shutdown();
});

process.on("SIGINT", () => {
  connection.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  connection.shutdown();
  process.exit(0);
});
