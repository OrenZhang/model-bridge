# MiniMax 订阅 thinking 实测

日期：2026-11-05。真实 Codex CLI **0.144.1**，使用 `app-server --listen stdio://`、临时 `CODEX_HOME`、临时工作目录及合成工具。没有操作当前 Codex 桌面会话，没有写入现有 Codex / Claude Code 的配置或登录文件；原文件 SHA-256 检查一致。

测试链路为 **独立 Codex CLI → 临时新版本网关 → 已登录的本机网关 → `agent.minimax.cn/mavis/api/v1/llm/v1/messages`**。临时适配层将原生 Messages 转交给现有网关，订阅令牌和刷新仍由现有网关处理，没有导出服务商凭据。这允许在不重启现有网关的情况下检验新的订阅参数规则。

| 真实订阅模型 | 对话轮数 | 工具执行 | 请求 / HTTP 200 | 收到加密 thinking | 历史 thinking 回传 |
| --- | ---: | ---: | ---: | ---: | ---: |
| MiniMax-M2.7 | 3 | 3 | 5 / 5 | 3 | 4 |
| MiniMax-M3 | 3 | 3 | 5 / 5 | 3 | 8 |
| MiniMax-M3.1-Flash | 3 | 4 | 6 / 6 | 4 | 7 |

三个模型均通过标记、工具生成的随机回执、多轮计算校验及 encrypted reasoning 往返断言。临时网关在原生 Messages 请求中观测到累计 **19 个 thinking 块，19 个均带原始签名**，与客户端加密 thinking 的累计回传数一致。M3 请求使用 adaptive；M3.1-Flash 请求不带 thinking 字段，推理等级为 `output_config.effort=low`。元数据见 [完整报告](validation-minimax-plan-thinking.json)，不含密钥、原始签名或推理正文。

第一轮工具写入合成标记和随机回执，同时计算 `17*23 + 19*29 = 942`。第二轮通过两次工具读取核对回执，计算 `(942*37+11) % 997 = 967`。第三轮不使用工具，从历史回忆标记与回执并计算 `942+967 = 1909`。测试只允许 `bridge_probe`，没有开放任意 Shell 或真实工作区文件操作。工具次数是实际执行数；thinking 回传是多轮累计历史条目数，不是独立推理次数。

额外的原生 Messages HTTP 探测确认 M2.7 同时返回 `thinking_delta`、`signature_delta` 和 `tool_use`；Responses 探测确认生成加密 reasoning 项。此前只有简短标记/工具任务的测试未收到 thinking；本次加入计算校验以实际覆盖推理传输，保留原有“必须收到并回传 thinking”的严格断言，没有降低门槛或伪造内容。

## 复现

在已更新并授权的网关设置本地客户端密钥环境变量，按照 [常规验证说明](validation.md) 提供网关地址、完整模型路由和 `MODEL_BRIDGE_TEST_ROUTE_METADATA`。可用 `MODEL_BRIDGE_VALIDATION_ROUTES` 选择一个或多个已配置模型；每项为 `{ "provider": "minimax-plan", "route": "连接ID/模型ID" }`。然后执行：

```sh
npm run build
node scripts/validate-codex-providers.mjs --thinking-probe
```

`--thinking-probe` 增加计算校验，仍要求至少三次真实工具执行、完整回执和 thinking 往返。默认测试不会要求推理正文公开展示；加密历史由客户端保留供续接。低复杂度任务可能省略 thinking，不能用单次未返回判定整个订阅通道不支持。

模拟协议检查可执行 `node scripts/validate-codex-providers.mjs --mock-pools --thinking-probe`；它验证原始 thinking/签名和工具回放，但不能替代上述真实服务测试。
