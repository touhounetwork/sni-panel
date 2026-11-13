# 17: 随机端口误判与多入口端口转发自测

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.298

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 随机端口不再被「环境缺失」误判为不可用，缺少转发工具时直接显示原因；多入口端口转发自测每个入口各测一次，不再漏节点；节点详情补充未确认的规则；可恢复规则按期望的转发类型比对。

- [x] `portForwardToolPreflight.ts` 新增 `MissingPortForwardToolError`；本地 `forwardGroupRepository.ts` 的两处调用点都要改；`rules.ports.ts` 返回 `configurationError`
- [x] 新增 `portEntrySelfTest.ts`、`portEntryProbePlan.ts`，加入 `pe-` 批次；`portEntryRuntime.ts` 和 `shared/portEntryDiagnostics.ts` 加 `unconfirmedRules`
- [x] 心跳里可恢复规则按期望的 `forwardType`（含 guard 和隧道类型）比对，在本地心跳文件里手工合并；`liveness.available` 只用于测试分派，不进入入口选择或 DDNS
- [x] 移植 `rulesPortAvailability`、`portEntryRuntime`、`portEntryProbePlan`、`PortEntryRuntimeSummary` 测试
