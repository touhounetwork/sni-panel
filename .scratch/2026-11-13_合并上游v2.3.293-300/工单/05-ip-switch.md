# 05: 国内健康检测与自动换 IP 全链修复

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.293、v2.3.294、v2.3.295、v2.3.296、v2.3.297

**Blocked by:** 01

**依据：** [本轮规格](../spec.md)

**What to build:** 冷却以完成时间为起点、同主机共用冷却；记录原因、HTTP 状态和冷却截止；只通知管理员；编辑时回显已保存的换 IP 参数；以 Agent 上报的实际地址变化确认换 IP 成功，同步改写入口地址、转发配置和 DDNS；新地址仍不可用时继续检测。

- [x] `host_ip_switch_attempts` 加 `reason/httpStatus/cooldownUntil/oldIp/addressSnapshot` 列和 `(status, createdAt)` 索引，保留本地 `(createdAt, id)` 索引
- [x] 合入 `shared/hostChinaHealth.ts`、`hostProbeHealth.ts`、`agentIpSwitchTasks.ts`、`hostIpSwitchProvider.ts`、`operationsMonitor.ts`、`HostChinaHealthSettings.tsx`、`OperationsMonitorPanel.tsx`；新增 `hostIpSwitchObservation.ts` 和 `hosts.probeServiceIpSwitchHook`
- [x] Agent：`ip_switch.go` 的排障日志、claim 和换 IP 后 3 分钟内每 10 秒刷新公网 IP
- [x] **ADR 约束**：`hostAddressRuntime.ts` 手工合并。「强制刷新运行配置和 DDNS」仍由 `runForwardGroupsForHostAddressChange` 按本地入口健康判断，不能变成绕过健康确认的整组切换；入口组成员的 hostId 要并入本地 SNI 受影响集合，不能覆盖
- [x] 移植 `hostProbeHealth.*`、`hostIpSwitchObservation.fixture.ts`、`hostIpSwitchRepeat.fixture.ts`、`agent/ip_switch*_test.go`；补 SNI 组和主机型主备组在换 IP 后的回归测试
