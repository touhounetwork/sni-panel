import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";

// Opt-in only (FORWARDX_TEST_MYSQL_URL). MariaDB 11.6.2+ enables
// innodb_snapshot_isolation: once a transaction has read a row, locking a row
// that another session committed afterwards fails with ER_CHECKREAD (1020)
// instead of waiting. Traffic reports update users.trafficUsed constantly, so
// saving a rule could fail with "Record has changed since last read in table
// 'users'". All work happens in a unique database created and dropped here.
test("rule saves recover from MariaDB snapshot conflicts on the owner row", {
  skip: !process.env.FORWARDX_TEST_MYSQL_URL,
  timeout: 120_000,
}, async (t) => {
  const url = new URL(process.env.FORWARDX_TEST_MYSQL_URL!);
  const database = `forwardx_checkread_test_${randomBytes(8).toString("hex")}`;
  const connection = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  const admin = await mysql.createConnection(connection);
  process.env.DATABASE_TYPE = "mysql";
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const { withPersonalRuleGroupLock } = await import("./repositories/ruleGroupRepository");
  let created = false;
  let writer: mysql.Connection | undefined;
  try {
    const [[{ isolation }]] = await admin.query<any[]>("SELECT COALESCE(@@innodb_snapshot_isolation, 0) AS isolation").catch(() => [[{ isolation: 0 }]] as any);
    if (!Number(isolation)) {
      t.skip("server does not enforce innodb_snapshot_isolation");
      return;
    }
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    await runtime.connectDatabase({ type: "mysql", mysql: { ...connection, database } });
    await ensureDatabaseSchema();
    await runtime.executeRaw("INSERT INTO users (id, username, password, role) VALUES (1, 'owner', 'x', 'admin')");
    await runtime.executeRaw("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'entry', '192.0.2.1', 1)");
    writer = await mysql.createConnection({ ...connection, database });
    // What a traffic report does to the owner row, committed by another session.
    const reportTraffic = () => writer!.query("UPDATE users SET trafficUsed = trafficUsed + 1 WHERE id = 1");

    // Reproduce: the SNI save path reads first, then takes the owner lock.
    const conflictingSave = async () => {
      await runtime.queryRaw("SELECT trafficUsed FROM users WHERE id = 1");
      await reportTraffic();
      await withPersonalRuleGroupLock(1, async () => undefined);
    };
    await assert.rejects(runtime.withDatabaseTransaction(conflictingSave), (error: any) => {
      for (let current = error; current; current = current.cause) {
        if (current.code === "ER_CHECKREAD" || Number(current.errno) === 1020) return true;
      }
      return false;
    }, "the unretried save must reproduce ER_CHECKREAD");

    // Fixed: the outer save transaction replays once with a fresh snapshot.
    let attempts = 0;
    await runtime.withDatabaseTransaction(async () => {
      attempts++;
      await runtime.queryRaw("SELECT trafficUsed FROM users WHERE id = 1");
      if (attempts === 1) await reportTraffic();
      await withPersonalRuleGroupLock(1, async () => {
        await runtime.executeRaw("UPDATE hosts SET name = ? WHERE id = 1", [`saved-${attempts}`]);
      });
    }, { retryConflicts: true });
    assert.equal(attempts, 2);
    const [[host]] = await writer.query<any[]>("SELECT name FROM hosts WHERE id = 1");
    assert.equal(host.name, "saved-2", "only the successful attempt is committed");

    // The owner lock also retries on its own when it owns the transaction.
    let lockAttempts = 0;
    await withPersonalRuleGroupLock(1, async () => {
      lockAttempts++;
      await runtime.queryRaw("SELECT name FROM hosts WHERE id = 1");
      if (lockAttempts === 1) await writer!.query("UPDATE hosts SET name = 'agent-report' WHERE id = 1");
      await runtime.executeRaw("UPDATE hosts SET name = ? WHERE id = 1", [`locked-${lockAttempts}`]);
    });
    assert.equal(lockAttempts, 2);
    const [[locked]] = await writer.query<any[]>("SELECT name FROM hosts WHERE id = 1");
    assert.equal(locked.name, "locked-2");
  } finally {
    await writer?.end().catch(() => undefined);
    await runtime.closeDatabase().catch(() => undefined);
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
