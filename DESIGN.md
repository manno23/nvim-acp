# Cap’n Web Bridge Design

## Goals
- Provide a thin Node sidecar that speaks Cap’n Web RPC to an ACP server while proxying a stable MsgPack-RPC channel to Neovim.
- Preserve capability semantics so that promise pipelining (e.g. calling `job.watch` before `submit` resolves) and cancelation remain lossless.
- Surface streamed action events, results, and fact updates to Neovim without blocking the UI and while keeping diagnostics/quickfix state consistent.
- Keep the system observable: produce structured logs of capability lifetimes so tests can assert on ordering invariants.

## Architecture Overview
1. **Cap’n Web shim** (`bridge/src/capnweb-shim.ts`)
   - Polyfills `navigator`, `WebSocket`, and `Promise.withResolvers` in Node 20 before dynamically importing `capnweb`.
   - Ensures both client and server sides can instantiate `newWebSocketRpcSession` using the `ws` library.

2. **Bridge runtime** (`bridge/src/bridge.ts`)
   - Connects to `${ACP_WS_URL}` using the shimmed Cap’n Web client and mints local job/subscription handles.
   - Pipelined operations: immediately call `job.watch(observer)` and `subscription.observe(observer)` without awaiting `submit/subscribeFacts` responses, allowing cancel/close to fire even if the server has not responded yet.
   - `BridgeJobObserver` / `BridgeFactsObserver` extend `RpcTarget` so the server can invoke callbacks. Every event/result/fact emits MsgPack-style JSON lines on stdout and logs invariants to stderr (e.g. job minted, event kind, final status).
   - Backpressure handled via queued stdout writer. Graceful shutdown disposes Cap’n Web stubs and closes WebSocket.

3. **Mock ACP server** (`mock/src/mock-server.ts`)
   - Implements Cap’n Web targets for `Acp`, `Job`, and `FactsSubscription`.
   - Uses capability references pipelined from the bridge (duplication ensures stubs remain alive beyond the `watch/observe` call) and records a timeline array with entries such as `submit:…`, `watch:…`, `cancel:…`, `fact:…`, `result:…`.
   - Emits deterministic progress, result, cancel, and fact callbacks with human-readable logs so tests and humans can verify behavior.

4. **Neovim Lua plugin**
   - Existing MsgPack RPC client remains unchanged, but it now observes richer job lifecycle events and facts (capability handles are native IDs minted by the bridge).

## Testing Strategy
- **Integration tests** (`tests/ts/bridge.spec.ts`)
  - Spawn the compiled bridge and mock server, issue RPC calls over stdout/stdin, and assert on:
    * Pipelined submit/watch: timeline shows `submit → watch → event → result` before disconnect.
    * Cancelation invariants: timeline records `cancel` and no result precedes it.
    * Fact subscriptions: streaming facts appear and timelines show observe/close pairs.
  - Tests print invariant logs (`[invariant] …`) and timeline snapshots to stdout as proof of correctness.
- **pnpm test:ts** builds and runs the test suite, ensuring Cap’n Web integration works end-to-end.

## Logging & Observability
- Bridge logs (stderr) enumerate connection, job minting, events, results, cancelations, and subscription lifecycle events.
- Mock server logs (stdout) mirror capability interactions to provide cross-checks.
- Tests surface these logs so CI output demonstrates the invariants hold.

## Future Considerations
- Replace stdout newline JSON with MsgPack framing once Neovim consumes binary frames natively.
- Extend the shim to expose more Cap’n Web exports as needed (e.g. `RpcSession` for advanced tooling).
- Introduce reconnect/backoff strategies in the bridge for production resilience.
