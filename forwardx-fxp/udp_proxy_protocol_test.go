package main

import (
	"bytes"
	"net"
	"runtime"
	"testing"
	"time"
)

func TestProxyProtocolV2DatagramRoundTripAndTransportSeparation(t *testing.T) {
	cases := []struct {
		name         string
		source, dest *net.UDPAddr
		family       byte
		wantDest     string
	}{
		{"ipv4", &net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 443}, 0x12, "198.51.100.9"},
		{"ipv6", &net.UDPAddr{IP: net.ParseIP("2001:db8::7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("2001:db8::9"), Port: 443}, 0x22, "2001:db8::9"},
		// A wildcard-bound listener must not turn a real source into LOCAL.
		{"ipv4 source on dual-stack wildcard", &net.UDPAddr{IP: net.ParseIP("::ffff:203.0.113.7"), Port: 4242}, &net.UDPAddr{IP: net.IPv6unspecified, Port: 443}, 0x12, "0.0.0.0"},
		{"ipv6 source with ipv4 dest", &net.UDPAddr{IP: net.ParseIP("2001:db8::7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 443}, 0x22, "::ffff:198.51.100.9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			header := formatProxyProtocolV2UDP(tc.source, tc.dest)
			if header[13] != tc.family {
				t.Fatalf("family/protocol byte = %#x, want %#x", header[13], tc.family)
			}
			info, rest, ok, err := consumeProxyProtocolV2Datagram(append(header, "payload"...))
			if err != nil || !ok || string(rest) != "payload" {
				t.Fatalf("parse: info=%+v rest=%q ok=%v err=%v", info, rest, ok, err)
			}
			if !net.ParseIP(info.SourceIP).Equal(tc.source.IP) || info.SourcePort != 4242 || info.DestPort != 443 || !net.ParseIP(info.DestIP).Equal(net.ParseIP(tc.wantDest)) {
				t.Fatalf("parsed %+v", info)
			}
			// A TCP connection must never accept a datagram header.
			if _, _, _, err := consumeProxyProtocol(header); err == nil {
				t.Fatal("stream parser accepted a UDP family")
			}
		})
	}
	tcp := formatProxyProtocolV2(helloFrame{ProxySourceIP: "203.0.113.7", ProxySourcePort: 1, ProxyDestIP: "198.51.100.9", ProxyDestPort: 443})
	if tcp[13] != 0x11 {
		t.Fatalf("TCP header family byte changed: %#x", tcp[13])
	}
	if _, _, _, err := consumeProxyProtocolV2Datagram(tcp); err == nil {
		t.Fatal("datagram parser accepted a TCP family")
	}
	if _, _, ok, err := consumeProxyProtocolV2Datagram([]byte("no header")); err != nil || ok {
		t.Fatalf("plain datagram: ok=%v err=%v", ok, err)
	}
}

func TestValidateConfigUDPProxyProtocolRequiresV2(t *testing.T) {
	base := config{Role: "entry", TunnelID: 1, RuleID: 1, ListenPort: 20000, Protocol: "udp", ExitHost: "127.0.0.1", ExitPort: 20001, TargetIP: "127.0.0.1", TargetPort: 20002, Key: "k", ProxyProtocolSend: true, ProxyProtocolExitSend: true}
	if err := validateConfig(normalizeConfig(base)); err == nil {
		t.Fatal("UDP PROXY without the UDP switch was accepted")
	}
	base.ProxyProtocolUDP = true
	base.ProxyProtocolVersion = 1
	if err := validateConfig(normalizeConfig(base)); err == nil {
		t.Fatal("UDP PROXY v1 was accepted; v1 has no UDP form")
	}
	base.ProxyProtocolVersion = 2
	if err := validateConfig(normalizeConfig(base)); err != nil {
		t.Fatalf("UDP PROXY v2 rejected: %v", err)
	}
}

// udpProxyChain runs a real UDP direct entry and exit with a UDP target.
type udpProxyChain struct {
	client *net.UDPConn
	target *net.UDPConn
	entry  *net.UDPAddr
}

func startUDPProxyChain(t *testing.T, mutate func(*config)) udpProxyChain {
	t.Helper()
	return startUDPProxyChainWithEntry(t, nil, mutate)
}

// startUDPProxyChainWithEntry lets a test supply the entry socket, e.g. one
// bound to the wildcard address like production listeners.
func startUDPProxyChainWithEntry(t *testing.T, entry *net.UDPConn, mutate func(*config)) udpProxyChain {
	t.Helper()
	listen := func() *net.UDPConn {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	target, exitConn := listen(), listen()
	entryConn := entry
	if entryConn == nil {
		entryConn = listen()
	}
	const key = "udp-proxy-protocol-test-key"
	exitCfg := config{Role: "exit", TunnelID: 7, Protocol: "udp", Key: key, UDPTargets: []udpTarget{{RuleID: 70, TargetIP: "127.0.0.1", TargetPort: target.LocalAddr().(*net.UDPAddr).Port}}}
	exitPort := exitConn.LocalAddr().(*net.UDPAddr).Port
	entryCfg := config{Role: "entry", TunnelID: 7, RuleID: 70, Protocol: "udp", Key: key, ExitHost: "127.0.0.1", ExitPort: exitPort, UDPExitPort: exitPort,
		ListenPort: entryConn.LocalAddr().(*net.UDPAddr).Port, TargetIP: "127.0.0.1", TargetPort: target.LocalAddr().(*net.UDPAddr).Port, ProxyProtocolVersion: 2}
	mutate(&entryCfg)
	entryCfg = normalizeConfig(entryCfg)
	if err := validateConfig(entryCfg); err != nil {
		t.Fatal(err)
	}
	selector := newExitEndpointSelector(entryCfg.Exits, exitEndpoint{Host: entryCfg.ExitHost, Port: entryCfg.ExitPort, UDPPort: entryCfg.UDPExitPort, Key: entryCfg.Key}, entryCfg.ExitStrategy)
	exitDone, entryDone := make(chan error, 1), make(chan error, 1)
	go func() { exitDone <- serveExitUDPDirect(exitConn, exitCfg) }()
	go func() { entryDone <- serveEntryUDPDirect(entryConn, entryCfg, selector, newLimiter(0), newLimiter(0)) }()
	entryAddr := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: entryConn.LocalAddr().(*net.UDPAddr).Port}
	client, err := net.DialUDP("udp", nil, entryAddr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		_ = entryConn.Close()
		_ = exitConn.Close()
		_ = target.Close()
		for _, done := range []chan error{entryDone, exitDone} {
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Error("UDP server did not stop")
			}
		}
	})
	return udpProxyChain{client: client, target: target, entry: entryAddr}
}

func (c udpProxyChain) send(t *testing.T, payload []byte) {
	t.Helper()
	if _, err := c.client.Write(payload); err != nil {
		t.Fatal(err)
	}
}

func (c udpProxyChain) receive(t *testing.T) ([]byte, *net.UDPAddr) {
	t.Helper()
	_ = c.target.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 4096)
	n, addr, err := c.target.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("target received nothing: %v", err)
	}
	return buf[:n], addr
}

func (c udpProxyChain) expectNothing(t *testing.T) {
	t.Helper()
	_ = c.target.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	buf := make([]byte, 4096)
	if n, _, err := c.target.ReadFromUDP(buf); err == nil {
		t.Fatalf("target unexpectedly received %q", buf[:n])
	}
}

func udpSendSwitches(cfg *config) {
	cfg.ProxyProtocolUDP = true
	cfg.ProxyProtocolSend = true
	cfg.ProxyProtocolExitReceive = true
	cfg.ProxyProtocolExitSend = true
}

func TestUDPDirectSendsProxyHeaderOnEveryDatagram(t *testing.T) {
	chain := startUDPProxyChain(t, udpSendSwitches)
	client := chain.client.LocalAddr().(*net.UDPAddr)
	want := formatProxyProtocolV2UDP(client, chain.entry)
	var replyTo *net.UDPAddr
	for _, payload := range []string{"first", "second", "third"} {
		chain.send(t, []byte(payload))
		got, from := chain.receive(t)
		if !bytes.Equal(got, append(append([]byte(nil), want...), payload...)) {
			t.Fatalf("target datagram = %q, want header then %q", got, payload)
		}
		replyTo = from
	}
	info, _, _, _ := consumeProxyProtocolV2Datagram(want)
	if info.SourcePort != client.Port || info.DestPort != chain.entry.Port {
		t.Fatalf("header endpoints = %+v, client=%s entry=%s", info, client, chain.entry)
	}
	// Replies travel back without any header.
	if _, err := chain.target.WriteToUDP([]byte("reply"), replyTo); err != nil {
		t.Fatal(err)
	}
	_ = chain.client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 1024)
	n, err := chain.client.Read(buf)
	if err != nil || string(buf[:n]) != "reply" {
		t.Fatalf("client reply = %q err=%v", buf[:n], err)
	}
}

func TestUDPDirectWithoutExitSendWritesNoHeader(t *testing.T) {
	chain := startUDPProxyChain(t, func(cfg *config) {
		cfg.ProxyProtocolUDP = true
		cfg.ProxyProtocolSend = true
	})
	chain.send(t, []byte("bare"))
	if got, _ := chain.receive(t); string(got) != "bare" {
		t.Fatalf("target datagram = %q", got)
	}
}

func TestUDPDirectReceivesUpstreamHeaderAndForwardsParsedSource(t *testing.T) {
	upstream := formatProxyProtocolV2UDP(&net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: 4242}, &net.UDPAddr{IP: net.ParseIP("198.51.100.9"), Port: 443})
	t.Run("receive and send", func(t *testing.T) {
		chain := startUDPProxyChain(t, func(cfg *config) { udpSendSwitches(cfg); cfg.ProxyProtocolReceive = true })
		chain.send(t, append(append([]byte(nil), upstream...), "data"...))
		if got, _ := chain.receive(t); !bytes.Equal(got, append(append([]byte(nil), upstream...), "data"...)) {
			t.Fatalf("target datagram = %q, want the parsed source re-encoded then data", got)
		}
	})
	t.Run("receive only strips the header", func(t *testing.T) {
		chain := startUDPProxyChain(t, func(cfg *config) { cfg.ProxyProtocolUDP = true; cfg.ProxyProtocolReceive = true })
		chain.send(t, append(append([]byte(nil), upstream...), "data"...))
		if got, _ := chain.receive(t); string(got) != "data" {
			t.Fatalf("target datagram = %q", got)
		}
	})
	t.Run("missing or TCP header is dropped", func(t *testing.T) {
		chain := startUDPProxyChain(t, func(cfg *config) { udpSendSwitches(cfg); cfg.ProxyProtocolReceive = true })
		chain.send(t, []byte("no header"))
		tcp := formatProxyProtocolV2(helloFrame{ProxySourceIP: "203.0.113.7", ProxySourcePort: 1, ProxyDestIP: "198.51.100.9", ProxyDestPort: 443})
		chain.send(t, append(tcp, "data"...))
		chain.expectNothing(t)
		// The session stays usable for valid datagrams.
		chain.send(t, append(append([]byte(nil), upstream...), "ok"...))
		if got, _ := chain.receive(t); !bytes.HasSuffix(got, []byte("ok")) {
			t.Fatalf("target datagram = %q", got)
		}
	})
}

func TestUDPDirectProxyHeaderIsNotBilled(t *testing.T) {
	session := &udpDirectEntrySession{}
	header := formatProxyProtocolV2UDP(&net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: 1}, nil)
	payload := append(append([]byte(nil), header...), "data"...)
	if got := session.proxyHeaderLen(payload); got != 0 {
		t.Fatalf("header length without the switches = %d", got)
	}
	udpSendSwitches(&session.cfg)
	if got := session.proxyHeaderLen(payload); got != len(header) {
		t.Fatalf("header length = %d, want %d", got, len(header))
	}
}

func TestUDPDirectHeaderUsesDatagramDestinationOnWildcardListener(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("packet info is only collected on Linux")
	}
	// Production entries listen on ":port"; without packet info the header
	// destination would be the unspecified listener address.
	entry, err := listenEntryUDP(":0", true)
	if err != nil {
		t.Fatal(err)
	}
	if ip := entry.LocalAddr().(*net.UDPAddr).IP; !ip.IsUnspecified() {
		t.Fatalf("test listener is not a wildcard bind: %s", ip)
	}
	chain := startUDPProxyChainWithEntry(t, entry, udpSendSwitches)
	for _, payload := range []string{"one", "two"} {
		chain.send(t, []byte(payload))
		got, _ := chain.receive(t)
		info, rest, ok, err := consumeProxyProtocolV2Datagram(got)
		if err != nil || !ok || string(rest) != payload {
			t.Fatalf("datagram %q: info=%+v rest=%q ok=%v err=%v", payload, info, rest, ok, err)
		}
		if info.DestIP != "127.0.0.1" || info.DestPort != chain.entry.Port {
			t.Fatalf("header destination = %s:%d, want 127.0.0.1:%d", info.DestIP, info.DestPort, chain.entry.Port)
		}
		if info.SourceIP != "127.0.0.1" || info.SourcePort != chain.client.LocalAddr().(*net.UDPAddr).Port {
			t.Fatalf("header source = %s:%d", info.SourceIP, info.SourcePort)
		}
	}
}

func TestUDPPacketDestinationParsesIPv4AndIPv6Info(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("packet info is only collected on Linux")
	}
	for _, network := range []string{"udp4", "udp6"} {
		t.Run(network, func(t *testing.T) {
			host := map[string]string{"udp4": "127.0.0.1", "udp6": "::1"}[network]
			conn, err := listenEntryUDP(net.JoinHostPort(host, "0"), true)
			if err != nil {
				t.Skipf("%s unavailable: %v", network, err)
			}
			defer conn.Close()
			sender, err := net.DialUDP("udp", nil, conn.LocalAddr().(*net.UDPAddr))
			if err != nil {
				t.Fatal(err)
			}
			defer sender.Close()
			if _, err := sender.Write([]byte("x")); err != nil {
				t.Fatal(err)
			}
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			buf := make([]byte, 16)
			n, _, dest, err := readEntryUDP(conn, buf, make([]byte, udpPacketInfoOOBSize))
			if err != nil || string(buf[:n]) != "x" {
				t.Fatalf("read: %q err=%v", buf[:n], err)
			}
			if !dest.Equal(net.ParseIP(host)) {
				t.Fatalf("destination = %v, want %s", dest, host)
			}
		})
	}
}
