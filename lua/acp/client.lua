local uv = vim.loop
local json = vim.json
local config = require("acp.init").config

local Client = {}
Client.__index = Client

local function schedule(fn)
  return vim.schedule_wrap(fn)
end

local function start_timer(timeout, on_timeout)
  if timeout <= 0 then
    return nil
  end
  local timer = uv.new_timer()
  timer:start(timeout, 0, function()
    timer:stop()
    timer:close()
    schedule(on_timeout)()
  end)
  return timer
end

function Client.new()
  local self = setmetatable({
    next_id = 0,
    pending = {},
    listeners = {},
    buffer = "",
    proc = nil,
    stdin = nil,
    jobs = {},
    last_job = nil,
  }, Client)
  return self
end

function Client:on(method, handler)
  self.listeners[method] = self.listeners[method] or {}
  table.insert(self.listeners[method], handler)
  return function()
    for i, fn in ipairs(self.listeners[method]) do
      if fn == handler then
        table.remove(self.listeners[method], i)
        break
      end
    end
  end
end

function Client:emit(method, payload)
  local handlers = self.listeners[method]
  if not handlers then
    return
  end
  for _, handler in ipairs(vim.deepcopy(handlers)) do
    schedule(handler)(payload)
  end
end

function Client:ensure_started()
  if self.proc then
    return true
  end
  local cfg = config()
  local env = vim.deepcopy(vim.fn.environ())
  if cfg.url then
    env.ACP_WS_URL = cfg.url
  end
  if cfg.token then
    env.ACP_TOKEN = cfg.token
  end
  local cmd = cfg.bridge_cmd
  self.proc = vim.system(cmd, {
    stdin = true,
    text = true,
    stdout = function(_, data)
      if data then
        self:_handle_stdout(data)
      end
    end,
    stderr = function(_, data)
      if data then
        vim.notify_once("acp bridge: " .. data, vim.log.levels.WARN)
      end
    end,
    env = env,
  }, function()
    self.proc = nil
    self.stdin = nil
    self:emit("disconnect", {})
  end)
  self.stdin = self.proc.stdin
  return true
end

function Client:_handle_stdout(chunk)
  self.buffer = self.buffer .. chunk
  while true do
    local nl = self.buffer:find("\n", 1, true)
    if not nl then
      break
    end
    local line = self.buffer:sub(1, nl - 1)
    self.buffer = self.buffer:sub(nl + 1)
    if line ~= "" then
      local ok, message = pcall(json.decode, line)
      if ok then
        self:_handle_message(message)
      end
    end
  end
end

function Client:_handle_message(message)
  if message.id ~= nil then
    local pending = self.pending[message.id]
    if not pending then
      return
    end
    self.pending[message.id] = nil
    if pending.timer then
      pending.timer:stop()
      pending.timer:close()
    end
    if message.error then
      schedule(pending.callback)(message.error.message, nil)
    else
      schedule(pending.callback)(nil, message.result)
    end
    return
  end

  if message.method then
    if message.method == "event" then
      local params = message.params or {}
      if params.jobId then
        self.jobs[params.jobId] = self.jobs[params.jobId] or {}
        if params.result then
          self.jobs[params.jobId].result = params.result
        else
          self.jobs[params.jobId].last_event = params.event
        end
        self.last_job = params.jobId
      end
    end
    self:emit(message.method, message.params)
  end
end

function Client:_next_id()
  self.next_id = self.next_id + 1
  return self.next_id
end

function Client:_write(obj)
  if not self.stdin then
    error("bridge process unavailable")
  end
  local encoded = json.encode(obj) .. "\n"
  self.stdin:write(encoded)
end

function Client:request(method, params, callback, opts)
  opts = opts or {}
  self:ensure_started()
  callback = callback or function(err)
    if err then
      vim.notify("ACP: " .. tostring(err), vim.log.levels.ERROR)
    end
  end
  local id = self:_next_id()
  local timeout = opts.timeout or config().connect_timeout_ms or 10000
  self.pending[id] = {
    callback = callback,
    timer = start_timer(timeout, function()
      if self.pending[id] then
        local pending = self.pending[id]
        self.pending[id] = nil
        schedule(pending.callback)("timeout", nil)
      end
    end),
  }
  self:_write({ id = id, method = method, params = params })
end

function Client:connect(url, cb)
  self:request("connect", { url = url }, cb)
end

function Client:submit(request, cb)
    self:request("submit", { request = request }, function(err, result)
    if not err and result and result.job and result.job.id then
      self.last_job = result.job.id
    end
    cb(err, result)
  end)
end

function Client:cancel(job_id, cb)
  self:request("cancel", { jobId = job_id }, cb)
end

function Client:subscribe_facts(meta, filters, cb)
  self:request("subscribeFacts", { meta = meta, filters = filters }, cb)
end

function Client:close_facts(subscription_id, cb)
  self:request("closeFacts", { subscriptionId = subscription_id }, cb)
end

local default_client

local function instance()
  if not default_client then
    default_client = Client.new()
  end
  return default_client
end

function Client:last_job_id()
  return self.last_job
end

return {
  Client = Client,
  instance = instance,
}
