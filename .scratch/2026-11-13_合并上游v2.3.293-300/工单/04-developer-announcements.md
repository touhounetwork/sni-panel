# 04: 开发者公告与按需检查

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.293、v2.3.294、v2.3.295

**Blocked by:** 03

**依据：** [本轮规格](../spec.md)

**What to build:** 管理员访问时按需检查版本和开发者公告（30 分钟内复用结果），去掉每 6 小时的定时检查；公告从本仓库 `announcements/developer.json` 读取，中英双语弹窗，按 revision 记录已读。

- [x] 新增 `server/developerAnnouncements.ts`、`shared/developerAnnouncements.ts`、`shared/visitChecks.ts`；URL 由 `REPO_RAW_BASE_URL` 派生，releaseUrl 用 `REPO_URL`（用户决定 4）
- [x] 新增本仓库 `announcements/developer.json`（初始无公告）；上游那条 JWT 公告按本地 docker-compose 和 .env.example 的情况改写或不发布
- [x] `scheduler.ts` 去掉定时检查；`DashboardLayout.tsx`、`Settings.tsx`、`main.tsx` 按上游合入
- [x] 移植 `developerAnnouncements.test.ts`、`DeveloperAnnouncement.test.ts`、`panelUpdateCache.test.ts`
