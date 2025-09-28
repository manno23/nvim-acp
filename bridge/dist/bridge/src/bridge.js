import { randomUUID } from "node:crypto";
import process from "node:process";
import WebSocket from "ws";
import { newWebSocketRpcSession, RpcTarget } from "./capnweb-shim.js";
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
function logInvariant(event, details) {
    process.stderr.write(`[acp-bridge:${event}] ${JSON.stringify(details)}\n`);
}
class BridgeJobObserver extends RpcTarget {
    jobId;
    writer;
    onResult;
    constructor(jobId, writer, onResult) {
        super();
        this.jobId = jobId;
        this.writer = writer;
        this.onResult = onResult;
    }
    async event(event) {
        logInvariant("job_event", { jobId: this.jobId, kind: event.kind, phase: event.progress?.phase });
        const payload = {
            jobId: this.jobId,
            event,
        };
        this.writer.write({ method: "event", params: payload });
    }
    async result(result) {
        logInvariant("job_result", { jobId: this.jobId, status: result.status });
        const payload = {
            jobId: this.jobId,
            result,
        };
        this.writer.write({ method: "event", params: payload });
        this.onResult(this.jobId);
    }
}
class BridgeFactsObserver extends RpcTarget {
    subscriptionId;
    writer;
    onClosed;
    constructor(subscriptionId, writer, onClosed) {
        super();
        this.subscriptionId = subscriptionId;
        this.writer = writer;
        this.onClosed = onClosed;
    }
    async fact(record) {
        logInvariant("fact", { subscriptionId: this.subscriptionId, scope: record.scope });
        const payload = {
            subscriptionId: this.subscriptionId,
            fact: record,
        };
        this.writer.write({ method: "fact", params: payload });
    }
    async closed(reason) {
        logInvariant("fact_closed", { subscriptionId: this.subscriptionId, reason });
        this.onClosed(this.subscriptionId);
    }
}
class AcpConnection {
    writer;
    socket;
    stub;
    jobs = new Map();
    subscriptions = new Map();
    constructor(writer) {
        this.writer = writer;
    }
    async connect(config) {
        if (this.stub) {
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
        const socket = new WebSocket(url, { headers });
        await this.awaitOpen(socket, config.connectTimeoutMs ?? 10_000);
        this.socket = socket;
        this.stub = newWebSocketRpcSession(socket);
        this.stub.onRpcBroken((err) => {
            logInvariant("rpc_broken", { message: err instanceof Error ? err.message : String(err) });
            this.writer.write({ method: "disconnect", params: {} });
            this.cleanupAll();
            this.stub = undefined;
        });
        logInvariant("connect", { url });
    }
    submit(request) {
        this.assertConnected();
        const jobId = randomUUID();
        const job = this.stub.submit(request);
        const observer = new BridgeJobObserver(jobId, this.writer, (id) => this.finishJob(id));
        this.jobs.set(jobId, { stub: job, observer });
        logInvariant("job_minted", { jobId, action: request.action });
        job
            .watch(observer)
            .catch((error) => {
            logInvariant("job_watch_error", { jobId, message: error instanceof Error ? error.message : String(error) });
            this.writer.write({
                method: "event",
                params: {
                    jobId,
                    result: { status: "failure", message: String(error) },
                },
            });
            this.finishJob(jobId);
        });
        return { job: { id: jobId } };
    }
    async cancel(jobId) {
        this.assertConnected();
        const handle = this.jobs.get(jobId);
        if (!handle) {
            throw new Error(`Unknown job ${jobId}`);
        }
        logInvariant("job_cancel", { jobId });
        await handle.stub.cancel();
        return { canceled: true };
    }
    subscribeFacts(meta, filters) {
        this.assertConnected();
        const subscriptionId = randomUUID();
        const stub = this.stub.subscribeFacts(meta, filters);
        const observer = new BridgeFactsObserver(subscriptionId, this.writer, (id) => this.finishSubscription(id));
        this.subscriptions.set(subscriptionId, { stub, observer });
        logInvariant("facts_minted", { subscriptionId, scope: meta.scope });
        stub
            .observe(observer)
            .catch((error) => {
            logInvariant("facts_observe_error", {
                subscriptionId,
                message: error instanceof Error ? error.message : String(error),
            });
            this.finishSubscription(subscriptionId);
        });
        return { subscription: { id: subscriptionId } };
    }
    async closeFacts(subscriptionId) {
        this.assertConnected();
        const handle = this.subscriptions.get(subscriptionId);
        if (!handle) {
            throw new Error(`Unknown subscription ${subscriptionId}`);
        }
        logInvariant("facts_close", { subscriptionId });
        await handle.stub.close();
        this.finishSubscription(subscriptionId);
        return { closed: true };
    }
    shutdown() {
        this.cleanupAll();
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.close(1000, "shutdown");
        }
        if (this.stub && typeof this.stub[Symbol.dispose] === "function") {
            this.stub[Symbol.dispose]();
        }
        this.stub = undefined;
    }
    async awaitOpen(socket, timeout) {
        if (socket.readyState === WebSocket.OPEN) {
            return;
        }
        await new Promise((resolve, reject) => {
            const timer = timeout > 0 ? setTimeout(() => {
                socket.terminate();
                reject(new Error("Timed out connecting to ACP"));
            }, timeout) : undefined;
            socket.once("open", () => {
                if (timer) {
                    clearTimeout(timer);
                }
                resolve();
            });
            socket.once("error", (error) => {
                if (timer) {
                    clearTimeout(timer);
                }
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    assertConnected() {
        if (!this.stub) {
            throw new Error("Not connected");
        }
    }
    finishJob(jobId) {
        const handle = this.jobs.get(jobId);
        if (!handle) {
            return;
        }
        this.jobs.delete(jobId);
        logInvariant("job_finalized", { jobId });
        if (typeof handle.stub[Symbol.dispose] === "function") {
            handle.stub[Symbol.dispose]();
        }
    }
    finishSubscription(subscriptionId) {
        const handle = this.subscriptions.get(subscriptionId);
        if (!handle) {
            return;
        }
        this.subscriptions.delete(subscriptionId);
        logInvariant("facts_finalized", { subscriptionId });
        if (typeof handle.stub[Symbol.dispose] === "function") {
            handle.stub[Symbol.dispose]();
        }
    }
    cleanupAll() {
        for (const jobId of this.jobs.keys()) {
            this.finishJob(jobId);
        }
        for (const subId of this.subscriptions.keys()) {
            this.finishSubscription(subId);
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
