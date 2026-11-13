# 10: Epusdt v2 支付

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.296

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** GM Pay 支持选择 MD5（旧版）或 HMAC-SHA256，并修正科学计数法金额的签名串。

- [x] `gmPay.ts`（本地与 294 相同）直接套用；`payment.ts`、`Payments.tsx`、`docs/guide/payments.md` 小改
- [x] 移植 `gmPay.test.ts`、`paymentIntegration.test.ts` 的相关用例
