local M = {}

local ns = vim.api.nvim_create_namespace("acp")
local state = {}

local severity_map = {
  error = vim.diagnostic.severity.ERROR,
  warning = vim.diagnostic.severity.WARN,
  info = vim.diagnostic.severity.INFO,
  hint = vim.diagnostic.severity.HINT,
}

local function merge(buffer_state)
  local merged = {}
  for _, items in pairs(buffer_state) do
    vim.list_extend(merged, items)
  end
  return merged
end

function M.namespace()
  return ns
end

function M.handle(job_id, event)
  local diag = event.diagnostic
  if not diag then
    return
  end
  local bufnr = vim.uri_to_bufnr(diag.uri)
  if not vim.api.nvim_buf_is_loaded(bufnr) then
    pcall(vim.fn.bufload, bufnr)
  end
  state[bufnr] = state[bufnr] or {}
  state[bufnr][job_id] = {
    {
      lnum = diag.range.start.line,
      end_lnum = diag.range["end"].line,
      col = diag.range.start.character,
      end_col = diag.range["end"].character,
      severity = severity_map[diag.severity] or vim.diagnostic.severity.INFO,
      message = diag.message,
      source = "acp",
    },
  }
  vim.diagnostic.set(ns, bufnr, merge(state[bufnr]), {})
end

local function reset_buffer(bufnr, buffers)
  local merged = merge(buffers)
  if #merged == 0 then
    vim.diagnostic.reset(ns, bufnr)
  else
    vim.diagnostic.set(ns, bufnr, merged, {})
  end
end

function M.clear(job_id)
  if job_id == "*" then
    for bufnr, buffers in pairs(state) do
      state[bufnr] = nil
      vim.diagnostic.reset(ns, bufnr)
    end
    return
  end

  for bufnr, buffers in pairs(state) do
    if buffers[job_id] then
      buffers[job_id] = nil
      reset_buffer(bufnr, buffers)
    end
  end
end

return M
