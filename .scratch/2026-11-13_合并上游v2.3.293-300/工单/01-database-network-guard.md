# 01: 数据库网络防护与健康误报

Status: resolved（2026-11-13 本地实施完成，按用户要求整体合并后统一测试、单次提交）

**上游来源：** v2.3.293、v2.3.294

**Blocked by:** None

**依据：** [本轮规格](../spec.md)

**What to build:** 数据库连接、查询、租用都有截止时间，超时销毁连接、排队有上限；MySQL/PG 开 keepAlive；单条查询超时不再把全站判为不可用，健康探测连续失败到阈值才判故障；PG 建表先查 catalog。

- [x] 新增 `server/databaseNetworkGuard.ts`，在本地 `dbRuntime.ts` 的连接池创建处手工接入（本地比上游多约 143 行）
- [x] 合入 `databaseHealthMonitor/State/Routes.ts`、`_core/context.ts`、`_core/trpc.ts`、`selfTestTiming.ts` 的改动；guard 错误统一返回 503 busy
- [x] `dbSchema.ts` 的 `ensurePostgresqlSchema` 改为先查 catalog
- [x] 保留本地 `isDatabaseTransactionActive` 的共享读取绕过（3.10.0 死锁修复）
- [x] 移植 `databaseNetworkGuard.test.ts`、`databaseHealth.test.ts`、`postgresqlSchemaMigration.test.ts` 并登记脚本；SQLite、MariaDB、PG 全部回归
