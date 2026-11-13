# 02: 权限与安装密钥加固

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.293

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** Agent Token、主机、隧道的增删改改为仅管理员；认证缓存只收录启用中的管理员签发的令牌，裸 token 也要校验；`/api/agent/register` 拒绝非管理员令牌；改角色、删用户、停用后让缓存失效；一键安装只用 `openssl rand -hex 32` 生成 JWT，`.env` 改为 600；MCP 令牌在 MySQL 下的字段引号问题。

- [x] `routers/agentTokens.ts`、`hosts.ts`、`tunnels.ts` 相关过程改为 adminProcedure；`Tunnels.tsx` 普通用户的新建、编辑、删除入口隐藏（用户决定 6）
- [x] `agentAuth.ts`、`agentRoutes.ts`、`tokenRepository.ts`、`userRepository.ts` 按上游合入
- [x] `install-panel-{docker,local}.sh` 去掉 `date | sha256sum` 兜底，保留本地品牌和预检
- [x] `mcpTokens.ts` 把 `fields` 挪进函数
- [x] 移植 `managementPermissions.test.ts`、`mcpAccess.*`；检查本地普通用户相关测试并按新权限更新
