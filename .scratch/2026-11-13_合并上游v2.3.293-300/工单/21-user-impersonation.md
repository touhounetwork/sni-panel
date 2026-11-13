# 21: 用户代入（新窗口进入普通用户后台）

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.299

**Blocked by:** 02

**依据：** [本轮规格](../spec.md)

**What to build:** 管理员可以在新窗口以普通用户身份进入后台，不影响原有登录。

- [x] 新增 `server/userImpersonation*.ts`、`shared/userImpersonation.ts`、`client/src/lib/userImpersonation.ts`、`UserEntryBoundary`；`_core/context.ts`、`_core/trpc.ts`、`routers/auth.ts`、`routers/users.ts`、`rules.tasks.ts`、`ruleTaskQueue.ts`、`main.tsx`、`App.tsx`、`useAuth.ts`、`Users.tsx`
- [x] 代入时的禁止范围：上游的 auth/users/google/telegram/discord/setup，再加上支付、余额、购买套餐、流量计费、推广提现、MCP 令牌、Agent Token 的写操作（用户决定 11）。用白名单测试逐个路由核对
- [x] 移植 `userImpersonation` 两份测试，登记 `test:user-entry`；补「代入时禁止的写操作」测试
