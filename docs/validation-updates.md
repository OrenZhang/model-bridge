# Release 更新验证

2026-11-06，版本 `0.1.0-alpha.2`，发布代码提交 `2219a6d`。

## 发布产物

[Release 工作流](https://github.com/OrenZhang/model-bridge/actions/runs/42147610157) 的五个构建任务及最终发布任务全部通过：macOS ARM64 / x64、Windows x64、Linux ARM64 / x64。Linux 两个架构均通过桌面启动、加密凭据库和网关健康检查。

公开 [v0.1.0-alpha.2](https://github.com/OrenZhang/model-bridge/releases/tag/v0.1.0-alpha.2) 包含 23 个文件：安装包、blockmap、alpha / latest 更新元数据，以及 `SHA256SUMS.txt`。发布阶段逐项检查元数据引用的文件与 SHA-512，再公开 Release。

Linux 的正式文件名遵循打包器的架构命名：x64 AppImage 为 `linux-x86_64.AppImage`，x64 Debian 包为 `linux-amd64.deb`；ARM64 为 `linux-arm64.AppImage` / `linux-arm64.deb`。README 的 7 个安装包下载链接已逐一与公开资产名称核对。

## 客户端与下载

本机打包应用通过真实 GitHub 更新源检查，显示 `0.1.0-alpha.2` 为当前最新版本。

另用独立 Electron 测试进程和临时数据目录，将更新器的来源版本设为 `0.1.0-alpha.1`，调用与桌面端相同的更新服务，依次完成：

1. 发现已公开的 `0.1.0-alpha.2`。
2. 下载对应架构的真实 Mac DMG，共 `239748230` 字节。
3. 按公开更新元数据验证完整文件的 SHA-512。
4. 调用安装入口，再次验证本地文件，确认路径指向已校验的安装包。
5. 删除测试下载与临时数据。

安装入口使用测试回调检查文件，没有打开系统安装器、替换应用或改写用户的 Codex / Claude Code 配置。macOS 当前仍通过 DMG 手动替换；Windows / Linux 的系统安装、授权提示和重启行为未在这台 Mac 上实测。

## 自动化测试

[四平台 Checks](https://github.com/OrenZhang/model-bridge/actions/runs/42147529174) 全部通过，每个平台运行 166 项测试。更新与发布相关测试覆盖并发去重、平台与架构选择、下载完整性、临时文件清理、安装前防篡改检查、失败重试、旧版本拒绝、元数据合并、预览通道别名、重复/缺失文件及校验失败阻止发布。

## 0.1.0-alpha.5 更新说明展开修复

2026-11-06，使用浏览器和模拟下载事件复现：点击“更新说明”后 open 为 true，一次下载进度事件后变回 false。原因是更新面板重建时丢失 details 的原生展开状态。

修复后，同一版本的说明在连续 100 次进度刷新后仍保持展开，正文 scrollTop 在刷新前后均为 120；用户手动收起后，下一次刷新保持收起。内容未变化时跳过重建，说明切换到另一个版本时重新初始化。TypeScript 检查和 194 项本机回归测试通过。模拟界面验证不访问用户账号、配置或真实更新下载。
