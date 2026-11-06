# 自动 AI 节点优选验证

版本：0.1.0-alpha.4。日期：2026-11-06。

## 已执行

- TypeScript 检查与 194 项本机回归测试通过。
- 真实 mihomo v1.19.32，三个本机受控代理：快速但返回 403、可用且较慢、可用且较快。自动选择可用节点中延迟最低的节点。
- 同一订阅的两个 AI 服务地址选择不同节点，互不覆盖。
- 当前节点返回 503 后，下次请求改走其他可用节点；失败的 POST 只发送一次，已经开始的流继续完成。
- 手动选择保留指定节点；请求进行中拒绝切换模式；恢复自动后重新检测。
- 全部节点失败时返回 no_ai_proxy_available，不直连、不使用未通过检测的节点。
- 单元测试覆盖定期检测、并发首次检测合并、失败冷却、停止时取消检测，以及 HTML、重定向、封禁、限流和错误响应的排除。
- 禁止内核网络下载后，直接从安装包附带的官方压缩包安装成功；损坏的压缩包被 SHA-256 校验拒绝。
- 浏览器使用模拟状态验证默认自动模式、各服务节点与延迟、手动切换和切回自动。浏览器测试不访问用户账号或订阅。
- 本地打包应用的 ASAR 中已核对内核压缩包 SHA-256、版本清单和许可证；通过 Electron 从该 ASAR 离线安装内核并执行 -v 验证版本成功。
- macOS 原生 powerSaveBlocker 取得 NoIdleSleepAssertion，停止后释放；未申请屏幕常亮。

复现：先 npm run build，再 node scripts/prepare-mihomo.mjs，最后 node scripts/validate-ai-proxy.mjs。macOS 唤醒验证：npx electron scripts/validate-power-save.cjs。

## 范围

真实 mihomo 路由测试使用本机受控服务，不代表实际订阅中每个节点均可用。AI 接口探测不携带账号密钥，不生成内容；账号额度、套餐和模型权限仍需实际调用确认。首次检测耗时取决于节点数量和超时情况。自动切换只影响后续请求，不重放已经发出的模型请求。

实现参考 Mihomo 官方 IN-USER 路由规则：https://wiki.metacubex.one/config/rules/#in-user 。系统唤醒使用 Electron 官方 powerSaveBlocker：https://www.electronjs.org/docs/latest/api/power-save-blocker 。

## 发布平台验证

[Release 流水线](https://github.com/OrenZhang/model-bridge/actions/runs/42168952904) 的 macOS ARM64 / x64、Windows x64、Linux x64 / ARM64 五个构建任务均通过。每个平台均执行真实 mihomo 路由与内置内核离线安装验证。macOS 执行 194 项回归，并核验原生唤醒断言；Windows / Linux 执行 188 项回归，跳过 6 项仅适用于 macOS 的更新助手测试。Linux 额外完成桌面及系统凭据库验证。
