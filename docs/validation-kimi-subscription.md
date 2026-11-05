# Kimi 订阅登录与 thinking 实测

日期：2026-11-05。账号本人完成中国区官方设备授权后，使用真实 Codex CLI **0.144.1** 的 `app-server --listen stdio://`，通过本机 Model Bridge 调用 `api.kimi.com/coding/v1`。测试使用临时 `CODEX_HOME`、临时工作目录和合成 `bridge_probe` 工具；没有开放任意 Shell，也没有修改当前 Codex / Claude Code 配置或登录文件，测试前后文件 SHA-256 一致。服务商凭据始终留在网关加密凭据库。

| 订阅模型 | 对话轮数 | 工具执行 | 请求 / HTTP 200 | 收到加密 thinking | 历史 thinking 累计回传 |
| --- | ---: | ---: | ---: | ---: | ---: |
| kimi-for-coding | 3 | 3 | 5 / 5 | 5 | 10 |
| kimi-for-coding-highspeed | 3 | 3 | 5 / 5 | 5 | 10 |
| k3.1-pro | 3 | 3 | 6 / 6 | 6 | 15 |

三组均通过多轮标记、工具随机回执、计算校验和 thinking 往返断言，总计 **9 轮、9 次工具执行、16 次 HTTP 200**。累计回传数包含每次请求携带的历史条目，不是独立推理次数。元数据见 [完整报告](validation-kimi-subscription.json)，不含令牌、推理正文或原始签名。测试命令沿用 [验证说明](validation.md) 的真实网关路由配置，执行 `node scripts/validate-codex-providers.mjs --thinking-probe`。

真实 `/models` 返回 6 个模型，均声明 Chat 上游协议；本次真实验证覆盖 **Codex Responses → Kimi Chat**。原生 Messages / Responses 上游的 Kimi 参数规则由模拟协议测试覆盖，不宣称这两个上游协议已经实测。

## 与官方实现对齐

- 模型同步读取 `reasoning.type`、`effort.valid/default`、协议、上下文、工具与图片能力。已存在模型更新能力信息，保留用户名称、价格和对外开关。
- Chat thinking 使用 `type=enabled`、`keep=all` 和服务端声明的 effort。无分级 effort 的高速模型只发送开关；不把界面的 medium 发送为服务商不支持的等级。
- 强制 thinking 模型拒绝关闭请求；不支持 thinking 的模型拒绝开启请求。Messages 使用 adaptive 和 `output_config.effort`；Responses 使用原生 `reasoning.effort`。
- 保存 `/me` 返回的用户 ID，JWT subject 单独用于识别账号变化，避免刷新时把不同格式的 ID 当作换号。Kimi 刷新必须返回新的 refresh token；瞬态错误最多尝试 3 次，invalid_grant 不重试，并发刷新合并。
- 本人授权、模型同步、重启恢复和上述真实推理已通过。真实令牌尚未到期，没有强行触发刷新；刷新身份、重试、取消和缺失字段由回归测试覆盖。

官方依据：[模型能力与协议](https://github.com/MoonshotAI/kimi-code/blob/2b8afafea4238aeb553ab946cf0a1c641f8712ca/packages/oauth/src/managed-kimi-code.ts)、[设备授权与刷新](https://github.com/MoonshotAI/kimi-code/blob/2b8afafea4238aeb553ab946cf0a1c641f8712ca/packages/oauth/src/oauth.ts)、[thinking 请求参数](https://github.com/MoonshotAI/kimi-code/blob/2b8afafea4238aeb553ab946cf0a1c641f8712ca/packages/agent-core-v2/src/human/llm-requester/thinking.ts)。

## 界面与模型暴露

首次登录和重新授权成功后自动关闭授权弹窗，模型同步在后台继续。连接列表显示状态圆点：成功绿、失败红，授权或同步中为等待色；实际调用失败会显示红点，后续成功恢复绿色。

模型默认全部对外提供。在“模型”页取消勾选后，管理列表保留该模型，所有模型目录与新生成的客户端配置只包含启用项；隐藏模型的直接调用返回 404。同模型多账号及重复导入账号的对应入口一起切换。同步已有目录保留开关，新发现模型默认启用。已复制的远程配置是快照，隐藏后服务端仍会拒绝旧入口，重新复制可更新接收端列表。

本地模拟页面验证了首次授权和重新授权自动关窗、同步失败红灯与成功恢复绿灯；真实桌面验证模型开关和目录隐藏、旧入口 404，并恢复测试前的启用状态。
