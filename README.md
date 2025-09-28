# nvim-acp

Thin Neovim ↔︎ ACP bridge combining a Lua client with a Cap'n Web TypeScript sidecar.

## Features

- Non-blocking communication with ACP via a Node.js sidecar that speaks Cap'n Web over WebSockets.
- MessagePack-framed stdio RPC between Neovim and the sidecar keeps request/response ordering tight while respecting libuv backpressure.
- Streamed action events into quickfix, diagnostics, and optional Telescope picker.
- Commands for common ACP actions and fact subscriptions with cancelation support.
- Mock ACP server and end-to-end tests for the bridge and Neovim integration.

## Requirements

- Neovim 0.10+ (for `vim.system`, modern diagnostics API).
- Node.js 18+.

## Installation

Clone into your `packpath`:

```sh
mkdir -p ~/.local/share/nvim/site/pack/acp/start
cd ~/.local/share/nvim/site/pack/acp/start
git clone https://example.com/nvim-acp.git
```

For lazy loading, move the directory to `pack/acp/opt` and `:packadd nvim-acp`.

### Building the sidecar

```sh
pnpm install
pnpm build
```

`bridge/dist/bridge/src/bridge.js` must exist for the Lua plugin to spawn the sidecar. Rebuild after modifying TypeScript sources.

## Configuration

Environment variables:

- `ACP_WS_URL` – default websocket endpoint (e.g. `wss://example.com/acp`).
- `ACP_TOKEN` – bearer token injected as `Authorization` header.
- `ACP_LOG_LEVEL` – Lua-side log verbosity (`error`, `warn`, etc.).

Optional Lua setup:

```lua
require("acp.init").setup({
  url = "ws://127.0.0.1:9876",
  bridge_cmd = { "node", "/path/to/nvim-acp/bridge/dist/bridge/src/bridge.js" },
})
```

## Commands

| Command | Description |
| --- | --- |
| `:ACPConnect [url]` | Connect to ACP (defaults to `ACP_WS_URL`). |
| `:ACPContactPoints` | Submit a `contact_points` action for the current buffer. |
| `:ACPSkeletonize` | Submit a `skeletonize` action with buffer artifacts. |
| `:ACPInferBody` | Submit an `infer_body` action. |
| `:ACPCancel [jobId]` | Cancel the most recent or specified job. |
| `:ACPSubscribeFacts [scope]` | Subscribe to facts stream; opens scratch buffer with updates. |
| `:ACPUnsubscribeFacts [scope]` | Close a facts subscription. |
| `:ACPEventsTelescope` | Browse quickfix events via Telescope (if installed). |

Diagnostics land in an `acp` namespace; job streams populate quickfix and can be browsed via Telescope.

## Mock server & demo

```sh
pnpm install
pnpm build
MOCK_ACP_PORT=9876 node bridge/dist/mock/src/mock-server.js
nvim -c "lua vim.cmd('ACPConnect ws://127.0.0.1:9876')"
```

Run `:ACPContactPoints` from Neovim; progress and results appear in quickfix and a diff preview pops up when artifacts contain patches. Cancel with `:ACPCancel`.

## Testing

```sh
pnpm install
pnpm test   # runs TypeScript bridge tests

# Lua smoke test (no external plugins required)
nvim --headless -u tests/minimal_init.lua \
  -c "lua require('tests.lua.runner').run()" \
  -c "qa!"
```

## Security notes

- Tokens stay in-process: Lua passes them via environment, sidecar injects `Authorization` header without logging secrets.
- stdout/stderr logs redact high-volume payloads and backpressure drops oldest events.

## Troubleshooting

- Ensure `bridge/dist/bridge.js` exists; otherwise `:ACPConnect` will report a missing bridge.
- When quickfix stays empty, inspect `:messages` for bridge warnings or run the mock server to validate connectivity.

## 30-second demo script

```sh
pnpm install && pnpm build
MOCK_ACP_PORT=9876 node bridge/dist/mock/src/mock-server.js &
NVIM_APPNAME=acp-demo nvim -u NONE \
  -c "lua require('acp.init').setup({ url = 'ws://127.0.0.1:9876' })" \
  -c "runtime plugin/acp.lua" \
  -c "ACPConnect" \
  -c "ACPContactPoints" \
  -c "qa!"
```
