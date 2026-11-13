import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// SNI PROXY Protocol, default route and per-port domain uniqueness on a real
// SQLite panel: save through the router, then read the splitter table the
// heartbeat hands to each entry Agent.

function verifySniProxyScenario(body: string, agentVersion = "3.10.0") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-sni-proxy-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import http from "node:http";
    import express from "express";
    import * as runtime from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { rulesRouter } from "./server/routers/rules.ts";
    import * as groups from "./server/repositories/forwardGroupRepository.ts";
    import * as savedRules from "./server/repositories/forwardRuleRepository.ts";
    import * as settings from "./server/repositories/settingsRepository.ts";
    import * as users from "./server/repositories/userRepository.ts";
    import * as billing from "./server/repositories/trafficBillingRepository.ts";
    import { registerAgentHeartbeatRoute } from "./server/agentHeartbeatRoute.ts";
    import { trafficBillingUserLockKey, withKeyedTaskLock } from "./server/keyedTaskLock.ts";
    const AGENT_VERSION = ${JSON.stringify(agentVersion)};
    const insert = (table, values) => runtime.executeRaw(
      'INSERT INTO "' + table + '" (' + Object.keys(values).map(k => '"' + k + '"').join(',') + ') VALUES (' + Object.keys(values).map(() => '?').join(',') + ')', Object.values(values));
    const context = user => ({ req: { headers: {} }, res: { clearCookie() {} }, user, authSession: null, authFailureReason: null });
    const admin = rulesRouter.createCaller(context({ id: 1, username: "admin", role: "admin", accountEnabled: true }));
    const within = async (work, label) => {
      const watchdog = setTimeout(() => { console.error(label + " did not finish within 5 seconds"); process.exit(2); }, 5000);
      try { return await work; } finally { clearTimeout(watchdog); }
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.agentToken = String(req.headers.authorization || "").replace("Bearer ", ""); next(); });
    registerAgentHeartbeatRoute(app);
    const server = http.createServer(app);
    let beforeHeartbeat = () => {};
    const heartbeat = async (id, localRules = []) => {
      beforeHeartbeat();
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/agent/heartbeat", {
        method: "POST", headers: { authorization: "Bearer token-" + id, "content-type": "application/json" },
        body: JSON.stringify({ agentVersion: AGENT_VERSION, agentBootId: "proxy-boot-" + id, agentProcessId: 1000 + id, forceReconcile: true, localState: { rules: localRules } }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.success, true);
      return result;
    };
    const splitter = result => result.desiredState.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter" && action.sourcePort === 18443);
    const localRules = config => config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, sourceAllowIps: [], ready: true }));
    const createRules = async (prefix, count) => {
      const ids = [];
      for (let index = 0; index < count; index++) {
        const rule = await admin.create({ forwardGroupId: 10, name: prefix + "-" + index, sourcePort: 18443, targetIp: "203.0.113.10", targetPort: 19443 + index, sni: prefix + "-" + index + ".example.test", isEnabled: true });
        ids.push(Number(rule.id));
      }
      return ids;
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await ensureDatabaseSchema();
      await insert("users", { id: 1, username: "admin", password: "x", role: "admin", canAddRules: 1, manualCanAddRules: 1, balanceCents: 1000 });
      await insert("users", { id: 2, username: "other", password: "x", role: "user", canAddRules: 1, manualCanAddRules: 1 });
      for (const id of [1, 2]) await insert("hosts", { id, name: "entrance-" + id, ip: "192.0.2." + id, ipv4: "192.0.2." + id, agentToken: "token-" + id, userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: AGENT_VERSION, portRangeStart: 18000, portRangeEnd: 19000 });
      await insert("forward_groups", { id: 10, name: "delete-test", groupType: "host", groupMode: "failover", forwardType: "nftables", domain: "", targetIp: "0.0.0.0", targetPort: 1, userId: 1, isEnabled: 1, failoverSeconds: 10, recoverSeconds: 10 });
      for (const id of [1, 2]) await insert("forward_group_members", { id: 100 + id, groupId: 10, memberType: "host", hostId: id, priority: id * 10, isEnabled: 1 });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      ${body}
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await runtime.closeDatabase();
    }
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db") }, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}


const portGroup = String.raw`
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    // Unchanged desired state is only resent after this interval.
    beforeHeartbeat = () => mock.timers.tick(5 * 60 * 1000);
    const service = await import("./server/services/forwardGroupService.ts");
    const input = { name: "proxy", groupType: "host", forwardType: "gost", protocol: "tcp", isEnabled: true,
      autoFailback: true, failoverSeconds: 10, recoverSeconds: 10, ddnsAutoResolveEnabled: false };
    const entryId = await service.createForwardGroupFromInput({ ...input, groupMode: "entry", domain: "proxy.example.test",
      members: [1, 2].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) }, 1);
    await service.updateForwardGroupFromInput(10, { ...input, groupMode: "port", entryGroupId: entryId, members: [] });
    const tableAt = async (port, hostId = 1, rules = []) => {
      const result = await heartbeat(hostId, rules);
      const action = result.desiredState?.actions.find(action => action.op === "apply" && action.fxp?.role === "sni-splitter" && action.sourcePort === port);
      return action?.fxp;
    };
    const create = (name, port, sni, extra = {}) => admin.create({ forwardGroupId: 10, name, sourcePort: port, targetIp: "127.0.0.1", targetPort: 20000 + port % 1000, sni, isEnabled: true, ...extra });
    const rejects = async (work, pattern) => {
      let caught;
      try { await work; } catch (error) { caught = error; }
      assert.ok(caught && pattern.test(String(caught?.message || caught)), "expected rejection matching " + pattern + ", got " + (caught ? caught.message : "success"));
    };
`;

test("SNI send switch and version reach the splitter route; receive is synchronized across the entry port", () => {
  verifySniProxyScenario(portGroup + String.raw`
    const a = await create("a", 18443, "a.example.test", { proxyProtocolSend: true, proxyProtocolVersion: 2 });
    const b = await create("b", 18443, "b.example.test");
    let table = await tableAt(18443);
    const route = sni => table.sniRoutes.find(item => item.sni === sni);
    assert.deepEqual(
      { receive: route("a.example.test").proxyProtocolReceive, send: route("a.example.test").proxyProtocolSend, version: route("a.example.test").proxyProtocolVersion },
      { receive: undefined, send: true, version: 2 });
    assert.equal(route("b.example.test").proxyProtocolSend, undefined, "send stays per rule");

    // Enabling receive on one rule applies to every SNI rule on the port.
    await admin.update({ id: b.id, proxyProtocolReceive: true });
    table = await tableAt(18443);
    assert.ok(table.sniRoutes.every(item => item.proxyProtocolReceive === true), JSON.stringify(table.sniRoutes));
    for (const id of [a.id, b.id]) assert.equal(Boolean((await savedRules.getForwardRuleById(Number(id))).proxyProtocolReceive), true);
    const children = await savedRules.getForwardGroupChildRules(10);
    assert.ok(children.filter(rule => !rule.pendingDelete).every(rule => Boolean(rule.proxyProtocolReceive)), "member copies follow the port switch");

    // A new rule on the port inherits receive when the field is omitted.
    await create("c", 18443, "c.example.test");
    table = await tableAt(18443);
    assert.equal(route("c.example.test").proxyProtocolReceive, true);

    // Other ports keep their own switch.
    await create("d", 18444, "d.example.test");
    assert.equal((await tableAt(18444)).sniRoutes[0].proxyProtocolReceive, undefined);

    // The panel only reports a rule as running once the splitter echoes the fields back.
    const echoed = config => config.sniRoutes.map(route => ({ ...route, port: config.listenPort, forwardType: "forwardx", protocol: "tcp", sniRouteVersion: config.sniRouteVersion, sourceAllowIps: [], ready: true }));
    const legacy = config => echoed(config).map(({ proxyProtocolReceive, proxyProtocolSend, proxyProtocolVersion, ...rest }) => rest);
    const current = await tableAt(18443);
    const applied = async () => (await admin.getById({ id: a.id })).sniRuntime.entries.find(entry => entry.hostId === 1).applied;
    await heartbeat(1, legacy(current));
    assert.equal(await applied(), false, "a splitter that drops the PROXY fields is not confirmed");
    await heartbeat(1, echoed(current));
    assert.equal(await applied(), true, "echoed PROXY fields confirm the route");
  `);
});

test("SNI PROXY switches are rejected on forward chains and below the minimum Agent version", () => {
  verifySniProxyScenario(portGroup + String.raw`
    await rejects(create("old", 18443, "old.example.test", { proxyProtocolSend: true }), /3\.10\.0/);
    await rejects(create("default", 18443, "*"), /3\.10\.0/);
    const plain = await create("plain", 18443, "plain.example.test");
    assert.ok(plain.id, "rules without the new fields keep working on old Agents");
    assert.equal((await tableAt(18443)).sniRoutes[0].proxyProtocolSend, undefined);
  `, "3.9.0");
  verifySniProxyScenario(String.raw`
    const service = await import("./server/services/forwardGroupService.ts");
    await insert("hosts", { id: 3, name: "exit", ip: "192.0.2.3", ipv4: "192.0.2.3", agentToken: "token-3", userId: 1, isOnline: 1, lastHeartbeat: Math.floor(Date.now() / 1000), agentVersion: AGENT_VERSION, portRangeStart: 18000, portRangeEnd: 30000 });
    const chainId = await service.createForwardGroupFromInput({ name: "chain", groupType: "host", forwardType: "gost", protocol: "tcp", isEnabled: true,
      autoFailback: true, failoverSeconds: 10, recoverSeconds: 10, ddnsAutoResolveEnabled: false, groupMode: "chain",
      members: [1, 3].map(hostId => ({ memberType: "host", hostId, isEnabled: true })) }, 1);
    await assert.rejects(admin.create({ forwardGroupId: chainId, name: "c", sourcePort: 18443, targetIp: "203.0.113.5", targetPort: 443, sni: "c.example.test", isEnabled: true, proxyProtocolSend: true }),
      /仅支持端口转发资源和主机型转发组/);
    const plain = await admin.create({ forwardGroupId: chainId, name: "d", sourcePort: 18443, targetIp: "203.0.113.5", targetPort: 443, sni: "*", isEnabled: true });
    assert.ok(plain.id, "the default route is allowed on chains");
  `);
});

test("SNI default route * is one per entry port and reaches the splitter", () => {
  verifySniProxyScenario(portGroup + String.raw`
    await create("named", 18443, "a.example.test");
    const fallback = await create("fallback", 18443, "*", { proxyProtocolSend: true, proxyProtocolVersion: 1 });
    const table = await tableAt(18443);
    const route = table.sniRoutes.find(item => item.sni === "*");
    const fallbackRule = await savedRules.getForwardRuleById(Number(route.ruleId));
    assert.equal(Number(fallbackRule.forwardGroupRuleId || fallbackRule.id), Number(fallback.id));
    assert.equal(route.proxyProtocolSend, true);
    await rejects(create("second", 18443, "*"), /冲突/);
    const other = await create("other", 18444, "*");
    assert.ok(other.id, "each port may have its own default route");
  `);
});

test("SNI domains are unique per entry host and port, not across ports", () => {
  verifySniProxyScenario(portGroup + String.raw`
    const first = await create("first", 18443, "same.example.test");
    const second = await admin.create({ forwardGroupId: 10, name: "second", sourcePort: 18444, targetIp: "127.0.0.2", targetPort: 21444, sni: "same.example.test", isEnabled: true });
    assert.ok(second.id, "the same domain on another port saves");
    const tableA = await tableAt(18443);
    const tableB = await tableAt(18444);
    assert.deepEqual(tableA.sniRoutes.map(route => [route.sni, route.targetIp, route.targetPort]), [["same.example.test", "127.0.0.1", 20443]]);
    assert.deepEqual(tableB.sniRoutes.map(route => [route.sni, route.targetIp, route.targetPort]), [["same.example.test", "127.0.0.2", 21444]]);
    await rejects(create("dup", 18443, "same.example.test"), /冲突/);
    await rejects(admin.update({ id: second.id, sourcePort: 18443 }), /冲突/);
    const check = await admin.checkSni({ forwardGroupId: 10, sourcePort: 18445, sni: "same.example.test" });
    assert.equal(check.ok, true);
    const blocked = await admin.checkSni({ forwardGroupId: 10, sourcePort: 18443, sni: "same.example.test" });
    assert.equal(blocked.ok, false);
    assert.ok(first.id);
  `);
});
