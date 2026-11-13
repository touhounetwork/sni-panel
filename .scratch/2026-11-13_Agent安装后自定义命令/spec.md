# Agent 安装／升级后执行自定义命令

Status: ready-for-human

## 决策（2026-11-13 与用户确认）

1. **执行位置**：安装脚本内同步执行。安装（`do_install`）在注册并启动服务之后、升级（`do_upgrade`）在注册之后，调用 `forwardx-agent -config … -post-install install|upgrade`。
2. **命令来源**：`/api/agent/install.sh` 公开且所有节点相同，命令不写入脚本；由新 Agent 用自己的 token 经加密 `/api/sync` 调 `/api/agent/install-hook` 取回（受安装身份隔离保护，退役安装取不到），节点磁盘不留副本。
3. **失败**：非 0、超时、取命令或回报失败一律只警告，安装照常成功。超时 10 分钟，结束整个进程组。旧 Agent（`-h` 无 `-post-install`）跳过。
4. **范围**：系统设置全局默认（`system_settings.agentInstallHookCommand`）+ 主机四选一：使用全局（默认）／使用本节点命令／追加本节点命令／不执行。「追加」先执行全局、再执行本节点，两段是分别启动的进程（一段的 `exit` 或语法错误不跳过另一段），共用 10 分钟超时；报告第一个非 0 的退出码，超时后不再执行后续段。切到不使用本节点命令的模式时保留已存命令。
5. **回报**：时间、模式、Agent 版本、来源、退出码、是否超时、用时、合并输出；输出保留最后 1MB 并标注截断，完整内容在节点日志或安装终端。
6. **总开关**：不设。
7. **审计**：全局与主机修改都记入配置审计，只记模式与摘要（是否配置、行数、字节、sha256 前 16 位），不记命令原文。

## 实现

- 新表 `host_install_hooks`（每主机一行，`longtext` 存命令与输出），纳入迁移顺序，标为非必要迁移、尽力迁移；删除主机时清理。
- 面板：`server/hostInstallHooks.ts`、`server/agentInstallHookRoutes.ts`（挂在受安装身份隔离的 Agent API 路由上）、`hosts.installHook/saveInstallHook/globalInstallHook/saveGlobalInstallHook`（仅管理员）。
- Agent：`agent/post_install.go`，复用 `configurePluginTaskCommand` 的进程组终止。
- 前端：`HostInstallHookSettings`（主机编辑「其他配置」）、`AgentInstallHookGlobalSetting`（系统设置 Agent 区）。

## 验证

- Agent：退出码／环境变量／输出、超时杀进程组（后台子进程不残留）、1MB 尾部截断、取命令失败不影响安装。
- 面板：优先级、仅管理员、64KB 上限、审计不含原文、真实加密通道取命令、退役安装取不到、输出截断、删主机清理、脚本语法与插入位置。
- 端到端：真实面板 + 生成脚本中的 `run_post_install_hook` + 真实新旧 Agent 二进制，覆盖全局、节点、追加（全局 `exit 5` 后节点命令仍执行）、不执行、失败只警告、旧 Agent 跳过。
- 浏览器：系统设置与主机编辑保存，数据库与审计核对。
