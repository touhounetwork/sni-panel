package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// These end-to-end tests run a real splitter listener. The capturing backend
// records everything a target receives so header and ClientHello order can
// be asserted byte for byte.

func TestSniSplitterSendsProxyHeaderBeforeClientHello(t *testing.T) {
	for _, version := range []int{1, 2} {
		t.Run("v"+strconv.Itoa(version), func(t *testing.T) {
			hello := clientHelloBytes(t, "api.example.com")
			backendPort, captured := startCapturingTCPBackend(t)
			splitterPort, stop := startTestSniSplitter(t, []sniRoute{{
				SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort,
				ProxyProtocolSend: true, ProxyProtocolVersion: version,
			}})
			defer stop()

			client := dialTestTCP(t, splitterPort)
			defer client.Close()
			writeTestBytes(t, client, hello)
			got := receiveCaptured(t, captured)

			clientAddr := client.LocalAddr().(*net.TCPAddr)
			want := expectedProxyHeader(t, version, "127.0.0.1", clientAddr.Port, "127.0.0.1", splitterPort)
			if !bytes.HasPrefix(got, want) {
				t.Fatalf("target did not receive header first:\n got %q\nwant prefix %q", got[:min(len(got), len(want))], want)
			}
			if !bytes.Equal(got[len(want):], hello) {
				t.Fatalf("ClientHello after header changed: got %d bytes want %d", len(got)-len(want), len(hello))
			}
		})
	}
}

func TestSniSplitterWithoutSendWritesNoProxyHeader(t *testing.T) {
	hello := clientHelloBytes(t, "api.example.com")
	backendPort, captured := startCapturingTCPBackend(t)
	splitterPort, stop := startTestSniSplitter(t, []sniRoute{{
		SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort,
		ProxyProtocolVersion: 2,
	}})
	defer stop()
	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	writeTestBytes(t, client, hello)
	if got := receiveCaptured(t, captured); !bytes.Equal(got, hello) {
		t.Fatalf("target received %d bytes, want the bare ClientHello (%d)", len(got), len(hello))
	}
}

func TestSniSplitterReceivesUpstreamHeaderAndForwardsParsedSource(t *testing.T) {
	upstream := map[string]func(t *testing.T) []byte{
		"v1": func(t *testing.T) []byte { return []byte("PROXY TCP4 203.0.113.7 198.51.100.9 4242 443\r\n") },
		"v2": func(t *testing.T) []byte { return expectedProxyHeader(t, 2, "203.0.113.7", 4242, "198.51.100.9", 443) },
	}
	for name, header := range upstream {
		for _, sendVersion := range []int{1, 2} {
			t.Run(fmt.Sprintf("receive %s send v%d", name, sendVersion), func(t *testing.T) {
				hello := clientHelloBytes(t, "api.example.com")
				backendPort, captured := startCapturingTCPBackend(t)
				splitterPort, stop := startTestSniSplitter(t, []sniRoute{{
					SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort,
					ProxyProtocolReceive: true, ProxyProtocolSend: true, ProxyProtocolVersion: sendVersion,
				}})
				defer stop()

				client := dialTestTCP(t, splitterPort)
				defer client.Close()
				// Header and hello in one segment exercises the replay of
				// bytes read past the header.
				writeTestBytes(t, client, append(header(t), hello...))
				got := receiveCaptured(t, captured)
				want := expectedProxyHeader(t, sendVersion, "203.0.113.7", 4242, "198.51.100.9", 443)
				if !bytes.HasPrefix(got, want) || !bytes.Equal(got[len(want):], hello) {
					t.Fatalf("target stream = %q, want parsed header %q followed by the ClientHello", got[:min(len(got), 64)], want)
				}
			})
		}
	}
}

func TestSniSplitterReceiveWithoutSendStripsHeader(t *testing.T) {
	hello := clientHelloBytes(t, "api.example.com")
	backendPort, captured := startCapturingTCPBackend(t)
	splitterPort, stop := startTestSniSplitter(t, []sniRoute{{
		SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort,
		ProxyProtocolReceive: true,
	}})
	defer stop()
	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	writeTestBytes(t, client, []byte("PROXY TCP4 203.0.113.7 198.51.100.9 4242 443\r\n"))
	time.Sleep(20 * time.Millisecond)
	writeTestBytes(t, client, hello)
	if got := receiveCaptured(t, captured); !bytes.Equal(got, hello) {
		t.Fatalf("target received %d bytes, want only the ClientHello (%d)", len(got), len(hello))
	}
}

func TestSniSplitterReceiveRejectsMissingHeader(t *testing.T) {
	oldTimeout := sniSplitterReadTimeout
	sniSplitterReadTimeout = 80 * time.Millisecond
	defer func() { sniSplitterReadTimeout = oldTimeout }()
	for name, payload := range map[string][]byte{
		"bare hello": clientHelloBytes(t, "api.example.com"),
		"silent":     nil,
	} {
		t.Run(name, func(t *testing.T) {
			backendPort, captured := startCapturingTCPBackend(t)
			// A default route must not hide a missing header either.
			splitterPort, stop := startTestSniSplitter(t, []sniRoute{
				{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort, ProxyProtocolReceive: true},
				{SNI: sniDefaultRoute, RuleID: 43, TargetIP: "127.0.0.1", TargetPort: backendPort, ProxyProtocolReceive: true},
			})
			defer stop()
			drainReadinessProbe(captured)
			client := dialTestTCP(t, splitterPort)
			defer client.Close()
			if len(payload) > 0 {
				writeTestBytes(t, client, payload)
			}
			expectTCPClosed(t, client)
			expectNoCapture(t, captured)
		})
	}
}

func TestSniSplitterConnectionGateUsesReceivedSource(t *testing.T) {
	hello := clientHelloBytes(t, "api.example.com")
	backendPort, captured := startCapturingTCPBackend(t)
	splitterPort, stop := startTestSniSplitter(t, []sniRoute{{
		SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort,
		MaxIPs: 1, ProxyProtocolReceive: true,
	}})
	defer stop()

	first := dialTestTCP(t, splitterPort)
	defer first.Close()
	writeTestBytes(t, first, append([]byte("PROXY TCP4 203.0.113.1 198.51.100.9 1000 443\r\n"), hello...))
	receiveCaptured(t, captured)

	// Both sockets come from 127.0.0.1; only the parsed source differs.
	second := dialTestTCP(t, splitterPort)
	defer second.Close()
	writeTestBytes(t, second, append([]byte("PROXY TCP4 203.0.113.2 198.51.100.9 1000 443\r\n"), hello...))
	expectTCPClosed(t, second)

	sameSource := dialTestTCP(t, splitterPort)
	defer sameSource.Close()
	writeTestBytes(t, sameSource, append([]byte("PROXY TCP4 203.0.113.1 198.51.100.9 1001 443\r\n"), hello...))
	if got := receiveCaptured(t, captured); !bytes.Equal(got, hello) {
		t.Fatalf("same parsed source should pass the gate, target got %d bytes", len(got))
	}
}

func TestSniSplitterDefaultRouteReplaysUnmatchedBytes(t *testing.T) {
	oldTimeout := sniSplitterReadTimeout
	sniSplitterReadTimeout = 80 * time.Millisecond
	defer func() { sniSplitterReadTimeout = oldTimeout }()
	hello := clientHelloBytes(t, "api.example.com")
	tests := []struct {
		name    string
		payload []byte
	}{
		{name: "read failure non-TLS", payload: []byte("GET / HTTP/1.1\r\nHost: probe\r\n\r\n")},
		{name: "read failure timeout with partial record header", payload: []byte{0x16, 0x03, 0x01}},
		{name: "read failure timeout with partial record body", payload: hello[:len(hello)/2]},
		{name: "read failure timeout without bytes", payload: nil},
		{name: "without sni", payload: clientHelloBytes(t, "")},
		{name: "lookup miss", payload: clientHelloBytes(t, "www.example.com")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			namedPort, namedCaptured := startCapturingTCPBackend(t)
			defaultPort, defaultCaptured := startCapturingTCPBackend(t)
			cfg := normalizeConfig(config{
				Role: "sni-splitter", ListenPort: freeTCPPort(t), Protocol: "tcp", SNIRouteVersion: 1,
				ControlSocketPath: testUnixSocketPathForOS(t),
				SNIRoutes: []sniRoute{
					{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: namedPort},
					{SNI: sniDefaultRoute, RuleID: 43, TargetIP: "127.0.0.1", TargetPort: defaultPort},
				},
			})
			splitterPort, stop := startTestSniSplitterWithConfig(t, cfg)
			defer stop()
			drainReadinessProbe(defaultCaptured)
			baseUnmatched := uint64(0)
			if cfg.ControlSocketPath != "" {
				baseUnmatched = getSNIRouteTableStatus(t, cfg.ControlSocketPath).UnmatchedConnections
			}

			client := dialTestTCP(t, splitterPort)
			defer client.Close()
			if len(tt.payload) > 0 {
				writeTestBytes(t, client, tt.payload)
			}
			got := receiveCapturedOrEmpty(t, defaultCaptured)
			if !bytes.Equal(got, tt.payload) {
				t.Fatalf("default target received %q, want the original bytes %q", got, tt.payload)
			}
			// The default target is a real peer, not a black hole.
			if _, err := client.Write([]byte("more")); err != nil {
				t.Fatalf("client connection closed after default routing: %v", err)
			}
			expectNoCapture(t, namedCaptured)
			if cfg.ControlSocketPath != "" {
				waitForSNIUnmatchedConnections(t, cfg.ControlSocketPath, baseUnmatched+1)
			}
		})
	}
}

func TestSniSplitterDefaultRouteSendsProxyHeader(t *testing.T) {
	payload := []byte("GET / HTTP/1.1\r\nHost: probe\r\n\r\n")
	backendPort, captured := startCapturingTCPBackend(t)
	splitterPort, stop := startTestSniSplitter(t, []sniRoute{
		{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: freeTCPPort(t)},
		{SNI: sniDefaultRoute, RuleID: 43, TargetIP: "127.0.0.1", TargetPort: backendPort, ProxyProtocolSend: true, ProxyProtocolVersion: 2},
	})
	defer stop()
	drainReadinessProbe(captured)
	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	writeTestBytes(t, client, payload)
	got := receiveCaptured(t, captured)
	want := expectedProxyHeader(t, 2, "127.0.0.1", client.LocalAddr().(*net.TCPAddr).Port, "127.0.0.1", splitterPort)
	if !bytes.Equal(got, append(want, payload...)) {
		t.Fatalf("default target stream = %q, want header then probe bytes", got)
	}
}

func TestSniSplitterHotUpdatesProxyProtocolSwitches(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix control sockets are not available on windows")
	}
	hello := clientHelloBytes(t, "api.example.com")
	backendPort, captured := startCapturingTCPBackend(t)
	cfg := normalizeConfig(config{
		Role: "sni-splitter", ListenPort: freeTCPPort(t), Protocol: "tcp", SNIRouteVersion: 1,
		ControlSocketPath: testUnixSocketPath(t),
		SNIRoutes:         []sniRoute{{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort}},
	})
	splitterPort, stop := startTestSniSplitterWithConfig(t, cfg)
	defer stop()

	established := dialTestTCP(t, splitterPort)
	defer established.Close()
	writeTestBytes(t, established, hello)
	receiveCaptured(t, captured)

	// Receive alone changes no route signature: established connections stay.
	sendSNIRouteTableUpdate(t, cfg.ControlSocketPath, 2, []sniRoute{{
		SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort, ProxyProtocolReceive: true,
	}})
	status := getSNIRouteTableStatus(t, cfg.ControlSocketPath)
	if status.Version != 2 || len(status.SNIRoutes) != 1 || !status.SNIRoutes[0].ProxyProtocolReceive {
		t.Fatalf("status after receive update = %+v", status)
	}
	if _, err := established.Write([]byte("still-open")); err != nil {
		t.Fatal(err)
	}
	if got := receiveCaptured(t, captured); !bytes.Equal(got, []byte("still-open")) {
		t.Fatalf("established connection was disturbed by a receive-only update: %q", got)
	}

	sendSNIRouteTableUpdate(t, cfg.ControlSocketPath, 3, []sniRoute{{
		SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort,
		ProxyProtocolReceive: true, ProxyProtocolSend: true, ProxyProtocolVersion: 1,
	}})
	status = getSNIRouteTableStatus(t, cfg.ControlSocketPath)
	if route := status.SNIRoutes[0]; !route.ProxyProtocolSend || route.ProxyProtocolVersion != 1 {
		t.Fatalf("status after send update = %+v", route)
	}
	// Enabling send changes the rule, so its established connection resets.
	expectTCPClosed(t, established)

	client := dialTestTCP(t, splitterPort)
	defer client.Close()
	writeTestBytes(t, client, append([]byte("PROXY TCP4 203.0.113.7 198.51.100.9 4242 443\r\n"), hello...))
	got := receiveCaptured(t, captured)
	want := []byte("PROXY TCP4 203.0.113.7 198.51.100.9 4242 443\r\n")
	if !bytes.Equal(got, append(want, hello...)) {
		t.Fatalf("after hot update target stream = %q", got[:min(len(got), 64)])
	}

	// Mixed receive switches in one table are rejected as a whole.
	if err := sendSNIRouteTableUpdateResult(cfg.ControlSocketPath, 4, []sniRoute{
		{SNI: "api.example.com", RuleID: 42, TargetIP: "127.0.0.1", TargetPort: backendPort, ProxyProtocolReceive: true},
		{SNI: "web.example.com", RuleID: 43, TargetIP: "127.0.0.1", TargetPort: backendPort},
	}); err == nil {
		t.Fatal("route table with mixed receive switches was accepted")
	}
}

func TestSniSplitterConfigAcceptsSingleDefaultRoute(t *testing.T) {
	base := config{Role: "sni-splitter", ListenPort: 443, Protocol: "tcp", SNIRouteVersion: 1}
	base.SNIRoutes = []sniRoute{{SNI: "*", RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443}}
	if err := validateSNISplitterConfig(normalizeConfig(base)); err != nil {
		t.Fatalf("default route rejected: %v", err)
	}
	for _, sni := range []string{"*.example.com", "a*b.example.com"} {
		base.SNIRoutes = []sniRoute{{SNI: sni, RuleID: 1, TargetIP: "127.0.0.1", TargetPort: 8443}}
		if err := validateSNISplitterConfig(normalizeConfig(base)); err == nil {
			t.Fatalf("wildcard %q accepted; only the bare default route is allowed", sni)
		}
	}
}

func TestFormatProxyProtocolV1HandlesMissingAndMixedAddresses(t *testing.T) {
	if got := string(formatProxyProtocolInfo(1, proxyProtocolInfo{})); got != "PROXY UNKNOWN\r\n" {
		t.Fatalf("empty endpoints = %q", got)
	}
	got := string(formatProxyProtocolInfo(1, proxyProtocolInfo{SourceIP: "203.0.113.7", SourcePort: 1, DestIP: "2001:db8::1", DestPort: 443}))
	if got != "PROXY TCP6 ::ffff:203.0.113.7 2001:db8::1 1 443\r\n" {
		t.Fatalf("mixed endpoints = %q", got)
	}
	info, rest, ok, err := consumeProxyProtocol([]byte(got + "x"))
	if err != nil || !ok || string(rest) != "x" || info.DestIP != "2001:db8::1" {
		t.Fatalf("mixed header does not parse back: info=%+v rest=%q ok=%v err=%v", info, rest, ok, err)
	}
}

func expectedProxyHeader(t *testing.T, version int, srcIP string, srcPort int, dstIP string, dstPort int) []byte {
	t.Helper()
	if version == 1 {
		return []byte(fmt.Sprintf("PROXY TCP4 %s %s %d %d\r\n", srcIP, dstIP, srcPort, dstPort))
	}
	header := append([]byte(nil), proxyProtocolV2Signature...)
	header = append(header, 0x21, 0x11, 0x00, 0x0c)
	header = append(header, net.ParseIP(srcIP).To4()...)
	header = append(header, net.ParseIP(dstIP).To4()...)
	header = binary.BigEndian.AppendUint16(header, uint16(srcPort))
	header = binary.BigEndian.AppendUint16(header, uint16(dstPort))
	return header
}

// startCapturingTCPBackend accepts any number of connections and reports
// each connection's bytes once the peer goes quiet or closes.
func startCapturingTCPBackend(t *testing.T) (int, <-chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	captured := make(chan []byte, 16)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				var data []byte
				buf := make([]byte, 4096)
				for {
					_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
					n, err := conn.Read(buf)
					data = append(data, buf[:n]...)
					if err != nil {
						if ne, ok := err.(net.Error); ok && ne.Timeout() && len(data) > 0 {
							captured <- data
							data = nil
							continue
						}
						if ne, ok := err.(net.Error); ok && ne.Timeout() {
							continue
						}
						if err == io.EOF && len(data) > 0 {
							captured <- data
						}
						return
					}
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, captured
}

func receiveCaptured(t *testing.T, captured <-chan []byte) []byte {
	t.Helper()
	select {
	case got := <-captured:
		return got
	case <-time.After(3 * time.Second):
		t.Fatal("target received nothing")
	}
	return nil
}

// receiveCapturedOrEmpty treats an accepted but silent connection as an
// empty capture, which is the expected outcome for a silent probe.
func receiveCapturedOrEmpty(t *testing.T, captured <-chan []byte) []byte {
	t.Helper()
	select {
	case got := <-captured:
		return got
	case <-time.After(700 * time.Millisecond):
		return nil
	}
}

func expectNoCapture(t *testing.T, captured <-chan []byte) {
	t.Helper()
	select {
	case got := <-captured:
		t.Fatalf("unexpected target traffic: %q", got)
	case <-time.After(300 * time.Millisecond):
	}
}

// drainReadinessProbe discards what the default route forwarded for the
// waitForTCPPort probe connection, which is itself an unmatched connection.
func drainReadinessProbe(captured <-chan []byte) {
	deadline := time.After(400 * time.Millisecond)
	for {
		select {
		case <-captured:
		case <-deadline:
			return
		}
	}
}

func writeTestBytes(t *testing.T, conn net.Conn, data []byte) {
	t.Helper()
	if _, err := conn.Write(data); err != nil {
		t.Fatal(err)
	}
}

func testUnixSocketPathForOS(t *testing.T) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	return testUnixSocketPath(t)
}
