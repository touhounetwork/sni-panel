# PROXY Protocol

[中文说明](./proxy-protocol.md)

PROXY Protocol carries the client's real source address across forwarding hops, so the backend sees the client instead of an intermediate host.

## How it works

For TCP, a header with the source and destination address and port is written after the connection opens and before any application data. The receiver parses the header and uses its source as the client address. UDP has no connection start, so a ForwardX tunnel writes one v2 header at the start of every UDP datagram; see [UDP](#udp).

```text
client -> relay (entry) -> exit -> backend
```

- The entry **sends** the header so the next hop learns the client address.
- The exit **receives** it and may **send** it on to the backend.
- The backend must support PROXY Protocol to read it.

## Options

PROXY Protocol is configured in the advanced settings of a port forwarding resource, tunnel or forward chain; rules referencing the resource inherit it.

| Option | Meaning |
| --- | --- |
| accept proxy (receive) | Read the client address sent by the previous hop |
| send proxy (send) | Send the client address to the next hop |

Enable entry send and exit receive together. Send alone passes the header on as data that nobody parses; receive alone waits for a header that never comes.

## SNI routing

SNI rules on port forwarding resources and host failover groups have their own PROXY switches, useful when the destination service needs the real client IP:

| Switch | Scope | Behaviour |
| --- | --- | --- |
| Send PROXY | One rule | After connecting to the destination, the splitter writes a v1 or v2 header, then replays the ClientHello |
| Receive PROXY | Entry host + entry port | Before reading the ClientHello, the splitter parses the upstream header; v1 and v2 are detected automatically |

- Receiving belongs to the entry port. Saving one rule applies it to every SNI rule on that port; new rules on the port inherit the current value.
- With receiving on, connections without a valid header are closed. The parsed client address drives connection and source-IP limits and is written into the forwarded header.
- Header bytes are not rate limited or counted as traffic.
- Chains and tunnels cannot enable it: a chain entry connects to the next hop and a tunnel exit only sees a local address, so neither knows the client.
- The `*` default destination can send a header too; see [SNI routing](./sni-routing.en.md#default-destination).
- Requires entry Agent `3.10.0` or later; the panel refuses to enable it below that.

## GOST tunnel recipes

### Upstream already sends PROXY headers

1. Enable **entry receives upstream**.
2. Enable **entry sends to exit** and **exit receives entry** so the address crosses the tunnel.
3. If the backend supports PROXY Protocol, enable **exit sends to target**.

### Upstream is plain TCP

1. Keep **entry receives upstream** off; the entry uses the client's socket address.
2. Enable **entry sends to exit** and **exit receives entry**.
3. If the backend supports PROXY Protocol, enable **exit sends to target**.

## UDP

Only ForwardX tunnels support PROXY Protocol for UDP, and only v2 (v1 has no UDP form). After enabling **Also for UDP (V2 only)** in the tunnel's PROXY settings:

- **Every datagram carries a header.** UDP has no connection start; if only the first datagram carried the header, losing it would lose the source for the whole session. Each datagram therefore starts with a v2 header (28 bytes and family 0x12 for IPv4, 52 bytes and 0x22 for IPv6), and the backend must parse it per datagram.
- Entry receives upstream: every datagram must start with a valid UDP v2 header or it is dropped; the header is stripped before forwarding.
- Entry sends to exit plus exit sends to target: the entry prepends the header before encryption, so the target receives header plus original data. Replies carry no header.
- Header bytes are not rate limited or counted as traffic. Each datagram sent to the target is 28 or 52 bytes larger, which can cause IP fragmentation near the path MTU.
- Every entry Agent must be `3.10.0` or later.

Other forwarding methods cannot add a header to UDP, so the panel disables the switch:

| Method | Reason |
| --- | --- |
| iptables / nftables | Kernel forwarding does not rewrite datagrams |
| realm | PROXY is implemented only on its TCP path |
| GOST | Sends the header as a separate datagram that receivers cannot recognise |
| socat, Nginx | No UDP PROXY Protocol support |

## Compatibility

| Aspect | Notes |
| --- | --- |
| Protocols | TCP supports v1 and v2; UDP only on ForwardX tunnels, v2 only |
| Backend | Must explicitly support PROXY Protocol (for example Nginx `proxy_protocol on`, HAProxy) |
| Panel | Switches are disabled for unsupported methods |
| Multi-hop | Configure receive and send for each hop according to its position |

## Common mistakes

- **Entry send alone is not enough**: the backend only gets the address if the exit also receives and sends it on.
- **Do not send to a target that does not support it**: the backend treats the header as application data and the protocol breaks.
- **UDP works only on ForwardX tunnels**, and the backend must parse a v2 header in every datagram.
- **Configure every hop**: each intermediate node needs receive and send set for its position, not just the two ends.
