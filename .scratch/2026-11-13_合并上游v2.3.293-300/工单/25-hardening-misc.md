# 25: 小数端口修复、安装脚本健壮性与杂项

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.300

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 修复端口可填小数导致 Agent 停止同步，启动时自动修正已有数据；数据库异常时请求安装脚本不再导致面板退出；主机监控单次查询最多 1440 条；Shell 脚本统一 LF。

- [x] `db.ts` 的 `repairFractionalPorts` 和 `forwardRuleRepository.ts` 的写入守卫，都要包含本地的 `sniSplitterPort`，并核对 `forward_groups` 的端口列；`rules.crud.ts`、`rules.ports.ts`、`tunnels.ts` 的 zod 加 `.int()`
- [x] `agentRoutes.ts` 的 install.sh 包上 try/catch，失败返回 503 和一段 `exit 1` 脚本，保留本地安装后命令参数；`index.ts` 注册 `unhandledRejection`
- [x] `routers/hosts.ts` 的 metrics limit 设为 1–1440，并核对本地 HostMonitor 传入的值
- [x] `.gitattributes` 加 `*.sh text eol=lf`
- [x] 移植 `hardeningRegression.test.ts`，并入 `test:security-boundaries`
