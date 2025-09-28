local M = {}

local function plugin_root()
  local source = debug.getinfo(1, "S").source
  if source:sub(1, 1) == "@" then
    source = source:sub(2)
  end
  local dir = vim.fs.dirname(source)
  if not dir then
    return vim.loop.cwd()
  end
  local parent = vim.fs.dirname(dir)
  local grand = parent and vim.fs.dirname(parent)
  if not grand then
    return parent or dir
  end
  return grand
end

local root = plugin_root()

local defaults = {
  bridge_cmd = { "node", vim.fs.joinpath(root, "bridge", "dist", "bridge", "src", "bridge.js") },
  url = vim.env.ACP_WS_URL,
  token = vim.env.ACP_TOKEN,
  connect_timeout_ms = 10000,
  log_level = vim.env.ACP_LOG_LEVEL or "warn",
}

M._config = vim.deepcopy(defaults)

function M.setup(opts)
  M._config = vim.tbl_deep_extend("force", defaults, opts or {})
end

function M.config()
  return M._config
end

function M.healthcheck()
  local cfg = M.config()
  if not vim.loop.fs_stat(cfg.bridge_cmd[2]) then
    return false, "bridge executable missing: " .. cfg.bridge_cmd[2]
  end
  return true
end

function M.root()
  return root
end

return M
