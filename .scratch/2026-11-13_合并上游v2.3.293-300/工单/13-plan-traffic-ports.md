# 13: 套餐单向/双向流量计费与端口数不限

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.297

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 商店套餐可选择单向或双向计费；套餐端口数填 0 表示不限，取消 1024 的上限。

- [x] `subscription_plans` 加 `trafficMode`（默认 both）；新增 `shared/planTraffic.ts`；`billingRepository.ts`、`forwardRuleRepository.ts`（`quotaSourcePort`）、`agentReportRoutes.ts` 用 `planTrafficBytes` 计入额度
- [x] 不影响本地计费资源（`billingResource.config`）和规则级 `trafficMode`；核对 SNI 子规则和组模板规则拿到的 `quotaSourcePort`
- [x] `routers/plans.ts` 端口数改为 0–65535，`billingRepository` 的 `|| 1` 等改为按 0 处理；网页的 `Plans`、`Billing`、`Users`、`Store` 页面允许填 0，并显示为「不限」
- [x] 移植 `planTraffic.*`、`planPorts.*`、`PlanTrafficMode.test.tsx`
