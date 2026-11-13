# 06: 入口组与转发组 DDNS 双栈，以及成员调整后的 DDNS 修复

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.294、v2.3.298

**Blocked by:** 01

**依据：** [本轮规格](../spec.md)

**What to build:** DDNS 支持 A+AAAA，按地址族分别同步，空地址族删除残留记录；新建时去掉 CNAME。修复转发组调整成员后 DDNS 指回已移除主机旧 IP 的问题。

- [x] 新增 `shared/forwardGroupDdns.ts`、`server/forwardGroupDdns.ts`；本地 5 处 `updateDdnsRecordValues` 调用改为按地址族下发；`routers/forwardGroups.ts` 的 enum 加 BOTH；网页隐藏 CNAME，旧配置显示「CNAME（旧配置）」（用户决定 7）
- [x] 成员调整后的 DDNS 只借用上游思路、按本地规则重写：兜底值只保留当前启用、未被流量排除的成员已有的旧地址，**不采用**上游「选第一个 available 成员」的兜底（违反 ADR-0006/0008）；有进行中的退役批次时跳过清理（ADR-0010）；签名复核与本地 `exactDdnsSignature` 和主机型主备组字段合并
- [x] 本地 SNI 组和主机型主备组的入选条件不改
- [x] 移植 `forwardGroupFailover.test.ts`、`linkAvailability.test.ts`、`forwardGroupMemberRegression.test.ts` 的相关用例；补 SNI 组、主机型主备组、退役中三种场景的回归测试
