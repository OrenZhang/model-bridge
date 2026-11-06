# 发布与更新

客户端左下角的版本号打开更新窗口。打包版本在启动时和每 6 小时检查一次 GitHub Releases；源码运行时不启用安装更新。Alpha 版本接收相应预览更新及后续稳定版，稳定版默认不接收预览版，不自动降级。

检查更新、下载和安装是三个独立步骤。检查只读取公开发布信息，不上传账号、模型凭据、用量或客户端配置。下载需手动点击，可查看进度；不在退出时自动安装。

## 安装行为

| 平台 | 下载与安装 |
| --- | --- |
| macOS | 下载匹配 CPU 架构的 DMG，验证 SHA-512；打开前再次校验。打开安装包后退出应用，拖入“应用程序”替换，再重新启动。当前未签名、公证，不使用 Squirrel 静默替换。 |
| Windows | electron-updater 校验 NSIS 安装包，用户选择“安装并重启”后运行安装程序。 |
| Linux AppImage | electron-updater 校验并替换 AppImage，安装后重启。需从具有写权限的位置运行对应 AppImage。 |
| Linux Debian | electron-updater 通过系统包管理器安装，可能出现系统授权提示，随后重启。 |

安装并重启前检查是否有模型请求；请求进行中时阻止安装。应用退出前关闭网关并等待用量写入完成；安装程序启动失败时保留正在运行的网关，允许重试。账号和配置独立于应用安装目录，更新保留这些数据。

更新请求使用系统网络。服务商连接绑定的代理或订阅不会改变更新通道。网络异常、版本未发布或校验失败会显示错误，可重试；失败的 Mac 临时下载文件自动删除。下载文件放在应用数据目录的 `updates/` 中。

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

当前版本的构建、公开下载和客户端检查结果见 [更新验证](validation-updates.md)。
