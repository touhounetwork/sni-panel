# 19: 主机网速统计与实时速率

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.298、v2.3.299

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 主机网速计算处理重启和计数回绕，离线显示为空；主机管理和探针的实时速率不再为空或显示慢（presence 响应带 `refreshMetrics` 唤醒指标心跳，watch TTL 改为 15 秒，用样本年龄避免时钟差）。

- [x] 新增 `shared/hostNetworkSpeed.ts`；`metricsRepository.ts`、`hostRepository.ts`、`routers/hosts.ts`、`HostMonitor.tsx`、`Hosts.tsx`、`HostCard.tsx`
- [x] Agent：presence 响应里的 `refreshMetrics` 唤醒指标心跳，3 秒节流；`agentHeartbeatGate.ts`、`agentEvents.ts`
- [x] 移植 `hostNetworkSpeed` 两份测试、`metricsRepositorySqlite`、`agent/metrics_refresh_test.go`、`agentHeartbeatGate`，登记 `test:network-speed`
