import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, lt, lte } from "drizzle-orm";
import { commandBatches, commandBatchResults } from "../drizzle/schema";
import { getDb, insertAndGetId, nowDate } from "./dbRuntime";
import { recordConfigAuditEvent } from "./configAudit";
import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { pushAgentCommandCancel, pushAgentCommandTask } from "./agentEvents";
import * as db from "./db";
import {
  HOST_COMMAND_DEFAULT_TIMEOUT_SECONDS, HOST_COMMAND_MAX_COMMAND_BYTES, HOST_COMMAND_MAX_OUTPUT_BYTES,
  HOST_COMMAND_MAX_TIMEOUT_SECONDS, HOST_COMMAND_MIN_AGENT_VERSION, HOST_COMMAND_MIN_TIMEOUT_SECONDS,
} from "../shared/hostCommands";

// 管理员向选定节点批量执行命令。面板经实时通道只推任务编号，Agent 凭自己的
// token 经加密通道取回命令、执行并回报。未连接实时通道的节点立即记为未送达，
// 不排队等待重连，避免离线节点在很久之后执行一条旧命令。

const HISTORY_RETENTION_SECONDS = 30 * 24 * 3600;
// Queueing on the Agent (one command at a time) and the result round trip.
const DEADLINE_GRACE_SECONDS = 60;

export type HostCommandStatus = "queued" | "running" | "success" | "failed" | "timeout" | "cancelled" | "undelivered" | "unsupported";
const TERMINAL = new Set<HostCommandStatus>(["success", "failed", "timeout", "cancelled", "undelivered", "unsupported"]);

const epoch = (value: unknown) => {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};
const nowSeconds = () => Math.floor(Date.now() / 1000);
const dateFrom = (seconds: number) => new Date(seconds * 1000);

function clampOutput(value: unknown) {
  const raw = Buffer.from(String(value ?? ""), "utf8");
  if (raw.length <= HOST_COMMAND_MAX_OUTPUT_BYTES) return { output: raw.toString("utf8"), truncated: false };
  let start = raw.length - HOST_COMMAND_MAX_OUTPUT_BYTES;
  while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
  return { output: raw.subarray(start).toString("utf8"), truncated: true };
}

async function requireDb() {
  const database = await getDb();
  if (!database) throw new Error("数据库不可用");
  return database;
}

async function purgeExpiredHistory() {
  const database = await requireDb();
  const cutoff = dateFrom(nowSeconds() - HISTORY_RETENTION_SECONDS);
  const old = (await database.select({ id: commandBatches.id }).from(commandBatches).where(lt(commandBatches.createdAt, cutoff))) as Array<{ id: number }>;
  if (old.length === 0) return;
  const ids = old.map((row) => Number(row.id));
  await database.delete(commandBatchResults).where(inArray(commandBatchResults.batchId, ids));
  await database.delete(commandBatches).where(inArray(commandBatches.id, ids));
}

/** Results still open past their deadline become timeouts (Agent gone or result lost). */
async function expireOverdueResults(batchId?: number) {
  const database = await requireDb();
  const now = nowDate();
  const open = inArray(commandBatchResults.status, ["queued", "running"]);
  await database.update(commandBatchResults)
    .set({ status: "timeout", finishedAt: now, updatedAt: now })
    .where(batchId ? and(open, eq(commandBatchResults.batchId, batchId), lte(commandBatchResults.deadlineAt, now)) : and(open, lte(commandBatchResults.deadlineAt, now)));
}

export function normalizeCommandInput(input: { command: unknown; timeoutSeconds?: unknown }) {
  const command = String(input.command ?? "").replace(/\r\n?/g, "\n").trim();
  if (!command) throw new Error("命令不能为空");
  if (Buffer.byteLength(command, "utf8") > HOST_COMMAND_MAX_COMMAND_BYTES) throw new Error(`命令不能超过 ${HOST_COMMAND_MAX_COMMAND_BYTES / 1024}KB`);
  const timeout = Math.floor(Number(input.timeoutSeconds ?? HOST_COMMAND_DEFAULT_TIMEOUT_SECONDS));
  if (!Number.isFinite(timeout) || timeout < HOST_COMMAND_MIN_TIMEOUT_SECONDS || timeout > HOST_COMMAND_MAX_TIMEOUT_SECONDS) {
    throw new Error(`超时必须在 ${HOST_COMMAND_MIN_TIMEOUT_SECONDS} 秒到 ${HOST_COMMAND_MAX_TIMEOUT_SECONDS} 秒之间`);
  }
  return { command, timeoutSeconds: timeout };
}

export async function runHostCommandBatch(input: {
  hostIds: number[]; command: unknown; timeoutSeconds?: unknown; actor: { id: number; name: string };
}) {
  const { command, timeoutSeconds } = normalizeCommandInput(input);
  const hostIds = [...new Set(input.hostIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (hostIds.length === 0) throw new Error("请选择至少一台节点");
  const hosts = (await db.getHostsByIds(hostIds)) as any[];
  const hostById = new Map(hosts.map((host) => [Number(host.id), host]));
  const missing = hostIds.filter((id) => !hostById.has(id));
  if (missing.length > 0) throw new Error(`节点不存在：${missing.join(", ")}`);
  await purgeExpiredHistory();
  const database = await requireDb();
  const createdAt = nowDate();
  // insertAndGetId works on all three databases (MySQL has no RETURNING).
  const batchId = Number(await insertAndGetId("command_batches", {
    command, timeoutSeconds, createdBy: input.actor.id, createdByName: String(input.actor.name || "").slice(0, 255),
    hostCount: hostIds.length, createdAt: nowSeconds(),
  }));
  const deadlineAt = dateFrom(nowSeconds() + timeoutSeconds + DEADLINE_GRACE_SECONDS);
  const rows = hostIds.map((hostId) => {
    const host = hostById.get(hostId);
    const supported = isAgentVersionAtLeast(String(host?.agentVersion || ""), HOST_COMMAND_MIN_AGENT_VERSION);
    return {
      batchId, hostId, hostName: String(host?.name || `#${hostId}`).slice(0, 255),
      taskId: randomBytes(16).toString("hex"),
      status: (supported ? "queued" : "unsupported") as HostCommandStatus,
      output: supported ? null : `Agent 版本 ${host?.agentVersion || "未上报"} 不足，需要 ${HOST_COMMAND_MIN_AGENT_VERSION} 或更高版本`,
      finishedAt: supported ? null : createdAt,
      deadlineAt, updatedAt: createdAt,
    };
  });
  await database.insert(commandBatchResults).values(rows);
  for (const row of rows) {
    if (row.status !== "queued") continue;
    if (!pushAgentCommandTask(row.hostId, row.taskId)) {
      await database.update(commandBatchResults)
        .set({ status: "undelivered", output: "节点不在线或实时通道未连接，命令未送达", finishedAt: nowDate(), updatedAt: nowDate() })
        .where(and(eq(commandBatchResults.taskId, row.taskId), eq(commandBatchResults.status, "queued")));
    }
  }
  await recordConfigAuditEvent({
    resourceType: "runtime", resourceId: batchId, action: "dispatch", source: "admin:host-command",
    after: {
      hostCommand: {
        hostIds, timeoutSeconds, lines: command.split("\n").length, bytes: Buffer.byteLength(command, "utf8"),
        sha256: createHash("sha256").update(command).digest("hex").slice(0, 16),
      },
    },
  });
  return getHostCommandBatch(batchId);
}

export type HostCommandResultView = ReturnType<typeof resultView>;

function resultView(row: any) {
  return {
    hostId: Number(row.hostId), hostName: String(row.hostName), taskId: String(row.taskId),
    status: String(row.status) as HostCommandStatus,
    exitCode: row.exitCode === null || row.exitCode === undefined ? null : Number(row.exitCode),
    durationMs: row.durationMs === null || row.durationMs === undefined ? null : Number(row.durationMs),
    output: String(row.output || ""), outputTruncated: row.outputTruncated === true || row.outputTruncated === 1,
    startedAt: epoch(row.startedAt), finishedAt: epoch(row.finishedAt),
  };
}

export async function getHostCommandBatch(batchId: number) {
  await expireOverdueResults(batchId);
  const database = await requireDb();
  const [batch] = await database.select().from(commandBatches).where(eq(commandBatches.id, batchId)).limit(1);
  if (!batch) return null;
  const rows = (await database.select().from(commandBatchResults).where(eq(commandBatchResults.batchId, batchId)).orderBy(commandBatchResults.id)) as any[];
  const results: HostCommandResultView[] = rows.map(resultView);
  const done = results.every((result) => TERMINAL.has(result.status));
  return {
    id: Number(batch.id), command: String(batch.command), timeoutSeconds: Number(batch.timeoutSeconds),
    createdBy: batch.createdBy === null ? null : Number(batch.createdBy), createdByName: String(batch.createdByName || ""),
    createdAt: epoch(batch.createdAt), cancelledAt: epoch(batch.cancelledAt), done, results,
    counts: results.reduce<Record<string, number>>((counts, result) => ({ ...counts, [result.status]: (counts[result.status] || 0) + 1 }), {}),
  };
}

export type HostCommandBatchSummary = {
  id: number; command: string; createdByName: string; createdAt: number | null; hostCount: number; counts: Record<string, number>; done: boolean;
};

export async function listHostCommandBatches(limit = 50): Promise<HostCommandBatchSummary[]> {
  await purgeExpiredHistory();
  await expireOverdueResults();
  const database = await requireDb();
  const batches = await database.select().from(commandBatches).orderBy(desc(commandBatches.id)).limit(Math.max(1, Math.min(200, limit)));
  const ids = batches.map((batch: any) => Number(batch.id));
  const rows = ids.length ? await database.select({ batchId: commandBatchResults.batchId, status: commandBatchResults.status })
    .from(commandBatchResults).where(inArray(commandBatchResults.batchId, ids)) : [];
  const countsById = new Map<number, Record<string, number>>();
  for (const row of rows as Array<{ batchId: number; status: string }>) {
    const counts = countsById.get(Number(row.batchId)) || {};
    counts[row.status] = (counts[row.status] || 0) + 1;
    countsById.set(Number(row.batchId), counts);
  }
  return batches.map((batch: any) => {
    const counts = countsById.get(Number(batch.id)) || {};
    const open = (counts.queued || 0) + (counts.running || 0);
    return {
      id: Number(batch.id), command: String(batch.command), createdByName: String(batch.createdByName || ""),
      createdAt: epoch(batch.createdAt), hostCount: Number(batch.hostCount), counts, done: open === 0,
    };
  });
}

/** Batches in history (purged after 30 days), for the tab badge. */
export async function countHostCommandBatches() {
  const database = await requireDb();
  const [row] = await database.select({ n: count() }).from(commandBatches);
  return Number(row?.n || 0);
}

/** Cancel a whole batch, or a single host in it. */
export async function cancelHostCommand(batchId: number, hostId?: number) {
  const database = await requireDb();
  const where = and(eq(commandBatchResults.batchId, batchId), inArray(commandBatchResults.status, ["queued", "running"]),
    ...(hostId ? [eq(commandBatchResults.hostId, hostId)] : []));
  const open = (await database.select().from(commandBatchResults).where(where)) as any[];
  for (const row of open) pushAgentCommandCancel(Number(row.hostId), String(row.taskId));
  if (open.length > 0) {
    const now = nowDate();
    // Shown as cancelled right away; a late Agent result keeps that status.
    await database.update(commandBatchResults).set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(inArray(commandBatchResults.taskId, open.map((row) => String(row.taskId))));
  }
  if (!hostId) await database.update(commandBatches).set({ cancelledAt: nowDate() }).where(eq(commandBatches.id, batchId));
  return getHostCommandBatch(batchId);
}

async function openTaskForHost(hostId: number, taskId: string) {
  const database = await requireDb();
  const [row] = await database.select().from(commandBatchResults)
    .where(and(eq(commandBatchResults.taskId, taskId), eq(commandBatchResults.hostId, hostId))).limit(1);
  return row || null;
}

/** Agent pull: the command for its own task, only while the task is open. */
export async function takeHostCommandForAgent(hostId: number, taskId: string) {
  const row = await openTaskForHost(hostId, taskId);
  if (!row || TERMINAL.has(row.status) || (epoch(row.deadlineAt) || 0) <= nowSeconds()) return null;
  const database = await requireDb();
  const [batch] = await database.select().from(commandBatches).where(eq(commandBatches.id, Number(row.batchId))).limit(1);
  if (!batch) return null;
  const now = nowDate();
  await database.update(commandBatchResults).set({ status: "running", startedAt: now, updatedAt: now })
    .where(and(eq(commandBatchResults.taskId, taskId), eq(commandBatchResults.status, "queued")));
  return { taskId, command: String(batch.command), timeoutSeconds: Number(batch.timeoutSeconds) };
}

export async function recordHostCommandResult(hostId: number, input: {
  taskId: unknown; exitCode: unknown; timedOut: unknown; cancelled: unknown; durationMs: unknown; output: unknown; outputTruncated: unknown;
}) {
  const taskId = String(input.taskId || "");
  const row = await openTaskForHost(hostId, taskId);
  if (!row) return false;
  const { output, truncated } = clampOutput(input.output);
  const exit = Number(input.exitCode);
  const exitCode = Number.isInteger(exit) ? exit : null;
  const reported: HostCommandStatus = input.cancelled === true ? "cancelled" : input.timedOut === true ? "timeout" : exitCode === 0 ? "success" : "failed";
  // A cancel or deadline already recorded keeps its status; output is still useful.
  const status = row.status === "cancelled" || row.status === "timeout" ? row.status : reported;
  const database = await requireDb();
  await database.update(commandBatchResults).set({
    status, exitCode, output, outputTruncated: truncated || input.outputTruncated === true,
    durationMs: Math.max(0, Math.min(2_147_483_647, Math.floor(Number(input.durationMs) || 0))),
    finishedAt: nowDate(), updatedAt: nowDate(),
  }).where(eq(commandBatchResults.taskId, taskId));
  return true;
}
