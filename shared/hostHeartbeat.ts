// Agents send idle heartbeats every 60 seconds. Keep two full heartbeat
// intervals plus a small network/scheduler margin before declaring offline.
export const HOST_ONLINE_TTL_MS = 150 * 1000;

// Offline alerts wait until a host has been unreachable this long since its last
// contact. Online state, failover and DDNS keep their own faster detection.
export const HOST_OFFLINE_NOTIFY_DEFAULT_MINUTES = 5;
export const HOST_OFFLINE_NOTIFY_MIN_MINUTES = 1;
export const HOST_OFFLINE_NOTIFY_MAX_MINUTES = 1440;

export function normalizeHostOfflineNotifyMinutes(value: unknown) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return HOST_OFFLINE_NOTIFY_DEFAULT_MINUTES;
  return Math.min(HOST_OFFLINE_NOTIFY_MAX_MINUTES, Math.max(HOST_OFFLINE_NOTIFY_MIN_MINUTES, Math.round(minutes)));
}
