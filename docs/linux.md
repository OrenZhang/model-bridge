# Linux

提供 Linux x64 / ARM64 的 AppImage 和 Debian 包。安装包由对应架构的原生 GitHub Actions runner 构建，上传为该次 Checks 工作流的 Linux artifacts，不依赖在 macOS 上交叉复制原生依赖。

- AppImage：下载对应架构文件，添加执行权限后运行。
- Debian / Ubuntu：安装对应架构的 .deb。
- 桌面环境需可用的系统 Secret Service / GNOME Keyring / KWallet；应用不使用 basic_text 存储凭据。
- Codex helper 与 mihomo 的 Linux 平台、架构选择沿用独立平台二进制；本机 Codex / Claude Code 使用用户主目录下的配置，也支持 CODEX_HOME / CLAUDE_CONFIG_DIR。

```sh
chmod +x Model*.AppImage
./Model*.AppImage
```

“对外服务 → 复制配置 → Linux”提供可粘贴执行的 Shell 脚本，配置包也包含 install-linux.sh。接收端需要 Node.js 18+；脚本自带配置解析器，自动备份并合并配置，不下载 npm 依赖。此处的 Node.js 是接收端配置脚本的要求；打包的桌面应用自带运行时。

构建需 Linux 主机、Node.js 22.22.2，执行 `npm ci` 后：

```sh
npm run build
npx electron-builder --linux AppImage deb --x64 --publish never
# ARM64 主机使用 --arm64
```

CI 在 Linux x64 / ARM64 上运行类型检查、完整测试、真实 Codex 与模拟上游、多轮和工具验证、桌面打包，并在 D-Bus + GNOME Keyring + Xvfb 环境检查原生桌面启动、加密凭据库和网关健康状态。CI 使用隔离数据目录和测试密钥环，没有服务商账号或个人凭据。

无桌面或无系统凭据库的环境可使用现有 CLI，通过 MODEL_BRIDGE_DATA_DIR 指定配置目录、MODEL_BRIDGE_GATEWAY_KEY 设置网关 Key；服务商 API Key 用 env:变量名引用。CLI 与桌面端应使用不同数据目录。

格式依据：[electron-builder Linux/AppImage](https://www.electron.build/v26/docs/appimage/)。凭据存储依据：[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。具体构建与原生启动是否通过，以对应提交的 Checks 结果为准；不等同于所有 Linux 发行版的人工桌面验收。
