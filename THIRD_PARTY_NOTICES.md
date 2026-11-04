# Third-party components

Model Bridge is independently implemented. Package dependencies retain their respective licenses; consult each dependency's package and license files.

- [OpenAI Codex](https://github.com/openai/codex) provides the separately invoked authentication helper. Version is pinned in `package.json`; no Tongzhou application code is bundled.
- [Mihomo](https://github.com/MetaCubeX/mihomo) is an optional, separately executed network core under its [upstream GPL-3.0 license](https://github.com/MetaCubeX/mihomo/blob/Meta/LICENSE). The application downloads unmodified official release archives on demand and checks pinned SHA-256 digests. [Corresponding source for v1.19.32](https://github.com/MetaCubeX/mihomo/tree/v1.19.32).
- [Electron](https://github.com/electron/electron) supplies the desktop runtime and includes its own notices in packaged applications.

This repository does not relicense third-party components. Before redistributing installers, preserve upstream license/notices and review the distribution requirements of all included components.
