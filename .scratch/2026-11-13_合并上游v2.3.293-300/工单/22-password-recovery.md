# 22: 通过已验证邮箱或 Telegram 找回密码

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.299

**Blocked by:** 08

**依据：** [本轮规格](../spec.md)

**What to build:** 登录页可以通过已验证的邮箱或已绑定的 Telegram 获取一次性的密码重置链接；没有配置找回方式时提示联系管理员。

- [x] 新增 `server/passwordRecovery.ts`、`shared/passwordRecovery.ts`、`PasswordRecoveryDialog.tsx`、`client/src/lib/passwordRecovery.ts`；`routers/auth.ts`、`twoFactorChallenges.ts`、`userRepository.ts`（CAS 重置，改邮箱时清除验证状态）
- [x] `telegramBot.ts` 的 `/resetpassword` 并入本地多语言 bot 结构；`docs/guide/account-recovery.md` 补充说明
- [x] 移植 `passwordRecovery`、`PasswordRecoveryDialog`、`twoFactorChallenges` 测试，登记 `test:password-recovery`
