## 0.1.0-alpha.2

首个公开预览安装包，包含此前的账号、网关、客户端切换和局域网功能。

- ChatGPT 官方浏览器登录、设备码登录与本机账号复用；Kimi / MiniMax 订阅授权和 API Key。
- Responses、Messages、Chat Completions 统一接入，跨协议流式、多轮、工具调用与 thinking 历史。
- 同名模型合并，新对话多账号轮询，后续消息和工具结果固定原通道。
- 本机 Codex / Claude Code 模式切换，局域网独立 Key 和跨平台配置脚本。
- 用量只保留最近 60 个 UTC 日，启动、跨日及读写时自动清理。
- 客户端内检查 Releases、显示下载进度、校验安装包并启动安装。

### 安装与更新

macOS 提供 Apple Silicon / Intel DMG 和 ZIP；Windows 提供 x64 NSIS；Linux 提供 x64 / ARM64 AppImage 和 Debian 包。文件名包含平台和架构，`SHA256SUMS.txt` 提供发布文件校验值。

当前 macOS 安装包未签名、公证，使用 DMG 手动拖入“应用程序”安装或替换。Windows / Linux 安装更新通过对应平台更新器完成。不会静默下载安装，不改写已有客户端登录文件。

Alpha 兼容范围和实测记录见仓库 README 与 docs/validation.md。套餐剩余额度、官方账单以及跨协议托管会话、音视频、服务端工具等能力尚未接入。
