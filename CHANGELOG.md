# 更新日志

本文档记录 Quotio Desktop 已发布版本的主要变化。安装包请前往 [GitHub Releases](https://github.com/xiaocoss/quotio-desktop/releases)。

## v0.4.1 - 2026-06-19

### 新增

- 新增自定义接口的模型路由能力，支持按模型名将请求路由到指定自定义服务商。
- 自定义接口支持「直连」或「继承全局代理」两种模式，便于同时管理内网/外网接口。
- 新增自定义接口密钥池，可为同一接口维护多把 key，并支持按 key 路由。
- 新增 Kiro 代理池与 sidecar 集成：从 `kiro-*.json` 账号派生 kiro-rs 凭据，随代理生命周期自动启停。
- 服务商添加账号流程新增统一弹窗，支持 OAuth、Token/JSON 粘贴和文件导入三种方式。

### 改进

- Antigravity OAuth 凭据改为构建期环境变量注入，不再硬编码到源码中。
- GitHub Actions Release 构建注入 Gemini / Antigravity OAuth 构建期 secrets，缺失时对应功能优雅降级。
- Release 工作流改用 `RELEASE_TOKEN` 发布，绕过 `GITHUB_TOKEN` 在创建 Release 时的 integration 权限限制。
- README 下载直链更新到 v0.4.1。

### 修复

- 隔离 management snapshot 测试对本地 `api-keys.json` 的依赖，避免开发机本地配置影响测试结果。

## v0.4.0 - 2026-06-17

### 新增

- 新增应用内自动更新能力，支持检查新版本、展示更新说明和下载进度。
- 新增 Codex 会话可见性修复逻辑，修复配置 provider 与历史会话 metadata 不一致导致的显示问题。
- 新增 CLIProxyAPI 账号导出能力，便于备份和迁移账号文件。
- 新增「上游代理不稳定」提示横幅，用于区分代理链路波动与账号鉴权失败。

### 改进

- 提升服务商账号页健壮性：代理不可用时也尽量读取本地 auth 目录展示已有账号。
- 优化额度与账号健康检测，按真实 HTTP 状态区分鉴权失败、限流和上游临时错误。
- 改进 Codex 账号/配置处理，降低重复账号、配置污染和恢复失败的概率。

### 修复

- 修复一批额度刷新、账号管理和 Codex 配置恢复相关的稳定性问题。

## v0.3.1 - 2026-06-15

### 改进

- README 改为更完整的产品介绍页，补充各平台下载入口和最新版直链。
- 版本脚本同步更新 README 下载直链版本号。

### 修复

- 修复一批稳定性问题。

## v0.3.0 - 2026-06-13

### 新增

- 新增 GitHub Actions 三端自动发版流程，推送 `v*` 标签后自动构建 Windows / macOS / Linux 安装包。
- README 新增界面预览截图和发版说明。
- Codex 额度页新增主动重置次数显示，并支持一键重置 5 小时窗口。
- 新增打包与版本号同步脚本，简化发版流程。
