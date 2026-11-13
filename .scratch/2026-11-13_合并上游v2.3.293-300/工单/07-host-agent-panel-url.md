# 07: 主机独立 Agent 面板连接地址

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.295

**Blocked by:** 02

**依据：** [本轮规格](../spec.md)

**What to build:** 主机可以单独设置 Agent 连接面板用的地址（适配反代和不同线路）。开启后，该主机的心跳、事件流、升级和回滚推送、已绑定 Token 的安装命令都改用这个地址；新版 Agent 只重连事件流，不重启转发。

- [x] `hosts` 表加 `agentPanelUrlEnabled`、`agentPanelUrl`；新增 `shared/agentPanelUrl.ts`、`HostAgentPanelUrlSetting.tsx`、`agent/panel_connection.go`
- [x] 本地心跳里 `resolveAgentAdvertisedPanelUrl` 的两处调用，以及 coalesced 快路径，按主机解析；迁移目标 `agentMigrationTargetPanelUrl` 仍优先
- [x] `pushAgentUpgrade` 的 5 个调用点（hosts、systemRouter 回滚、telegramBot）改为按主机解析；`migration.ts` 的迁移目标不动
- [x] `AgentTokenManager.tsx` 的安装命令使用主机地址；设置放在主机编辑「其他配置」里安装后命令的旁边
- [x] 移植 `hostAgentPanelUrl*.test.ts`、`HostAgentPanelUrlSetting.test.tsx`、`agent/panel_connection_test.go`
