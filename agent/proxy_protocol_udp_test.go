package main

import (
	"net"
	"testing"
)

// The Agent keeps its own PROXY implementation (protocol guard); its UDP
// families must match forwardx-fxp byte for byte.
func TestAgentProxyProtocolV2DatagramFamilies(t *testing.T) {
	cases := []struct {
		name         string
		source, dest *net.UDPAddr
		family       byte
	}{
		{"ipv4", &net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 443}, 0x12},
		{"ipv6", &net.UDPAddr{IP: net.ParseIP("2001:db8::7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("2001:db8::9"), Port: 443}, 0x22},
		{"ipv4 on dual-stack wildcard", &net.UDPAddr{IP: net.ParseIP("::ffff:203.0.113.7"), Port: 4242}, &net.UDPAddr{IP: net.IPv6unspecified, Port: 443}, 0x12},
		{"ipv6 source with ipv4 dest", &net.UDPAddr{IP: net.ParseIP("2001:db8::7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 443}, 0x22},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			header := buildProxyProtocolV2UDP(tc.source, tc.dest)
			if header[13] != tc.family {
				t.Fatalf("family byte = %#x, want %#x", header[13], tc.family)
			}
			info, rest, ok, err := consumeProxyProtocolV2Datagram(append(header, "x"...))
			if err != nil || !ok || string(rest) != "x" || !net.ParseIP(info.SourceIP).Equal(tc.source.IP) || info.SourcePort != 4242 {
				t.Fatalf("parse: %+v rest=%q ok=%v err=%v", info, rest, ok, err)
			}
			if _, _, _, err := consumeProxyProtocol(header); err == nil {
				t.Fatal("stream parser accepted a UDP family")
			}
		})
	}
	tcp := buildProxyProtocolV2(proxyProtocolInfo{SourceIP: "203.0.113.7", SourcePort: 1, DestIP: "198.51.100.9", DestPort: 443}, nil, nil, nil)
	if tcp[13] != 0x11 {
		t.Fatalf("TCP family byte changed: %#x", tcp[13])
	}
	if _, _, _, err := consumeProxyProtocolV2Datagram(tcp); err == nil {
		t.Fatal("datagram parser accepted a TCP family")
	}
}
