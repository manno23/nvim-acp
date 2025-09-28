import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startMockServer } from "../../mock/src/mock-server.js";
async function waitFor(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error("timeout");
        }
        await delay(10);
    }
}
function startBridge(t, env) {
    const child = spawn(process.execPath, ["bridge/dist/bridge/src/bridge.js"], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
    });
    const responses = new Map();
    const events = [];
    const stderrLogs = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.trim().length === 0) {
                index = buffer.indexOf("\n");
                continue;
            }
            const message = JSON.parse(line);
            console.log("[bridge->test]", message);
            if (typeof message.id === "number") {
                responses.set(message.id, message);
            }
            else {
                events.push(message);
            }
            index = buffer.indexOf("\n");
        }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        const lines = chunk.split(/\n/).map((line) => line.trim()).filter(Boolean);
        stderrLogs.push(...lines);
    });
    function send(obj) {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
    }
    async function waitForResponse(id, timeoutMs = 5000) {
        await waitFor(() => responses.has(id), timeoutMs);
        return responses.get(id);
    }
    async function waitForEvents(predicate, count, timeoutMs = 5000) {
        await waitFor(() => events.filter(predicate).length >= count, timeoutMs);
        return events.filter(predicate).slice(0, count);
    }
    async function shutdown() {
        if (!child.killed && child.exitCode === null) {
            child.stdin.end();
            child.kill();
            await new Promise((resolve) => child.once("exit", () => resolve()));
        }
    }
    return {
        send,
        waitForResponse,
        waitForEvents,
        responses,
        events,
        stderrLogs,
        shutdown,
    };
}
test("capnweb bridge pipelines job observers and streams results", { timeout: 15_000 }, async (t) => {
    const server = startMockServer(0);
    const url = await server.ready;
    const bridge = startBridge(t, { ACP_WS_URL: url });
    bridge.send({ id: 1, method: "connect", params: {} });
    await bridge.waitForResponse(1);
    bridge.send({
        id: 2,
        method: "submit",
        params: {
            request: {
                action: "contact_points",
                parameters: { uri: "file:///tmp/test.lua" },
            },
        },
    });
    const submitResponse = await bridge.waitForResponse(2);
    const jobHandle = submitResponse.result.job.id;
    t.diagnostic(`submit response: ${JSON.stringify(submitResponse)}`);
    assert.ok(typeof jobHandle === "string" && jobHandle.length > 0, "bridge minted job handle");
    const [progressEvent, resultEvent] = await bridge.waitForEvents((evt) => evt.method === "event", 2);
    t.diagnostic(`received events: ${JSON.stringify([progressEvent, resultEvent])}`);
    assert.equal(progressEvent.params.jobId, jobHandle);
    assert.equal(resultEvent.params.jobId, jobHandle);
    assert.equal(progressEvent.params.event?.kind, "progress");
    assert.equal(resultEvent.params.result?.status, "success");
    console.log("[timeline snapshot]", server.timeline);
    const submitTimeline = server.timeline.filter((entry) => entry.includes("submit"))[0];
    const jobId = submitTimeline.split(":")[1];
    const expectedOrder = [
        `submit:${jobId}:contact_points`,
        `watch:${jobId}`,
        `event:${jobId}:progress`,
        `result:${jobId}`,
    ];
    assert.deepEqual(server.timeline.slice(1, 1 + expectedOrder.length), expectedOrder, "mock server timeline preserves pipelined watch before events");
    console.log("[invariant] job timeline", server.timeline);
    console.log("[invariant] bridge stderr", bridge.stderrLogs);
    await bridge.shutdown();
    await server.close();
});
test("capnweb bridge cancels jobs before completion", { timeout: 15_000 }, async (t) => {
    const server = startMockServer(0);
    const url = await server.ready;
    const bridge = startBridge(t, { ACP_WS_URL: url });
    bridge.send({ id: 1, method: "connect", params: {} });
    await bridge.waitForResponse(1);
    bridge.send({
        id: 2,
        method: "submit",
        params: { request: { action: "slow", parameters: {} } },
    });
    const response = await bridge.waitForResponse(2);
    const jobHandle = response.result.job.id;
    t.diagnostic(`cancel test response: ${JSON.stringify(response)}`);
    bridge.send({ id: 3, method: "cancel", params: { jobId: jobHandle } });
    await bridge.waitForResponse(3);
    const [resultEvent] = await bridge.waitForEvents((evt) => evt.method === "event" && evt.params.result, 1);
    t.diagnostic(`cancel event: ${JSON.stringify(resultEvent)}`);
    assert.equal(resultEvent.params.result?.status, "canceled");
    console.log("[cancel timeline snapshot]", server.timeline);
    const cancelEntry = server.timeline.find((entry) => entry.startsWith("cancel:"));
    assert.ok(cancelEntry, "server recorded cancel call");
    const resultIndex = server.timeline.findIndex((entry) => entry.startsWith("result:"));
    const cancelIndex = server.timeline.findIndex((entry) => entry.startsWith("cancel:"));
    assert.ok(resultIndex === -1 || cancelIndex < resultIndex, "cancel delivered before result emission");
    console.log("[invariant] cancel timeline", server.timeline);
    console.log("[invariant] bridge stderr", bridge.stderrLogs);
    await bridge.shutdown();
    await server.close();
});
test("capnweb bridge streams fact subscriptions", { timeout: 15_000 }, async (t) => {
    const server = startMockServer(0);
    const url = await server.ready;
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
    const subscriptionId = subscribeResponse.result.subscription.id;
    t.diagnostic(`facts response: ${JSON.stringify(subscribeResponse)}`);
    assert.ok(subscriptionId);
    const [factEvent] = await bridge.waitForEvents((evt) => evt.method === "fact", 1);
    t.diagnostic(`fact event: ${JSON.stringify(factEvent)}`);
    assert.equal(factEvent.params.subscriptionId, subscriptionId);
    assert.equal(factEvent.params.fact.scope, "workspace");
    bridge.send({ id: 3, method: "closeFacts", params: { subscriptionId } });
    await bridge.waitForResponse(3);
    const closeEntry = server.timeline.find((entry) => entry.startsWith("facts_close:"));
    assert.ok(closeEntry, "close recorded on server timeline");
    console.log("[invariant] facts timeline", server.timeline);
    console.log("[invariant] bridge stderr", bridge.stderrLogs);
    await bridge.shutdown();
    await server.close();
});
