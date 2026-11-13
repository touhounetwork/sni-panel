export const SNI_SPLITTER_MIN_AGENT_VERSION = "2.2.195";
// Splitters before this version ignore the PROXY fields and reject "*", so a
// receiving listener would wait for headers that never come.
export const SNI_PROXY_PROTOCOL_MIN_AGENT_VERSION = "3.10.0";
/** SNI value of the rule that receives a port's unmatched connections. */
export const SNI_DEFAULT_ROUTE = "*";

function agentVersionAtLeast(value: unknown, minimum: string) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== minimumParts[index]) return parts[index] > minimumParts[index];
  }
  return true;
}

export function isSniEntryAgentVersionSupported(value: unknown) {
  return agentVersionAtLeast(value, SNI_SPLITTER_MIN_AGENT_VERSION);
}

export function isSniProxyProtocolAgentVersionSupported(value: unknown) {
  return agentVersionAtLeast(value, SNI_PROXY_PROTOCOL_MIN_AGENT_VERSION);
}

export function isSniDefaultRoute(value: unknown) {
  return normalizeSniValue(value) === SNI_DEFAULT_ROUTE;
}

export function normalizeSniValue(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\.+$/, "");
}

export function getSniRuleGroupKey(rule: {
  sni?: unknown;
  tunnelId?: unknown;
  forwardGroupId?: unknown;
  sourcePort?: unknown;
}) {
  const forwardGroupId = Number(rule.forwardGroupId || 0);
  const tunnelId = Number(rule.tunnelId || 0);
  const sourcePort = Number(rule.sourcePort || 0);
  if (!normalizeSniValue(rule.sni) || sourcePort <= 0) return null;
  if (forwardGroupId > 0) return `sni:${forwardGroupId}:${sourcePort}`;
  if (tunnelId > 0) return `sni:tunnel:${tunnelId}:${sourcePort}`;
  return null;
}

export function isValidSniValue(value: unknown) {
  const normalized = normalizeSniValue(value);
  if (!normalized || normalized.length > 253 || normalized.includes("*")) return false;
  return normalized.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
}

/** A rule's SNI field: a complete domain, or the port's default route. */
export function isValidSniRuleValue(value: unknown) {
  return isSniDefaultRoute(value) || isValidSniValue(value);
}
