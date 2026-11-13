//go:build !linux

package main

import "net"

var udpPacketInfoOOBSize = 0

// listenEntryUDP without packet info: the UDP PROXY header falls back to the
// listener address as its destination on non-Linux builds.
func listenEntryUDP(address string, _ bool) (*net.UDPConn, error) {
	addr, err := net.ResolveUDPAddr("udp", address)
	if err != nil {
		return nil, err
	}
	return net.ListenUDP("udp", addr)
}

func readEntryUDP(conn *net.UDPConn, buf, _ []byte) (int, *net.UDPAddr, net.IP, error) {
	n, addr, err := conn.ReadFromUDP(buf)
	return n, addr, nil, err
}
