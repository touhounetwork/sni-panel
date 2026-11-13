import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveInstallHook } from "./hostInstallHooks";
import { generateInstallScript } from "./agentInstallScripts";

test("install hook precedence: inherit, custom, append, disabled", () => {
  const g = { source: "global", command: "echo g" };
  const h = { source: "host", command: "echo h" };
  assert.deepEqual(resolveInstallHook("inherit", "echo h", "echo g"), { source: "global", steps: [g] });
  assert.deepEqual(resolveInstallHook("inherit", "echo h", ""), { source: null, steps: [] });
  assert.deepEqual(resolveInstallHook("custom", "echo h", "echo g"), { source: "host", steps: [h] });
  // Append runs the global command first, then the host command.
  assert.deepEqual(resolveInstallHook("append", "echo h", "echo g"), { source: "global+host", steps: [g, h] });
  assert.deepEqual(resolveInstallHook("append", "echo h", ""), { source: "host", steps: [h] });
  assert.deepEqual(resolveInstallHook("disabled", "echo h", "echo g"), { source: null, steps: [] });
});

test("install script runs the hook after install and upgrade without embedding any command", () => {
  const script = generateInstallScript("https://panel.example");
  const install = script.slice(script.indexOf("do_install() {"), script.indexOf("do_upgrade() {"));
  const upgrade = script.slice(script.indexOf("do_upgrade() {"));
  assert.ok(install.indexOf("start_agent_service") < install.indexOf("run_post_install_hook install"));
  assert.ok(upgrade.indexOf("register_agent_once") < upgrade.indexOf("run_post_install_hook upgrade"));
  // Old Agents without the flag are skipped; a failure never aborts the installer.
  assert.match(script, /-h 2>&1 \| grep -q -- "-post-install"/);
  assert.match(script, /-post-install "\$MODE" \|\| echo "\[警告\]/);
  const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("install hook storage, Agent endpoints, admin router, audit and host deletion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-install-hook-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import express from "express";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { agentRouter } from "./server/agentRoutes.ts";
    import { hostsRouter } from "./server/routers/hosts.ts";
    import { encryptPayload } from "./server/agentCrypto.ts";
    import * as hostRepo from "./server/repositories/hostRepository.ts";
    const insert = (table, values) => runtime.executeRaw('INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(",") + ") VALUES (" + Object.keys(values).map(() => "?").join(",") + ")", Object.values(values));
    const ctx = (role) => ({ req: { headers: {} }, res: { clearCookie() {} }, user: { id: role === "admin" ? 1 : 2, username: role, role, accountEnabled: true }, authSession: null, authFailureReason: null });
    const admin = hostsRouter.createCaller(ctx("admin"));
    const ordinary = hostsRouter.createCaller(ctx("user"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      const now = Math.floor(Date.now() / 1000);
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin" });
      await insert("users", { id: 2, username: "user", password: "x", role: "user" });
      for (const id of [1, 2]) await insert("hosts", { id, name: "h" + id, ip: "192.0.2." + id, agentToken: "token-" + id, agentInstallationId: id === 2 ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : null, userId: 1, isOnline: 1, lastHeartbeat: now, agentVersion: "3.10.0" });

      // Admin-only.
      await assert.rejects(ordinary.installHook({ hostId: 1 }));
      await assert.rejects(ordinary.saveGlobalInstallHook({ command: "id" }));

      const secret = "export API_KEY=super-secret-value; ./setup.sh";
      await admin.saveGlobalInstallHook({ command: "echo global" });
      await admin.saveInstallHook({ hostId: 1, mode: "custom", command: secret });
      await assert.rejects(admin.saveInstallHook({ hostId: 2, mode: "custom", command: "   " }), /必须填写命令/);
      await assert.rejects(admin.saveInstallHook({ hostId: 2, mode: "append", command: "" }), /追加本节点命令.*必须填写命令/);
      await assert.rejects(admin.saveInstallHook({ hostId: 2, mode: "custom", command: "x".repeat(64 * 1024 + 1) }), /64KB/);

      // Audit records a digest, never the command.
      const audit = await runtime.queryRaw('SELECT * FROM config_audit_events ORDER BY id');
      assert.ok(audit.length >= 2, "global and host changes are audited");
      const auditText = JSON.stringify(audit);
      assert.ok(!auditText.includes("super-secret-value") && !auditText.includes("echo global"), "audit leaked the command");
      assert.ok(auditText.includes("sha256"));

      // Agent side, over the real encrypted /api/sync channel.
      const app = express(); app.use(express.json({ limit: "10mb" }));
      app.use(agentRouter);
      const server = http.createServer(app); await new Promise(r => server.listen(0, "127.0.0.1", r));
      const call = async (token, installationId, path, payload) => {
        const env = encryptPayload({ path, payload, installationId }, token);
        const res = await fetch("http://127.0.0.1:" + server.address().port + "/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
        return res.json();
      };
      const decode = async (body, token) => body && body.iv ? (await import("./server/agentCrypto.ts")).decryptPayload(body, token) : body;
      let got = await decode(await call("token-1", "", "/api/agent/install-hook", { mode: "install" }), "token-1");
      assert.deepEqual(got.steps, [{ source: "host", command: secret }]); assert.equal(got.source, "host"); assert.equal(got.hostId, 1);
      got = await decode(await call("token-2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/api/agent/install-hook", { mode: "upgrade" }), "token-2");
      assert.deepEqual(got.steps, [{ source: "global", command: "echo global" }]); assert.equal(got.source, "global");
      await admin.saveInstallHook({ hostId: 2, mode: "append", command: "echo node2" });
      got = await decode(await call("token-2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/api/agent/install-hook", { mode: "upgrade" }), "token-2");
      assert.equal(got.source, "global+host");
      assert.deepEqual(got.steps.map(step => step.command), ["echo global", "echo node2"]);
      // A retired installation of host 2 gets nothing.
      got = await decode(await call("token-2", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "/api/agent/install-hook", { mode: "upgrade" }), "token-2");
      assert.ok(!got.steps?.length, "retired installation received the command: " + JSON.stringify(got));

      const big = "x".repeat(1024 * 1024 + 10) + "TAIL";
      got = await decode(await call("token-1", "", "/api/agent/install-hook-result", { runMode: "upgrade", agentVersion: "3.10.0", source: "host", exitCode: 3, timedOut: false, durationMs: 1234, output: big, outputTruncated: false }), "token-1");
      assert.equal(got.success, true);
      const view = await admin.installHook({ hostId: 1 });
      assert.equal(view.lastResult.exitCode, 3);
      assert.equal(view.lastResult.runMode, "upgrade");
      assert.equal(view.lastResult.outputTruncated, true);
      assert.equal(Buffer.byteLength(view.lastResult.output), 1024 * 1024);
      assert.ok(view.lastResult.output.endsWith("TAIL"));

      // Switching away from "custom" keeps the stored command for later.
      await admin.saveInstallHook({ hostId: 1, mode: "disabled", command: "" });
      const disabled = await admin.installHook({ hostId: 1 });
      assert.equal(disabled.command, secret); assert.deepEqual(disabled.effective.steps, []);

      server.closeAllConnections(); await new Promise(r => server.close(r));
      await hostRepo.deleteHost(1);
      assert.equal((await runtime.queryRaw('SELECT COUNT(*) AS n FROM host_install_hooks WHERE "hostId" = 1'))[0].n, 0);
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
