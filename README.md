# Model Bridge

一个在本机运行、可选向局域网提供服务的模型入口，把 ChatGPT、Kimi、MiniMax 和兼容服务接入 Codex、Claude Code 与其他 Agent。

**当前版本：`0.1.0-alpha.1`，开发预览。** 已有可运行桌面界面和网关；真实订阅账号的完整联调与 Windows 实机验收尚未完成。兼容范围见下表，不能将接口存在等同于所有模型功能均可用。

## 使用方式

```text
Codex 桌面端 / CLI ─ Responses ─┐
Claude Code ──────── Messages ──┼─ 127.0.0.1:18765 ─ 模型目录与协议适配 ─ 服务商账号
其他 Agent ─ Chat Completions ──┘                                      └ 可选独立代理
```

添加连接或复用本机 Codex 账号 → 登录或填写 API Key → 自动获取模型 → 选择客户端并启用统一模型 → 在客户端选择账号和模型。获取失败时保留已有目录，并提供重新获取和手工填写。

“客户端模式”按 Codex、Claude Code 分页，每个客户端只提供两种模式：

- **统一模型**：客户端连接本地网关，使用所有已接入服务商的模型。服务商认证由网关管理，Codex 使用 `requires_openai_auth = false`，不再要求客户端额外登录 OpenAI；网关仍验证本地访问密钥，上游仍使用已授权凭据。
- **原始认证**：恢复接入前的客户端连接和认证设置，继续使用原账号。模式切换不改写原有登录文件；保留用户后来修改的不相关设置。

服务商添加、账号登录和网络设置集中在“账号与连接”，模型集中在“模型目录”。启用统一模型会自动汇总全部模型目录，无需再选定某个服务商。首次默认模型从可用模型中选取，之后在客户端选择模型；已打开的客户端可能需要重启。其他 Agent 使用总览中的统一接口地址和访问密钥接入。

所有连接始终经过同一网关。模型 ID 为 `连接ID/模型ID`，同名模型、多账号不会互相覆盖。请求明确指定模型，未知模型返回错误；切换不会把正在进行的请求转到另一个账号。

网络设置位于每个连接的可选区域。可导入自己的 Clash / Mihomo YAML 订阅或本地配置，选择节点后由官方 mihomo 内核按需运行；只处理绑定此订阅的模型连接，不设置系统代理、TUN 或系统 DNS。也保留默认网络、直连和手动 HTTP / HTTPS / SOCKS5 代理。

## 已实现与边界

| 能力 | Alpha 状态 |
| --- | --- |
| Windows / macOS 桌面界面 | Electron 实现，macOS 已启动检查；跨平台 CI 验证编译和测试，Windows 实机交互待验收 |
| ChatGPT 设备码登录 | 已接入随应用分发的官方 Codex helper、独立账号目录、取消与刷新；真实账号登录及推理待验证 |
| Kimi / MiniMax / Anthropic / 自定义服务 | API Key 与手工模型配置；模型发现取决于服务商是否提供列表接口 |
| Responses / Messages / Chat Completions | 同协议透传，跨协议文本和 JSON 工具调用转换；流式与非流式调用、取消、错误处理 |
| Codex 模型目录 | 生成专用目录文件和配置；已用真实 Codex `0.144.1` 的 `model/list` 验证多个服务商同时可见 |
| 已有 Codex 账号 | 检测默认目录及 `CODEX_HOME`，识别文件和直接系统 keyring 登录；复用时保存独立副本，账号凭据不返回界面 |
| Claude Code 模式 | 统一模型 / 原始认证切换、备份与恢复；默认模型可在 Claude Code 使用完整网关模型 ID 切换，未验证其所有版本的模型选择器行为 |
| 账号网络 | HTTP / HTTPS / SOCKS5、系统网络、直连；授权轮询、模型发现、推理采用同一连接设置；浏览器授权页采用浏览器自身网络 |
| 代理订阅 | Mihomo `v1.19.32`、HTTPS 订阅/本地 YAML、节点选择、更新订阅、加密保存、官方压缩包 SHA-256 校验；已运行真实内核验证指定节点与模型发现 |
| 局域网 | 默认 `127.0.0.1`；可切换监听 `0.0.0.0`，展示网卡 IP，所有模型接口仍要求访问密钥 |
| 用量统计 | 请求数、状态、输入/输出/缓存 Token、延迟、首字节时间、配置价格后的估算费用；按客户端/服务商/账号/模型筛选、CSV 导出 |
| 凭据与配置 | API Key、代理密码、本地访问密钥由系统密钥服务加密；客户端配置变更前备份并检测冲突 |

### 当前兼容限制

- **跨协议的 thinking / reasoning 状态、加密推理项暂不支持**，会明确报错。MiniMax 等需要完整思考历史的模型，目前应使用原生 Messages 客户端；不能宣称它们已能在 Codex 中完成多轮工具任务。后续优先补齐这一项。
- 跨协议暂不支持 `previous_response_id`、托管会话、结构化输出、音视频、服务端工具、强制指定工具等高级能力。图片只支持已声明的常见图片块。原生协议优先保留服务商字段，但仍受服务商兼容范围限制。
- ChatGPT 设备授权使用 Codex 的登录能力与账号凭据，**不等于 OpenAI Platform API Key**。当前 ChatGPT 请求通道属于需单独验证的适配器，不能承诺所有订阅、组织策略或未来版本均兼容。
- Kimi / MiniMax 暂不提供各自的订阅 OAuth 登录。套餐剩余额度/官方账单未接入，本地统计只覆盖经过本网关的请求。
- 未返回的用量记为未知，不从文本猜测 Token 数；费用为配置价格下的估算，不是订阅账单。线上协议必填用量字段可能使用零占位，本机统计保留未知状态。
- 未提供签名/公证的正式安装包。当前推荐开发者从源码运行；不要把 CI 构建成功当作 Windows 实机验收。
- 本机账号复用只读取已知 Codex 登录格式；新版 secrets keyring 格式可能需要设备码重新授权。复制登录后与原客户端共用同一授权来源，令牌轮换后可能需要重新登录。
- 代理订阅当前支持含 `proxies` 的 Clash / Mihomo YAML，不处理裸 URI/base64 订阅、远程 `proxy-providers` 链或任意插件配置；不支持的字段会报错。订阅内容和地址保存在加密凭据库，运行时生成的节点配置仅保存在私有临时目录。

## 从源码运行

需要 Node.js **22.19 或更新版本**（仓库 `.nvmrc` 为 `22.22.2`）。

```sh
git clone https://github.com/OrenZhang/model-bridge.git
cd model-bridge
npm ci
npm run desktop
```

开发验证与打包：

```sh
npm run check
npm test
npm run build
npm run package
```

真实内核检查（需下载官方 mihomo，使用模拟节点，不使用模型账号）：

```sh
node scripts/smoke-managed-network.mjs
```

打包使用当前系统架构；macOS 生成 DMG/ZIP，Windows 生成 NSIS。官方 Codex helper 随应用打包，不要求用户预先安装 Codex CLI。跨架构打包需额外检查对应 helper 是否被包含。

桌面端数据默认保存在系统的应用数据目录。可用 `MODEL_BRIDGE_DATA_DIR` 指定独立测试目录。关闭窗口后网关保留在托盘；通过托盘“退出”停止服务。

### 无界面网关

复制 [配置示例](examples/config.json) 到一个独立目录下的 `config.json`，修改模型、地址与 `env:` 密钥引用。不要在配置文件中直接写入真实密钥。

macOS / Linux：

```sh
export MODEL_BRIDGE_DATA_DIR="$PWD/.model-bridge"
export MODEL_BRIDGE_GATEWAY_KEY="替换为随机本地访问密钥"
export MODEL_API_KEY="填写自己的服务商密钥"
npm run dev
```

Windows PowerShell：

```powershell
$env:MODEL_BRIDGE_DATA_DIR = "$PWD/.model-bridge"
$env:MODEL_BRIDGE_GATEWAY_KEY = "替换为随机本地访问密钥"
$env:MODEL_API_KEY = "填写自己的服务商密钥"
npm run dev
```

无界面模式的默认网络从环境变量读取；桌面模式从系统网络读取。ChatGPT 设备码登录的交互入口目前在桌面端。

## 接口

| 路径 | 用途 |
| --- | --- |
| `GET /healthz` | 本机健康检查，不含账号信息 |
| `GET /v1/models` | 聚合模型列表；Anthropic 请求头可获得对应列表格式 |
| `GET /codex/models` | Codex 完整模型目录，不是普通 `/v1/models` 返回值 |
| `POST /v1/responses` | Responses |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/chat/completions` | Chat Completions |

除健康检查外均要求本地访问密钥。Codex、Claude Code 和其他 Agent 分别使用独立访问密钥；本地密钥不会发往服务商。HTTP 默认监听 `127.0.0.1`；开启局域网模式后监听 `0.0.0.0`。两种模式均拒绝浏览器 Origin，管理操作仅通过桌面 IPC 完成。

### 可复制的客户端基础地址

| 客户端协议 | 本机 Base URL | 完整请求地址 |
| --- | --- | --- |
| Responses / Codex / OpenAI SDK | `http://127.0.0.1:18765/v1` | `http://127.0.0.1:18765/v1/responses` |
| Messages / Claude Code / Anthropic SDK | `http://127.0.0.1:18765` | `http://127.0.0.1:18765/v1/messages` |
| Chat Completions / OpenAI SDK | `http://127.0.0.1:18765/v1` | `http://127.0.0.1:18765/v1/chat/completions` |

总览分别提供基础地址、完整地址和访问密钥的复制入口。允许局域网访问后，其他设备用本机实际网卡 IP 替换 `127.0.0.1`；`0.0.0.0` 是监听地址，不是客户端目标地址。同网段设备还需要系统防火墙允许端口。此模式为 HTTP，请只用于可信局域网。

## 数据存储

- `config.json`：服务地址、模型能力、代理引用、客户端密钥散列。
- `credentials.enc`：桌面凭据，使用 Electron safeStorage 加密。
- `accounts/<id>/codex/`：独立 Codex 登录目录。**官方 helper 的 `auth.json` 当前使用私有文件权限存储，尚未纳入桌面加密凭据库**；请勿分享该目录。
- `usage/*.jsonl`：UTC 按天记录的调用元数据，不记录提示词或回复正文。界面最多查询 90 天，文件不会自动清理。
- `backups/`：客户端配置备份。备份可能含原有客户端的凭据，不应上传到 GitHub。

需求、架构与验收计划分别见 [需求范围](docs/requirements.md)、[架构](docs/architecture.md)、[路线图](docs/roadmap.md)。项目独立实现，参考同舟的交互边界，不复制其业务源码。
