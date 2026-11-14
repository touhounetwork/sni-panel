import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-notifications-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "notifications.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.DISCORD_BOT_TOKEN = "";

let runtime: typeof import("./dbRuntime");
let hosts: typeof import("./repositories/hostRepository");
let settings: typeof import("./repositories/settingsRepository");
let notifier: typeof import("./hostStatusNotifier");
let router: typeof import("./routers/hosts").hostsRouter;
const context = (id: number, role: "admin" | "user") => ({ user: { id, role, username: `user-${id}` }, req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null }) as any;
const delayedNotifications: Array<() => void> = [];
const delayedNotificationDelays: number[] = [];
const originalSetTimeout = globalThis.setTimeout;

before(async () => {
  // Install before importing routes/repositories, which can load the notifier.
  // Capture only offline-alert waits (minutes); all other timers remain real.
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: any[]) => {
    if (delay >= 60_000) {
      delayedNotifications.push(callback);
      delayedNotificationDelays.push(delay);
      return { unref() {} } as any;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;
  try {
    runtime = await import("./dbRuntime");
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
    // Upgrade an existing database, not just a newly created hosts table.
    await runtime.executeRaw('CREATE TABLE hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, "userId" INTEGER NOT NULL, "createdAt" INTEGER NOT NULL DEFAULT 0, "updatedAt" INTEGER NOT NULL DEFAULT 0)');
    await runtime.executeRaw("INSERT INTO hosts (id, name, ip, userId) VALUES (1, 'legacy host', '198.51.100.1', 1)");
    await (await import("./dbSchema")).ensureDatabaseSchema();
    hosts = await import("./repositories/hostRepository");
    settings = await import("./repositories/settingsRepository");
    router = (await import("./routers/hosts")).hostsRouter;
    await runtime.insertAndGetId("users", { id: 1, username: "staff", password: "unused", role: "admin", telegramId: "1001", discordId: "123456789012345671" });
    await runtime.insertAndGetId("users", { id: 2, username: "customer", password: "unused", role: "user" });
    await settings.setSettings({ notificationChannel: "telegram", telegramBotEnabled: "true", telegramBotToken: "test-token",
      telegramHostStatusNotify: "true", discordBotEnabled: "true", discordBotToken: "test-token", discordHostStatusNotify: "true" });
    notifier = await import("./hostStatusNotifier");
  } catch (error) {
    throw new Error(`Host notification fixture setup failed: ${String(error)}`, { cause: error });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

after(async () => {
  globalThis.setTimeout = originalSetTimeout;
  await notifier?.primeHostStatusNotifier();
  await new Promise((resolve) => originalSetTimeout(resolve, 25));
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("schema upgrade and new hosts default to notifications enabled; only admins can change the preference", async () => {
  assert.equal((await hosts.getHostById(1))?.hostStatusNotifyEnabled, true);
  const definition = (await import("./dbSchema")).getDatabaseTableDefs().find((table) => table.name === "hosts")!;
  assert.deepEqual(definition.columns.find((column) => column.name === "hostStatusNotifyEnabled"), { name: "hostStatusNotifyEnabled", type: "bool", notNull: true, default: true });
  const staff = router.createCaller(context(1, "admin"));
  const customer = router.createCaller(context(2, "user"));
  const created = await staff.create({ name: "default", ip: "198.51.100.2" });
  assert.equal((await hosts.getHostById(created.id))?.hostStatusNotifyEnabled, true);
  const disabled = await staff.create({ name: "muted", ip: "198.51.100.3", hostStatusNotifyEnabled: false });
  assert.equal((await hosts.getHostById(disabled.id))?.hostStatusNotifyEnabled, false);
  await assert.rejects(customer.create({ name: "owned", ip: "198.51.100.4", hostStatusNotifyEnabled: false }), { code: "FORBIDDEN" });
  const owned = await staff.create({ name: "owned", ip: "198.51.100.4" });
  await staff.update({ id: owned.id, hostStatusNotifyEnabled: false });
  await assert.rejects(customer.update({ id: owned.id, hostStatusNotifyEnabled: true, name: "renamed" }), { code: "FORBIDDEN" });
  assert.equal((await hosts.getHostById(owned.id))?.hostStatusNotifyEnabled, false, "owner cannot override administrator preference");
  assert.equal((await hosts.getHostById(owned.id))?.name, "owned");
  await staff.update({ id: owned.id, name: "admin rename" });
  assert.equal((await hosts.getHostById(owned.id))?.hostStatusNotifyEnabled, false, "unrelated updates preserve the switch");
  await staff.update({ id: owned.id, hostStatusNotifyEnabled: true });
  assert.equal((await hosts.getHostById(owned.id))?.hostStatusNotifyEnabled, true);
  await assert.rejects(router.createCaller(context(99, "user")).update({ id: owned.id, hostStatusNotifyEnabled: false }), { code: "FORBIDDEN" });
});

test("both notification channels obey the host switch without suppressing offline state or replaying muted events", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, options) => {
    requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
    return Response.json({ ok: true, result: { message_id: 1 }, id: "234567890123456789" });
  }) as typeof fetch;
  const online = async () => {
    await hosts.touchHostHeartbeat(1);
    await notifier.notifyHostOnlineIfNeeded(await hosts.getHostById(1));
  };
  const offline = async () => {
    await runtime.executeRaw('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ? WHERE id = 1', [Math.floor(Date.now() / 1000) - 600]);
    assert.equal(await notifier.sweepOfflineHostsAndNotify(), 1);
    assert.equal((await hosts.getHostById(1))?.isOnline, false);
  };
  try {
    for (const channel of ["telegram", "discord"] as const) {
      await settings.setSettings({ notificationChannel: channel, [`${channel}HostStatusNotify`]: "true" });
      await hosts.updateHost(1, { hostStatusNotifyEnabled: true, isOnline: false });
      await notifier.primeHostStatusNotifier();
      requests.length = 0;
      await online();
      assert.ok(requests.some((request) => JSON.stringify(request.body).includes("主机上线通知")));
      assert.ok(requests.every((request) => request.url.startsWith(channel === "telegram" ? "https://api.telegram.org/" : "https://discord.com/")));
      requests.length = 0;
      await offline();
      assert.ok(requests.some((request) => JSON.stringify(request.body).includes("主机离线告警")));
      await hosts.updateHost(1, { hostStatusNotifyEnabled: false });
      requests.length = 0;
      await online();
      await offline();
      assert.equal(requests.length, 0, "both directions must be muted");
      await online();
      await hosts.updateHost(1, { hostStatusNotifyEnabled: true });
      await notifier.notifyHostOnlineIfNeeded(await hosts.getHostById(1));
      assert.equal(requests.length, 0, "enabling does not replay an already observed transition");
      await offline();
      assert.ok(requests.length > 0, "future transitions notify again");
      requests.length = 0;
      await settings.setSetting(`${channel}HostStatusNotify`, "false");
      await online();
      await offline();
      assert.equal(requests.length, 0, "global notification switch remains authoritative");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queued fast-offline notification reads the latest saved preference, not its captured host snapshot", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  try {
    await settings.setSettings({ notificationChannel: "telegram", telegramHostStatusNotify: "true" });
    await hosts.updateHost(1, { hostStatusNotifyEnabled: true });
    await hosts.touchHostHeartbeat(1);
    await notifier.primeHostStatusNotifier();
    delayedNotifications.length = 0;
    delayedNotificationDelays.length = 0;
    const now = Date.now();
    await notifier.handlePresenceCapableHostOffline({ kind: "confirmed-offline", hostId: 1, agentVersion: "2.2.198", transitionEpoch: 1,
      lastSeenAt: now - 20_000, deadlineAt: now, offlineAt: now, lastOfflineAt: now, confirmedOffline: true, isCurrent: () => true });
    assert.equal(delayedNotifications.length, 1);
    assert.deepEqual(delayedNotificationDelays, [5 * 60_000 - 20_000], "default wait is five minutes from the last contact");
    await hosts.updateHost(1, { hostStatusNotifyEnabled: false });
    delayedNotifications.shift()!();
    await (await import("./keyedTaskLock")).withKeyedTaskLock("agent-liveness:1", async () => {});
    assert.equal(requests, 0);
    assert.equal((await hosts.getHostById(1))?.isOnline, false);
    const rows = await runtime.queryRaw('SELECT * FROM host_availability_intervals WHERE "hostId" = 1 AND "offlineIncident" = 1');
    assert.ok(rows.length > 0, "muting must not suppress downtime observations");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("offline alerts wait for the configured minutes since last contact and are dropped when the host recovers first", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, options) => {
    requests.push(String(options?.body || ""));
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  const silentFor = async (seconds: number) => {
    await runtime.executeRaw('UPDATE hosts SET "isOnline" = 1, "lastHeartbeat" = ? WHERE id = 1', [Math.floor(Date.now() / 1000) - seconds]);
    assert.equal(await notifier.sweepOfflineHostsAndNotify(), 1);
    assert.equal((await hosts.getHostById(1))?.isOnline, false, "online state does not wait for the alert");
  };
  const online = async () => {
    await hosts.touchHostHeartbeat(1);
    await notifier.notifyHostOnlineIfNeeded(await hosts.getHostById(1));
  };
  try {
    await settings.setSettings({ notificationChannel: "telegram", telegramHostStatusNotify: "true", telegramHostOfflineNotifyMinutes: "10" });
    await hosts.updateHost(1, { hostStatusNotifyEnabled: true });
    await online();
    await notifier.primeHostStatusNotifier();
    requests.length = 0;
    delayedNotifications.length = 0;
    delayedNotificationDelays.length = 0;

    await silentFor(200);
    assert.equal(requests.length, 0, "not alerted before the configured wait");
    assert.equal(delayedNotifications.length, 1);
    assert.ok(Math.abs(delayedNotificationDelays[0] - 400_000) <= 2_000, `remaining wait ${delayedNotificationDelays[0]}`);
    await online();
    delayedNotifications.shift()!();
    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    assert.equal(requests.filter((body) => body.includes("离线告警")).length, 0, "recovery before the wait drops the alert");

    requests.length = 0;
    delayedNotifications.length = 0;
    await silentFor(200);
    delayedNotifications.shift()!();
    await new Promise((resolve) => originalSetTimeout(resolve, 25));
    assert.equal(requests.filter((body) => body.includes("离线告警")).length, 1, "still offline after the wait alerts once");

    await online();
    requests.length = 0;
    delayedNotifications.length = 0;
    await silentFor(700);
    assert.equal(delayedNotifications.length, 0);
    assert.equal(requests.filter((body) => body.includes("离线告警")).length, 1, "already past the wait alerts immediately");
  } finally {
    globalThis.fetch = originalFetch;
    await settings.setSetting("telegramHostOfflineNotifyMinutes", null);
  }
});

test("offline alert delay is read per channel, defaults to five minutes and stays within range", async () => {
  const { notificationSettings } = await import("./notificationSettings");
  assert.equal(notificationSettings({}, "telegram").hostOfflineNotifyMinutes, 5);
  const saved = { telegramHostOfflineNotifyMinutes: "15", discordHostOfflineNotifyMinutes: "30" };
  assert.equal(notificationSettings(saved, "telegram").hostOfflineNotifyMinutes, 15);
  assert.equal(notificationSettings(saved, "discord").hostOfflineNotifyMinutes, 30);
  for (const [value, expected] of [["0", 5], ["abc", 5], ["9999", 1440], ["0.4", 1]] as const) {
    assert.equal(notificationSettings({ telegramHostOfflineNotifyMinutes: value }, "telegram").hostOfflineNotifyMinutes, expected, value);
  }
});
