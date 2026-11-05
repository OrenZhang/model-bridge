# 连接模式、对外服务与独立密钥

统一处理顺序为：客户端 Responses / Messages / Chat 请求 → 按原始模型 ID 选择连接并均衡分发 → 应用选中连接的推理模式 → 转为上游协议 → 转回客户端协议。原有多轮、thinking 和工具调用继续固定原连接。

## 连接中的推理模式

在“连接 → 管理 → 推理模式”中，按该连接的模型选择模式。默认“跟随客户端”；“模型默认”去掉客户端的模式选择；明确选择低/中/高等模式后，覆盖客户端参数。配置只作用于该连接，因此同名模型合并后仍保留各个通道的设置。请求中的工具、图片和加密历史不会随模式设置被替换。

选项按模型能力显示：

- GPT：按模型目录支持的等级提供低、中、高、极高等选项；不能假定所有模型都支持关闭或最高等级。
- Kimi：订阅目录决定 low/high/max 或仅开启思考；强制 thinking 的模型不提供关闭，也不把不支持的 medium 偷换成 high。
- MiniMax：M2.7 保留原生思考，M3 支持开启/关闭，M3.1-Flash 提供 low/medium/high/xhigh/max 且不能关闭。
- DeepSeek：增加 API Key 服务预设。当前已识别的 deepseek-flash、deepseek-v4-pro 提供关闭与 low/high/max；不同入口统一转成配置的 Chat 上游 thinking / reasoning_effort。
- 自定义服务按已配置的模型能力提供选项；未声明能力的模型保持原有行为。

三种入口的参数覆盖已由真实本地 HTTP 网关与模拟上游检查，覆盖 GPT、Kimi、MiniMax、DeepSeek。当前没有已授权的 DeepSeek 连接，DeepSeek 不宣称真实服务实测。原有 Kimi/MiniMax 10 个模型的真实矩阵见 [局域网验证](validation-lan-model-matrix.md)。

官方参考：[OpenAI 推理等级](https://developers.openai.com/api/docs/guides/reasoning)、[Kimi 模型能力声明](https://github.com/MoonshotAI/kimi-code/blob/2b8afafea4238aeb553ab946cf0a1c641f8712ca/packages/oauth/src/managed-kimi-code.ts)、[MiniMax 开放平台 thinking](https://platform.minimax.io/docs/api-reference/text-anthropic-api)、[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)。MiniMax 订阅通道继续遵循单独的官方 managed payload 规则。

## 本机切换与对外服务

“客户端”页仅保留 Codex / Claude Code 的统一模型、原始认证切换；启用会备份并修改本机配置，原始认证可恢复。

“对外服务”页集中管理三种接口地址、局域网监听、独立访问密钥及接入配置导出。启用局域网后监听 0.0.0.0；接收端配置使用实际网卡 IP。复制配置或导出脚本不修改本机客户端。

为每台设备或每位使用者创建独立 Key，命名后可复制、改名、停用或重新启用。停用后新的请求立即失去认证，其他 Key 继续使用；已产生的用量记录保留。密钥原文存入系统加密凭据库，普通配置只保存散列。界面状态和配置预览不包含密钥原文。

配置导出必须选择一个启用的独立 Key，支持 Codex、Claude Code 与 macOS / Windows / Linux 执行脚本。对外配置包含选中 Key；本机 Codex/Claude Code 的密钥单独管理。用量按 Key ID 记录，改名不改变归属；用量页可按名称筛选。

## CoSail 设备标识

Kimi 官方身份协议要求调用方声明自己的应用身份。本项目使用 `User-Agent: CoSail/0.1.0`、`X-Msh-Platform: cosail`、`X-Msh-Device-Name: CoSail`，并附带操作系统、架构和持久化的随机设备 ID。授权、刷新、个人资料、模型目录与订阅调用保持同一设备身份。不会借用 Kimi Code CLI 的平台标识。

依据：[官方身份字段实现](https://github.com/MoonshotAI/kimi-code/blob/2b8afafea4238aeb553ab946cf0a1c641f8712ca/packages/oauth/src/identity.ts)。已有服务商设备记录无法由本网关改名，最终展示由服务商决定；新标识随后续授权发送，旧“未知设备”记录可能需要重新授权后才更新。
