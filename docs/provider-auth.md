# 订阅认证与 API Key

Kimi 和 MiniMax 在“添加连接”中提供“登录新账号 / API Key”。每个连接独立保存凭据，可选择中国区或国际区。授权请求、令牌刷新、模型目录和模型调用都使用该连接的网络设置。官方授权页面由用户在浏览器确认。

| 连接 | 账号授权 | 模型通道 |
| --- | --- | --- |
| ChatGPT | Codex 官方 helper，浏览器或设备码 | ChatGPT Codex Responses |
| Kimi Code 订阅 | 官方设备授权，自动刷新 | 同区域 Kimi Coding API；遵循模型目录声明的协议 |
| MiniMax Code Token Plan | 官方设备授权、PKCE S256，自动刷新 | 同区域 agent-backend 的 Messages 通道 |
| MiniMax 开放平台 / Coding Plan | API Key | 用户配置的开放平台接口，例如 Anthropic 兼容接口 |

MiniMax Code 的 OAuth audience 为 `agent-backend`，scope 为 `agent.default`。它的账号令牌不能用于 `api.minimax.*` 开放平台。订阅账号连接限定官方区域模型地址，API Key 连接单独配置，池化不会混合这两种计费来源。

ACP 是 Agent 会话协议，不等于模型认证协议。当前实现直接复用服务商公开的 OAuth 与模型 HTTP 协议，向 Codex 提供统一模型接口；没有在 Codex 背后启动另一个 ACP Agent 执行工具。工具仍由请求客户端执行。

凭据只保存在系统加密凭据库。界面状态不含 access/refresh/device token；移除连接清除本地保存的订阅令牌。授权轮询支持 pending、slow_down、拒绝、超时与取消；并发调用共享一次刷新。区域、账号和连接 ID 共同隔离凭据。已有对话继续遵循原账号绑定。

Kimi 通过官方 `/models` 读取协议、工具支持、图片输入和上下文信息。MiniMax Code 订阅直接加载官方 first-run 目录，在界面标记“权限以套餐为准”；它的模型列表路径实测返回 503，不用于判断登录是否成功。MiniMax API Key 连接仍优先尝试 `/models`，仅官方地址返回 404/405 时回退预置目录，401/403 保留错误。内置模型 ID 不代表账号已获得调用权限。

## 验证范围

- 2026-11-05：Kimi 中国区 `/api/oauth/device_authorization` 和 MiniMax 中国区 `/oauth2/device/code` 均返回 HTTP 200 和可用的官方授权页。测试立即取消，没有替用户完成登录，没有保存账号凭据。
- MiniMax 授权完成后保持登录状态，重启从凭据库恢复，不重复授权或轮换对话身份；回归测试覆盖授权、模型加载和重启全过程。
- 自动测试覆盖两种 MiniMax 设备响应、PKCE、pending/slow_down、取消、错误 audience、独立账号与区域、令牌轮换和并发刷新。
- 模拟订阅凭据经过真实本地 HTTP 网关验证模型发现、区域地址、Bearer 注入和跨协议 Responses 输出；Kimi Messages 使用 beta 路径和 adaptive thinking。
- 本机现有 ChatGPT 账号和 OpenAI API Key 连接分别通过真实 Codex 0.144.1 的 3 轮对话、3 次工具调用；原生加密推理和工具结果均继续回传。此结果与订阅通道测试分开记录。
- Kimi/MiniMax API Key 的真实跨协议多轮、thinking、工具调用结果见 [原验证记录](validation.md)。Kimi 订阅完整授权仍待账号本人验证；MiniMax 账号本人已完成授权，使用原有凭据恢复连接，MiniMax-M2.7 实际 Responses 调用已返回 HTTP 200、完整响应和预期文本。

## 官方协议依据

独立实现线级协议，以下固定版本作为核对依据：

- [Kimi OAuth 设备授权与刷新](https://github.com/MoonshotAI/kimi-code/blob/2a6d1cf570d15174d6d5add04eaa8d9d6d45348b/packages/oauth/src/oauth.ts)、[Kimi 模型目录和协议](https://github.com/MoonshotAI/kimi-code/blob/2a6d1cf570d15174d6d5add04eaa8d9d6d45348b/packages/oauth/src/managed-kimi-code.ts)。
- [MiniMax OAuth PKCE 与两种设备响应](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/oauth-core/src/oauth-client.ts)、[OAuth audience 与 scope](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/oauth-core/src/contracts.ts)。
- [MiniMax 官方区域模型地址](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/config/src/config.ts)、[官方 first-run 目录](https://github.com/MiniMax-AI/minimax-code/blob/3c21163c85a9684030cb147bfef48c6284fa3c46/packages/config/src/minimax-model-catalog.ts)。
