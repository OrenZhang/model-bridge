## 0.1.0-alpha.10

- 新增「对外服务 → 联网搜索」。支持自建 SearXNG 与 Tavily，配置后可测试连接。Tavily API Key 加密存于网关。
- Codex 的 Responses `web_search` 请求由 Model Bridge 执行。网关将搜索结果交给当前模型，返回搜索事件和来源链接。当前轮继续调用客户端工具时可回放搜索结果。
- 已通过真实 Codex 同一对话切换验证。DeepSeek Flash、Kimi K3-256K、MiniMax M3.1 Flash 均发起搜索，返回的来源与 SearXNG 实际结果匹配。
- 已接入的 Codex 可在「本机接入与恢复」更新配置后重启。远程设备可重新导出接入配置。

提供 macOS Apple Silicon / Intel、Windows x64、Linux x64 / ARM64 安装包。校验文件为 SHA256SUMS.txt。
