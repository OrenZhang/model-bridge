# 发布与更新

客户端左下角的版本号打开更新窗口。打包版本在启动时和每 6 小时检查一次 GitHub Releases；源码运行时不启用安装更新。Alpha 版本接收相应预览更新及后续稳定版，稳定版默认不接收预览版，不自动降级。

检查更新、下载和安装是三个独立步骤。检查只读取公开发布信息，不上传账号、模型凭据、用量或客户端配置。下载需手动点击，可查看进度；不在退出时自动安装。

## 安装行为

| 平台 | 下载与安装 |
| --- | --- |
| macOS | 下载匹配 CPU 架构的 ZIP，验证 SHA-512、包标识、版本、架构及链接路径。点击“安装并重启”后，独立原生助手等待旧进程退出，原子交换应用目录，再启动新版。新版网关就绪后清理旧版；启动失败或超时则回退并重新打开原版。 |
| Windows | electron-updater 校验 NSIS 安装包，用户选择“安装并重启”后运行安装程序。 |
| Linux AppImage | electron-updater 校验并替换 AppImage，安装后重启。需从具有写权限的位置运行对应 AppImage。 |
| Linux Debian | electron-updater 通过系统包管理器安装，可能出现系统授权提示，随后重启。 |

安装并重启前检查是否有模型请求；请求进行中时阻止安装。应用退出前关闭网关并等待用量写入完成；安装程序启动失败时保留正在运行的网关，允许重试。账号和配置独立于应用安装目录，更新保留这些数据。

更新请求使用系统网络。服务商连接绑定的代理或订阅不会改变更新通道。网络异常、版本未发布或校验失败会显示错误，可重试；失败的 Mac 临时下载文件自动删除。安装目录需可写；准备失败或权限不足会在退出前显示错误，现有应用保留。下载文件放在应用数据目录的 `updates/` 中。

## 发布版本

1. 更新 `package.json` 和 `package-lock.json` 的版本号，并同步 README 下载链接、`docs/releases/current.md`。
2. 运行类型检查、测试和构建，提交代码。
3. 创建对应标签，如 `v0.1.0-alpha.2`，推送到仓库。
4. `Release` 工作流在原生 runner 上构建 macOS ARM64 / x64、Windows x64、Linux ARM64 / x64。
5. 全部构建与验证通过后，合并不同架构的更新元数据，检查引用的安装包，生成校验文件。先上传至草稿，再公开 Release；预览版本标记为 prerelease。

更新元数据与安装包必须来自同一版本。macOS 两个架构共用更新元数据时合并 `files`，保留每个文件的 SHA-512，防止一个架构覆盖另一个架构。

GitHub 构建默认可能只生成 `latest*.yml`。发布阶段按版本号补齐相应 `alpha` / `beta` 元数据别名，保留 `latest` 兼容回退；稳定版客户端仍只检查正式 Release。

发布写权限仅授予最后的 publish job，构建 job 只读。GitHub 凭据不会放入客户端。后续版本继续使用同一仓库的 Releases，用户不需要访问 Actions artifacts。

实现依据：[electron-updater](https://www.electron.build/v26/docs/features/auto-update/)、[Electron macOS 更新要求](https://www.electronjs.org/docs/latest/api/auto-updater#macos)、[electron-builder 发布配置](https://www.electron.build/v26/docs/publish/)。

`0.1.0-alpha.2` 的构建、公开下载和客户端检查结果见 [更新验证](validation-updates.md)。

## macOS 一键更新

从 `0.1.0-alpha.3` 起，macOS 使用单独编译的 Universal 原生助手安装更新，不依赖系统 Node.js，也不需要打开 Finder 拖动应用。Squirrel 的签名要求不适用于这条独立安装流程；应用仍保留系统安全检查，不删除隔离属性、不关闭 Gatekeeper、不申请 root 权限。当前版本的 DMG 仍用于首次安装。

更新包先复制到私有工作目录并复核 SHA-512，检查 ZIP 路径、符号链接、应用标识、版本和 CPU 架构。现有应用使用 Developer ID 签名时，新包必须来自相同 Team ID，且通过 codesign 完整性验证。未签名预览版继续使用同仓库发布的校验包。

新版准备在安装目录所在文件系统的私有临时目录中。退出前确认助手已启动；旧进程通过正常退出流程等待网关请求和用量写入。助手通过 `renamex_np(RENAME_SWAP)` 交换两个完整应用目录，原路径始终指向完整应用。新版启动后提交与私有任务、随机令牌、目标路径及版本绑定的就绪标记。180 秒内启动失败或无法就绪时，助手停止本次新版进程、交换回旧版并重新打开；回退原因保存在应用数据目录的 `updates/mac-jobs/` 下。

安装目录不可写、运行于 DMG 或 App Translocation 时，准备阶段会明确报错，原应用不退出。需将应用安装到本机可写位置后使用一键更新；系统如出现应用管理授权提示，由账号本人确认。更新只替换应用包，不迁移或替换账号、密钥和客户端配置。

`0.1.0-alpha.2` 尚未包含此助手，需要先升级一次到 `0.1.0-alpha.3`，后续版本即可在客户端内完成安装与重启。

一键更新的原生实测、配置保留与失败回退结果见 [macOS 更新验证](validation-mac-update.md)。
