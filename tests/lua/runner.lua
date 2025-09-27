local M = {}

local function wait_for(timeout, predicate)
  return vim.wait(timeout, predicate, 20)
end

local function clear_quickfix()
  pcall(vim.fn.setqflist, {})
end

function M.run()
  clear_quickfix()
  local env = vim.tbl_extend("force", vim.fn.environ(), { MOCK_ACP_PORT = "9876" })
  local server = vim.system({ "node", "bridge/dist/mock/src/mock-server.js" }, {
    env = env,
    text = true,
  })

  -- give the server time to boot
  vim.wait(200, function()
    return false
  end, 20)

  local client = require("acp.client").instance()
  local connected = false
  client:connect("ws://127.0.0.1:9876", function(err)
    assert(not err, err)
    connected = true
  end)
  assert(wait_for(2000, function()
    return connected
  end), "connect should complete")

  vim.cmd("ACPContactPoints")
  local ok = wait_for(3000, function()
    local items = vim.fn.getqflist()
    for _, item in ipairs(items) do
      if item.text and item.text:find("mock complete", 1, true) then
        return true
      end
    end
    return false
  end)
  assert(ok, "job result should reach quickfix")

  if server and server.kill then
    pcall(function()
      server:kill("term")
    end)
  end
  clear_quickfix()
  print("[nvim-acp] lua smoke test ok")
end

return M
