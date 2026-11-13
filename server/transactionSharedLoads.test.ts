import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createQueryCache, setQueryCacheIsolationCheck } from "./queryCache";

// A SQLite transaction owns the only connection. A shared load started
// outside it is queued behind that transaction, so a transaction joining the
// load waits for itself. Seen as an intermittent hang in concurrent batch
// saves (linkAccessView scope and system settings).

test("query cache loads inside an isolated scope neither join nor publish shared loads", async () => {
  let isolated = false;
  setQueryCacheIsolationCheck(() => isolated);
  try {
    const cache = createQueryCache(10);
    let release!: (value: string) => void;
    const outside = cache.get("k", { ttlMs: 1000 }, () => new Promise<string>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    isolated = true;
    // Would never settle if it joined the pending outside load.
    assert.equal(await cache.get("k", { ttlMs: 1000 }, async () => "inside"), "inside");
    isolated = false;
    release("outside");
    assert.equal(await outside, "outside");
    assert.equal(await cache.get("k", { ttlMs: 1000 }, async () => "unused"), "outside", "the inside value was not published");
  } finally {
    setQueryCacheIsolationCheck(() => false);
  }
});

test("SQLite transactions do not join shared loads queued behind them", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tx-shared-load-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { getAllSettings } from "./server/repositories/settingsRepository.ts";
    import { createQueryCache } from "./server/queryCache.ts";
    const watchdog = setTimeout(() => { console.error("transaction deadlocked on a shared load"); process.exit(2); }, 10_000);
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await ensureDatabaseSchema();
    const cache = createQueryCache(10);
    const load = async () => (await runtime.queryRaw("SELECT COUNT(*) AS n FROM system_settings"))[0].n;
    let outsideSettings, outsideCached;
    let started;
    const outsideStarted = new Promise(resolve => { started = resolve; });
    const transaction = runtime.withDatabaseTransaction(async () => {
      await outsideStarted;
      // Both shared loads below are in flight and queued behind this transaction.
      assert.ok(Object.keys(await getAllSettings()).length > 0);
      assert.ok(Number(await cache.get("count", { ttlMs: 1000 }, load)) > 0);
    });
    // Start the shared loads outside the transaction context.
    setImmediate(() => {
      outsideSettings = getAllSettings();
      outsideCached = cache.get("count", { ttlMs: 1000 }, load);
      setImmediate(started);
    });
    await transaction;
    assert.ok(Object.keys(await outsideSettings).length > 0);
    assert.ok(Number(await outsideCached) > 0);
    clearTimeout(watchdog);
    await runtime.closeDatabase();
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
