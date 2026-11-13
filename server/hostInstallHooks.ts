import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { hostInstallHooks } from "../drizzle/schema";
import { getDb, nowDate } from "./dbRuntime";
import { recordConfigAuditEvent } from "./configAudit";
import { getSetting, setSetting } from "./repositories/settingsRepository";

// 节点在安装或升级 Agent 后执行的自定义命令。安装脚本是公开下载的，
// 命令不能写进脚本：由刚装好的 Agent 凭自己的 token 经加密通道取回，
// 执行后把退出码和输出尾部回报到这里。

export const INSTALL_HOOK_GLOBAL_SETTING = "agentInstallHookCommand";
export const INSTALL_HOOK_MAX_COMMAND_BYTES = 64 * 1024;
export const INSTALL_HOOK_MAX_OUTPUT_BYTES = 1024 * 1024;
export const INSTALL_HOOK_MODES = ["inherit", "custom", "append", "disabled"] as const;
export type InstallHookMode = (typeof INSTALL_HOOK_MODES)[number];
export type InstallHookRunMode = "install" | "upgrade";
export type InstallHookSource = "global" | "host" | "global+host";
export type InstallHookStep = { source: "global" | "host"; command: string };
const INSTALL_HOOK_SOURCES = new Set<InstallHookSource>(["global", "host", "global+host"]);

export type InstallHookResult = {
  runAt: number;
  runMode: InstallHookRunMode;
  agentVersion: string;
  source: InstallHookSource;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
};

export type HostInstallHookView = {
  mode: InstallHookMode;
  command: string;
  globalCommand: string;
  effective: { source: InstallHookSource | null; steps: InstallHookStep[] };
  lastResult: InstallHookResult | null;
};

function normalizeCommand(value: unknown) {
  const command = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (Buffer.byteLength(command, "utf8") > INSTALL_HOOK_MAX_COMMAND_BYTES) {
    throw new Error(`自定义命令不能超过 ${INSTALL_HOOK_MAX_COMMAND_BYTES / 1024}KB`);
  }
  return command;
}

function normalizeMode(value: unknown): InstallHookMode {
  return (INSTALL_HOOK_MODES as readonly string[]).includes(String(value)) ? value as InstallHookMode : "inherit";
}

// The audit trail must never hold the command itself (it may carry secrets).
function commandSummary(command: string) {
  if (!command) return { configured: false };
  return {
    configured: true,
    lines: command.split("\n").length,
    bytes: Buffer.byteLength(command, "utf8"),
    sha256: createHash("sha256").update(command).digest("hex").slice(0, 16),
  };
}

const epochSeconds = (value: unknown) => {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const bool = (value: unknown) => value === true || value === 1 || value === "1";

async function readRow(hostId: number) {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db.select().from(hostInstallHooks).where(eq(hostInstallHooks.hostId, hostId)).limit(1);
  return row || null;
}

export async function getGlobalInstallHookCommand() {
  return normalizeCommand(await getSetting(INSTALL_HOOK_GLOBAL_SETTING));
}

export async function saveGlobalInstallHookCommand(value: unknown) {
  const next = normalizeCommand(value);
  const previous = await getGlobalInstallHookCommand();
  if (next === previous) return { command: next };
  await setSetting(INSTALL_HOOK_GLOBAL_SETTING, next || null);
  await recordConfigAuditEvent({
    resourceType: "settings", resourceId: 1, action: "update", source: "admin:install-hook-global",
    before: { agentInstallHook: commandSummary(previous) }, after: { agentInstallHook: commandSummary(next) },
  });
  return { command: next };
}

function resultFromRow(row: any): InstallHookResult | null {
  if (!row || !epochSeconds(row.lastRunAt)) return null;
  return {
    runAt: epochSeconds(row.lastRunAt),
    runMode: row.lastRunMode === "upgrade" ? "upgrade" : "install",
    agentVersion: String(row.lastAgentVersion || ""),
    source: INSTALL_HOOK_SOURCES.has(row.lastSource) ? row.lastSource : "global",
    exitCode: row.lastExitCode === null || row.lastExitCode === undefined ? null : Number(row.lastExitCode),
    timedOut: bool(row.lastTimedOut),
    durationMs: Number(row.lastDurationMs || 0),
    output: String(row.lastOutput || ""),
    outputTruncated: bool(row.lastOutputTruncated),
  };
}

/**
 * What this host runs now. "append" runs the global command, then the host
 * command, as separate processes so one cannot cut the other short.
 */
export function resolveInstallHook(mode: InstallHookMode, hostCommand: string, globalCommand: string): HostInstallHookView["effective"] {
  const steps: InstallHookStep[] = [];
  if ((mode === "inherit" || mode === "append") && globalCommand) steps.push({ source: "global", command: globalCommand });
  if ((mode === "custom" || mode === "append") && hostCommand) steps.push({ source: "host", command: hostCommand });
  const source: InstallHookSource | null = steps.length === 0 ? null
    : steps.length === 2 ? "global+host" : steps[0].source;
  return { source, steps };
}

export async function getHostInstallHook(hostId: number): Promise<HostInstallHookView> {
  const [row, globalCommand] = await Promise.all([readRow(hostId), getGlobalInstallHookCommand()]);
  const mode = normalizeMode(row?.mode);
  const command = String(row?.command || "");
  return { mode, command, globalCommand, effective: resolveInstallHook(mode, command, globalCommand), lastResult: resultFromRow(row) };
}

export async function saveHostInstallHook(hostId: number, input: { mode: unknown; command: unknown }) {
  const mode = normalizeMode(input.mode);
  const command = normalizeCommand(input.command);
  if (mode === "custom" && !command) throw new Error("选择「使用本节点命令」时必须填写命令");
  if (mode === "append" && !command) throw new Error("选择「追加本节点命令」时必须填写命令");
  const db = await getDb();
  if (!db) throw new Error("数据库不可用");
  const row = await readRow(hostId);
  const before = { mode: normalizeMode(row?.mode), command: String(row?.command || "") };
  // Keep the stored command when switching to a mode that ignores it.
  const storedCommand = mode === "custom" || mode === "append" || command ? command : before.command;
  if (row) {
    await db.update(hostInstallHooks).set({ mode, command: storedCommand || null, updatedAt: nowDate() }).where(eq(hostInstallHooks.hostId, hostId));
  } else {
    await db.insert(hostInstallHooks).values({ hostId, mode, command: storedCommand || null, updatedAt: nowDate() });
  }
  await recordConfigAuditEvent({
    resourceType: "host", resourceId: hostId, hostId, action: "update", source: "admin:install-hook",
    before: { installHookMode: before.mode, installHook: commandSummary(before.command) },
    after: { installHookMode: mode, installHook: commandSummary(storedCommand) },
  });
  return getHostInstallHook(hostId);
}

/** What the Agent asked for right after install/upgrade. */
export async function getInstallHookForAgent(hostId: number) {
  const view = await getHostInstallHook(hostId);
  return view.effective;
}

function clampOutput(value: unknown) {
  const raw = Buffer.from(String(value ?? ""), "utf8");
  if (raw.length <= INSTALL_HOOK_MAX_OUTPUT_BYTES) return { output: raw.toString("utf8"), truncated: false };
  // Keep the tail, where failures are reported; drop a split leading UTF-8 sequence.
  let start = raw.length - INSTALL_HOOK_MAX_OUTPUT_BYTES;
  while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
  return { output: raw.subarray(start).toString("utf8"), truncated: true };
}

export async function recordInstallHookResult(hostId: number, input: {
  runMode: unknown; agentVersion: unknown; source: unknown; exitCode: unknown; timedOut: unknown;
  durationMs: unknown; output: unknown; outputTruncated: unknown;
}) {
  const db = await getDb();
  if (!db) return false;
  const { output, truncated } = clampOutput(input.output);
  const exit = Number(input.exitCode);
  const values = {
    lastRunAt: nowDate(),
    lastRunMode: input.runMode === "upgrade" ? "upgrade" : "install",
    lastAgentVersion: String(input.agentVersion || "").slice(0, 32),
    lastSource: INSTALL_HOOK_SOURCES.has(input.source as InstallHookSource) ? input.source as InstallHookSource : "global",
    lastExitCode: Number.isInteger(exit) ? exit : null,
    lastTimedOut: input.timedOut === true,
    lastDurationMs: Math.max(0, Math.min(2_147_483_647, Math.floor(Number(input.durationMs) || 0))),
    lastOutput: output,
    lastOutputTruncated: truncated || input.outputTruncated === true,
    updatedAt: nowDate(),
  };
  const row = await readRow(hostId);
  if (row) await db.update(hostInstallHooks).set(values).where(eq(hostInstallHooks.hostId, hostId));
  else await db.insert(hostInstallHooks).values({ hostId, mode: "inherit", command: null, ...values });
  return true;
}
