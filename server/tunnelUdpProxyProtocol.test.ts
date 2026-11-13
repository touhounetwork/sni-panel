import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Saving the tunnel UDP PROXY switch: ForwardX only, v2 only, and every entry
// Agent must be 3.10.0+ (older entries reject PROXY on UDP-only rules).
test("tunnel UDP PROXY switch requires ForwardX, v2 and 3.10.0 entry Agents", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-udp-proxy-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { tunnelsRouter } from "./server/routers/tunnels.ts";
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(",") + ") VALUES (" + Object.keys(values).map(() => "?").join(",") + ")", Object.values(values));
    const tunnelRow = async id => (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [id]))[0];
    const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
    const caller = tunnelsRouter.createCaller(context);
    const rejects = async (work, pattern) => {
      let caught;
      try { await work; } catch (error) { caught = error; }
      assert.ok(caught && pattern.test(String(caught.message)), "expected " + pattern + ", got " + (caught ? caught.message : "success"));
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1 });
      await insert("hosts", { id: 1, name: "entry", ip: "192.0.2.1", ipv4: "192.0.2.1", agentToken: "t1", userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: "3.9.0", portRangeStart: 20000, portRangeEnd: 21000 });
      await insert("hosts", { id: 2, name: "exit", ip: "192.0.2.2", ipv4: "192.0.2.2", agentToken: "t2", userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: "3.10.0", portRangeStart: 20000, portRangeEnd: 21000 });
      await insert("tunnels", { id: 70, name: "fx", entryHostId: 1, exitHostId: 2, mode: "forwardx", listenPort: 20500, userId: 1, isEnabled: 1 });
      await insert("tunnels", { id: 71, name: "tls", entryHostId: 1, exitHostId: 2, mode: "tls", listenPort: 20501, userId: 1, isEnabled: 1 });
      const udp = { proxyProtocolSend: true, proxyProtocolExitSend: true, proxyProtocolUdp: true };

      await rejects(caller.update({ id: 70, ...udp, proxyProtocolVersion: 1 }), /v1 没有 UDP 格式/);
      await rejects(caller.update({ id: 70, ...udp, proxyProtocolVersion: 2 }), /3\.10\.0/);
      assert.equal(Number((await tunnelRow(70)).proxyProtocolUdp), 0);

      await runtime.executeRaw('UPDATE "hosts" SET "agentVersion" = ? WHERE "id" = 1', ["3.10.0"]);
      await caller.update({ id: 70, ...udp, proxyProtocolVersion: 2 });
      const saved = await tunnelRow(70);
      assert.equal(Number(saved.proxyProtocolUdp), 1);
      assert.equal(Number(saved.proxyProtocolVersion), 2);

      // Other tunnel modes cannot carry a header per datagram; the switch is dropped.
      await caller.update({ id: 71, ...udp, proxyProtocolVersion: 2 });
      assert.equal(Number((await tunnelRow(71)).proxyProtocolUdp), 0);
      assert.equal(Number((await tunnelRow(71)).proxyProtocolSend), 1);
    } finally {
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
