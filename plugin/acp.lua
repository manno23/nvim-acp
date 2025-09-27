local init = require("acp.init")
local client_module = require("acp.client")
local ui = require("acp.ui")
local diagnostics = require("acp.diagnostics")

local client = client_module.instance()
local handlers_attached = false
local subscriptions = {}

local function attach_handlers()
  if handlers_attached then
    return
  end
  client:on("event", function(params)
    local job_id = params.jobId
    if params.event then
      ui.handle_event(job_id, params.event)
    elseif params.result then
      ui.handle_result(job_id, params.result)
    end
  end)
  client:on("fact", function(params)
    ui.handle_fact(params.subscriptionId, params.fact)
  end)
  client:on("disconnect", function()
    ui.clear()
    diagnostics.clear("*")
    vim.notify("ACP bridge disconnected", vim.log.levels.WARN)
  end)
  handlers_attached = true
end

attach_handlers()

local function notify_result(err, result)
  if err then
    vim.notify("ACP error: " .. tostring(err), vim.log.levels.ERROR)
    return
  end
  vim.notify("ACP ok", vim.log.levels.INFO)
end

vim.api.nvim_create_user_command("ACPConnect", function(opts)
  attach_handlers()
  local url = opts.args ~= "" and opts.args or init.config().url
  client:connect(url, function(err)
    if err then
      vim.notify("ACP connect failed: " .. tostring(err), vim.log.levels.ERROR)
    else
      vim.notify("Connected to ACP", vim.log.levels.INFO)
    end
  end)
end, { nargs = "?", complete = "file" })

local function current_context()
  local bufnr = vim.api.nvim_get_current_buf()
  local uri = vim.uri_from_bufnr(bufnr)
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  return {
    action = "buffer_state",
    parameters = {
      uri = uri,
      language = vim.bo[bufnr].filetype,
      content = table.concat(lines, "\n"),
    },
    artifacts = {
      {
        id = string.format("buf:%d", bufnr),
        uri = uri,
        mediaType = "text/plain",
      },
    },
  }
end

local function submit_action(action)
  attach_handlers()
  client:submit({
    action = action,
    parameters = {
      cwd = vim.loop.cwd(),
      file = vim.api.nvim_buf_get_name(0),
    },
    clientContext = current_context().parameters,
  }, notify_result)
end

vim.api.nvim_create_user_command("ACPContactPoints", function()
  submit_action("contact_points")
end, { nargs = 0 })

vim.api.nvim_create_user_command("ACPSkeletonize", function()
  local ctx = current_context()
  client:submit({
    action = "skeletonize",
    parameters = ctx.parameters,
    artifacts = ctx.artifacts,
  }, notify_result)
end, { nargs = 0 })

vim.api.nvim_create_user_command("ACPInferBody", function()
  local ctx = current_context()
  client:submit({
    action = "infer_body",
    parameters = ctx.parameters,
    artifacts = ctx.artifacts,
  }, notify_result)
end, { nargs = 0 })

vim.api.nvim_create_user_command("ACPCancel", function(opts)
  local job_id = opts.args ~= "" and opts.args or client:last_job_id()
  if not job_id then
    vim.notify("No job id to cancel", vim.log.levels.WARN)
    return
  end
  client:cancel(job_id, notify_result)
end, { nargs = "?" })

vim.api.nvim_create_user_command("ACPSubscribeFacts", function(opts)
  local scope = opts.args ~= "" and opts.args or "default"
  client:subscribe_facts({ scope = scope }, {}, function(err, result)
    if err then
      vim.notify("Subscribe failed: " .. tostring(err), vim.log.levels.ERROR)
      return
    end
    local id = result.subscription and result.subscription.id
    if not id then
      vim.notify("ACP subscription missing id", vim.log.levels.ERROR)
      return
    end
    subscriptions[scope] = id
    vim.notify(string.format("Subscribed to facts '%s'", scope), vim.log.levels.INFO)
  end)
end, { nargs = "?" })

vim.api.nvim_create_user_command("ACPUnsubscribeFacts", function(opts)
  local scope = opts.args ~= "" and opts.args or "default"
  local id = subscriptions[scope]
  if not id then
    vim.notify("No subscription for scope " .. scope, vim.log.levels.WARN)
    return
  end
  client:close_facts(id, function(err)
    if err then
      vim.notify("Unsubscribe failed: " .. tostring(err), vim.log.levels.ERROR)
      return
    end
    subscriptions[scope] = nil
    vim.notify(string.format("Unsubscribed from '%s'", scope), vim.log.levels.INFO)
  end)
end, { nargs = "?" })

vim.api.nvim_create_user_command("ACPEventsTelescope", function()
  ui.telescope()
end, { nargs = 0 })
