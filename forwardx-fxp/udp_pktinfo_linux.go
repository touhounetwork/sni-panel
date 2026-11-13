//go:build linux

package main

import (
	"context"
	"fmt"
	"net"
	"syscall"
)

// udpPacketInfoOOBSize fits one IPv4 and one IPv6 packet-info message: a
// dual-stack socket may report both for an IPv4-mapped datagram.
var udpPacketInfoOOBSize = syscall.CmsgSpace(syscall.SizeofInet4Pktinfo) + syscall.CmsgSpace(syscall.SizeofInet6Pktinfo)

// listenEntryUDP binds the entry UDP listener. With packetInfo the kernel
// reports each datagram's destination address, so a wildcard listener still
// knows which local IP the client addressed. It is enabled before bind so no
// early datagram arrives without that metadata.
func listenEntryUDP(address string, packetInfo bool) (*net.UDPConn, error) {
	if !packetInfo {
		addr, err := net.ResolveUDPAddr("udp", address)
		if err != nil {
			return nil, err
		}
		return net.ListenUDP("udp", addr)
	}
	config := net.ListenConfig{Control: func(network, _ string, raw syscall.RawConn) error {
		var optionErr error
		err := raw.Control(func(fd uintptr) {
			// Linux honours IP_PKTINFO on dual-stack IPv6 sockets as well.
			optionErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_PKTINFO, 1)
			if optionErr == nil && network == "udp6" {
				optionErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IPV6, syscall.IPV6_RECVPKTINFO, 1)
			}
		})
		if err != nil {
			return err
		}
		if optionErr != nil {
			return fmt.Errorf("enable udp packet info: %w", optionErr)
		}
		return nil
	}}
	conn, err := config.ListenPacket(context.Background(), "udp", address)
	if err != nil {
		return nil, err
	}
	udp, ok := conn.(*net.UDPConn)
	if !ok {
		_ = conn.Close()
		return nil, fmt.Errorf("udp packet info requires a udp socket")
	}
	return udp, nil
}

// readEntryUDP reads one datagram. With an oob buffer it also returns the
// datagram's destination IP; a missing or truncated control message yields a
// nil IP and the caller falls back to the listener address.
func readEntryUDP(conn *net.UDPConn, buf, oob []byte) (int, *net.UDPAddr, net.IP, error) {
	if oob == nil {
		n, addr, err := conn.ReadFromUDP(buf)
		return n, addr, nil, err
	}
	n, oobn, flags, addr, err := conn.ReadMsgUDP(buf, oob)
	if err != nil || flags&syscall.MSG_CTRUNC != 0 {
		return n, addr, nil, err
	}
	return n, addr, udpPacketDestination(oob[:oobn]), nil
}

func udpPacketDestination(oob []byte) net.IP {
	messages, err := syscall.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var dest net.IP
	for _, message := range messages {
		switch {
		case message.Header.Level == syscall.IPPROTO_IP && message.Header.Type == syscall.IP_PKTINFO && len(message.Data) >= syscall.SizeofInet4Pktinfo:
			// in_pktinfo: ifindex, spec_dst, addr. addr is the header
			// destination, i.e. what the client actually sent to.
			return net.IPv4(message.Data[8], message.Data[9], message.Data[10], message.Data[11]).To4()
		case message.Header.Level == syscall.IPPROTO_IPV6 && message.Header.Type == syscall.IPV6_PKTINFO && len(message.Data) >= syscall.SizeofInet6Pktinfo:
			dest = append(net.IP(nil), message.Data[:16]...)
		}
	}
	if ip4 := dest.To4(); ip4 != nil {
		return ip4
	}
	return dest
}
