export type GostProxyProtocolMetadata = {
  proxyProtocol: "1" | "2";
};

export type GostTunnelProxyProtocolPlan = {
  entryListener?: GostProxyProtocolMetadata;
  entryHandler?: GostProxyProtocolMetadata;
  exitBridgeReceive?: GostProxyProtocolMetadata;
  exitBridgeSend?: GostProxyProtocolMetadata;
};

export type GostTunnelProxyProtocolOptions = {
  entryReceive: boolean;
  entrySend: boolean;
  exitReceive: boolean;
  exitSend: boolean;
  version: unknown;
};

export type EffectiveTunnelProxyProtocolOptions = {
  entryReceive: boolean;
  entrySend: boolean;
  exitReceive: boolean;
  exitSend: boolean;
  version: 1 | 2;
};

export type ResolvedRuleProxyProtocolOptions = {
  proxyProtocolReceive: boolean;
  proxyProtocolSend: boolean;
  proxyProtocolExitReceive: boolean;
  proxyProtocolExitSend: boolean;
  proxyProtocolVersion: 1 | 2;
  /** UDP datagrams also carry v2 headers (ForwardX tunnels only). */
  proxyProtocolUdp: boolean;
};

/**
 * Only the ForwardX tunnel entry can add or strip a header per datagram.
 * iptables/nftables forward in the kernel, realm has no UDP PROXY support and
 * GOST 3.2.6 sends the UDP header as a separate datagram, so all of them stay
 * TCP-only. v1 has no UDP form.
 */
export function isTunnelUdpProxyProtocolEnabled(tunnel: any) {
  return !!tunnel
    && String(tunnel?.mode || "").trim().toLowerCase() === "forwardx"
    && !!tunnel.proxyProtocolUdp
    && Number(tunnel.proxyProtocolVersion) === 2;
}

const PROXY_PROTOCOL_TUNNEL_MODES = new Set(["forwardx", "tls", "wss", "tcp", "mtls", "mwss", "mtcp"]);

export function resolveRuleProxyProtocolOptions(rule: any, tunnel?: any | null): ResolvedRuleProxyProtocolOptions {
  const protocol = String(rule?.protocol || "").trim().toLowerCase();
  const tcpSupported = protocol === "tcp" || protocol === "both";
  const udpProxy = (protocol === "udp" || protocol === "both") && isTunnelUdpProxyProtocolEnabled(tunnel);
  const tunnelSupported = !tunnel || PROXY_PROTOCOL_TUNNEL_MODES.has(String(tunnel?.mode || "").trim().toLowerCase());
  const enabled = (tcpSupported || udpProxy) && tunnelSupported;
  // Tunnel switches are the source of truth. Rule columns are only a
  // synchronized snapshot and may be stale after upgrading older panels.
  const source = tunnel || rule || {};
  return {
    proxyProtocolReceive: enabled && !!source.proxyProtocolReceive,
    proxyProtocolSend: enabled && !!source.proxyProtocolSend,
    proxyProtocolExitReceive: enabled && !!tunnel && !!source.proxyProtocolExitReceive,
    proxyProtocolExitSend: enabled && !!tunnel && !!source.proxyProtocolExitSend,
    proxyProtocolVersion: enabled && Number(source.proxyProtocolVersion) === 2 ? 2 : 1,
    proxyProtocolUdp: enabled && udpProxy,
  };
}

export function gostProxyProtocolMetadata(version: unknown): GostProxyProtocolMetadata {
  // GOST v3.2.6 ignores JSON numbers here because metadata values decode as float64.
  return { proxyProtocol: Number(version) === 2 ? "2" : "1" };
}

export function effectiveTunnelProxyProtocolOptions(options: GostTunnelProxyProtocolOptions): EffectiveTunnelProxyProtocolOptions {
  const entryReceive = options.entryReceive === true;
  const entrySend = options.entrySend === true;
  const exitSend = options.exitSend === true;
  return {
    entryReceive,
    entrySend,
    // The bridge is an implementation detail. When both ends send PROXY,
    // consume the authenticated inner header so its source is not replaced by
    // the bridge's 127.0.0.1 socket address.
    exitReceive: options.exitReceive === true || (entrySend && exitSend),
    exitSend,
    version: Number(options.version) === 2 ? 2 : 1,
  };
}

export function gostTunnelProxyProtocolPlan(options: GostTunnelProxyProtocolOptions): GostTunnelProxyProtocolPlan {
  const effective = effectiveTunnelProxyProtocolOptions(options);
  return {
    entryListener: effective.entryReceive ? gostProxyProtocolMetadata(effective.version) : undefined,
    entryHandler: effective.entrySend ? gostProxyProtocolMetadata(effective.version) : undefined,
    exitBridgeReceive: effective.exitReceive ? gostProxyProtocolMetadata(effective.version) : undefined,
    exitBridgeSend: effective.exitSend ? gostProxyProtocolMetadata(effective.version) : undefined,
  };
}
