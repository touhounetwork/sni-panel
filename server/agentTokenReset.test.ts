import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

// Runs in a child process: the Agent routes keep background timers alive.
test("resetting a Token keeps the host and rejects the old Token while the new one takes the host over", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-token-reset-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { once } from "node:events";
    import http from "node:http";
    import express from "express";
    import { connectDatabase, closeDatabase, executeRaw, queryRaw } from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { agentRouter } from "./server/agentRoutes.ts";
    import { encryptPayload, decryptPayload } from "./server/agentCrypto.ts";
    import { agentTokensRouter } from "./server/routers/agentTokens.ts";
    const context = (id, role) => ({ user: { id, username: "u" + id, role }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null });
    const admin = agentTokensRouter.createCaller(context(1, "admin"));
    const ordinary = agentTokensRouter.createCaller(context(2, "user"));
    const server = http.createServer(express().use(express.json()).use(agentRouter));
    let base;
    const register = async (token, installationId) => {
      const response = await fetch(base + "/api/sync", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(encryptPayload({ path: "/api/agent/register", installationId, payload: { token, ip: "203.0.113.20", ipv4: "203.0.113.20", agentVersion: "3.10.0" } }, token)) });
      const text = await response.text();
      let body = null;
      try { body = decryptPayload(JSON.parse(text), token, { validateTimestamp: false }); } catch {}
      return { status: response.status, body };
    };
    try {
      await connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      await executeRaw('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)', [1, "owner", "hash", "admin"]);
      await executeRaw('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)', [2, "other", "hash", "user"]);
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      base = "http://127.0.0.1:" + server.address().port;

      const { id: tokenId, token: oldToken } = await admin.create({ description: "reset host" });
      const first = await register(oldToken, "a".repeat(64));
      assert.equal(first.status, 200);
      const hostId = first.body.hostId;
      await executeRaw('UPDATE hosts SET "entryIp" = ? WHERE id = ?', ["198.51.100.20", hostId]);

      await assert.rejects(ordinary.reset({ id: tokenId }), { code: "FORBIDDEN" });
      await assert.rejects(admin.reset({ id: 999 }), /Token 不存在/);
      assert.deepEqual(await admin.reset({ id: tokenId }), { success: true, hostCount: 1 });

      const newToken = (await admin.getInstallToken({ id: tokenId })).token;
      assert.notEqual(newToken, oldToken);
      assert.equal(newToken.length, 32);
      const [host] = await queryRaw('SELECT id, name, "agentToken", "entryIp" FROM hosts');
      assert.equal(host.id, hostId, "the host record is kept");
      assert.equal(host.agentToken, newToken);
      assert.equal(host.entryIp, "198.51.100.20", "host configuration is untouched");
      assert.equal((await queryRaw('SELECT COUNT(*) AS c FROM agent_tokens'))[0].c, 1, "no extra Token is created");

      assert.notEqual((await register(oldToken, "a".repeat(64))).status, 200, "the old Token is rejected");
      const takeover = await register(newToken, "b".repeat(64));
      assert.equal(takeover.status, 200);
      assert.equal(takeover.body.hostId, hostId, "reinstalling with the new Token takes over the same host");
      assert.equal(takeover.body.message, "Host updated");
      assert.equal((await queryRaw('SELECT COUNT(*) AS c FROM hosts'))[0].c, 1);

      const audits = await queryRaw('SELECT source, "beforeJson", "afterJson" FROM config_audit_events WHERE "resourceType" = ? AND "resourceId" = ?', ["host", hostId]);
      const audit = audits.find((row) => row.source === "admin:agent-token-reset");
      assert.ok(audit, "the reset is audited");
      for (const value of [oldToken, newToken]) assert.ok(!JSON.stringify(audit).includes(value), "audit never stores the Token");

      // An unbound Token can be reset as well.
      const unbound = await admin.create({ description: "spare" });
      assert.deepEqual(await admin.reset({ id: unbound.id }), { success: true, hostCount: 0 });
      assert.notEqual((await admin.getInstallToken({ id: unbound.id })).token, unbound.token);
    } finally {
      server.closeAllConnections?.(); server.close();
      await closeDatabase().catch(() => {});
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "panel.db"), FORWARDX_DEV_PANEL: "1", JWT_SECRET: "token-reset-test-secret-with-more-than-32-characters", FORWARDX_LOG_DIR: directory },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
