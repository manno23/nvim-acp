local cwd = vim.fn.getcwd()
vim.opt.runtimepath:append(cwd)
package.path = table.concat({
  cwd .. "/?.lua",
  cwd .. "/?/init.lua",
  package.path,
}, ";")
require("acp.init").setup({ url = "ws://127.0.0.1:9876" })
vim.cmd("runtime plugin/acp.lua")
