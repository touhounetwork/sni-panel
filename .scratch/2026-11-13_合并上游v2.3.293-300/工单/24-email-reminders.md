# 24: 邮件提醒：抄送管理员、失败隔离、去重记录清理

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.300

**Blocked by:** 09

**依据：** [本轮规格](../spec.md)

**What to build:** 账户临期和流量不足提醒可以汇总抄送给管理员（可以指定邮箱，留空发给全部管理员）；单个用户被拒收不再影响其后用户；停用账号不再提醒；定期清理提醒去重记录。邮件主题和正文使用站点名称。

- [x] 新增 `server/emailReminders.ts`；`email.ts`、`scheduler.ts`（替换本地旧循环）、`settingsRepository.ts`（`cleanOldReminderMarkers`，也覆盖本地 Telegram 提醒键）、`systemRouter.ts`、`ai/panelTools.ts`、`EmailSettings.tsx`
- [x] 主题和正文的「ForwardX」改用站点名称，没填时用 ForwardX（用户决定 12）
- [x] 移植 `emailReminders.test.ts`，并入 `test:smtp`
