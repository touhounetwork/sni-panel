# 09: 面板内存优化：按需加载与空闲释放

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.296

**Blocked by:** 01、08

**依据：** [本轮规格](../spec.md)

**What to build:** 数据库驱动、drizzle 适配器、exceljs、nodemailer、验证码、undici 改为按需加载；离线 IP 库空闲 60 秒后释放；queryCache 定时清理过期项；事件流设全局 32MB 待发上限。

- [x] 新增 `server/databaseDrivers.ts`、`server/idleResourceCache.ts`；`dbRuntime.ts`、`migration.ts`、`databaseSwitch.ts`、`databaseHealthMonitor.ts` 手工合并
- [x] `email.ts`、`operationsSourceGeo.ts` 本地与上游 294 相同，直接套用；同时检查本地 `imageCaptcha.ts` 静态引入的 svg-captcha
- [x] `agentEvents.ts` 的全局上限要和本地批量命令事件、install hook 的推送兼容
- [x] 移植 `databaseLazyLoading`、`idleResourceCache`、`routineDependencyLoading`、`operationsSourceGeoLifecycle` 等测试；`routineDependencyLoading` 要逐一排查本地 SNI、计费路由链里的静态引入
