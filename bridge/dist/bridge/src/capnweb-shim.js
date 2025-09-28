import WebSocketImpl from "ws";
if (typeof globalThis.navigator === "undefined") {
    globalThis.navigator = { userAgent: "Node.js" };
}
if (typeof globalThis.WebSocket === "undefined") {
    globalThis.WebSocket = WebSocketImpl;
}
if (typeof Promise.withResolvers !== "function") {
    Promise.withResolvers = function () {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}
const capnwebModule = await import("capnweb");
export const { newWebSocketRpcSession, RpcTarget } = capnwebModule;
export default capnwebModule;
