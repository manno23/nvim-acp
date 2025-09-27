vim.opt.runtimepath:append(vim.fn.getcwd())
require("acp.init").setup({ url = "ws://127.0.0.1:9876" })
vim.cmd("runtime plugin/acp.lua")
