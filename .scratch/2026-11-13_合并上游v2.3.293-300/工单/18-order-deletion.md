# 18: 订单管理删除未支付订单

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.298

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 管理员可以删除未支付订单，待付款订单删除时释放折扣。

- [x] `payment_orders` 加 `adminDismissedAt`；`billingRepository.ts` 的 `canDeletePaymentOrder/deletePaymentOrder`，列表和统计过滤；`routers/billing.ts`、`Billing.tsx`
- [x] 移植 `paymentOrderDeletion.test.ts`
