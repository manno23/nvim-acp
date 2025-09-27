local function wait_for(timeout, predicate)
  local start = vim.loop.hrtime()
  local timeout_ns = timeout * 1e6
  while true do
    if predicate() then
      return true
    end
    if (vim.loop.hrtime() - start) > timeout_ns then
      return false
    end
    vim.loop.sleep(20)
  end
end

describe("nvim-acp integration", function()
  local server

  before_each(function()
    local cmd = { "node", "bridge/dist/mock/src/mock-server.js" }
    server = vim.system(cmd, {
      env = vim.tbl_extend("force", vim.fn.environ(), { MOCK_ACP_PORT = "9876" }),
      text = true,
    })
    -- give server time to boot
    vim.wait(100)
    package.loaded["acp.client"] = nil
    package.loaded["acp.init"] = nil
    package.loaded["acp.ui"] = nil
    package.loaded["acp.diagnostics"] = nil
    package.loaded["acp"] = nil
    vim.cmd("runtime plugin/acp.lua")
  end)

  after_each(function()
    if server then
      server:kill(15)
      server = nil
    end
    vim.fn.setqflist({})
  end)

  it("streams job results into quickfix", function()
    local client = require("acp.client").instance()
    client:connect("ws://127.0.0.1:9876", function() end)
    assert.is_true(wait_for(2000, function()
      return vim.tbl_count(client.pending) == 0
    end), "connect should complete")

    vim.cmd("ACPContactPoints")

    assert.is_true(wait_for(3000, function()
      local items = vim.fn.getqflist()
      for _, item in ipairs(items) do
        if item.text:find("mock complete", 1, true) then
          return true
        end
      end
      return false
    end), "job result should reach quickfix")
  end)
end)
