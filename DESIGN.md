# Cap’n Web Bridge Design

## Goals
- Provide a thin Node sidecar that speaks Cap’n Web RPC to an ACP server while proxying a stable MsgPack-RPC channel to Neovim.
- Preserve capability semantics so that job and subscription lifecycle events (e.g. cancelation) are handled reliably.
- Surface streamed action events, results, and fact updates to Neovim without blocking the UI and while keeping diagnostics/quickfix state consistent.
- Keep the system observable: produce structured logs of capability lifetimes so tests can assert on ordering invariants.

## Architecture Overview
1. **Cap’n Web shim** (`bridge/src/capnweb-shim.ts`)
   - Polyfills `navigator`, `WebSocket`, and `Promise.withResolvers` in Node 20 before dynamically importing `capnweb`.
   - Ensures both client and server sides can instantiate `newWebSocketRpcSession` using the `ws` library.

2. **Bridge runtime** (`bridge/src/bridge.ts`)
   - Connects to `${ACP_WS_URL}` and manages job and subscription handles.
   - Translates between the Cap’n Web RPC protocol and a stable, MsgPack-based RPC protocol for Neovim.
   - Forwards events, results, and facts from the ACP server to Neovim, using job and subscription IDs to route messages.
   - Handles backpressure from Neovim using a queued writer for stdout.
   - Manages graceful shutdown of the WebSocket connection.

3. **Mock ACP server** (`mock/src/mock-server.ts`)
   - Implements Cap’n Web targets for `Acp`, `Job`, and `FactsSubscription`.
   - Records a timeline of events to allow tests to assert on the correct sequence of operations (e.g., `submit`, `cancel`, `event`, `result`).
   - Emits deterministic progress, result, cancel, and fact callbacks with human-readable logs so tests and humans can verify behavior.

4. **Neovim Lua plugin**
   - Existing MsgPack RPC client remains unchanged, but it now observes richer job lifecycle events and facts (capability handles are native IDs minted by the bridge).

## Testing Strategy
- **Integration tests** (`tests/ts/bridge.spec.ts`)
  - Spawns the compiled bridge and mock server, then issues RPC calls over stdin/stdout to assert on:
    * **Correctness of RPC handling:** Ensures that `submit`, `cancel`, and other RPC methods are correctly translated and forwarded.
    * **Cancelation invariants:** Verifies that a `cancel` request stops the job and prevents a `result` from being sent.
    * **Fact subscriptions:** Confirms that fact subscriptions are correctly established and that streaming facts are received.
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
