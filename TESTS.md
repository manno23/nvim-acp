# Test Suite Overview

This project splits automated coverage between the TypeScript sidecar and the Lua plugin to validate the Cap'n Web bridge end to end.

## TypeScript tests (`tests/ts`)
- **`bridge.spec.ts`** exercises the compiled Node sidecar by framing MessagePack traffic over stdio, issuing `connect`, `submit`, and `cancel` RPCs, and asserting that job events and results are streamed back intact. The test harness spins up an in-memory `ws` server stub so capability handles and payload shapes can be inspected without leaving the process.

## Lua integration tests (`tests/lua`)
- **`spec_acp_spec.lua`** delegates to `tests.lua.runner` and can be executed through Plenary/Busted. It boots the packaged Neovim plugin, connects to the mock ACP server, triggers `:ACPContactPoints`, and waits for quickfix entries to confirm streamed job results.
- **`runner.lua`** is a reusable helper that may also be invoked directly with `nvim --headless -u tests/minimal_init.lua -c "lua require('tests.lua.runner').run()" -c qa!`. It ensures the quickfix list is cleaned up, manages the mock server lifecycle, and asserts that the asynchronous pipeline stays responsive.

## Mock server (`mock/src`)
- **`mock-server.ts`** implements a lightweight WebSocket ACP facade used by both test suites. It mints job handles, emits progress events, and feeds deterministic artifacts/results for assertions. The compiled JavaScript lives in `bridge/dist/mock/src/mock-server.js` for environments without `ts-node`.

## Test bootstrap files
- **`tests/minimal_init.lua`** provides a minimal Neovim configuration that adds the plugin to `runtimepath`, seeds connection defaults, and loads the user commands before the Lua tests run.

## Running the suites
1. Install dependencies and build the sidecar: `pnpm install && pnpm build`.
2. TypeScript tests: `pnpm test:ts`.
3. Lua smoke test (requires Neovim ≥ 0.10 on `$PATH`): `nvim --headless -u tests/minimal_init.lua -c "lua require('tests.lua.runner').run()" -c qa!`.
