# 普通客户端与简洁模型名验证

日期：2026-11-05。本机现有 ChatGPT 登录账号，通过实际局域网网卡地址访问正在运行的 Model Bridge。没有修改当前 Codex / Claude Code 客户端配置；HTTP 测试前后文件哈希一致，CLI 使用临时 CODEX_HOME 和合成工具。

## 问题与修复

原客户端通过 Chat Completions 发送 temperature 和 max_tokens。网关虽转为 Responses，但仍携带 temperature / max_output_tokens，ChatGPT 订阅上游返回 HTTP 400；同一路由去掉这些参数则返回 200。网关现按 ChatGPT 订阅的窄版 Responses 规则适配：强制 stream=true、store=false，剔除不支持的采样与输出上限等字段，将 system 消息转为 developer，保留完整历史、工具和推理项。该订阅通道无法保证采样和 token 上限参数生效；API Key 通道不做此项过滤。HTTP previous_response_id / conversation 和后台任务返回明确错误，要求客户端携带完整历史。

依据：[官方 ChatGPT 计划调用限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。官方页面描述 Sign in with ChatGPT 的公共 API；本项目仍使用现有 Codex 订阅端点，修复效果以以下真实端点测试为依据。

对外模型 ID 改为原始名称，例如 `gpt-5.6-sol`、`kimi-for-coding`。兼容账号池使用同一名称，绑定和均衡分发继续使用内部稳定标识。不同通道同名时优先 ChatGPT 官方账号、其次订阅，再 API Key；其他项追加可读后缀，例如 `gpt-5.6-sol~openai-api-key`。名称分配考虑已隐藏模型，隐藏主通道不会把原名称重新分配给另一个计费来源。旧的连接前缀和池 ID 继续兼容，目录与新导出配置只显示新名称。

## 真实验证

| 请求 | 模型 ID | 结果 |
| --- | --- | --- |
| Chat 非流式，system + temperature + max_tokens | gpt-5.6-sol | HTTP 200，预期标记 |
| Responses 非流式，system + temperature + top_p + max_output_tokens | gpt-5.6-sol | HTTP 200，预期标记 |
| Messages 非流式，system + temperature + max_tokens | gpt-5.6-sol | HTTP 200，预期标记 |
| Chat 非流式，旧连接前缀 + 常见参数 | 旧账号路由 | HTTP 200，预期标记 |
| Chat 流式，temperature + max_tokens | gpt-5.6-sol | HTTP 200，完整分片文本和 [DONE] |
| 独立真实 Codex CLI 0.144.1，thinking probe | gpt-5.6-sol | 3 轮、3 次工具执行、6 次 HTTP 200 |

Codex 收到 3 项原生加密 reasoning，累计回传历史 reasoning 8 项，工具结果累计回传 10 项。测试只允许 bridge_probe；不开放任意 Shell 或真实工作区工具。真实模型列表、Codex model/list、导出配置及隐藏模型行为同时由回归测试覆盖；同名不同通道、隐藏后不改投、旧路由兼容与别名/旧池 ID 混用的工具续接均有断言。[去敏元数据](validation-client-compatibility.json) 不包含密钥、账号 ID、提示词、原始 reasoning 或内部网卡地址。
