//! Desktop half of "browser traffic through this computer" (docs/design/browser-user-egress.md, wire format in
//! docs/design/browser-user-egress-protocol.md). The app dials OUT to the runtime's `/v1/browser/egress` WebSocket
//! (bearer token in a header, never in the URL) and acts as the far end of a multiplexed stream relay: the agent
//! browser's daemon sends OPEN host:port, this module resolves DNS on this machine, checks the guard on the exact
//! addresses it will connect to, opens the TCP connection and relays bytes under per-stream credits.
//!
//! There is NO listening socket here, ever. Streams only originate from the one authenticated runtime WebSocket,
//! and the guard refuses private/loopback/link-local space (after DNS) and every port but 80/443/8080/8443 by default.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{async_runtime::{spawn, JoinHandle}, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, Notify, Semaphore},
    task::JoinSet,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};

// ---------------------------------------------------------------------------------------------------------------------
// Limits (protocol §Streams, design §3.2)
// ---------------------------------------------------------------------------------------------------------------------

pub const ALLOWED_PORTS: [u16; 4] = [80, 443, 8080, 8443];
pub const MAX_STREAMS: usize = 256;
pub const FRAME_MAX: usize = 32 * 1024;
pub const WINDOW: u32 = 256 * 1024;
pub const MAX_HOST: usize = 255;
const RATE_PER_SEC: f64 = 60.0;
const RATE_BURST: f64 = 120.0;
/// 50 Mbit/s.
const BANDWIDTH_BYTES_PER_SEC: f64 = 50.0 * 1_000_000.0 / 8.0;
pub const DEFAULT_DAILY_CAP: u64 = 10 * 1024 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const STREAM_IDLE_SECS: u64 = 15 * 60;
const PING_EVERY: Duration = Duration::from_secs(20);
const DEAD_AFTER: Duration = Duration::from_secs(60);
const BACKOFF_SECS: [u64; 5] = [1, 2, 5, 10, 30];
const RECENT_MAX: usize = 500;
const HAPPY_EYEBALLS_STAGGER: Duration = Duration::from_millis(250);

// RST reasons (the full list of the protocol doc, some are only ever sent by the other side)
#[allow(dead_code)]
pub const RST_GENERIC: u8 = 0;
#[allow(dead_code)]
pub const RST_GUARD: u8 = 1;
#[allow(dead_code)]
pub const RST_STREAMS: u8 = 2;
#[allow(dead_code)]
pub const RST_RATE: u8 = 3;
#[allow(dead_code)]
pub const RST_BANDWIDTH: u8 = 4;
#[allow(dead_code)]
pub const RST_DAILY: u8 = 5;
#[allow(dead_code)]
pub const RST_IDLE: u8 = 6;
#[allow(dead_code)]
pub const RST_PROTOCOL: u8 = 7;
#[allow(dead_code)]
pub const RST_KILLED: u8 = 8;
#[allow(dead_code)]
pub const RST_SHUTDOWN: u8 = 9;
#[allow(dead_code)]
pub const RST_UPSTREAM: u8 = 10;
/// Sent by the runtime hub when the desktop that owned a stream is no longer the active one (or the link dropped).
#[allow(dead_code)]
pub const RST_LINK_DOWN: u8 = 11;

// WebSocket close codes the runtime hub uses (protocol doc, Connection)
const CLOSE_INCOMPATIBLE: u16 = 4400;
#[allow(dead_code)]
const CLOSE_DESKTOP_OPEN: u16 = 4401;

// SOCKS5 reply codes carried by OPENED
const SOCKS_GENERAL: u8 = 0x01;
const SOCKS_NOT_ALLOWED: u8 = 0x02;
const SOCKS_NET_UNREACH: u8 = 0x03;
const SOCKS_HOST_UNREACH: u8 = 0x04;
const SOCKS_REFUSED: u8 = 0x05;
const SOCKS_TTL: u8 = 0x06;

// ---------------------------------------------------------------------------------------------------------------------
// Guard: pure and table tested. Everything that decides whether this machine may connect lives here.
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    /// Advanced opt-in: ports other than 80/443/8080/8443. Address ranges stay guarded regardless.
    pub allow_other_ports: bool,
    /// Daily data cap in bytes; 0 means the default (10 GiB).
    pub daily_cap_bytes: u64,
    /// This machine's own networks, gateway and public address (see `LocalGuard`). Filled in by the session, never by the UI.
    #[serde(skip)]
    pub local: LocalGuard,
    /// Tests connect to loopback fixtures; this field does not exist in release builds.
    #[cfg(test)]
    #[serde(skip)]
    pub allow_local: bool,
}

impl Policy {
    fn daily_cap(&self) -> u64 {
        if self.daily_cap_bytes == 0 { DEFAULT_DAILY_CAP } else { self.daily_cap_bytes }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Deny {
    /// Malformed, over-long or local-by-name host.
    Host,
    Port,
    Address,
}

const V4_BLOCKED: &[([u8; 4], u8)] = &[
    ([0, 0, 0, 0], 8),       // "this network"
    ([10, 0, 0, 0], 8),      // RFC1918
    ([100, 64, 0, 0], 10),   // CGNAT
    ([127, 0, 0, 0], 8),     // loopback
    ([169, 254, 0, 0], 16),  // link-local, cloud metadata
    ([172, 16, 0, 0], 12),   // RFC1918
    ([192, 0, 0, 0], 24),    // IETF protocol assignments
    ([192, 0, 2, 0], 24),    // documentation
    ([192, 88, 99, 0], 24),  // 6to4 relay anycast
    ([192, 168, 0, 0], 16),  // RFC1918
    ([198, 18, 0, 0], 15),   // benchmarking
    ([198, 51, 100, 0], 24), // documentation
    ([203, 0, 113, 0], 24),  // documentation
    ([224, 0, 0, 0], 4),     // multicast
    ([240, 0, 0, 0], 4),     // reserved + broadcast
];

fn v4_blocked(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    V4_BLOCKED.iter().any(|(net, prefix)| {
        let mask = if *prefix == 0 { 0 } else { u32::MAX << (32 - *prefix as u32) };
        value & mask == u32::from(Ipv4Addr::from(*net)) & mask
    })
}

fn embedded_v4(high: u16, low: u16) -> Ipv4Addr {
    Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8)
}

fn v6_blocked(address: Ipv6Addr) -> bool {
    let s = address.segments();
    // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT)
    if let Some(v4) = address.to_ipv4_mapped() {
        return v4_blocked(v4);
    }
    if s[..4] == [0, 0, 0, 0] && s[4] == 0xffff && s[5] == 0 {
        return v4_blocked(embedded_v4(s[6], s[7]));
    }
    // ::/96: unspecified, ::1 and deprecated IPv4-compatible addresses.
    if s[..6] == [0, 0, 0, 0, 0, 0] {
        return true;
    }
    // NAT64 well-known prefix 64:ff9b::/96 embeds a v4 address; 64:ff9b:1::/48 is local-use.
    if s[0] == 0x64 && s[1] == 0xff9b {
        if s[2..6] == [0, 0, 0, 0] {
            return v4_blocked(embedded_v4(s[6], s[7]));
        }
        if s[2] == 1 {
            return true;
        }
    }
    // 6to4 2002::/16 embeds the v4 address in bits 16..48.
    if s[0] == 0x2002 {
        return v4_blocked(embedded_v4(s[1], s[2]));
    }
    if s[..4] == [0x100, 0, 0, 0] { return true; } // 100::/64 discard
    if s[0] & 0xffc0 == 0xfe80 { return true; } // link-local
    if s[0] & 0xffc0 == 0xfec0 { return true; } // deprecated site-local
    if s[0] & 0xfe00 == 0xfc00 { return true; } // ULA
    if s[0] & 0xff00 == 0xff00 { return true; } // multicast
    if s[0] == 0x2001 && s[1] == 0x0db8 { return true; } // documentation
    if s[0] == 0x2001 && s[1] == 0 { return true; } // Teredo
    if s[0] == 0x2001 && s[1] == 2 && s[2] == 0 { return true; } // benchmarking
    if s[0] == 0x2001 && s[1] & 0xfff0 == 0x10 { return true; } // ORCHID
    if s[0] == 0x2001 && s[1] & 0xfff0 == 0x20 { return true; } // ORCHIDv2
    if s[0] == 0x3fff && s[1] & 0xf000 == 0 { return true; } // documentation 3fff::/20
    if s[0] == 0x5f00 { return true; } // SRv6 SIDs 5f00::/16
    false
}

// ---------------------------------------------------------------------------------------------------------------------
// This machine's own network (design §3.2 / E3: the user's LAN is unreachable through the egress)
// ---------------------------------------------------------------------------------------------------------------------

/// What the static range tables cannot know. Devices on the user's LAN often have GLOBAL IPv6 addresses (2000::/3) that the
/// router's inbound firewall hides from the internet but not from this computer, and the public IPv4 of this connection is the
/// router itself when reached from inside (NAT loopback). So the guard also refuses every on-link prefix of this machine
/// (IPv4 and IPv6), the default gateway, and the public address the runtime saw this computer connect from.
#[derive(Clone, Debug, Default)]
pub struct LocalGuard {
    nets: Vec<(IpAddr, u8)>,
    addrs: Vec<IpAddr>,
}

fn prefix_match(net: IpAddr, prefix: u8, ip: IpAddr) -> bool {
    match (net, ip) {
        (IpAddr::V4(n), IpAddr::V4(i)) => {
            let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix.min(32) as u32) };
            u32::from(n) & mask == u32::from(i) & mask
        }
        (IpAddr::V6(n), IpAddr::V6(i)) => {
            let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix.min(128) as u32) };
            u128::from(n) & mask == u128::from(i) & mask
        }
        _ => false,
    }
}

/// The IPv4 address an IPv6 address carries (mapped, SIIT, NAT64, 6to4), if any: those reach the same host as the v4 form.
fn carried_v4(address: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = address.segments();
    if let Some(v4) = address.to_ipv4_mapped() { return Some(v4); }
    if s[..4] == [0, 0, 0, 0] && s[4] == 0xffff && s[5] == 0 { return Some(embedded_v4(s[6], s[7])); }
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] { return Some(embedded_v4(s[6], s[7])); }
    if s[0] == 0x2002 { return Some(embedded_v4(s[1], s[2])); }
    None
}

impl LocalGuard {
    #[cfg(test)]
    pub fn for_test(nets: &[(&str, u8)], addrs: &[&str]) -> Self {
        LocalGuard { nets: nets.iter().map(|(a, p)| (a.parse().unwrap(), *p)).collect(), addrs: addrs.iter().map(|a| a.parse().unwrap()).collect() }
    }

    /// Reads this machine's interfaces and default gateway now.
    pub fn detect() -> Self {
        let nets = interface_nets();
        let addrs = default_gateways();
        LocalGuard { nets, addrs }
    }

    /// Adds the address this computer is seen from on the internet (sent by the runtime in its HELLO).
    pub fn with_public(mut self, address: Option<IpAddr>) -> Self {
        if let Some(ip) = address { self.addrs.push(ip); }
        self
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let mut candidates = vec![ip];
        if let IpAddr::V6(v6) = ip {
            if let Some(v4) = carried_v4(v6) { candidates.push(IpAddr::V4(v4)); }
        }
        candidates.iter().any(|c| self.addrs.contains(c) || self.nets.iter().any(|(net, prefix)| prefix_match(*net, *prefix, *c)))
    }
}

#[cfg(unix)]
fn interface_nets() -> Vec<(IpAddr, u8)> {
    let mut out = Vec::new();
    // SAFETY: getifaddrs allocates a list we only read and free with freeifaddrs; every pointer is checked before use and the
    // sockaddr casts follow the family the kernel reports for that very entry.
    unsafe {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut head) != 0 { return out; }
        let mut cur = head;
        while !cur.is_null() {
            let ifa = &*cur;
            if !ifa.ifa_addr.is_null() && !ifa.ifa_netmask.is_null() {
                match (*ifa.ifa_addr).sa_family as i32 {
                    libc::AF_INET => {
                        let a = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                        let m = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                        let prefix = u32::from_be(m.sin_addr.s_addr).count_ones() as u8;
                        if prefix > 0 { out.push((IpAddr::V4(Ipv4Addr::from(u32::from_be(a.sin_addr.s_addr))), prefix)); }
                    }
                    libc::AF_INET6 => {
                        let a = &*(ifa.ifa_addr as *const libc::sockaddr_in6);
                        let m = &*(ifa.ifa_netmask as *const libc::sockaddr_in6);
                        let prefix = u128::from_be_bytes(m.sin6_addr.s6_addr).count_ones() as u8;
                        if prefix > 0 { out.push((IpAddr::V6(Ipv6Addr::from(a.sin6_addr.s6_addr)), prefix)); }
                    }
                    _ => {}
                }
            }
            cur = ifa.ifa_next;
        }
        libc::freeifaddrs(head);
    }
    out
}

/// Non-unix fallback: the source address the OS would pick (a UDP connect sends nothing), with the usual /24 and /64.
#[cfg(not(unix))]
fn interface_nets() -> Vec<(IpAddr, u8)> {
    let mut out = Vec::new();
    for (bind, probe, prefix) in [("0.0.0.0:0", "192.0.2.1:9", 24u8), ("[::]:0", "[2001:db8::1]:9", 64u8)] {
        if let Ok(socket) = std::net::UdpSocket::bind(bind) {
            if socket.connect(probe).is_ok() {
                if let Ok(local) = socket.local_addr() { out.push((local.ip(), prefix)); }
            }
        }
    }
    out
}

/// Default gateways (Linux reads /proc; elsewhere the gateway lies inside an on-link prefix in practice, which is refused anyway).
fn default_gateways() -> Vec<IpAddr> {
    let mut out = Vec::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/net/route") {
            for line in text.lines().skip(1) {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() > 2 && f[1] == "00000000" {
                    if let Ok(raw) = u32::from_str_radix(f[2], 16) { out.push(IpAddr::V4(Ipv4Addr::from(raw.swap_bytes()))); }
                }
            }
        }
        if let Ok(text) = std::fs::read_to_string("/proc/net/ipv6_route") {
            for line in text.lines() {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() > 4 && f[0] == "00000000000000000000000000000000" && f[1] == "00" {
                    if let Ok(raw) = u128::from_str_radix(f[4], 16) { out.push(IpAddr::V6(Ipv6Addr::from(raw))); }
                }
            }
        }
    }
    out
}

/// True when this address must never be connected to.
pub fn ip_blocked(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4_blocked(v4),
        IpAddr::V6(v6) => v6_blocked(v6),
    }
}

/// Lowercased host with surrounding brackets and a trailing root dot removed.
fn normalize_host(host: &str) -> String {
    let host = host.trim();
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    host.trim_end_matches('.').to_lowercase()
}

/// Cheap checks that need no DNS: shape of the host, local names, literal addresses and the port.
pub fn guard_target(host: &str, port: u16, policy: &Policy) -> Result<(), Deny> {
    if host.is_empty() || host.len() > MAX_HOST {
        return Err(Deny::Host);
    }
    let name = normalize_host(host);
    if name.is_empty() || name.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '%' | '?' | '#')) {
        return Err(Deny::Host);
    }
    if name == "localhost" || name.ends_with(".localhost") {
        #[cfg(test)]
        if policy.allow_local {
            return port_ok(port, policy);
        }
        return Err(Deny::Host);
    }
    port_ok(port, policy)?;
    if let Ok(literal) = name.parse::<IpAddr>() {
        return check_addresses(&[literal], policy);
    }
    Ok(())
}

fn port_ok(port: u16, policy: &Policy) -> Result<(), Deny> {
    if port != 0 && (policy.allow_other_ports || ALLOWED_PORTS.contains(&port)) { Ok(()) } else { Err(Deny::Port) }
}

fn check_addresses(resolved: &[IpAddr], policy: &Policy) -> Result<(), Deny> {
    #[cfg(test)]
    if policy.allow_local {
        return if resolved.is_empty() { Err(Deny::Address) } else { Ok(()) };
    }
    // A name with ANY blocked answer is refused as a whole: a mixed answer is how rebinding tricks look.
    // `policy.local` adds what no static table can know: the user's own LAN (global IPv6 prefixes included), the gateway and
    // the public address this computer is seen from (NAT hairpin to the router).
    if resolved.is_empty() || resolved.iter().any(|ip| ip_blocked(*ip) || policy.local.contains(*ip)) { Err(Deny::Address) } else { Ok(()) }
}

/// The full decision, `resolved` being what DNS (or the literal) produced. The caller must connect to exactly these
/// addresses, never re-resolve, so a rebinding answer cannot slip in between check and connect.
pub fn guard(host: &str, port: u16, resolved: &[IpAddr], policy: &Policy) -> Result<(), Deny> {
    guard_target(host, port, policy)?;
    check_addresses(resolved, policy)
}

// ---------------------------------------------------------------------------------------------------------------------
// Frame codec (protocol doc)
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Addr {
    V4(Ipv4Addr),
    Domain(String),
    V6(Ipv6Addr),
}

impl Addr {
    pub fn host(&self) -> String {
        match self {
            Addr::V4(a) => a.to_string(),
            Addr::V6(a) => a.to_string(),
            Addr::Domain(d) => d.clone(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Frame {
    Open { id: u32, addr: Addr, port: u16 },
    Opened { id: u32, result: u8 },
    Data { id: u32, bytes: Vec<u8> },
    Credit { id: u32, bytes: u32 },
    Fin { id: u32 },
    Rst { id: u32, reason: u8 },
    Ping(u64),
    Pong(u64),
    Hello(String),
    Unknown { kind: u8, id: u32 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum CodecError {
    Short,
    BadPayload,
    TooBig,
}

pub fn encode(frame: &Frame) -> Vec<u8> {
    fn head(kind: u8, id: u32, extra: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + extra);
        out.push(kind);
        out.extend_from_slice(&id.to_be_bytes());
        out
    }
    match frame {
        Frame::Open { id, addr, port } => {
            let mut out = head(0x01, *id, 24);
            match addr {
                Addr::V4(a) => { out.push(1); out.extend_from_slice(&a.octets()); }
                Addr::V6(a) => { out.push(4); out.extend_from_slice(&a.octets()); }
                Addr::Domain(d) => { out.push(3); out.push(d.len() as u8); out.extend_from_slice(d.as_bytes()); }
            }
            out.extend_from_slice(&port.to_be_bytes());
            out
        }
        Frame::Opened { id, result } => { let mut out = head(0x02, *id, 1); out.push(*result); out }
        Frame::Data { id, bytes } => { let mut out = head(0x03, *id, bytes.len()); out.extend_from_slice(bytes); out }
        Frame::Credit { id, bytes } => { let mut out = head(0x04, *id, 4); out.extend_from_slice(&bytes.to_be_bytes()); out }
        Frame::Fin { id } => head(0x05, *id, 0),
        Frame::Rst { id, reason } => { let mut out = head(0x06, *id, 1); out.push(*reason); out }
        Frame::Ping(nonce) => { let mut out = head(0x07, 0, 8); out.extend_from_slice(&nonce.to_be_bytes()); out }
        Frame::Pong(nonce) => { let mut out = head(0x08, 0, 8); out.extend_from_slice(&nonce.to_be_bytes()); out }
        Frame::Hello(json) => { let mut out = head(0x09, 0, json.len()); out.extend_from_slice(json.as_bytes()); out }
        Frame::Unknown { kind, id } => head(*kind, *id, 0),
    }
}

pub fn decode(buf: &[u8]) -> Result<Frame, CodecError> {
    if buf.len() < 5 {
        return Err(CodecError::Short);
    }
    let kind = buf[0];
    let id = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]);
    let payload = &buf[5..];
    match kind {
        0x01 => {
            let atyp = *payload.first().ok_or(CodecError::Short)?;
            let (addr, rest) = match atyp {
                1 => {
                    let raw: [u8; 4] = payload.get(1..5).ok_or(CodecError::Short)?.try_into().unwrap();
                    (Addr::V4(Ipv4Addr::from(raw)), &payload[5..])
                }
                4 => {
                    let raw: [u8; 16] = payload.get(1..17).ok_or(CodecError::Short)?.try_into().unwrap();
                    (Addr::V6(Ipv6Addr::from(raw)), &payload[17..])
                }
                3 => {
                    let len = *payload.get(1).ok_or(CodecError::Short)? as usize;
                    if len == 0 {
                        return Err(CodecError::BadPayload);
                    }
                    let name = payload.get(2..2 + len).ok_or(CodecError::Short)?;
                    let name = std::str::from_utf8(name).map_err(|_| CodecError::BadPayload)?;
                    (Addr::Domain(name.to_string()), &payload[2 + len..])
                }
                _ => return Err(CodecError::BadPayload),
            };
            if rest.len() != 2 {
                return Err(if rest.len() < 2 { CodecError::Short } else { CodecError::BadPayload });
            }
            Ok(Frame::Open { id, addr, port: u16::from_be_bytes([rest[0], rest[1]]) })
        }
        0x02 => Ok(Frame::Opened { id, result: *payload.first().ok_or(CodecError::Short)? }),
        0x03 => {
            if payload.len() > FRAME_MAX {
                return Err(CodecError::TooBig);
            }
            Ok(Frame::Data { id, bytes: payload.to_vec() })
        }
        0x04 => {
            let raw: [u8; 4] = payload.get(..4).ok_or(CodecError::Short)?.try_into().unwrap();
            Ok(Frame::Credit { id, bytes: u32::from_be_bytes(raw) })
        }
        0x05 => Ok(Frame::Fin { id }),
        0x06 => Ok(Frame::Rst { id, reason: payload.first().copied().unwrap_or(RST_GENERIC) }),
        0x07 | 0x08 => {
            let raw: [u8; 8] = payload.get(..8).ok_or(CodecError::Short)?.try_into().unwrap();
            let nonce = u64::from_be_bytes(raw);
            Ok(if kind == 0x07 { Frame::Ping(nonce) } else { Frame::Pong(nonce) })
        }
        0x09 => Ok(Frame::Hello(String::from_utf8(payload.to_vec()).map_err(|_| CodecError::BadPayload)?)),
        _ => Ok(Frame::Unknown { kind, id }),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure accounting: admission, token buckets, usage, flow-control window, rolling byte rate
// ---------------------------------------------------------------------------------------------------------------------

/// Token bucket with caller-supplied time so tests do not sleep.
pub struct Bucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    at: f64,
}

impl Bucket {
    pub fn new(rate: f64, burst: f64) -> Self {
        Bucket { rate, burst, tokens: burst, at: 0.0 }
    }

    fn refill(&mut self, now: f64) {
        if now > self.at {
            self.tokens = (self.tokens + (now - self.at) * self.rate).min(self.burst);
        }
        self.at = self.at.max(now);
    }

    /// Takes `n` if available now.
    pub fn try_take(&mut self, now: f64, n: f64) -> bool {
        self.refill(now);
        if self.tokens >= n {
            self.tokens -= n;
            true
        } else {
            false
        }
    }

    /// Takes `n` regardless (the balance may go negative) and returns the seconds the caller should wait to stay
    /// within the rate. Used for throttling bandwidth instead of dropping traffic.
    pub fn take_delay(&mut self, now: f64, n: f64) -> f64 {
        self.refill(now);
        self.tokens -= n;
        if self.tokens >= 0.0 { 0.0 } else { -self.tokens / self.rate }
    }
}

/// Decides whether a daemon-sent OPEN may start a stream. Protocol violations and caps map to RST reasons.
pub struct Admission {
    live: HashSet<u32>,
    last_id: u32,
    rate: Bucket,
    max_streams: usize,
}

impl Admission {
    pub fn new(max_streams: usize) -> Self {
        Admission { live: HashSet::new(), last_id: 0, rate: Bucket::new(RATE_PER_SEC, RATE_BURST), max_streams }
    }

    /// Err(reason) is the RST reason to answer with; `RST_PROTOCOL` closes the whole connection upstream.
    pub fn open(&mut self, id: u32, now: f64) -> Result<(), u8> {
        // Ids are daemon-allocated: odd and strictly increasing. Anything else is a protocol error.
        if id % 2 == 0 || id <= self.last_id || self.live.contains(&id) {
            return Err(RST_PROTOCOL);
        }
        self.last_id = id;
        if self.live.len() >= self.max_streams {
            return Err(RST_STREAMS);
        }
        if !self.rate.try_take(now, 1.0) {
            return Err(RST_RATE);
        }
        self.live.insert(id);
        Ok(())
    }

    pub fn close(&mut self, id: u32) {
        self.live.remove(&id);
    }

    pub fn contains(&self, id: u32) -> bool {
        self.live.contains(&id)
    }

    pub fn len(&self) -> usize {
        self.live.len()
    }

    pub fn clear(&mut self) {
        self.live.clear();
    }
}

/// Bytes moved today (local midnight reset), persisted between runs.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq, Eq)]
pub struct Usage {
    pub day: String,
    pub bytes: u64,
}

impl Usage {
    pub fn roll(&mut self, today: &str) {
        if self.day != today {
            self.day = today.to_string();
            self.bytes = 0;
        }
    }

    /// Adds `n` bytes and returns whether the daily cap is now reached.
    pub fn add(&mut self, today: &str, n: u64, cap: u64) -> bool {
        self.roll(today);
        self.bytes = self.bytes.saturating_add(n);
        self.bytes >= cap
    }
}

/// Receive-side flow control for one stream: bytes the peer may still send before more credit is returned.
pub struct RecvWindow {
    outstanding: u64,
    size: u64,
}

impl RecvWindow {
    pub fn new(size: u32) -> Self {
        RecvWindow { outstanding: 0, size: size as u64 }
    }

    /// Peer sent `n` bytes. Err when it overran the window it was granted.
    pub fn on_data(&mut self, n: usize) -> Result<(), ()> {
        self.outstanding += n as u64;
        if self.outstanding > self.size { Err(()) } else { Ok(()) }
    }

    /// The bytes were written to the socket: returns the credit to hand back.
    pub fn on_written(&mut self, n: usize) -> u32 {
        self.outstanding = self.outstanding.saturating_sub(n as u64);
        n as u32
    }
}

/// Bytes per minute over a rolling 60 s, in per-second slots.
pub struct Rolling {
    slots: [u64; 60],
    last: u64,
}

impl Rolling {
    pub fn new() -> Self {
        Rolling { slots: [0; 60], last: 0 }
    }

    fn advance(&mut self, sec: u64) {
        if sec >= self.last + 60 {
            self.slots = [0; 60];
        } else {
            for s in self.last + 1..=sec {
                self.slots[(s % 60) as usize] = 0;
            }
        }
        self.last = self.last.max(sec);
    }

    pub fn add(&mut self, sec: u64, n: u64) {
        self.advance(sec);
        self.slots[(sec % 60) as usize] += n;
    }

    pub fn per_minute(&mut self, sec: u64) -> u64 {
        self.advance(sec);
        self.slots.iter().sum()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Status, recent log, shared state
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub host: String,
    pub port: u16,
    pub bytes: u64,
    /// Unix ms.
    pub start: u64,
    pub end: u64,
    pub result: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    /// off | connecting | up | standby | paused | error
    pub state: String,
    pub error: Option<String>,
    pub streams: usize,
    pub bytes_per_min: u64,
    pub rtt_ms: Option<u64>,
    pub used_today: u64,
    pub daily_cap: u64,
    pub machine: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusFull {
    #[serde(flatten)]
    pub status: Status,
    pub recent: Vec<Recent>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn today() -> String {
    chrono::Local::now().date_naive().to_string()
}

struct Inner {
    state: String,
    error: Option<String>,
    rtt_ms: Option<u64>,
    machine: Option<String>,
    usage: Usage,
    usage_dirty: bool,
    cap: u64,
    limit_hit: bool,
    rolling: Rolling,
    recent: VecDeque<Recent>,
    streams: usize,
}

type Notify_ = Arc<dyn Fn(&Status) + Send + Sync>;

pub struct Shared {
    inner: Mutex<Inner>,
    kill: Notify,
    stopped: AtomicBool,
    usage_path: Option<std::path::PathBuf>,
    bandwidth: Mutex<Bucket>,
    started: Instant,
    on_status: Notify_,
}

impl Shared {
    fn new(usage_path: Option<std::path::PathBuf>, on_status: Notify_) -> Arc<Self> {
        let usage = usage_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|raw| serde_json::from_slice::<Usage>(&raw).ok())
            .unwrap_or_default();
        Arc::new(Shared {
            inner: Mutex::new(Inner {
                state: "off".into(),
                error: None,
                rtt_ms: None,
                machine: None,
                usage,
                usage_dirty: false,
                cap: DEFAULT_DAILY_CAP,
                limit_hit: false,
                rolling: Rolling::new(),
                recent: VecDeque::new(),
                streams: 0,
            }),
            kill: Notify::new(),
            stopped: AtomicBool::new(false),
            usage_path,
            bandwidth: Mutex::new(Bucket::new(BANDWIDTH_BYTES_PER_SEC, BANDWIDTH_BYTES_PER_SEC)),
            started: Instant::now(),
            on_status,
        })
    }

    fn secs(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    fn status(&self) -> Status {
        let mut inner = self.inner.lock().unwrap();
        let sec = self.started.elapsed().as_secs();
        let today = today();
        inner.usage.roll(&today);
        let per_minute = inner.rolling.per_minute(sec);
        Status {
            running: inner.state != "off",
            state: inner.state.clone(),
            error: inner.error.clone(),
            streams: inner.streams,
            bytes_per_min: per_minute,
            rtt_ms: inner.rtt_ms,
            used_today: inner.usage.bytes,
            daily_cap: inner.cap,
            machine: inner.machine.clone(),
        }
    }

    fn full(&self) -> StatusFull {
        let status = self.status();
        let recent = self.inner.lock().unwrap().recent.iter().rev().cloned().collect();
        StatusFull { status, recent }
    }

    fn publish(&self) {
        (self.on_status)(&self.status());
    }

    fn set_state(&self, state: &str, error: Option<String>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.state = state.to_string();
            inner.error = error;
            if state != "up" {
                inner.rtt_ms = None;
            }
        }
        self.publish();
    }

    fn set_streams(&self, n: usize) {
        self.inner.lock().unwrap().streams = n;
    }

    /// Records bytes moved; true when the daily cap is reached (the caller resets its stream).
    fn count(&self, n: u64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let sec = self.started.elapsed().as_secs();
        inner.rolling.add(sec, n);
        let cap = inner.cap;
        let hit = inner.usage.add(&today(), n, cap);
        inner.usage_dirty = true;
        if hit {
            inner.limit_hit = true;
        }
        hit
    }

    fn limit_hit(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.limit_hit {
            // A new day lifts the pause.
            let cap = inner.cap;
            inner.usage.roll(&today());
            if inner.usage.bytes < cap {
                inner.limit_hit = false;
            }
        }
        inner.limit_hit
    }

    fn bandwidth_delay(&self, n: usize) -> Duration {
        let now = self.secs();
        Duration::from_secs_f64(self.bandwidth.lock().unwrap().take_delay(now, n as f64).min(5.0))
    }

    fn log(&self, entry: Recent) {
        let mut inner = self.inner.lock().unwrap();
        if inner.recent.len() >= RECENT_MAX {
            inner.recent.pop_front();
        }
        inner.recent.push_back(entry);
    }

    fn flush_usage(&self) {
        let (snapshot, dirty) = {
            let mut inner = self.inner.lock().unwrap();
            let dirty = inner.usage_dirty;
            inner.usage_dirty = false;
            (inner.usage.clone(), dirty)
        };
        if dirty {
            if let (Some(path), Ok(raw)) = (&self.usage_path, serde_json::to_vec(&snapshot)) {
                let _ = std::fs::write(path, raw);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mux session
// ---------------------------------------------------------------------------------------------------------------------

enum Inbound {
    Data(Vec<u8>),
    Fin,
    Rst,
}

struct Handle {
    tx: mpsc::UnboundedSender<Inbound>,
    credit: Arc<Semaphore>,
    window: Arc<Mutex<RecvWindow>>,
}

struct Table {
    admission: Admission,
    streams: HashMap<u32, Handle>,
}

struct Ctx {
    shared: Arc<Shared>,
    policy: Policy,
    public_ip: Option<IpAddr>,
    /// Interfaces and gateway, re-read when older than LOCAL_REFRESH (a laptop changes networks).
    local: Mutex<(Instant, LocalGuard)>,
    out: mpsc::Sender<Vec<u8>>,
    table: Mutex<Table>,
}

const LOCAL_REFRESH: Duration = Duration::from_secs(30);

impl Ctx {
    /// The policy with this machine's current network (and public IP) filled in.
    fn policy_now(&self) -> Policy {
        let mut local = self.local.lock().unwrap();
        if local.0.elapsed() > LOCAL_REFRESH { *local = (Instant::now(), LocalGuard::detect().with_public(self.public_ip)); }
        Policy { local: local.1.clone(), ..self.policy.clone() }
    }

    async fn send(&self, frame: Frame) {
        let _ = self.out.send(encode(&frame)).await;
    }

    fn finish(&self, id: u32) {
        let count = {
            let mut table = self.table.lock().unwrap();
            table.admission.close(id);
            table.streams.remove(&id);
            table.streams.len()
        };
        self.shared.set_streams(count);
    }
}

enum Ending {
    Done(&'static str),
    Rst(u8, &'static str),
}

fn socks_code(error: &std::io::Error) -> u8 {
    use std::io::ErrorKind::*;
    match error.kind() {
        ConnectionRefused => SOCKS_REFUSED,
        TimedOut => SOCKS_TTL,
        NetworkUnreachable => SOCKS_NET_UNREACH,
        HostUnreachable => SOCKS_HOST_UNREACH,
        _ => SOCKS_GENERAL,
    }
}

/// Resolve on this machine (the user's own DNS), check the guard on every answer, then connect to exactly those
/// addresses, trying IPv6 first with a 250 ms stagger (happy eyeballs).
async fn connect_guarded(host: &str, port: u16, policy: &Policy) -> Result<TcpStream, u8> {
    guard_target(host, port, policy).map_err(deny_code)?;
    let name = normalize_host(host);
    let addrs: Vec<IpAddr> = if let Ok(literal) = name.parse::<IpAddr>() {
        vec![literal]
    } else {
        match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((name.as_str(), port))).await {
            Ok(Ok(found)) => found.map(|a| a.ip()).collect(),
            Ok(Err(_)) => return Err(SOCKS_HOST_UNREACH),
            Err(_) => return Err(SOCKS_TTL),
        }
    };
    if addrs.is_empty() {
        return Err(SOCKS_HOST_UNREACH);
    }
    guard(host, port, &addrs, policy).map_err(deny_code)?;
    let (mut v6, mut v4): (Vec<IpAddr>, Vec<IpAddr>) = addrs.into_iter().partition(|a| a.is_ipv6());
    v6.dedup();
    v4.dedup();
    let mut ordered = Vec::new();
    while !v6.is_empty() || !v4.is_empty() {
        if !v6.is_empty() { ordered.push(v6.remove(0)); }
        if !v4.is_empty() { ordered.push(v4.remove(0)); }
    }
    let mut attempts: JoinSet<std::io::Result<TcpStream>> = JoinSet::new();
    for (index, ip) in ordered.into_iter().enumerate() {
        attempts.spawn(async move {
            tokio::time::sleep(HAPPY_EYEBALLS_STAGGER * index as u32).await;
            TcpStream::connect(SocketAddr::new(ip, port)).await
        });
    }
    let mut last = SOCKS_HOST_UNREACH;
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match tokio::time::timeout_at(deadline, attempts.join_next()).await {
            Err(_) => return Err(SOCKS_TTL),
            Ok(None) => return Err(last),
            Ok(Some(Ok(Ok(socket)))) => {
                let _ = socket.set_nodelay(true);
                return Ok(socket); // dropping the JoinSet aborts the slower attempts
            }
            Ok(Some(Ok(Err(error)))) => last = socks_code(&error),
            Ok(Some(Err(_))) => {}
        }
    }
}

fn deny_code(deny: Deny) -> u8 {
    let _ = deny;
    SOCKS_NOT_ALLOWED
}

async fn run_stream(
    ctx: Arc<Ctx>,
    id: u32,
    host: String,
    port: u16,
    mut rx: mpsc::UnboundedReceiver<Inbound>,
    credit: Arc<Semaphore>,
    window: Arc<Mutex<RecvWindow>>,
) {
    let start = now_ms();
    let bytes = Arc::new(AtomicU64::new(0));
    let ending = stream_body(&ctx, id, &host, port, &mut rx, credit, window, &bytes).await;
    let result = match ending {
        Ending::Done(label) => label.to_string(),
        Ending::Rst(reason, label) => {
            ctx.send(Frame::Rst { id, reason }).await;
            label.to_string()
        }
    };
    ctx.finish(id);
    ctx.shared.log(Recent { host, port, bytes: bytes.load(Ordering::Relaxed), start, end: now_ms(), result });
}

async fn stream_body(
    ctx: &Arc<Ctx>,
    id: u32,
    host: &str,
    port: u16,
    rx: &mut mpsc::UnboundedReceiver<Inbound>,
    credit: Arc<Semaphore>,
    window: Arc<Mutex<RecvWindow>>,
    bytes: &Arc<AtomicU64>,
) -> Ending {
    if ctx.shared.limit_hit() {
        return Ending::Rst(RST_DAILY, "paused: daily limit");
    }
    let policy = ctx.policy_now();
    let socket = tokio::select! {
        result = connect_guarded(host, port, &policy) => match result {
            Ok(socket) => socket,
            Err(code) => {
                ctx.send(Frame::Opened { id, result: code }).await;
                return Ending::Done(if code == SOCKS_NOT_ALLOWED { "denied" } else { "failed" });
            }
        },
        // The daemon may reset a stream that is still connecting.
        Some(Inbound::Rst) = rx.recv() => return Ending::Done("aborted"),
    };
    ctx.send(Frame::Opened { id, result: 0 }).await;
    let (mut read_half, mut write_half) = socket.into_split();
    let last_activity = Arc::new(AtomicU64::new(ctx.shared.started.elapsed().as_secs()));

    let writer = {
        let ctx = ctx.clone();
        let bytes = bytes.clone();
        let last = last_activity.clone();
        async move {
            while let Some(message) = rx.recv().await {
                match message {
                    Inbound::Data(data) => {
                        let delay = ctx.shared.bandwidth_delay(data.len());
                        if !delay.is_zero() {
                            tokio::time::sleep(delay).await;
                        }
                        if write_half.write_all(&data).await.is_err() {
                            return Ending::Rst(RST_UPSTREAM, "upstream error");
                        }
                        bytes.fetch_add(data.len() as u64, Ordering::Relaxed);
                        last.store(ctx.shared.started.elapsed().as_secs(), Ordering::Relaxed);
                        if ctx.shared.count(data.len() as u64) {
                            return Ending::Rst(RST_DAILY, "daily limit reached");
                        }
                        let back = window.lock().unwrap().on_written(data.len());
                        ctx.send(Frame::Credit { id, bytes: back }).await;
                    }
                    Inbound::Fin => {
                        let _ = write_half.shutdown().await;
                        return Ending::Done("ok");
                    }
                    Inbound::Rst => return Ending::Done("aborted"),
                }
            }
            Ending::Done("ok")
        }
    };

    let reader = {
        let ctx = ctx.clone();
        let bytes = bytes.clone();
        let last = last_activity.clone();
        async move {
            let mut buf = vec![0u8; FRAME_MAX];
            loop {
                // Wait for credit, then read no more than the credit allows.
                let Ok(first) = credit.acquire().await else { return Ending::Done("ok") };
                let cap = (1 + credit.available_permits()).min(FRAME_MAX);
                let n = match read_half.read(&mut buf[..cap]).await {
                    Ok(0) => {
                        drop(first);
                        ctx.send(Frame::Fin { id }).await;
                        return Ending::Done("ok");
                    }
                    Ok(n) => n,
                    Err(_) => return Ending::Rst(RST_UPSTREAM, "upstream error"),
                };
                first.forget();
                if n > 1 {
                    if let Ok(more) = credit.try_acquire_many(n as u32 - 1) {
                        more.forget();
                    }
                }
                let delay = ctx.shared.bandwidth_delay(n);
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                bytes.fetch_add(n as u64, Ordering::Relaxed);
                last.store(ctx.shared.started.elapsed().as_secs(), Ordering::Relaxed);
                if ctx.shared.count(n as u64) {
                    return Ending::Rst(RST_DAILY, "daily limit reached");
                }
                ctx.send(Frame::Data { id, bytes: buf[..n].to_vec() }).await;
            }
        }
    };

    let idle = {
        let ctx = ctx.clone();
        let last = last_activity.clone();
        async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                if ctx.shared.started.elapsed().as_secs().saturating_sub(last.load(Ordering::Relaxed)) > STREAM_IDLE_SECS {
                    return Ending::Rst(RST_IDLE, "idle timeout");
                }
            }
        }
    };

    tokio::pin!(writer, reader, idle);
    let (mut writer_done, mut reader_done) = (false, false);
    let mut label = "ok";
    loop {
        tokio::select! {
            ending = &mut writer, if !writer_done => match ending {
                Ending::Done("aborted") => return Ending::Done("aborted"),
                Ending::Done(l) => { writer_done = true; label = l; }
                other => return other,
            },
            ending = &mut reader, if !reader_done => match ending {
                Ending::Done(_) => reader_done = true,
                other => return other,
            },
            ending = &mut idle => return ending,
        }
        if writer_done && reader_done {
            return Ending::Done(label);
        }
    }
}

#[derive(Deserialize)]
struct Hello {
    v: u32,
    #[serde(default)]
    standby: bool,
    /// The address this computer connected from, as the runtime saw it: its public IP. Never a target.
    #[serde(default)]
    peer: Option<String>,
}

enum SessionEnd {
    /// Retry after backoff; the bool says the session got as far as HELLO (resets the backoff).
    Retry(bool, Option<String>),
    /// Do not reconnect (killed, or the runtime says this app is incompatible).
    Stop(Option<String>),
}

async fn session(shared: &Arc<Shared>, url: &str, token: &str, policy: &Policy) -> SessionEnd {
    let mut request = match url.into_client_request() {
        Ok(request) => request,
        Err(error) => return SessionEnd::Stop(Some(format!("Invalid address ({error})"))),
    };
    match HeaderValue::from_str(&format!("Bearer {token}")) {
        Ok(mut value) => {
            value.set_sensitive(true);
            request.headers_mut().insert("Authorization", value);
        }
        Err(_) => return SessionEnd::Stop(Some("Invalid session token".into())),
    }
    let (ws, _) = match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(request)).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => return SessionEnd::Retry(false, Some(format!("Cannot reach the server ({})", short_error(&error.to_string())))),
        Err(_) => return SessionEnd::Retry(false, Some("Cannot reach the server (timeout)".into())),
    };
    let (mut ws_tx, mut ws_rx) = ws.split();

    // HELLO: the runtime speaks first; we answer and only then relay anything.
    let hello = match tokio::time::timeout(CONNECT_TIMEOUT, async {
        while let Some(message) = ws_rx.next().await {
            match message {
                Ok(Message::Binary(data)) => return decode(&data).ok(),
                Ok(Message::Close(_)) | Err(_) => return None,
                _ => {}
            }
        }
        None
    })
    .await
    {
        Ok(Some(Frame::Hello(json))) => serde_json::from_str::<Hello>(&json).ok(),
        _ => None,
    };
    let Some(hello) = hello else { return SessionEnd::Retry(false, Some("The server did not answer".into())) };
    if hello.v != 1 {
        return SessionEnd::Stop(Some("The server uses a newer egress protocol. Update Floq.".into()));
    }
    let machine = sysinfo::System::host_name().unwrap_or_else(|_| "this computer".into());
    let reply = serde_json::json!({
        "v": 1, "role": "desktop", "machine": machine, "app": env!("CARGO_PKG_VERSION"), "caps": ["egress"],
        "limits": {"streams": MAX_STREAMS, "frame": FRAME_MAX, "window": WINDOW,
                   "portsAllowed": if policy.allow_other_ports { serde_json::json!("all") } else { serde_json::json!(ALLOWED_PORTS) }}
    });
    if ws_tx.send(Message::Binary(encode(&Frame::Hello(reply.to_string())).into())).await.is_err() {
        return SessionEnd::Retry(false, None);
    }
    {
        let mut inner = shared.inner.lock().unwrap();
        inner.machine = Some(machine);
    }
    let public_ip = hello.peer.as_deref().and_then(|p| p.trim().parse::<IpAddr>().ok());
    let mut standby = hello.standby;
    shared.set_state(if standby { "standby" } else { "up" }, None);

    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(1024);
    let ctx = Arc::new(Ctx {
        shared: shared.clone(),
        policy: policy.clone(),
        public_ip,
        local: Mutex::new((Instant::now(), LocalGuard::detect().with_public(public_ip))),
        out: out_tx,
        table: Mutex::new(Table { admission: Admission::new(MAX_STREAMS), streams: HashMap::new() }),
    });
    let mut tasks: JoinSet<()> = JoinSet::new();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut ticks: u64 = 0;
    let mut pending_ping: Option<(u64, Instant)> = None;
    let mut last_pong = Instant::now();
    let ended = loop {
        tokio::select! {
            // Biased: a kill that arrived while the session was still connecting wins over any frame already waiting (no OPEN is admitted first).
            biased;
            _ = shared.kill.notified() => {
                let _ = ws_tx.send(Message::Close(None)).await;
                break SessionEnd::Stop(None);
            }
            _ = tick.tick() => {
                ticks += 1;
                while tasks.try_join_next().is_some() {}
                if ticks % 5 == 0 { shared.flush_usage(); }
                if shared.limit_hit() { shared.set_state("paused", Some("Paused: daily data limit reached".into())); }
                else if shared.inner.lock().unwrap().state == "paused" { shared.set_state(if standby { "standby" } else { "up" }, None); }
                else { shared.publish(); }
            }
            _ = ping.tick() => {
                if last_pong.elapsed() > DEAD_AFTER { break SessionEnd::Retry(true, Some("Connection to the server timed out".into())); }
                let nonce = now_ms();
                pending_ping = Some((nonce, Instant::now()));
                if ws_tx.send(Message::Binary(encode(&Frame::Ping(nonce)).into())).await.is_err() { break SessionEnd::Retry(true, None); }
            }
            Some(frame) = out_rx.recv() => {
                if ws_tx.send(Message::Binary(frame.into())).await.is_err() { break SessionEnd::Retry(true, None); }
            }
            message = ws_rx.next() => {
                let Some(message) = message else { break SessionEnd::Retry(true, None) };
                let data = match message {
                    Ok(Message::Binary(data)) => data,
                    Ok(Message::Close(frame)) => {
                        let incompatible = frame.as_ref().map(|f| u16::from(f.code) == CLOSE_INCOMPATIBLE).unwrap_or(false);
                        break if incompatible { SessionEnd::Stop(Some("The server rejected this app version. Update Floq.".into())) } else { SessionEnd::Retry(true, None) };
                    }
                    Ok(Message::Text(_)) => break SessionEnd::Retry(true, Some("Protocol error".into())),
                    Ok(_) => continue,
                    Err(_) => break SessionEnd::Retry(true, None),
                };
                last_pong = Instant::now();
                match decode(&data) {
                    Err(_) => break SessionEnd::Retry(true, Some("Protocol error".into())),
                    Ok(Frame::Hello(json)) => {
                        if let Ok(hello) = serde_json::from_str::<Hello>(&json) {
                            standby = hello.standby;
                            shared.set_state(if standby { "standby" } else { "up" }, None);
                        }
                    }
                    Ok(Frame::Ping(nonce)) => { let _ = ws_tx.send(Message::Binary(encode(&Frame::Pong(nonce)).into())).await; }
                    Ok(Frame::Pong(nonce)) => {
                        if let Some((sent, at)) = pending_ping { if sent == nonce { shared.inner.lock().unwrap().rtt_ms = Some(at.elapsed().as_millis() as u64); pending_ping = None; } }
                    }
                    // The desktop never opens streams; a peer that does is broken or hostile.
                    Ok(Frame::Opened { .. }) => break SessionEnd::Retry(true, Some("Protocol error".into())),
                    Ok(Frame::Open { id, addr, port }) => {
                        if standby { ctx.send(Frame::Rst { id, reason: RST_PROTOCOL }).await; continue; }
                        let admitted = ctx.table.lock().unwrap().admission.open(id, shared.secs());
                        match admitted {
                            Err(RST_PROTOCOL) => {
                                let _ = ws_tx.send(Message::Close(None)).await;
                                break SessionEnd::Retry(true, Some("Protocol error".into()));
                            }
                            Err(reason) => {
                                shared.log(Recent { host: addr.host(), port, bytes: 0, start: now_ms(), end: now_ms(), result: "refused: limit".into() });
                                ctx.send(Frame::Rst { id, reason }).await;
                            }
                            Ok(()) => {
                                let (tx, rx) = mpsc::unbounded_channel();
                                let credit = Arc::new(Semaphore::new(WINDOW as usize));
                                let window = Arc::new(Mutex::new(RecvWindow::new(WINDOW)));
                                let count = {
                                    let mut table = ctx.table.lock().unwrap();
                                    table.streams.insert(id, Handle { tx, credit: credit.clone(), window: window.clone() });
                                    table.streams.len()
                                };
                                shared.set_streams(count);
                                tasks.spawn(run_stream(ctx.clone(), id, addr.host(), port, rx, credit, window));
                            }
                        }
                    }
                    Ok(Frame::Data { id, bytes }) => {
                        // Decide under the lock, answer after releasing it (no guard across an await).
                        let overran = {
                            let table = ctx.table.lock().unwrap();
                            match table.streams.get(&id) {
                                Some(handle) if handle.window.lock().unwrap().on_data(bytes.len()).is_err() => { let _ = handle.tx.send(Inbound::Rst); true }
                                Some(handle) => { let _ = handle.tx.send(Inbound::Data(bytes)); false }
                                None => false,
                            }
                        };
                        if overran { ctx.send(Frame::Rst { id, reason: RST_PROTOCOL }).await; }
                    }
                    Ok(Frame::Credit { id, bytes }) => {
                        if let Some(handle) = ctx.table.lock().unwrap().streams.get(&id) {
                            // Never above one window: the runtime clamps its grants to what it accounts for, and so do we.
                            let room = (WINDOW as usize).saturating_sub(handle.credit.available_permits());
                            handle.credit.add_permits((bytes as usize).min(room));
                        }
                    }
                    Ok(Frame::Fin { id }) => { if let Some(handle) = ctx.table.lock().unwrap().streams.get(&id) { let _ = handle.tx.send(Inbound::Fin); } }
                    Ok(Frame::Rst { id, .. }) => { if let Some(handle) = ctx.table.lock().unwrap().streams.get(&id) { let _ = handle.tx.send(Inbound::Rst); } }
                    Ok(Frame::Unknown { .. }) => {}
                }
            }
        }
    };
    // Dropping the JoinSet aborts every open stream and closes its socket.
    tasks.shutdown().await;
    {
        let mut table = ctx.table.lock().unwrap();
        table.streams.clear();
        table.admission.clear();
    }
    shared.set_streams(0);
    shared.flush_usage();
    ended
}

fn short_error(error: &str) -> String {
    let error = error.lines().next().unwrap_or("");
    error.chars().take(120).collect()
}

async fn supervise(shared: Arc<Shared>, url: String, token: String, policy: Policy) {
    let mut attempt = 0usize;
    loop {
        shared.set_state("connecting", None);
        match session(&shared, &url, &token, &policy).await {
            SessionEnd::Stop(error) => {
                shared.stopped.store(true, Ordering::Relaxed);
                shared.set_state(if error.is_some() { "error" } else { "off" }, error);
                return;
            }
            SessionEnd::Retry(reached, error) => {
                if reached { attempt = 0; }
                let delay = BACKOFF_SECS[attempt.min(BACKOFF_SECS.len() - 1)];
                attempt += 1;
                shared.set_state("connecting", error);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                    _ = shared.kill.notified() => { shared.set_state("off", None); return; }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tauri surface: commands, tray, events
// ---------------------------------------------------------------------------------------------------------------------

pub struct Egress {
    shared: Mutex<Option<Arc<Shared>>>,
    task: Mutex<Option<JoinHandle<()>>>,
    stop_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

impl Default for Egress {
    fn default() -> Self {
        Egress { shared: Mutex::new(None), task: Mutex::new(None), stop_item: Mutex::new(None) }
    }
}

impl Egress {
    pub fn set_stop_item(&self, item: tauri::menu::MenuItem<tauri::Wry>) {
        *self.stop_item.lock().unwrap() = Some(item);
    }
}

fn describe(status: &Status) -> String {
    match status.state.as_str() {
        "up" if status.streams > 0 => format!(
            "Agent browser is using your connection · {} connection{} · {:.1} MB/min",
            status.streams,
            if status.streams == 1 { "" } else { "s" },
            status.bytes_per_min as f64 / 1_000_000.0
        ),
        "up" => "Agent browser can use your connection (idle)".into(),
        "paused" => "Floq: browser connection paused (daily limit reached)".into(),
        "standby" => "Floq: another computer is being used for the agent browser".into(),
        "connecting" => "Floq: connecting the agent browser to this computer".into(),
        _ => "Floq".into(),
    }
}

fn update_tray(app: &tauri::AppHandle, status: &Status) {
    if let Some(tray) = app.tray_by_id("floq-tray") {
        let _ = tray.set_tooltip(Some(describe(status)));
        // macOS shows this beside the icon; a dot while streams are open. Other platforms ignore it.
        let _ = tray.set_title(if status.state == "up" && status.streams > 0 { Some("●") } else { None::<&str> });
    }
    if let Some(item) = app.state::<Egress>().stop_item.lock().unwrap().as_ref() {
        let _ = item.set_enabled(status.running);
    }
}

/// The address rules of `egress_start`, separate so they are testable.
fn validate_url(url: &str) -> Result<(), String> {
    if !url.starts_with("wss://") && !url.starts_with("ws://") {
        return Err("Invalid egress URL".into());
    }
    // The bearer token must not travel in clear: plain ws:// is for a runtime on this very computer only.
    if let Some(rest) = url.strip_prefix("ws://") {
        let authority = rest.split('/').next().unwrap_or("");
        let host = authority.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map(|(h, _)| h).unwrap_or(authority);
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if !(host == "localhost" || host == "127.0.0.1" || host == "::1") {
            return Err("Use a secure (wss://) address for this server".into());
        }
    }
    // The token travels in a header only: never in a URL that could land in an access log.
    if url.contains('?') || url.contains('#') || url.contains('@') {
        return Err("The egress URL must not carry credentials".into());
    }
    Ok(())
}

pub fn egress_start(app: tauri::AppHandle, state: tauri::State<'_, Egress>, url: String, token: String, policy: Policy) -> Result<(), String> {
    validate_url(&url)?;
    if token.is_empty() || token.len() > 4096 {
        return Err("Missing session token".into());
    }
    stop_inner(&state);
    let usage_path = app.path().app_local_data_dir().ok().map(|dir| {
        let _ = std::fs::create_dir_all(&dir);
        dir.join("egress-usage.json")
    });
    let handle = app.clone();
    let shared = Shared::new(usage_path, Arc::new(move |status: &Status| {
        let _ = handle.emit("egress://status", status);
        update_tray(&handle, status);
    }));
    shared.inner.lock().unwrap().cap = policy.daily_cap();
    *state.shared.lock().unwrap() = Some(shared.clone());
    let task = spawn(supervise(shared, url, token, policy));
    *state.task.lock().unwrap() = Some(task);
    Ok(())
}

fn stop_inner(state: &Egress) {
    let shared = state.shared.lock().unwrap().take();
    let task = state.task.lock().unwrap().take();
    if let Some(shared) = shared {
        // The supervisor closes the WebSocket with a Close frame, which resets every stream on both ends.
        shared.kill.notify_one();
        shared.flush_usage();
        shared.set_state("off", None);
        if let Some(task) = task {
            spawn(async move {
                tokio::time::sleep(Duration::from_millis(800)).await;
                task.abort();
            });
        }
    }
}

/// Kill switch: also used by the tray menu item and when the user turns the setting off.
pub fn egress_stop(state: tauri::State<'_, Egress>) {
    stop_inner(&state);
}

pub fn egress_status(state: tauri::State<'_, Egress>) -> StatusFull {
    match state.shared.lock().unwrap().as_ref() {
        Some(shared) => shared.full(),
        None => StatusFull {
            status: Status { running: false, state: "off".into(), error: None, streams: 0, bytes_per_min: 0, rtt_ms: None, used_today: 0, daily_cap: DEFAULT_DAILY_CAP, machine: None },
            recent: Vec::new(),
        },
    }
}

/// Tray "Stop using my connection": stops the relay and tells the UI so it flips the setting off.
pub fn kill_from_tray(app: &tauri::AppHandle) {
    stop_inner(&app.state::<Egress>());
    let _ = app.emit("egress://killed", ());
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn pol() -> Policy {
        Policy::default()
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn blocks_every_private_v4_range() {
        for blocked in [
            "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.255",
            "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.5", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
            "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(ip_blocked(ip(blocked)), "{blocked} should be blocked");
        }
    }

    #[test]
    fn allows_public_v4_next_to_blocked_ranges() {
        for allowed in ["1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.1", "100.63.255.255", "100.128.0.1", "126.255.255.255", "128.0.0.1", "169.253.255.255", "169.255.0.1",
            "172.15.255.255", "172.32.0.1", "192.0.1.1", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "93.184.216.34"] {
            assert!(!ip_blocked(ip(allowed)), "{allowed} should be allowed");
        }
    }

    #[test]
    fn blocks_v6_ranges() {
        for blocked in ["::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001::1", "2001:2::5", "2001:10::1", "100::1", "fec0::1", "::10.0.0.1"] {
            assert!(ip_blocked(ip(blocked)), "{blocked} should be blocked");
        }
        for allowed in ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "2620:fe::fe"] {
            assert!(!ip_blocked(ip(allowed)), "{allowed} should be allowed");
        }
    }

    #[test]
    fn blocks_embedded_private_v4_in_mapped_nat64_and_6to4() {
        // IPv4-mapped
        assert!(ip_blocked(ip("::ffff:127.0.0.1")));
        assert!(ip_blocked(ip("::ffff:10.1.2.3")));
        assert!(ip_blocked(ip("::ffff:169.254.169.254")));
        assert!(!ip_blocked(ip("::ffff:8.8.8.8")));
        // SIIT
        assert!(ip_blocked(ip("::ffff:0:192.168.0.1")));
        // NAT64 well-known prefix: 7f00:0001 = 127.0.0.1, a9fe:a9fe = 169.254.169.254
        assert!(ip_blocked(ip("64:ff9b::7f00:1")));
        assert!(ip_blocked(ip("64:ff9b::a9fe:a9fe")));
        assert!(ip_blocked(ip("64:ff9b::a00:1")));
        assert!(!ip_blocked(ip("64:ff9b::808:808")));
        assert!(ip_blocked(ip("64:ff9b:1::1")));
        // 6to4: 2002:7f00:0001:: = 127.0.0.1, 2002:c0a8:0101:: = 192.168.1.1
        assert!(ip_blocked(ip("2002:7f00:1::1")));
        assert!(ip_blocked(ip("2002:c0a8:101::")));
        assert!(ip_blocked(ip("2002:a9fe:a9fe::1")));
        assert!(!ip_blocked(ip("2002:808:808::1")));
    }

    #[test]
    fn ports_default_and_opt_in() {
        for port in [80, 443, 8080, 8443] {
            assert_eq!(guard("example.com", port, &[ip("93.184.216.34")], &pol()), Ok(()));
        }
        for port in [0, 21, 22, 25, 53, 3306, 5432, 6379, 8000, 9222, 65535] {
            assert_eq!(guard("example.com", port, &[ip("93.184.216.34")], &pol()), Err(Deny::Port), "port {port}");
        }
        let open = Policy { allow_other_ports: true, ..Policy::default() };
        assert_eq!(guard("example.com", 22, &[ip("93.184.216.34")], &open), Ok(()));
        // Port 0 is never valid, and other ports never lift the address guard.
        assert_eq!(guard("example.com", 0, &[ip("93.184.216.34")], &open), Err(Deny::Port));
        assert_eq!(guard("example.com", 22, &[ip("10.0.0.1")], &open), Err(Deny::Address));
    }

    #[test]
    fn dns_answers_are_checked_after_resolution() {
        // A public name that resolves to a private address (rebinding) is refused.
        assert_eq!(guard("evil.example", 443, &[ip("127.0.0.1")], &pol()), Err(Deny::Address));
        // Any bad answer in a mixed set refuses the whole name.
        assert_eq!(guard("evil.example", 443, &[ip("93.184.216.34"), ip("10.0.0.5")], &pol()), Err(Deny::Address));
        assert_eq!(guard("evil.example", 443, &[ip("93.184.216.34"), ip("::ffff:192.168.1.1")], &pol()), Err(Deny::Address));
        assert_eq!(guard("evil.example", 443, &[], &pol()), Err(Deny::Address));
        assert_eq!(guard("ok.example", 443, &[ip("93.184.216.34"), ip("2606:2800:220:1::1")], &pol()), Ok(()));
    }

    #[test]
    fn literal_hosts_are_checked_without_dns() {
        for host in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "::1", "[fe80::1]", "::ffff:127.0.0.1", "[64:ff9b::7f00:1]", "0.0.0.0"] {
            assert_eq!(guard_target(host, 443, &pol()), Err(Deny::Address), "{host}");
        }
        assert_eq!(guard_target("93.184.216.34", 443, &pol()), Ok(()));
        assert_eq!(guard_target("[2606:4700:4700::1111]", 443, &pol()), Ok(()));
    }

    #[test]
    fn local_names_uppercase_idn_and_shape() {
        for host in ["localhost", "LOCALHOST", "Localhost.", "foo.localhost", "a.b.LOCALHOST"] {
            assert_eq!(guard_target(host, 443, &pol()), Err(Deny::Host), "{host}");
        }
        // Case and a trailing root dot do not change the decision for ordinary names.
        assert_eq!(guard("Example.COM", 443, &[ip("93.184.216.34")], &pol()), Ok(()));
        assert_eq!(guard("example.com.", 443, &[ip("93.184.216.34")], &pol()), Ok(()));
        // Punycode and raw IDN names pass the shape check (the OS resolver decides).
        assert_eq!(guard("xn--bcher-kva.example", 443, &[ip("93.184.216.34")], &pol()), Ok(()));
        assert_eq!(guard("bücher.example", 443, &[ip("93.184.216.34")], &pol()), Ok(()));
        // Names that try to smuggle structure.
        for host in ["", "exa mple.com", "example.com/evil", "user@example.com", "a\0b.com", "a\r\nb.com", "fe80::1%eth0", "example.com?x", "back\\slash.com"] {
            assert_eq!(guard_target(host, 443, &pol()), Err(Deny::Host), "{host:?}");
        }
        assert_eq!(guard_target(&"a".repeat(MAX_HOST), 443, &pol()), Ok(()));
        assert_eq!(guard_target(&"a".repeat(MAX_HOST + 1), 443, &pol()), Err(Deny::Host));
    }

    #[test]
    fn codec_round_trips_every_frame() {
        let frames = vec![
            Frame::Open { id: 1, addr: Addr::Domain("example.com".into()), port: 443 },
            Frame::Open { id: 3, addr: Addr::V4(Ipv4Addr::new(93, 184, 216, 34)), port: 80 },
            Frame::Open { id: 5, addr: Addr::V6("2606:4700::1111".parse().unwrap()), port: 8443 },
            Frame::Opened { id: 1, result: 0 },
            Frame::Opened { id: 1, result: 2 },
            Frame::Data { id: 7, bytes: vec![1, 2, 3, 255] },
            Frame::Data { id: 7, bytes: Vec::new() },
            Frame::Credit { id: 7, bytes: 262_144 },
            Frame::Fin { id: 9 },
            Frame::Rst { id: 9, reason: RST_GUARD },
            Frame::Ping(0xdead_beef_cafe_f00d),
            Frame::Pong(1),
            Frame::Hello("{\"v\":1}".into()),
        ];
        for frame in frames {
            assert_eq!(decode(&encode(&frame)), Ok(frame.clone()), "{frame:?}");
        }
    }

    #[test]
    fn codec_byte_layout_matches_the_protocol_doc() {
        // type | u32 BE id | payload; OPEN = atyp | len | name | u16 BE port.
        let bytes = encode(&Frame::Open { id: 0x0102_0304, addr: Addr::Domain("a.io".into()), port: 0x01bb });
        assert_eq!(bytes, vec![0x01, 1, 2, 3, 4, 3, 4, b'a', b'.', b'i', b'o', 0x01, 0xbb]);
        assert_eq!(encode(&Frame::Credit { id: 1, bytes: 0x0001_0000 }), vec![0x04, 0, 0, 0, 1, 0, 1, 0, 0]);
        assert_eq!(encode(&Frame::Ping(1)), vec![0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    }

    #[test]
    fn codec_rejects_malformed_frames() {
        assert_eq!(decode(&[]), Err(CodecError::Short));
        assert_eq!(decode(&[0x03, 0, 0]), Err(CodecError::Short));
        assert_eq!(decode(&[0x01, 0, 0, 0, 1]), Err(CodecError::Short));
        // zero-length name, bad atyp, truncated address, trailing bytes, invalid UTF-8
        assert_eq!(decode(&[0x01, 0, 0, 0, 1, 3, 0, 1, 187]), Err(CodecError::BadPayload));
        assert_eq!(decode(&[0x01, 0, 0, 0, 1, 9, 1, 187]), Err(CodecError::BadPayload));
        assert_eq!(decode(&[0x01, 0, 0, 0, 1, 1, 1, 2, 3]), Err(CodecError::Short));
        assert_eq!(decode(&[0x01, 0, 0, 0, 1, 1, 1, 2, 3, 4, 1, 187, 0]), Err(CodecError::BadPayload));
        assert_eq!(decode(&[0x01, 0, 0, 0, 1, 3, 2, 0xff, 0xfe, 1, 187]), Err(CodecError::BadPayload));
        let mut big = vec![0x03, 0, 0, 0, 1];
        big.extend(vec![0u8; FRAME_MAX + 1]);
        assert_eq!(decode(&big), Err(CodecError::TooBig));
        // unknown types are tolerated for forward compatibility
        assert_eq!(decode(&[0x7f, 0, 0, 0, 2, 9]), Ok(Frame::Unknown { kind: 0x7f, id: 2 }));
    }

    #[test]
    fn admission_enforces_ids_stream_cap_and_rate() {
        let mut a = Admission::new(3);
        assert_eq!(a.open(1, 0.0), Ok(()));
        assert_eq!(a.open(3, 0.0), Ok(()));
        // Even ids (desktop-allocated), repeats and going backwards are protocol errors.
        assert_eq!(a.open(2, 0.0), Err(RST_PROTOCOL));
        assert_eq!(a.open(3, 0.0), Err(RST_PROTOCOL));
        assert_eq!(a.open(1, 0.0), Err(RST_PROTOCOL));
        assert_eq!(a.open(5, 0.0), Ok(()));
        // Fourth live stream exceeds the cap of 3; closing one makes room.
        assert_eq!(a.open(7, 0.0), Err(RST_STREAMS));
        a.close(1);
        assert_eq!(a.open(9, 0.0), Ok(()));
        assert_eq!(a.len(), 3);
        assert!(a.contains(9) && !a.contains(1));
    }

    #[test]
    fn admission_default_cap_is_256() {
        let mut a = Admission::new(MAX_STREAMS);
        let mut now = 0.0;
        for n in 0..MAX_STREAMS as u32 {
            // Stay under the rate limit while filling up.
            now += 0.1;
            assert_eq!(a.open(2 * n + 1, now), Ok(()), "stream {n}");
        }
        assert_eq!(a.open(2 * MAX_STREAMS as u32 + 1, now + 1.0), Err(RST_STREAMS));
    }

    #[test]
    fn connection_rate_is_60_per_second_with_burst_120() {
        let mut a = Admission::new(10_000);
        let mut accepted = 0;
        for n in 0..300u32 {
            if a.open(2 * n + 1, 0.0).is_ok() { accepted += 1; }
        }
        assert_eq!(accepted, 120, "burst");
        // After one second 60 more are allowed.
        let mut more = 0;
        for n in 300..400u32 {
            if a.open(2 * n + 1, 1.0).is_ok() { more += 1; }
        }
        assert_eq!(more, 60);
        let mut a = Admission::new(10_000);
        for n in 0..120u32 { a.open(2 * n + 1, 0.0).unwrap(); }
        assert_eq!(a.open(1001, 0.0), Err(RST_RATE));
    }

    #[test]
    fn bucket_throttles_bandwidth_without_dropping() {
        let mut b = Bucket::new(1000.0, 1000.0);
        assert_eq!(b.take_delay(0.0, 1000.0), 0.0);
        // Empty: 500 more bytes cost half a second.
        assert!((b.take_delay(0.0, 500.0) - 0.5).abs() < 1e-9);
        // Time passing pays the debt back.
        assert_eq!(b.take_delay(10.0, 100.0), 0.0);
        assert!(b.try_take(10.0, 900.0));
        assert!(!b.try_take(10.0, 1.0));
    }

    #[test]
    fn credit_window_accounting() {
        let mut w = RecvWindow::new(1000);
        assert!(w.on_data(600).is_ok());
        assert!(w.on_data(400).is_ok());
        // Overrunning what was granted is a violation.
        assert!(w.on_data(1).is_err());
        let mut w = RecvWindow::new(1000);
        w.on_data(1000).unwrap();
        assert_eq!(w.on_written(1000), 1000);
        // After returning the credit the peer may send a full window again.
        assert!(w.on_data(1000).is_ok());
        assert_eq!(w.on_written(300), 300);
        assert!(w.on_data(300).is_ok());
        assert!(w.on_data(1).is_err());
    }

    #[test]
    fn daily_usage_counts_resets_at_a_new_day_and_roundtrips() {
        let mut usage = Usage::default();
        assert!(!usage.add("2026-11-13", 400, 1000));
        assert!(!usage.add("2026-11-13", 500, 1000));
        assert!(usage.add("2026-11-13", 100, 1000));
        assert_eq!(usage.bytes, 1000);
        // Midnight: the counter resets.
        assert!(!usage.add("2026-11-14", 10, 1000));
        assert_eq!(usage, Usage { day: "2026-11-14".into(), bytes: 10 });
        let parsed: Usage = serde_json::from_slice(&serde_json::to_vec(&usage).unwrap()).unwrap();
        assert_eq!(parsed, usage);
    }

    #[test]
    fn rolling_rate_forgets_after_a_minute() {
        let mut r = Rolling::new();
        r.add(100, 1000);
        r.add(130, 500);
        assert_eq!(r.per_minute(130), 1500);
        assert_eq!(r.per_minute(159), 1500);
        assert_eq!(r.per_minute(160), 500);
        assert_eq!(r.per_minute(190), 0);
        r.add(1000, 7);
        assert_eq!(r.per_minute(1000), 7);
    }

    // --- End to end: a fake runtime speaking the protocol over a real WebSocket, a local echo server as the "internet".

    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;

    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    while let Ok(n) = socket.read(&mut buf).await {
                        if n == 0 || socket.write_all(&buf[..n]).await.is_err() { break; }
                    }
                });
            }
        });
        port
    }

    struct FakeRuntime {
        auth: Arc<Mutex<Option<String>>>,
        ws_rx: tokio::sync::mpsc::UnboundedReceiver<Frame>,
        ws_tx: tokio::sync::mpsc::UnboundedSender<Frame>,
        url: String,
    }

    async fn fake_runtime(standby: bool) -> FakeRuntime {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://127.0.0.1:{}/v1/browser/egress", listener.local_addr().unwrap().port());
        let auth = Arc::new(Mutex::new(None));
        let (to_test, ws_rx) = tokio::sync::mpsc::unbounded_channel();
        let (ws_tx, mut from_test) = tokio::sync::mpsc::unbounded_channel::<Frame>();
        let auth_seen = auth.clone();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let ws = accept_hdr_async(socket, move |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                *auth_seen.lock().unwrap() = request.headers().get("authorization").map(|v| v.to_str().unwrap().to_string());
                Ok(response)
            })
            .await
            .unwrap();
            let (mut tx, mut rx) = ws.split();
            tx.send(Message::Binary(encode(&Frame::Hello(format!("{{\"v\":1,\"role\":\"runtime\",\"standby\":{standby}}}"))).into())).await.unwrap();
            loop {
                tokio::select! {
                    message = rx.next() => match message {
                        Some(Ok(Message::Binary(data))) => { let _ = to_test.send(decode(&data).unwrap()); }
                        Some(Ok(_)) => {}
                        _ => break,
                    },
                    Some(frame) = from_test.recv() => { tx.send(Message::Binary(encode(&frame).into())).await.unwrap(); }
                }
            }
        });
        FakeRuntime { auth, ws_rx, ws_tx, url }
    }

    async fn next_frame(rt: &mut FakeRuntime) -> Frame {
        tokio::time::timeout(Duration::from_secs(5), rt.ws_rx.recv()).await.expect("frame in time").expect("socket open")
    }

    fn local_policy() -> Policy {
        Policy { allow_local: true, allow_other_ports: true, ..Policy::default() }
    }

    #[tokio::test]
    async fn relays_a_stream_end_to_end_with_header_auth_and_credits() {
        let echo = echo_server().await;
        let mut rt = fake_runtime(false).await;
        let shared = Shared::new(None, Arc::new(|_| {}));
        let task = tokio::spawn(supervise(shared.clone(), rt.url.clone(), "secret-token".into(), local_policy()));
        // Desktop answers our HELLO and sends the bearer token in the Authorization header, not in the URL.
        match next_frame(&mut rt).await {
            Frame::Hello(json) => {
                let hello: serde_json::Value = serde_json::from_str(&json).unwrap();
                assert_eq!(hello["v"], 1);
                assert_eq!(hello["role"], "desktop");
            }
            other => panic!("expected HELLO, got {other:?}"),
        }
        assert_eq!(rt.auth.lock().unwrap().as_deref(), Some("Bearer secret-token"));
        assert!(!rt.url.contains("secret-token"));

        rt.ws_tx.send(Frame::Open { id: 1, addr: Addr::V4(Ipv4Addr::LOCALHOST), port: echo }).unwrap();
        assert_eq!(next_frame(&mut rt).await, Frame::Opened { id: 1, result: 0 });
        rt.ws_tx.send(Frame::Data { id: 1, bytes: b"hello".to_vec() }).unwrap();
        let mut echoed = Vec::new();
        let mut credited = 0;
        while echoed.len() < 5 || credited < 5 {
            match next_frame(&mut rt).await {
                Frame::Data { id: 1, bytes } => echoed.extend(bytes),
                Frame::Credit { id: 1, bytes } => credited += bytes,
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(echoed, b"hello");
        assert_eq!(shared.status().streams, 1);
        rt.ws_tx.send(Frame::Fin { id: 1 }).unwrap();
        // The echo closes its side after our FIN, the desktop reports FIN back.
        loop {
            match next_frame(&mut rt).await {
                Frame::Fin { id: 1 } => break,
                Frame::Credit { .. } | Frame::Data { .. } => {}
                other => panic!("unexpected {other:?}"),
            }
        }
        // Recent log has the connection with its byte count.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let full = shared.full();
        assert_eq!(full.recent.len(), 1);
        assert_eq!(full.recent[0].port, echo);
        assert_eq!(full.recent[0].bytes, 10, "5 up + 5 echoed back");
        assert!(full.status.used_today >= 10);
        shared.kill.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
        assert_eq!(shared.status().state, "off");
    }

    #[tokio::test]
    async fn guard_blocks_loopback_in_release_policy_and_answers_not_allowed() {
        let mut rt = fake_runtime(false).await;
        let shared = Shared::new(None, Arc::new(|_| {}));
        let task = tokio::spawn(supervise(shared.clone(), rt.url.clone(), "t".into(), Policy::default()));
        assert!(matches!(next_frame(&mut rt).await, Frame::Hello(_)));
        // Loopback, a private address, the metadata address, a non-allowed port.
        rt.ws_tx.send(Frame::Open { id: 1, addr: Addr::V4(Ipv4Addr::LOCALHOST), port: 443 }).unwrap();
        assert_eq!(next_frame(&mut rt).await, Frame::Opened { id: 1, result: SOCKS_NOT_ALLOWED });
        rt.ws_tx.send(Frame::Open { id: 3, addr: Addr::Domain("localhost".into()), port: 443 }).unwrap();
        assert_eq!(next_frame(&mut rt).await, Frame::Opened { id: 3, result: SOCKS_NOT_ALLOWED });
        rt.ws_tx.send(Frame::Open { id: 5, addr: Addr::V4(Ipv4Addr::new(169, 254, 169, 254)), port: 80 }).unwrap();
        assert_eq!(next_frame(&mut rt).await, Frame::Opened { id: 5, result: SOCKS_NOT_ALLOWED });
        rt.ws_tx.send(Frame::Open { id: 7, addr: Addr::Domain("example.com".into()), port: 22 }).unwrap();
        assert_eq!(next_frame(&mut rt).await, Frame::Opened { id: 7, result: SOCKS_NOT_ALLOWED });
        shared.kill.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
    }

    #[tokio::test]
    async fn standby_desktop_opens_nothing_and_a_desktop_sent_open_ids_are_validated() {
        let mut rt = fake_runtime(true).await;
        let shared = Shared::new(None, Arc::new(|_| {}));
        let task = tokio::spawn(supervise(shared.clone(), rt.url.clone(), "t".into(), local_policy()));
        assert!(matches!(next_frame(&mut rt).await, Frame::Hello(_)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(shared.status().state, "standby");
        rt.ws_tx.send(Frame::Open { id: 1, addr: Addr::V4(Ipv4Addr::LOCALHOST), port: 80 }).unwrap();
        assert_eq!(next_frame(&mut rt).await, Frame::Rst { id: 1, reason: RST_PROTOCOL });
        shared.kill.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
    }

    #[tokio::test]
    async fn kill_switch_closes_the_websocket_and_stops_reconnecting() {
        let mut rt = fake_runtime(false).await;
        let shared = Shared::new(None, Arc::new(|_| {}));
        let task = tokio::spawn(supervise(shared.clone(), rt.url.clone(), "t".into(), local_policy()));
        assert!(matches!(next_frame(&mut rt).await, Frame::Hello(_)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(shared.status().state, "up");
        shared.kill.notify_one();
        tokio::time::timeout(Duration::from_secs(3), task).await.expect("supervisor exits").unwrap();
        assert_eq!(shared.status().state, "off");
        assert!(!shared.status().running);
    }

    #[test]
    fn local_guard_refuses_the_users_own_lan_gateway_and_public_ip() {
        let local = LocalGuard::for_test(&[("192.168.1.20", 24), ("2a02:1234:5678:9abc::20", 64), ("203.0.113.77", 32)], &["198.51.100.1", "2001:db8:ffff::1"])
            .with_public(Some(ip("93.184.216.34")));
        let p = Policy { local, ..Policy::default() };
        // global IPv6 neighbour in the same /64 (router admin, NAS): refused
        assert_eq!(guard("x.example", 443, &[ip("2a02:1234:5678:9abc::1")], &p), Err(Deny::Address));
        assert_eq!(guard("x.example", 443, &[ip("2a02:1234:5678:9abc:aaaa:bbbb:cccc:dddd")], &p), Err(Deny::Address));
        // another /64 of the same ISP is fine
        assert_eq!(guard("x.example", 443, &[ip("2a02:1234:5678:9abd::1")], &p), Ok(()));
        // own public IPv4 (NAT hairpin) and the gateway: refused
        assert_eq!(guard("x.example", 443, &[ip("93.184.216.34")], &p), Err(Deny::Address));
        assert_eq!(guard("x.example", 443, &[ip("198.51.100.1")], &p), Err(Deny::Address));
        // an on-link PUBLIC IPv4 prefix (a /32 here) is refused; its neighbour is not
        assert_eq!(guard("x.example", 443, &[ip("203.0.113.77")], &p), Err(Deny::Address));
        assert_eq!(guard("x.example", 443, &[ip("93.184.216.35")], &p), Ok(()));
        // the same host reached through a v4-in-v6 form is still that host
        assert_eq!(guard("x.example", 443, &[ip("::ffff:93.184.216.34")], &p), Err(Deny::Address));
        assert_eq!(guard("x.example", 443, &[ip("64:ff9b::5db8:d822")], &p), Err(Deny::Address));
        // literals are checked by guard_target too, before any DNS
        assert_eq!(guard_target("[2a02:1234:5678:9abc::1]", 443, &p), Err(Deny::Address));
        assert_eq!(guard_target("93.184.216.34", 443, &p), Err(Deny::Address));
        // a name with one LAN answer is refused as a whole
        assert_eq!(guard("x.example", 443, &[ip("8.8.8.8"), ip("2a02:1234:5678:9abc::1")], &p), Err(Deny::Address));
    }

    #[test]
    fn detect_reads_this_machines_interfaces() {
        let local = LocalGuard::detect();
        #[cfg(unix)]
        {
            // every unix host has a loopback interface; its on-link /8 must be in the list
            assert!(local.nets.iter().any(|(net, _)| *net == ip("127.0.0.1")), "{:?}", local.nets);
            // every address of this machine is covered by its own prefix
            for (net, _) in &local.nets { assert!(local.contains(*net), "{net}"); }
        }
        let _ = local;
    }

    #[test]
    fn extra_reserved_v6_ranges_are_blocked() {
        for text in ["3fff::1", "3fff:fff:ffff::1", "2001:20::1", "2001:2f:ffff::1", "5f00::1", "5f00:ffff::1"] {
            assert!(ip_blocked(ip(text)), "{text}");
        }
        assert!(!ip_blocked(ip("3fff:1000::1")), "3fff:1000:: is outside 3fff::/20");
        assert!(!ip_blocked(ip("2001:30::1")));
    }

    #[test]
    fn protocol_constants_match_the_doc_and_the_hub() {
        assert_eq!([RST_GENERIC, RST_GUARD, RST_STREAMS, RST_RATE, RST_BANDWIDTH, RST_DAILY, RST_IDLE, RST_PROTOCOL, RST_KILLED, RST_SHUTDOWN, RST_UPSTREAM, RST_LINK_DOWN], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert_eq!((CLOSE_INCOMPATIBLE, CLOSE_DESKTOP_OPEN), (4400, 4401));
    }

    #[test]
    fn plain_ws_is_only_for_this_computer() {
        for ok in ["wss://floq.example.com/v1/browser/egress", "ws://127.0.0.1:8787/v1/browser/egress", "ws://localhost:8787/x", "ws://[::1]:8787/x", "ws://localhost/x"] {
            assert_eq!(validate_url(ok), Ok(()), "{ok}");
        }
        for bad in ["ws://floq.example.com/v1/browser/egress", "ws://203.0.113.5:80/x", "ws://127.0.0.1.evil.com/x", "ws://localhost.evil.com:80/x", "http://x", "wss://a?token=1", "wss://u@h/x", "wss://h/x#f"] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_kill_that_beat_the_main_loop_admits_no_stream() {
        let mut rt = fake_runtime(false).await;
        let shared = Shared::new(None, Arc::new(|_| {}));
        shared.kill.notify_one(); // before the session even connected
        rt.ws_tx.send(Frame::Open { id: 1, addr: Addr::V4(Ipv4Addr::LOCALHOST), port: 80 }).unwrap();
        let task = tokio::spawn(supervise(shared.clone(), rt.url.clone(), "t".into(), local_policy()));
        tokio::time::timeout(Duration::from_secs(5), task).await.expect("supervisor exits").unwrap();
        assert!(shared.full().recent.is_empty(), "no OPEN was admitted or even looked at");
        while let Ok(frame) = rt.ws_rx.try_recv() { assert!(!matches!(frame, Frame::Opened { .. } | Frame::Rst { .. }), "{frame:?}"); }
    }

    /// The real Rust client against the real TypeScript `EgressHub` (no hand-written peer on either side): the runtime speaks
    /// first, the client answers, LINK comes up, a stream opens to a local echo server and bytes round-trip. Needs `node` and a
    /// built runtime (`npm run build` in runtime/); skipped with a message otherwise.
    #[tokio::test]
    async fn interop_with_the_real_runtime_hub() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime");
        let script = root.join("test/fixtures/egressHubInterop.mjs");
        if !root.join("dist/browserEgress.js").exists() || !root.join("node_modules/ws").exists() || std::process::Command::new("node").arg("--version").output().is_err() {
            eprintln!("interop test skipped: needs node and a built runtime (runtime/dist, runtime/node_modules)");
            return;
        }
        let echo = echo_server().await;
        struct Kill(std::process::Child);
        impl Drop for Kill { fn drop(&mut self) { let _ = self.0.kill(); } }
        let mut child = Kill(std::process::Command::new("node").arg(&script).arg(echo.to_string()).stdout(std::process::Stdio::piped()).spawn().unwrap());
        let stdout = child.0.stdout.take().unwrap();
        let (line_tx, line_rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) { if line_tx.send(line).is_err() { break; } }
        });
        let line = line_rx.recv_timeout(Duration::from_secs(10)).expect("hub fixture starts");
        let port: u16 = line.trim().strip_prefix("PORT ").expect(&line).parse().unwrap();
        let shared = Shared::new(None, Arc::new(|_| {}));
        let task = tokio::spawn(supervise(shared.clone(), format!("ws://127.0.0.1:{port}/v1/browser/egress"), "tok".into(), local_policy()));
        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            match line_rx.try_recv() {
                Ok(line) => {
                    out.push_str(&line); out.push('\n');
                    if line.starts_with("ECHO ") || line.starts_with("RST") || line.starts_with("OPENED_FAIL") || line.starts_with("TIMEOUT") { break; }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => tokio::time::sleep(Duration::from_millis(50)).await,
                Err(_) => break,
            }
        }
        assert!(out.contains("ECHO hello-interop"), "interop output: {out:?}");
        assert_eq!(shared.status().state, "up");
        shared.kill.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
    }
}
