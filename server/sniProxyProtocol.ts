import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { forwardRules } from "../drizzle/schema";
import * as db from "./db";
import { getDb } from "./dbRuntime";
import { pushAgentRefresh } from "./agentEvents";
import { getSniEntryHostVersionStatuses } from "./sniEntryPortOverview";
import { resolveRuleProxyProtocolOptions } from "./gostProxyProtocol";
import {
  isSniDefaultRoute,
  isSniProxyProtocolAgentVersionSupported,
  normalizeSniValue,
  SNI_PROXY_PROTOCOL_MIN_AGENT_VERSION,
} from "@shared/sni";

// SNI 分流的 PROXY Protocol 只在「分流器既面对客户端又直连落地」的资源上有意义：
// 端口转发资源（port）与主机型转发组（failover）。转发链入口拨的是下一跳，隧道
// 出口只看到 127.0.0.1，两者都拿不到客户端地址。
//
// 发送开关和版本按规则；接收开关属于「入口主机 + 入口端口」，存在该端口每条 SNI
// 规则上，保存任一条时同步到全部（分流器拒绝路由间不一致的分流表）。

const SNI_PROXY_PROTOCOL_GROUP_MODES = new Set(["port", "failover"]);

export type SniProxyProtocolPatch = {
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: false;
  proxyProtocolExitSend: false;
  proxyProtocolVersion: 1 | 2;
};

type ProxyProtocolInput = {
  proxyProtocolReceive?: unknown;
  proxyProtocolSend?: unknown;
  proxyProtocolVersion?: unknown;
};

function dbBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value ?? "").trim().toLowerCase() === "true";
}

export function isSniProxyProtocolGroupMode(groupMode: unknown) {
  return SNI_PROXY_PROTOCOL_GROUP_MODES.has(String(groupMode || ""));
}

export type SniPortProxyState = {
  /** Current port-level receive switch; null when no other SNI rule uses the port. */
  receive: boolean | null;
  templateRuleIds: number[];
  /** Templates and their member copies, i.e. every row carrying the switch. */
  rowIds: number[];
  /** A forward chain shares this listener; chains cannot receive PROXY. */
  chainShared: boolean;
};

/**
 * SNI root rules sharing the listener at (any of entryHostIds, sourcePort).
 * Templates are matched through their group's entry hosts rather than member
 * rows, so a disabled rule without members still follows the port switch.
 */
export async function getSniPortProxyState(options: {
  entryHostIds: number[];
  sourcePort: number;
  excludeRuleIds?: number[];
}): Promise<SniPortProxyState> {
  const empty: SniPortProxyState = { receive: null, templateRuleIds: [], rowIds: [], chainShared: false };
  const database = await getDb();
  const entryHostIds = new Set(options.entryHostIds.map(Number).filter((id) => id > 0));
  const sourcePort = Number(options.sourcePort || 0);
  if (!database || entryHostIds.size === 0 || sourcePort <= 0) return empty;
  const excluded = new Set((options.excludeRuleIds || []).map(Number));
  const templates = (await database.select({
    id: forwardRules.id,
    sni: forwardRules.sni,
    forwardGroupId: forwardRules.forwardGroupId,
    proxyProtocolReceive: forwardRules.proxyProtocolReceive,
  }).from(forwardRules).where(and(
    eq(forwardRules.sourcePort, sourcePort),
    eq(forwardRules.isForwardGroupTemplate, true),
    eq(forwardRules.pendingDelete, false),
    isNotNull(forwardRules.sni),
  ))) as Array<{ id: number; sni: string | null; forwardGroupId: number | null; proxyProtocolReceive: unknown }>;
  const groupCache = new Map<number, { mode: string; shares: boolean }>();
  const sharing: typeof templates = [];
  let chainShared = false;
  for (const template of templates) {
    const groupId = Number(template.forwardGroupId || 0);
    if (excluded.has(Number(template.id)) || groupId <= 0 || !normalizeSniValue(template.sni)) continue;
    let group = groupCache.get(groupId);
    if (!group) {
      const [row, hostIds] = await Promise.all([db.getForwardGroupById(groupId), db.getForwardGroupRuleEntryHostIds(groupId)]);
      group = {
        mode: String((row as any)?.groupMode || ""),
        shares: (hostIds as number[]).some((hostId) => entryHostIds.has(Number(hostId))),
      };
      groupCache.set(groupId, group);
    }
    if (!group.shares) continue;
    if (group.mode === "chain") chainShared = true;
    if (isSniProxyProtocolGroupMode(group.mode)) sharing.push(template);
  }
  if (sharing.length === 0) return { ...empty, chainShared };
  const templateRuleIds = sharing.map((template) => Number(template.id));
  const children = (await database.select({ id: forwardRules.id }).from(forwardRules)
    .where(inArray(forwardRules.forwardGroupRuleId, templateRuleIds))) as Array<{ id: number }>;
  return {
    receive: sharing.some((template) => dbBool(template.proxyProtocolReceive)),
    templateRuleIds,
    rowIds: [...templateRuleIds, ...children.map((child) => Number(child.id))],
    chainShared,
  };
}

export async function assertSniProxyProtocolAgentVersions(entryHostIds: number[]) {
  const unsupported = (await getSniEntryHostVersionStatuses(entryHostIds))
    .find((status) => !isSniProxyProtocolAgentVersionSupported(status.agentVersion));
  if (!unsupported) return;
  throw new Error(
    `入口 Agent「${unsupported.name}」（ID ${unsupported.id}）版本 ${unsupported.agentVersion || "未上报"} 不足，SNI 默认去向（*），以及 SNI 分流和 UDP 上的 PROXY Protocol，需要 ${SNI_PROXY_PROTOCOL_MIN_AGENT_VERSION} 或更高版本`,
  );
}

/**
 * Validates and resolves the PROXY columns of a forward group SNI rule.
 * An omitted receive switch inherits the port's current value so adding a
 * domain never silently flips a listener that already parses headers.
 */
export async function prepareSniRuleProxyProtocol(options: {
  input: ProxyProtocolInput;
  existing?: ProxyProtocolInput | null;
  sni: string;
  groupMode: unknown;
  entryHostIds: number[];
  sourcePort: number;
  excludeRuleIds?: number[];
}): Promise<SniProxyProtocolPatch> {
  const pick = (key: keyof ProxyProtocolInput) => (
    options.input[key] !== undefined ? options.input[key] : options.existing?.[key]
  );
  const portState = await getSniPortProxyState(options);
  const receiveInput = pick("proxyProtocolReceive");
  const receive = receiveInput === undefined ? portState.receive === true : dbBool(receiveInput);
  const send = dbBool(pick("proxyProtocolSend"));
  const version: 1 | 2 = Number(pick("proxyProtocolVersion")) === 2 ? 2 : 1;
  if ((receive || send) && !isSniProxyProtocolGroupMode(options.groupMode)) {
    throw new Error("SNI 分流的 PROXY Protocol 仅支持端口转发资源和主机型转发组：转发链和隧道的分流器拿不到客户端地址");
  }
  if (receive && portState.chainShared) {
    throw new Error(`入口端口 ${options.sourcePort} 与转发链共用分流器，转发链不支持接收 PROXY Protocol`);
  }
  if (String(options.groupMode || "") === "chain" && portState.receive === true) {
    throw new Error(`入口端口 ${options.sourcePort} 已开启接收 PROXY Protocol，转发链不能共用该端口`);
  }
  if (receive || send || isSniDefaultRoute(options.sni)) {
    await assertSniProxyProtocolAgentVersions(options.entryHostIds);
  }
  return {
    proxyProtocolReceive: receive,
    proxyProtocolSend: send,
    proxyProtocolExitReceive: false,
    proxyProtocolExitSend: false,
    proxyProtocolVersion: send ? version : 1,
  };
}

/**
 * Applies the port-level receive switch to every other SNI rule on the
 * listener, including member copies, and asks the entry Agents to refresh.
 * Runs inside withSniRuleWrite, which already orders writes per entry host.
 */
export async function syncSniPortProxyReceive(options: {
  entryHostIds: number[];
  sourcePort: number;
  receive: boolean;
  excludeRuleIds?: number[];
}) {
  const state = await getSniPortProxyState(options);
  if (state.rowIds.length === 0) return [];
  const database = await getDb();
  if (!database) return [];
  const stale = (await database.select({ id: forwardRules.id }).from(forwardRules).where(and(
    inArray(forwardRules.id, state.rowIds),
    ne(forwardRules.proxyProtocolReceive, options.receive),
  ))) as Array<{ id: number }>;
  if (stale.length === 0) return [];
  const staleIds = stale.map((row) => Number(row.id));
  await database.update(forwardRules)
    .set({ proxyProtocolReceive: options.receive, isRunning: false } as any)
    .where(inArray(forwardRules.id, staleIds));
  for (const hostId of new Set(options.entryHostIds)) pushAgentRefresh(hostId, "sni-port-proxy-receive-synced");
  return staleIds;
}

export type SniRouteProxyProtocolFields = {
  proxyProtocolReceive?: boolean;
  proxyProtocolSend?: boolean;
  proxyProtocolVersion?: 1 | 2;
};

/**
 * Splitter route fields for a runtime rule. Omitted entirely when nothing is
 * enabled, so tables without PROXY keep their pre-3.10 shape and version.
 */
export function sniRouteProxyProtocolFields(rule: object, resource: unknown): SniRouteProxyProtocolFields {
  if (!isSniProxyProtocolGroupMode(resource)) return {};
  const fields = rule as ProxyProtocolInput;
  const receive = dbBool(fields?.proxyProtocolReceive);
  const send = dbBool(fields?.proxyProtocolSend);
  if (!receive && !send) return {};
  return {
    ...(receive ? { proxyProtocolReceive: true } : {}),
    ...(send ? { proxyProtocolSend: true, proxyProtocolVersion: Number(fields?.proxyProtocolVersion) === 2 ? 2 : 1 } : {}),
  };
}

/** Whether a splitter route needs a 3.10+ Agent to be served correctly. */
export function sniRouteRequiresProxyProtocolAgent(route: { sni?: unknown } & SniRouteProxyProtocolFields) {
  return isSniDefaultRoute(route?.sni) || !!route?.proxyProtocolReceive || !!route?.proxyProtocolSend;
}

/**
 * Receive is listener-wide; saving keeps it consistent, but a table mixing
 * values would be rejected whole by the splitter and take the port down.
 * Normalize to the explicit switch instead.
 */
export function normalizeSniPortProxyReceive<T extends SniRouteProxyProtocolFields>(routes: T[]): T[] {
  if (!routes.some((route) => route.proxyProtocolReceive)) return routes;
  return routes.map((route) => (route.proxyProtocolReceive ? route : { ...route, proxyProtocolReceive: true }));
}

/**
 * UDP PROXY fields of a ForwardX tunnel entry. Before 3.10.0 the entry
 * rejected any PROXY switch on a UDP-only rule and ignored the UDP field on
 * TCP+UDP rules, so an older Agent gets the TCP behaviour only: switches are
 * cleared for UDP-only rules and the UDP field is never sent.
 */
export function forwardXUdpProxyProtocolFields(rule: { protocol?: unknown }, tunnel: unknown, agentVersion: unknown) {
  const options = resolveRuleProxyProtocolOptions(rule, tunnel);
  if (!options.proxyProtocolUdp) return {};
  if (isSniProxyProtocolAgentVersionSupported(agentVersion)) return { proxyProtocolUdp: true };
  if (String(rule?.protocol || "").trim().toLowerCase() !== "udp") return {};
  return { proxyProtocolReceive: false, proxyProtocolSend: false, proxyProtocolExitReceive: false, proxyProtocolExitSend: false };
}
