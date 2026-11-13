# 23: 整条链路 TCP/UDP 测速

Status: resolved（2026-11-13）

**上游来源：** v2.3.300

**Blocked by:** 11、19

**依据：** [本轮规格](../spec.md)

**What to build:** 隧道和转发链可以对整条链路做 TCP/UDP 测速，默认上传和下载各 10 秒，实时显示速度、仪表盘和曲线；结果包括平均速度、峰值、数据量、实际时长，UDP 还有丢包和抖动，可导出 JSON。

- [x] Agent：新增 `link_speed*.go`；心跳上报 `linkSpeedSupported`，响应带 `linkSpeedTasks`；和本地批量命令（SSE 通道）并列，互不影响
- [x] 面板：新增 `linkSpeedPlan.ts`、`linkSpeedTasks.ts`、`routers/linkSpeed.ts`（adminProcedure）、`shared/linkSpeed.ts`；新增两个加密端点并加入 `AGENT_TUNNEL_PATHS`
- [x] 临时监听端口要避开本地 SNI 分流端口（`sniSplitterPort`）；文案说明测速不包含 SNI 分流和 PROXY 头这一段
- [x] 网页：`LinkSpeedTest.tsx`、`LinkSpeedGauge.tsx`，在 `Tunnels.tsx`、`ForwardGroups.tsx` 加入口；文档 `tunnels.md`、`port-chains.md`
- [x] 移植 `linkSpeed.test.ts`、`agent/link_speed_test.go`、`linkSpeedGauge.test.ts`，登记 `test:link-speed`；用真实 Agent 二进制做一次本机端到端测速

## Comments

- 2026-11-13 未完成的验证：未用真实 Agent 二进制做本机端到端测速，只通过了面板与 Agent 单元测试。
- 2026-11-13 已验证：`.dev/e2e-link-speed.mjs` 用真实面板 + 两个真实 Agent 进程（bwrap 隔离状态目录）组成直连转发链，TCP 与 UDP 测速都完成（上传/下载有流量与速率，UDP 50 Mbps 按设定速率、丢包与抖动统计正确），两次之间等待 Agent 确认停止临时监听，业务转发链配置不变。隧道（FXP/GOST）模式未测。
