package main

import (
	"errors"
	"net/netip"
	"sort"
	"unsafe"

	"golang.org/x/sys/windows"

	"amnesiawg-helper/internal/proto"
)

type adapter struct {
	index   uint32
	alias   string
	metric  uint32
	up      bool
	loop    bool
	servers []string
}

func adapters() ([]adapter, error) {
	size := uint32(15000)
	for {
		buf := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC,
			windows.GAA_FLAG_SKIP_UNICAST|windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST, 0, first, &size)
		if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var out []adapter
		for a := first; a != nil; a = a.Next {
			ad := adapter{
				index:  a.IfIndex,
				alias:  windows.UTF16PtrToString(a.FriendlyName),
				metric: a.Ipv4Metric,
				up:     a.OperStatus == windows.IfOperStatusUp,
				loop:   a.IfType == windows.IF_TYPE_SOFTWARE_LOOPBACK,
			}
			for d := a.FirstDnsServerAddress; d != nil; d = d.Next {
				ip, ok := netip.AddrFromSlice(d.Address.IP())
				// fec0:0:0:ffff::1 and friends are placeholders Windows lists for adapters without DNS.
				if ok && !ip.IsLoopback() && !isSiteLocal(ip) {
					ad.servers = append(ad.servers, ip.Unmap().String())
				}
			}
			out = append(out, ad)
		}
		return out, nil
	}
}

func isSiteLocal(ip netip.Addr) bool {
	return ip.Is6() && ip.As16()[0] == 0xfe && ip.As16()[1]&0xc0 == 0xc0
}

// netInfo answers the app's connectivity check without any output parsing: which interface the system
// would use to reach the target, and which resolver it would ask first (the up interface with a DNS
// server and the lowest metric, which is how Windows orders them).
func netInfo(target string) (*proto.Response, error) {
	ip, err := netip.ParseAddr(target)
	if err != nil || !ip.Is4() {
		return nil, proto.Errf(proto.CodeBadRequest, "Для проверки маршрута нужен IPv4-адрес")
	}
	all, err := adapters()
	if err != nil {
		return nil, err
	}
	resp := &proto.Response{OK: true}

	var best uint32
	if err := windows.GetBestInterfaceEx(&windows.SockaddrInet4{Addr: ip.As4()}, &best); err == nil {
		for _, a := range all {
			if a.index == best {
				resp.RouteIface = a.alias
			}
		}
	}

	var withDNS []adapter
	for _, a := range all {
		if a.up && !a.loop && len(a.servers) > 0 {
			withDNS = append(withDNS, a)
		}
	}
	sort.SliceStable(withDNS, func(i, j int) bool { return withDNS[i].metric < withDNS[j].metric })
	if len(withDNS) > 0 {
		resp.Resolver = &proto.Resolver{Iface: withDNS[0].alias, Nameservers: withDNS[0].servers}
	}
	return resp, nil
}
