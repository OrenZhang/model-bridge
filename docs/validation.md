# 验证记录与复现

验证日期：2026-11-04。客户端版本固定为项目依赖的 Codex **0.144.1**。运行环境要求 Node.js **>= 22.19.0**；下面命令均从仓库根目录执行。

## 当前结果

| 验证范围 | 结果 | 能证明的内容 |
| --- | --- | --- |
| 真实 Codex + 模拟 Kimi Chat 上游 | 通过 | Responses ↔ Chat 的三轮会话、工具执行及 thinking 历史回传 |
| 真实 Codex + 模拟 MiniMax Messages 上游 | 通过 | Responses ↔ Messages 的三轮会话、工具执行及签名 thinking 历史回传 |
| 真实 Codex + 真实 Kimi `kimi-for-coding` | 通过 | 最终构建经 `api.kimi.com/coding/v1/chat/completions` 完成三轮及工具调用，含最新 effort 映射 |
| 真实 Codex + 真实 MiniMax `MiniMax-M2.7` | 通过 | 最终构建经 `api.minimaxi.com/anthropic/v1/messages` 完成三轮、工具调用和 thinking 历史续接 |
| 真实 Codex 读取便携模型目录 | 通过 | 不同工作目录下读取相对 catalog 路径并列出所有服务商模型，无需登录 |

最终构建的两家真实服务均为 3 轮、3 次工具执行（写入一次、读取两次）、5 次 HTTP 200。Kimi 收到 5 个加密 reasoning，累计回传 10 个；MiniMax 收到 1 个加密 thinking，在后续 3 个请求中回传。两者累计工具结果回传均为 8 个。Kimi 用量 input 27,443、output 522，其中 reasoning 210；MiniMax input 29,826、output 217，未单独报告 reasoning token。详细元数据见 [实测报告](validation-live.json)。

这些是本次测试数值，不代表模型固定开销。重复回传包含多轮累计历史，不能把 8 次工具结果回传解释成 8 次工具执行。Kimi 使用已配置账号的正常刷新流程，MiniMax 复用现有同服务凭据；测试使用隔离网关，没有重写用户 Codex、Claude Code 或 CC Switch 设置。

此次验证在 macOS 上执行。脚本及便携配置包含 Windows 路径处理，但不据此声称已完成 Windows 安装包或另一台局域网电脑的实机验收。

## 真实 Codex + 模拟上游

先安装依赖、构建，再运行独立验证脚本：

```sh
npm ci
npm run build
node scripts/validate-codex-providers.mjs --mock
```

若需要落盘报告，可通过环境变量指定路径（不设置时仅输出各服务的统计）：

```sh
MODEL_BRIDGE_VALIDATION_REPORT=work/codex-mock-validation.json node scripts/validate-codex-providers.mjs --mock
```

PowerShell 的环境变量写法：

```powershell
$env:MODEL_BRIDGE_VALIDATION_REPORT = 'work/codex-mock-validation.json'
node scripts/validate-codex-providers.mjs --mock
```

脚本使用真实 Codex `app-server --listen stdio://`、真实网关代码及两个确定性的本地模拟上游。模拟 Chat 接口提供 `reasoning_content`，模拟 Messages 接口提供 thinking 与原生签名。它们的服务商和模型名称是测试标签，不会请求 Kimi 或 MiniMax 的真实服务。

每个服务商执行同一个三轮场景：

1. 记住随机 marker，调用 `bridge_probe` 写入临时 `probe.json`；receipt 由工具生成，要求回答准确返回 marker 和 receipt。
2. 调用两次读取工具，分别读取 slot a / b，校验两次 receipt 一致。模拟上游在同一次响应中发出两个并行工具调用，验证工具 ID、参数和结果映射。
3. 不再调用工具，从已有对话回忆同一 marker 和 receipt。

2026-11-04 模拟报告中两个服务商均为 3 轮、3 次工具执行、5 次 HTTP 200、5 次收到加密 reasoning、10 次回传加密 reasoning、8 次回传工具结果；上游各完成 4 次原始 thinking 历史检查。并行工具测试验证同一响应中的多个调用及正确续接，不测量工具执行的墙钟并发程度。

脚本为每个服务创建独立临时 `CODEX_HOME` 和 fixture 工作目录，使用 ephemeral 会话、read-only sandbox，仅处理 `bridge_probe` 动态工具；工具只能写入/读取脚本固定的临时文件，不能接受任意路径或命令。验证结束删除临时目录。它不会修改用户的 `~/.codex/config.toml`、`auth.json` 或登录状态。

Codex 子进程移除继承的 OpenAI 认证和代理环境变量，连接本地观察转发器；真正的上游网络仍遵循网关配置。验证使用 `web_search = "disabled"`，因为 Codex 0.144.1 即使模型目录标记不支持搜索，也可能默认发送 hosted `web_search`。这个服务商工具不能直接转成普通 Chat / Messages 工具调用。

## Thinking 能力矩阵

六个方向由 [thinking.test.ts](../tests/thinking.test.ts) 通过上游 JSON → 统一数据 → 客户端格式 → 下一轮上游请求验证。下表箭头从**上游响应协议**开始，表示返回给客户端后再回传原上游，不代表把某个提供商的原生签名移植给另一个提供商。

| 往返方向 | 保留并验证的 reasoning | 工具续接 |
| --- | --- | --- |
| Responses → Messages → Responses | 原生 reasoning ID、summary、encrypted_content 原样恢复 | 两个调用与对应结果 |
| Responses → Chat → Responses | 原生 reasoning ID、summary、encrypted_content 原样恢复 | 两个调用与对应结果 |
| Messages → Responses → Messages | thinking、完整签名、redacted_thinking 原样恢复 | 两个结果归入同一用户消息 |
| Messages → Chat → Messages | thinking、完整签名、redacted_thinking 原样恢复 | 两个结果归入同一用户消息 |
| Chat → Responses → Chat | reasoning_content、reasoning_details 原样恢复 | tool_calls 与结果 ID 一致 |
| Chat → Messages → Chat | reasoning_content、reasoning_details 原样恢复 | tool_calls 与结果 ID 一致 |

流式测试另行覆盖 Messages 的分片签名、隐藏 reasoning 和有序 Responses 事件；Chat reasoning 流入 Codex 后的完整回放；Responses 最终加密状态优先于早期摘要片段；Chat 迟到的 reasoning 元数据在 Messages block 关闭前封装。六方向矩阵本身是 codec 往返测试，不等于六种真实服务组合均经过实机调用。

Chat → Messages 为保留流末尾才返回的 reasoning 元数据，会等完整上游响应后输出内容块；其余已验证路径按完成的块或增量输出。

[gateway-thinking.test.ts](../tests/gateway-thinking.test.ts) 进一步经过真实 HTTP 网关验证：Messages 上游 SSE / JSON fallback × Responses 客户端流式 / 非流式，共四种组合；均包含签名 thinking、redacted thinking、并行工具和下一轮回放。另验证修改密文、更换客户端、更换模型路由时在转发前返回 HTTP 400，避免错误地使用其他会话或路由的 opaque state。Codec 测试还覆盖跨协议拒绝、大小上限和不伪造外来原生签名。

复现这些自动化断言：

```sh
npm test -- tests/thinking.test.ts tests/gateway-thinking.test.ts
```

## 便携配置与原始认证恢复

Codex 便携包包含 `config.toml`、`codex-models.json` 和 `README.txt`。接收端将配置字段合并到自己的 Codex 配置，将模型目录放在配置旁；`model_catalog_json = "codex-models.json"` 无需携带发送者电脑的绝对路径。默认目录为 macOS `~/.codex`、Windows `%USERPROFILE%\.codex`；设置了 `CODEX_HOME` 时使用该目录。已有同名字段和表应替换合并，不能反复追加。

[portable-codex.test.ts](../tests/portable-codex.test.ts) 将生成的文件放进包含空格的隔离 `CODEX_HOME`，从另一个工作目录启动真实 Codex，调用 `model/list` 并确认 Kimi、MiniMax 两个模型均存在。这验证 Codex 0.144.1 相对于配置目录解析 catalog 路径；此测试不发起推理请求，也不证明示例 LAN IP 的连通性。

[configuration.test.ts](../tests/configuration.test.ts) 验证便携导出不读取/覆盖本地原始配置，不携带上游密钥、原始登录或发送端绝对路径；本地启用与导出均写入 `web_search = "disabled"`。恢复原始模式覆盖原先 `live`、`cached`、未设置三种搜索配置，并在重复启用之后仍保留用户后来修改的无关设置。

局域网客户端需要网关机器的实际 IP，例如 `http://192.168.31.21:18765/v1`。`0.0.0.0` 仅用于网关监听，不能写成客户端目的地址。导出时只允许选择当前本机地址或已启用的局域网地址；过期地址与通配监听地址会被拒绝。本机“启用”仍写入 loopback；选择局域网地址复制/导出不会改变本机 Codex 的接入地址。

```sh
npm test -- tests/configuration.test.ts tests/portable-codex.test.ts
```

## 真实 Kimi / MiniMax 复现

先在运行中的网关配置有效的服务商连接，并确认可获取模型。脚本只接收**网关访问密钥**，服务商 API Key 保留在网关自己的凭据存储中。默认选取 `/v1/models` 中 `owned_by` 为 `kimi` / `minimax` 的第一个模型，也可指定完整路由 ID。

| 环境变量 | 用途 |
| --- | --- |
| `MODEL_BRIDGE_TEST_GATEWAY_URL` | 运行中的网关根地址，不含 `/v1`，例如 `http://127.0.0.1:18765` |
| `MODEL_BRIDGE_TEST_GATEWAY_KEY` | 网关客户端访问密钥；使用下方无回显输入，不能写入命令参数或报告 |
| `MODEL_BRIDGE_KIMI_MODEL_ROUTE` | 可选，指定 Kimi 完整路由 ID，与模型列表一致 |
| `MODEL_BRIDGE_MINIMAX_MODEL_ROUTE` | 可选，指定 MiniMax 完整路由 ID，与模型列表一致 |
| `MODEL_BRIDGE_TEST_ROUTE_METADATA` | 必填 JSON；键为选中的路由 ID，值包含实际 `upstreamHost`、`upstreamModel`、`upstreamProtocol` |
| `MODEL_BRIDGE_VALIDATION_REPORT` | 可选，输出 JSON 统计报告的路径 |

`upstreamProtocol` 必须为 `chat` 或 `messages`，以证明本次实际走了跨协议转换。元数据必须从当前连接配置核对；脚本不会自动从桌面端取得该信息。以下以路由 `kimi/kimi-for-coding` 为例，使用前替换为自己的完整路由并同步修改 JSON 的键。若同时验证 MiniMax，在 JSON 中添加它的路由及实际上游信息。

macOS / Linux 的 Bash 示例，不在命令行或历史中写入密钥值：

```bash
export MODEL_BRIDGE_TEST_GATEWAY_URL='http://127.0.0.1:18765'
export MODEL_BRIDGE_KIMI_MODEL_ROUTE='kimi/kimi-for-coding'
export MODEL_BRIDGE_TEST_ROUTE_METADATA='{"kimi/kimi-for-coding":{"upstreamHost":"api.kimi.com","upstreamModel":"kimi-for-coding","upstreamProtocol":"chat"}}'
export MODEL_BRIDGE_VALIDATION_REPORT='work/codex-live-validation.json'
read -r -s -p 'Gateway access key: ' MODEL_BRIDGE_TEST_GATEWAY_KEY
export MODEL_BRIDGE_TEST_GATEWAY_KEY
node scripts/validate-codex-providers.mjs
unset MODEL_BRIDGE_TEST_GATEWAY_KEY
```

Windows PowerShell 示例：

```powershell
$env:MODEL_BRIDGE_TEST_GATEWAY_URL = 'http://127.0.0.1:18765'
$env:MODEL_BRIDGE_KIMI_MODEL_ROUTE = 'kimi/kimi-for-coding'
$env:MODEL_BRIDGE_TEST_ROUTE_METADATA = '{"kimi/kimi-for-coding":{"upstreamHost":"api.kimi.com","upstreamModel":"kimi-for-coding","upstreamProtocol":"chat"}}'
$env:MODEL_BRIDGE_VALIDATION_REPORT = 'work/codex-live-validation.json'
$gatewaySecret = Read-Host 'Gateway access key' -AsSecureString
$gatewaySecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($gatewaySecret)
try {
    $env:MODEL_BRIDGE_TEST_GATEWAY_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($gatewaySecretPointer)
    node scripts/validate-codex-providers.mjs
} finally {
    Remove-Item Env:MODEL_BRIDGE_TEST_GATEWAY_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($gatewaySecretPointer)
    $gatewaySecret.Dispose()
}
```

运行真实服务会消耗对应服务商额度。脚本每条路由最多转发 12 个 Responses 请求，每轮等待上限 120 秒；用量、请求状态、工具执行和 reasoning 回放次数写入报告，密钥不写入报告。

脚本当前始终检查 Kimi、MiniMax 两项，没有单服务 `--provider` 参数。只配置 Kimi 时，Kimi 可以为 `passed`，MiniMax 会为 `blocked`，总退出码仍为 1；必须读取各项 `status` 判断具体结果。仅两项都通过才返回退出码 0。模拟验证报告带 `mockUpstream: true` 和 `validationKind: real-codex-simulated-upstream`；真实验证报告带 `mockUpstream: false` 和 `real-codex-live-gateway`，两种结果不得混用。

## 2026-11-05：登录方式、紧凑界面与模型池

- 官方 Codex helper 0.144.1 的真实浏览器授权启动返回 `auth.openai.com`，无设备码；设备登录启动返回官方 URL 与设备码。均在隔离目录取消，不改写用户现有 Codex 登录，不保存测试账号连接。完整用户授权没有在这次自动验证中代替用户完成。
- `device-login.test.ts` 验证两种 RPC、允许的官方 URL、登录完成后验证账号、独立目录及取消隔离。`login-runtime.test.ts` 验证浏览器流程串行，设备码流程独立。
- `model-pool.test.ts` 验证 20 个并发新会话严格交替、归属续接、重启恢复、不落盘原始提示词/会话 ID、账号身份/API Key 改变时拒绝、限流冷却、客户端隔离及 thinking 原账号恢复。`pool-gateway.test.ts` 通过真实 HTTP 验证 a → b → a 的工具回传与实际账号用量。
- `node scripts/validate-codex-providers.mjs --mock-pools` 使用真实 Codex 和真实网关，为 Kimi Chat、MiniMax Messages 各配置两个模拟账号，客户端只看到一个模型池；两家各三轮、三次工具、五次成功请求，thinking 历史完整续接。这项检查纳入 Windows/macOS CI。它不表示调用了两家真实服务，本次没有重复消耗线上模型额度。
- 使用实际构建的界面验证添加账号的三种入口、设备码展示、复用入口、模型去重、账号详情及配置复制；界面测试数据为本地模拟，桌面空状态另行检查。

`runtime.test.ts` 还验证更换 API Key 时配置写入失败，旧引用与旧密钥保持可用。
