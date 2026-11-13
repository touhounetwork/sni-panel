import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("batch commands: delivery, Agent pull/result, cancel, deadline, retention and audit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-command-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    // First on purpose: the router must not read limits from a half-loaded hostCommands.ts.
    import { normalizeCommandInput } from "./server/hostCommands.ts";
    import express from "express";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { agentRouter } from "./server/agentRoutes.ts";
    import { hostsRouter } from "./server/routers/hosts.ts";
    import { encryptPayload, decryptPayload } from "./server/agentCrypto.ts";
    import { registerAgentEventClient } from "./server/agentEvents.ts";
    const insert = (table, values) => runtime.executeRaw('INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(",") + ") VALUES (" + Object.keys(values).map(() => "?").join(",") + ")", Object.values(values));
    const ctx = (role) => ({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: role === "admin" ? 1 : 2, username: role, role, accountEnabled: true }, authSession: null, authFailureReason: null });
    const admin = hostsRouter.createCaller(ctx("admin"));
    const ordinary = hostsRouter.createCaller(ctx("user"));
    const INSTALL = "a".repeat(64);
    // A fake SSE response that records the decrypted events for each host.
    const events = new Map();
    const connect = (hostId, token) => {
      events.set(hostId, []);
      registerAgentEventClient(hostId, token, { write(frame) {
        const body = JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
        events.get(hostId).push(decryptPayload(body, token));
        return true;
      }, once() {} });
    };
    assert.deepEqual(normalizeCommandInput({ command: "  uptime\r\n", timeoutSeconds: 30 }), { command: "uptime", timeoutSeconds: 30 });
    assert.equal(normalizeCommandInput({ command: "id" }).timeoutSeconds, 300);
    assert.throws(() => normalizeCommandInput({ command: "x".repeat(64 * 1024 + 1) }), /64KB/);
    assert.throws(() => normalizeCommandInput({ command: "id", timeoutSeconds: 9 }), /10 秒到 3600 秒/);
    assert.throws(() => normalizeCommandInput({ command: "id", timeoutSeconds: 3601 }), /10 秒到 3600 秒/);
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin" });
      await insert("users", { id: 2, username: "user", password: "x", role: "user" });
      const versions = { 1: "3.10.0", 2: "3.10.0", 3: "3.9.0", 4: "3.10.0" };
      for (const id of [1, 2, 3, 4]) await insert("hosts", { id, name: "h" + id, ip: "192.0.2." + id, agentToken: "token-" + id, agentInstallationId: id === 2 ? INSTALL : null, userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: versions[id] });
      connect(1, "token-1"); connect(2, "token-2"); connect(3, "token-3");
      // Host 4 has no event stream.

      await assert.rejects(ordinary.runCommand({ hostIds: [1], command: "id", timeoutSeconds: 30 }));
      await assert.rejects(ordinary.commandBatches());
      await assert.rejects(admin.runCommand({ hostIds: [99], command: "id", timeoutSeconds: 30 }), /节点不存在/);
      await assert.rejects(admin.runCommand({ hostIds: [1], command: "  ", timeoutSeconds: 30 }), /不能为空/);

      const secret = "export TOKEN=super-secret-value; uptime";
      const batch = await admin.runCommand({ hostIds: [1, 2, 3, 4], command: secret, timeoutSeconds: 30 });
      const byHost = Object.fromEntries(batch.results.map(r => [r.hostId, r]));
      assert.equal(byHost[1].status, "queued");
      assert.equal(byHost[2].status, "queued");
      assert.equal(byHost[3].status, "unsupported");
      assert.equal(byHost[4].status, "undelivered");
      assert.equal(batch.done, false);
      // The event stream carries only the task id, never the command.
      assert.deepEqual(events.get(1), [{ type: "agent-command", data: { taskId: byHost[1].taskId } }]);
      assert.equal(events.get(3).length, 0, "an unsupported Agent was sent the task");
      assert.ok(!JSON.stringify([...events.values()]).includes("super-secret"));

      // Audit records a digest, never the command.
      const auditText = JSON.stringify(await runtime.queryRaw('SELECT * FROM config_audit_events'));
      assert.ok(auditText.includes("admin:host-command") && auditText.includes("sha256"));
      assert.ok(!auditText.includes("super-secret-value"), "audit leaked the command");

      // Agent side, over the real encrypted /api/sync channel.
      const app = express(); app.use(express.json({ limit: "10mb" }));
      app.use(agentRouter);
      const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
      const call = async (token, installationId, path, payload) => {
        const env = encryptPayload({ path, payload, installationId }, token);
        const res = await fetch("http://127.0.0.1:" + server.address().port + "/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
        const body = await res.json();
        return body && body.iv ? decryptPayload(body, token) : body;
      };

      // Another host cannot pull host 1's task; a retired installation gets nothing.
      assert.equal((await call("token-2", INSTALL, "/api/agent/command-pull", { taskId: byHost[1].taskId })).success, false);
      const retired = await call("token-2", "b".repeat(64), "/api/agent/command-pull", { taskId: byHost[2].taskId });
      assert.ok(retired.agentSuperseded === true && !retired.command, "retired installation received the command: " + JSON.stringify(retired));

      let pulled = await call("token-1", "", "/api/agent/command-pull", { taskId: byHost[1].taskId });
      assert.equal(pulled.success, true); assert.equal(pulled.command, secret); assert.equal(pulled.timeoutSeconds, 30); assert.equal(pulled.hostId, 1);
      assert.equal((await admin.commandBatch({ batchId: batch.id })).results.find(r => r.hostId === 1).status, "running");

      const big = "x".repeat(1024 * 1024 + 10) + "TAIL";
      assert.equal((await call("token-1", "", "/api/agent/command-result", { taskId: byHost[1].taskId, exitCode: 2, timedOut: false, cancelled: false, durationMs: 1234, output: big, outputTruncated: false })).success, true);
      let view = await admin.commandBatch({ batchId: batch.id });
      let r1 = view.results.find(r => r.hostId === 1);
      assert.equal(r1.status, "failed"); assert.equal(r1.exitCode, 2); assert.equal(r1.durationMs, 1234);
      assert.equal(r1.outputTruncated, true); assert.equal(Buffer.byteLength(r1.output), 1024 * 1024); assert.ok(r1.output.endsWith("TAIL"));
      // A finished task cannot be pulled again.
      assert.equal((await call("token-1", "", "/api/agent/command-pull", { taskId: byHost[1].taskId })).success, false);

      // Cancel a single host: it is pushed a cancel event and stays cancelled after a late result.
      pulled = await call("token-2", INSTALL, "/api/agent/command-pull", { taskId: byHost[2].taskId });
      assert.equal(pulled.success, true);
      view = await admin.cancelCommand({ batchId: batch.id, hostId: 2 });
      assert.equal(view.results.find(r => r.hostId === 2).status, "cancelled");
      assert.deepEqual(events.get(2).at(-1), { type: "agent-command-cancel", data: { taskId: byHost[2].taskId } });
      await call("token-2", INSTALL, "/api/agent/command-result", { taskId: byHost[2].taskId, exitCode: 0, timedOut: false, cancelled: false, durationMs: 5, output: "late", outputTruncated: false });
      view = await admin.commandBatch({ batchId: batch.id });
      const r2 = view.results.find(r => r.hostId === 2);
      assert.equal(r2.status, "cancelled"); assert.equal(r2.output, "late");
      assert.equal(view.done, true);
      assert.equal(view.counts.failed, 1); assert.equal(view.counts.cancelled, 1);

      // Cancel the whole batch: open hosts are cancelled and a cancelled task is not pulled.
      const second = await admin.runCommand({ hostIds: [1, 2], command: "sleep 100", timeoutSeconds: 60 });
      view = await admin.cancelCommand({ batchId: second.id });
      assert.ok(view.cancelledAt); assert.ok(view.results.every(r => r.status === "cancelled"));
      assert.equal((await call("token-1", "", "/api/agent/command-pull", { taskId: second.results[0].taskId })).success, false);

      // Past the deadline an open task becomes a timeout and is no longer pulled.
      const third = await admin.runCommand({ hostIds: [1], command: "id", timeoutSeconds: 10 });
      await runtime.executeRaw('UPDATE command_batch_results SET "deadlineAt" = ? WHERE "batchId" = ?', [now - 1, third.id]);
      assert.equal((await call("token-1", "", "/api/agent/command-pull", { taskId: third.results[0].taskId })).success, false);
      view = await admin.commandBatch({ batchId: third.id });
      assert.equal(view.results[0].status, "timeout"); assert.equal(view.done, true);

      // History lists newest first; batches older than 30 days are purged.
      let history = await admin.commandBatches();
      assert.deepEqual(history.map(item => item.id), [third.id, second.id, batch.id]);
      assert.equal(history.at(-1).hostCount, 4);
      assert.equal((await admin.managementCounts()).commands, 3);
      await runtime.executeRaw('UPDATE command_batches SET "createdAt" = ? WHERE id = ?', [now - 31 * 24 * 3600, batch.id]);
      history = await admin.commandBatches();
      assert.ok(!history.some(item => item.id === batch.id));
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM command_batch_results WHERE "batchId" = ?', [batch.id]))[0].n, 0);
      await assert.rejects(admin.commandBatch({ batchId: batch.id }), /不存在或已过期/);

      server.closeAllConnections(); await new Promise(r => server.close(r));
    } finally {
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
