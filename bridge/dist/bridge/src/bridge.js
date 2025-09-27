import process from "node:process";
import WebSocket from "ws";
class StdoutWriter {
    queue = [];
    paused = false;
    highWaterMark = 200;
    constructor() {
        process.stdout.on("drain", () => {
            this.paused = false;
            this.flush();
        });
    }
    write(obj) {
        const payload = `${JSON.stringify(obj)}\n`;
        if (this.paused) {
            this.enqueue(payload);
            return;
        }
        if (!process.stdout.write(payload)) {
            this.paused = true;
        }
    }
    enqueue(payload) {
        if (this.queue.length >= this.highWaterMark) {
            this.queue.shift();
            process.stderr.write("[acp-bridge] dropping stdout message due to backpressure\n");
        }
        this.queue.push(payload);
    }
    flush() {
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
    writer;
    ws;
    callId = 0;
    pending = new Map();
    jobByCall = new Map();
    factsByCall = new Map();
    shuttingDown = false;
    constructor(writer) {
        this.writer = writer;
    }
    async connect(config) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }
        const url = config.url ?? process.env.ACP_WS_URL;
        if (!url) {
            throw new Error("ACP websocket URL not provided");
        }
        const headers = {};
        const token = config.token ?? process.env.ACP_TOKEN;
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        await new Promise((resolve, reject) => {
            const socket = new WebSocket(url, {
                headers,
            });
            let timeoutHandle;
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
            socket.once("error", (err) => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
    }
    submit(req) {
        return this.sendCall("acp.Acp", "submit", req, (callId, payload) => {
            const job = payload.job;
            if (job?.id) {
                this.jobByCall.set(callId, job.id);
            }
        });
    }
    cancel(jobId) {
        return this.sendCall("acp.Job", "cancel", { jobId });
    }
    subscribeFacts(meta, filters) {
        return this.sendCall("acp.Acp", "subscribeFacts", { meta, filters }, (callId, payload) => {
            const sub = payload.subscription;
            if (sub?.id) {
                this.factsByCall.set(callId, sub.id);
            }
        });
    }
    closeFacts(subscriptionId) {
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
    sendCall(interfaceId, method, payload, onReturn) {
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
            this.ws?.send(JSON.stringify(message), (err) => {
                if (err) {
                    this.pending.delete(callId);
                    reject(err);
                }
            });
        });
    }
    setupSocket(socket) {
        socket.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            }
            catch (error) {
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
    handleMessage(message) {
        const { type, callId } = message;
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
                const event = { jobId, event: payload.event };
                this.writer.write({ method: "event", params: event });
            }
            else if (payload?.kind === "jobResult" && jobId) {
                const result = { jobId, result: payload.result };
                this.writer.write({ method: "event", params: result });
            }
            else if (payload?.kind === "fact" && factsId) {
                this.writer.write({ method: "fact", params: { subscriptionId: factsId, fact: payload.fact } });
            }
        }
    }
}
const writer = new StdoutWriter();
const connection = new AcpConnection(writer);
async function handleRequest(request) {
    switch (request.method) {
        case "connect": {
            const config = request.params ?? {};
            await connection.connect(config);
            return {};
        }
        case "submit": {
            const payload = request.params?.request;
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
            const meta = request.params?.meta;
            const filters = request.params?.filters ?? [];
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
let residual = "";
function processLine(line) {
    if (!line.trim()) {
        return;
    }
    let request;
    try {
        request = JSON.parse(line);
    }
    catch (error) {
        writer.write({ id: -1, error: { message: `Invalid JSON: ${String(error)}` } });
        return;
    }
    handleRequest(request)
        .then((result) => {
        const response = { id: request.id, result };
        writer.write(response);
    })
        .catch((error) => {
        const response = {
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
        };
        writer.write(response);
    });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    residual += chunk;
    let index = residual.indexOf("\n");
    while (index !== -1) {
        const line = residual.slice(0, index);
        residual = residual.slice(index + 1);
        processLine(line);
        index = residual.indexOf("\n");
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
