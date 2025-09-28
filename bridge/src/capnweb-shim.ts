import WebSocketImpl from "ws";

if (typeof globalThis.navigator === "undefined") {
  (globalThis as any).navigator = { userAgent: "Node.js" };
}

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocketImpl;
}

if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function <T = unknown>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const capnwebModule = await import("capnweb");

export const { newWebSocketRpcSession, RpcTarget } = capnwebModule as typeof import("capnweb");
export type { RpcStub, RpcPromise, RpcSessionOptions, RpcTransport } from "capnweb";
export default capnwebModule;
