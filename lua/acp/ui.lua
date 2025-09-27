local diagnostics = require("acp.diagnostics")

local M = {}

local quickfix_items = {}
local subscription_windows = {}

local severity_type = {
  error = "E",
  warning = "W",
  info = "I",
  hint = "N",
}

local function add_quickfix_item(text, severity)
  table.insert(quickfix_items, {
    text = text,
    type = severity_type[severity or "info"] or "I",
  })
  vim.fn.setqflist({}, "r", {
    title = "ACP",
    items = quickfix_items,
  })
end

local function open_diff_window(lines)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.api.nvim_buf_set_option(buf, "filetype", "diff")
  local width = math.floor(vim.o.columns * 0.6)
  local height = math.floor(vim.o.lines * 0.6)
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    style = "minimal",
    border = "rounded",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
  })
  vim.api.nvim_win_set_option(win, "number", false)
  return buf
end

local function render_artifacts(job_id, result)
  if not result.artifacts then
    return
  end
  for _, artifact in ipairs(result.artifacts) do
    if artifact.mediaType == "text/x-diff" or artifact.uri:find("skeleton", 1, true) then
      local path = vim.uri_to_fname(artifact.uri)
      local lines = {}
      local fd = io.open(path, "r")
      if fd then
        for line in fd:lines() do
          table.insert(lines, line)
        end
        fd:close()
        open_diff_window(lines)
        add_quickfix_item(string.format("job %s diff displayed", job_id), "info")
      end
    end
  end
end

function M.handle_event(job_id, event)
  if event.message then
    local severity
    if event.kind == "diagnostic" and event.diagnostic then
      severity = event.diagnostic.severity
    end
    add_quickfix_item(string.format("[%s] %s", job_id, event.message), severity)
  elseif event.kind == "progress" and event.progress then
    local pct
    if event.progress.total and event.progress.total > 0 then
      pct = math.floor((event.progress.current / event.progress.total) * 100)
    else
      pct = event.progress.current
    end
    add_quickfix_item(string.format("[%s] progress %s", job_id, pct), "info")
  end
  diagnostics.handle(job_id, event)
end

function M.handle_result(job_id, result)
  add_quickfix_item(string.format("[%s] %s", job_id, result.message or result.status), result.status == "failure" and "error" or "info")
  diagnostics.clear(job_id)
  render_artifacts(job_id, result)
end

function M.handle_fact(subscription_id, fact)
  local lines = vim.split(vim.inspect(fact), "\n")
  local buf = subscription_windows[subscription_id]
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_option(buf, "bufhidden", "wipe")
    vim.api.nvim_buf_set_option(buf, "filetype", "lua")
    subscription_windows[subscription_id] = buf
  end
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
end

function M.clear()
  quickfix_items = {}
  vim.fn.setqflist({}, "r", { title = "ACP", items = quickfix_items })
end

function M.telescope()
  local ok, pickers = pcall(require, "telescope.pickers")
  if not ok then
    vim.notify("Telescope not available", vim.log.levels.WARN)
    return
  end
  local finders = require("telescope.finders")
  local conf = require("telescope.config").values
  pickers.new({}, {
    prompt_title = "ACP Events",
    finder = finders.new_table({
      results = quickfix_items,
      entry_maker = function(entry)
        return {
          value = entry,
          display = entry.text,
          ordinal = entry.text,
        }
      end,
    }),
    sorter = conf.generic_sorter({}),
  }):find()
end

return M
