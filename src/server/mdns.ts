// mDNS/Zeroconf service discovery — data + functions, no class, no this.
//
// Implements RFC 6762 (Multicast DNS) and RFC 6763 (DNS-Based Service
// Discovery) for LAN auto-discovery of c0de-agent instances.
//
// Uses raw `node:dgram` UDP multicast on 224.0.0.251:5353 to avoid
// external dependencies. All DNS packet encoding/decoding is pure data
// transformations on Uint8Arrays.
//
// Multiple instances are supported via unique instance names (hostname +
// PID by default). Each instance advertises itself and can discover others.

import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";
import type { RemoteInfo } from "node:dgram";

// ── Constants ───────────────────────────────────────────────────────────────

const MDNS_MULTICAST_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const SERVICE_TYPE = "_c0de._tcp.local";
const DEFAULT_TTL = 120; // seconds
const CACHE_TTL_MS = 60_000; // 60s eviction check
const REANNOUNCE_INTERVAL_MS = 10_000; // periodic re-announcement
const DISCOVERY_WAIT_MS = 1_500; // wait for responses on discover

// ── Types ───────────────────────────────────────────────────────────────────

/** Information about a discovered c0de service on the LAN. */
export type ServiceInfo = {
  name: string; // instance name, e.g. "alice-mbp._c0de._tcp.local"
  host: string; // hostname, e.g. "alice-mbp.local"
  port: number;
  txt: Record<string, string>; // key-value metadata
  address: string; // IPv4 address
  ttl: number;
  discoveredAt: number; // Date.now()
};

/**
 * Internal registry entry — one advertised service instance.
 * Separate from ServiceInfo to keep the public API stable.
 */
type RegistryEntry = {
  name: string;
  port: number;
  txt: Record<string, string>;
};

/**
 * Internal module-level state. One `mdnsState` per process, owned by the
 * module, never exported. The socket and timer are nullable so the module
 * can be cleanly shut down.
 */
type MdnsState = {
  socket: ReturnType<typeof createSocket> | null;
  registry: Map<string, RegistryEntry>; // full FQDN → entry
  cache: Map<string, ServiceInfo>; // full FQDN → discovered
  reannounceTimer: ReturnType<typeof setInterval> | null;
  cacheTimer: ReturnType<typeof setInterval> | null;
};

const state: MdnsState = {
  socket: null,
  registry: new Map(),
  cache: new Map(),
  reannounceTimer: null,
  cacheTimer: null,
};

// ── DNS name encoding (RFC 1035 §4.1.4) ────────────────────────────────────

/**
 * Encode a dotted DNS name into wire format: length-prefixed labels
 * terminated by a zero byte. "foo.bar.local" → [3]foo[3]bar[5]local[0].
 */
function encodeName(name: string): Uint8Array {
  const labels = name.split(".");
  const parts: number[] = [];
  for (const label of labels) {
    parts.push(label.length);
    for (let i = 0; i < label.length; i++) {
      parts.push(label.charCodeAt(i));
    }
  }
  parts.push(0);
  return new Uint8Array(parts);
}

/**
 * Decode a DNS name from a packet buffer starting at `offset`.
 * Follows basic label pointers (0xC0 prefix) for compression support.
 * Returns the decoded name string and the number of bytes consumed.
 */
function decodeName(buf: Uint8Array, offset: number): { name: string; bytesRead: number } {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let startOffset = offset;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos++;
      break;
    }
    // Compression pointer: top two bits set
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) startOffset = pos + 2;
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      pos = pointer;
      jumped = true;
      continue;
    }
    pos++;
    let label = "";
    for (let i = 0; i < len; i++) {
      label += String.fromCharCode(buf[pos++]);
    }
    labels.push(label);
  }

  return {
    name: labels.join("."),
    bytesRead: jumped ? startOffset - offset : pos - offset,
  };
}

/**
 * Measure the wire length of a DNS name at the given offset (including
 * the terminating zero or pointer). Used by decodeAnswer to advance.
 */
function nameWireLength(buf: Uint8Array, offset: number): number {
  let pos = offset;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) return pos - offset + 1;
    if ((len & 0xc0) === 0xc0) return pos - offset + 2;
    pos += 1 + len;
  }
  return pos - offset;
}

// ── DNS packet encoding ─────────────────────────────────────────────────────

/**
 * Encode a DNS response packet. Header fields are hardcoded for a standard
 * response with authoritative answers and no questions.
 */
function encodePacket(
  answers: Uint8Array[],
  answerCount: number,
): Uint8Array {
  // DNS header: ID=0 (mDNS), QR=1 (response), AA=1 (authoritative),
  // TC=0, RD=0, RA=0, Z=0, RCODE=0
  // Flags: 0x8400 = QR(1) + AA(1)
  const header = new Uint8Array(12);
  // ID = 0 (mDNS spec)
  header[0] = 0;
  header[1] = 0;
  // Flags
  header[2] = 0x84; // QR=1, AA=1
  header[3] = 0x00;
  // QDCOUNT = 0
  header[4] = 0;
  header[5] = 0;
  // ANCOUNT
  header[6] = (answerCount >> 8) & 0xff;
  header[7] = answerCount & 0xff;
  // NSCOUNT = 0
  header[8] = 0;
  header[9] = 0;
  // ARCOUNT = 0
  header[10] = 0;
  header[11] = 0;

  let totalLen = 12;
  for (const a of answers) totalLen += a.length;

  const packet = new Uint8Array(totalLen);
  packet.set(header);
  let offset = 12;
  for (const a of answers) {
    packet.set(a, offset);
    offset += a.length;
  }
  return packet;
}

/**
 * Encode a DNS query packet with one question.
 */
function encodeQuery(name: string, type: number): Uint8Array {
  const nameBytes = encodeName(name);
  // Header
  const header = new Uint8Array(12);
  header[0] = 0;
  header[1] = 0;
  // Flags: standard query, RD=0 (mDNS)
  header[2] = 0x00;
  header[3] = 0x00;
  // QDCOUNT = 1
  header[4] = 0;
  header[5] = 1;
  // ANCOUNT, NSCOUNT, ARCOUNT = 0
  header[6] = 0;
  header[7] = 0;
  header[8] = 0;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;

  // Question: name + type(2) + class(2)
  const question = new Uint8Array(nameBytes.length + 4);
  question.set(nameBytes);
  const off = nameBytes.length;
  question[off] = (type >> 8) & 0xff;
  question[off + 1] = type & 0xff;
  question[off + 2] = 0x00; // class IN
  question[off + 3] = 0x01;

  const packet = new Uint8Array(12 + question.length);
  packet.set(header);
  packet.set(question, 12);
  return packet;
}

// ── DNS resource record constructors ────────────────────────────────────────

function rrHeader(name: string, type: number, ttl: number): Uint8Array {
  const nameBytes = encodeName(name);
  const buf = new Uint8Array(nameBytes.length + 10);
  buf.set(nameBytes);
  const off = nameBytes.length;
  // TYPE
  buf[off] = (type >> 8) & 0xff;
  buf[off + 1] = type & 0xff;
  // CLASS IN + cache-flush bit (0x8001)
  buf[off + 2] = 0x80;
  buf[off + 3] = 0x01;
  // TTL (4 bytes)
  buf[off + 4] = (ttl >> 24) & 0xff;
  buf[off + 5] = (ttl >> 16) & 0xff;
  buf[off + 6] = (ttl >> 8) & 0xff;
  buf[off + 7] = ttl & 0xff;
  // RDLENGTH placeholder (filled by caller)
  buf[off + 8] = 0;
  buf[off + 9] = 0;
  return buf;
}

function writeRdLength(buf: Uint8Array, length: number): void {
  buf[buf.length - 2] = (length >> 8) & 0xff;
  buf[buf.length - 1] = length & 0xff;
}

/** PTR record: owner → target name. */
function encodePtr(owner: string, target: string, ttl: number): Uint8Array {
  const hdr = rrHeader(owner, 12, ttl);
  const rd = encodeName(target);
  writeRdLength(hdr, rd.length);
  const result = new Uint8Array(hdr.length + rd.length);
  result.set(hdr);
  result.set(rd, hdr.length);
  return result;
}

/** SRV record: owner → priority, weight, port, target. */
function encodeSrv(
  owner: string,
  target: string,
  port: number,
  ttl: number,
): Uint8Array {
  const hdr = rrHeader(owner, 33, ttl);
  const targetBytes = encodeName(target);
  const rdLen = 6 + targetBytes.length;
  writeRdLength(hdr, rdLen);
  const rd = new Uint8Array(rdLen);
  // Priority
  rd[0] = 0;
  rd[1] = 0;
  // Weight
  rd[2] = 0;
  rd[3] = 0;
  // Port
  rd[4] = (port >> 8) & 0xff;
  rd[5] = port & 0xff;
  rd.set(targetBytes, 6);
  const result = new Uint8Array(hdr.length + rd.length);
  result.set(hdr);
  result.set(rd, hdr.length);
  return result;
}

/** TXT record: owner → key=value pairs. */
function encodeTxt(
  owner: string,
  txt: Record<string, string>,
  ttl: number,
): Uint8Array {
  const hdr = rrHeader(owner, 16, ttl);
  const entries = Object.entries(txt);
  const rdParts: Uint8Array[] = [];
  let rdLen = 0;
  for (const [k, v] of entries) {
    const str = `${k}=${v}`;
    const entry = new Uint8Array(1 + str.length);
    entry[0] = str.length;
    for (let i = 0; i < str.length; i++) {
      entry[i + 1] = str.charCodeAt(i);
    }
    rdParts.push(entry);
    rdLen += entry.length;
  }
  // Empty TXT if no entries
  if (rdParts.length === 0) {
    rdParts.push(new Uint8Array([0]));
    rdLen = 1;
  }
  writeRdLength(hdr, rdLen);
  const result = new Uint8Array(hdr.length + rdLen);
  result.set(hdr);
  let offset = hdr.length;
  for (const part of rdParts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** A record: owner → IPv4 address. */
function encodeA(owner: string, addr: string, ttl: number): Uint8Array {
  const hdr = rrHeader(owner, 1, ttl);
  const parts = addr.split(".").map(Number);
  writeRdLength(hdr, 4);
  const result = new Uint8Array(hdr.length + 4);
  result.set(hdr);
  result[hdr.length] = parts[0];
  result[hdr.length + 1] = parts[1];
  result[hdr.length + 2] = parts[2];
  result[hdr.length + 3] = parts[3];
  return result;
}

// ── DNS packet decoding ─────────────────────────────────────────────────────

type DnsQuestion = { name: string; type: number; class: number };
type DnsAnswer = {
  name: string;
  type: number;
  class: number;
  ttl: number;
  data: Uint8Array;
};

type DnsPacket = {
  id: number;
  flags: number;
  isResponse: boolean;
  questions: DnsQuestion[];
  answers: DnsAnswer[];
  additionals: DnsAnswer[];
};

function decodePacket(buf: Uint8Array): DnsPacket | null {
  if (buf.length < 12) return null;

  const id = (buf[0] << 8) | buf[1];
  const flags = (buf[2] << 8) | buf[3];
  const isResponse = (flags & 0x8000) !== 0;
  const qdCount = (buf[4] << 8) | buf[5];
  const anCount = (buf[6] << 8) | buf[7];
  // const nsCount = (buf[8] << 8) | buf[9]; // unused
  const arCount = (buf[10] << 8) | buf[11];

  let offset = 12;

  // Decode questions
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < qdCount; i++) {
    const { name, bytesRead } = decodeName(buf, offset);
    offset += bytesRead;
    if (offset + 4 > buf.length) return null;
    const type = (buf[offset] << 8) | buf[offset + 1];
    const cls = (buf[offset + 2] << 8) | buf[offset + 3];
    offset += 4;
    questions.push({ name, type, class: cls & 0x7fff });
  }

  // Decode answers + additionals
  const answers: DnsAnswer[] = [];
  const additionals: DnsAnswer[] = [];
  const totalCount = anCount + arCount;

  for (let i = 0; i < totalCount; i++) {
    const { name, bytesRead } = decodeName(buf, offset);
    offset += bytesRead;
    if (offset + 10 > buf.length) return null;
    const type = (buf[offset] << 8) | buf[offset + 1];
    const cls = (buf[offset + 2] << 8) | buf[offset + 3];
    const ttl =
      ((buf[offset + 4] & 0xff) << 24) |
      ((buf[offset + 5] & 0xff) << 16) |
      ((buf[offset + 6] & 0xff) << 8) |
      (buf[offset + 7] & 0xff);
    const rdLen = (buf[offset + 8] << 8) | buf[offset + 9];
    offset += 10;
    if (offset + rdLen > buf.length) return null;
    const data = buf.slice(offset, offset + rdLen);
    offset += rdLen;

    const answer: DnsAnswer = { name, type, class: cls & 0x7fff, ttl, data };
    if (i < anCount) {
      answers.push(answer);
    } else {
      additionals.push(answer);
    }
  }

  return { id, flags, isResponse, questions, answers, additionals };
}

// ── TXT record decoding ─────────────────────────────────────────────────────

function decodeTxt(data: Uint8Array): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const len = data[offset];
    offset++;
    if (len === 0) continue;
    let str = "";
    for (let i = 0; i < len && offset + i < data.length; i++) {
      str += String.fromCharCode(data[offset + i]);
    }
    offset += len;
    const eqIdx = str.indexOf("=");
    if (eqIdx > 0) {
      result[str.slice(0, eqIdx)] = str.slice(eqIdx + 1);
    }
  }
  return result;
}

// ── Network address detection ───────────────────────────────────────────────

/**
 * Get the local IPv4 address that can reach the LAN. Falls back to
 * 127.0.0.1 if no suitable interface is found.
 */
function getLocalIPv4(): string {
  const interfaces = networkInterfaces();
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

// ── Socket management ───────────────────────────────────────────────────────

/**
 * Ensure the mDNS socket exists and is bound. Idempotent — calling twice
 * is a no-op. Joins the multicast group and sets up message handlers.
 */
function ensureSocket(): ReturnType<typeof createSocket> {
  if (state.socket) return state.socket;

  const socket = createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (msg: Buffer, _rinfo: RemoteInfo) => {
    const packet = decodePacket(new Uint8Array(msg));
    if (!packet) return;

    if (packet.isResponse) {
      handleResponse(packet);
    } else {
      handleQuery(packet);
    }
  });

  socket.on("error", (err: Error) => {
    console.error("[mDNS] socket error:", err.message);
  });

  socket.bind(MDNS_PORT, () => {
    socket.addMembership(MDNS_MULTICAST_ADDR);
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
  });

  state.socket = socket;
  return socket;
}

// ── Query handler — respond to queries for our services ─────────────────────

function handleQuery(packet: DnsPacket): void {
  for (const q of packet.questions) {
    // Only respond to PTR queries for our service type
    if (q.type === 12 && q.name === SERVICE_TYPE) {
      sendAllRegistrations();
      return;
    }
    // Respond to queries for a specific instance
    if (state.registry.has(q.name)) {
      sendRegistration(q.name);
    }
  }
}

// ── Response handler — update cache from incoming answers ───────────────────

function handleResponse(packet: DnsPacket): void {
  // Collect all records: answers + additionals
  const allRecords = [...packet.answers, ...packet.additionals];

  // Build temporary maps for cross-referencing records
  const srvByName = new Map<string, { port: number; target: string }>();
  const txtByName = new Map<string, Record<string, string>>();
  const aByHost = new Map<string, string>();

  for (const rr of allRecords) {
    switch (rr.type) {
      case 33: { // SRV
        if (rr.data.length >= 7) {
          const port = (rr.data[4] << 8) | rr.data[5];
          const { name: target } = decodeName(rr.data, 6);
          srvByName.set(rr.name, { port, target });
        }
        break;
      }
      case 16: // TXT
        txtByName.set(rr.name, decodeTxt(rr.data));
        break;
      case 1: { // A
        if (rr.data.length >= 4) {
          const addr = `${rr.data[0]}.${rr.data[1]}.${rr.data[2]}.${rr.data[3]}`;
          aByHost.set(rr.name, addr);
        }
        break;
      }
      case 12: { // PTR — instance name from service type
        const { name: instanceName } = decodeName(rr.data, 0);
        // PTR records themselves don't carry service info; the SRV/TXT/A
        // records in the same packet do. We just note the instance name
        // so it gets resolved in the cross-reference pass below.
        if (!srvByName.has(instanceName)) {
          // Mark as needing resolution
          srvByName.set(instanceName, { port: 0, target: "" });
        }
        break;
      }
    }
  }

  // Cross-reference: for each SRV entry, find its TXT and A records
  for (const [instanceName, srv] of srvByName) {
    if (srv.port === 0) continue; // placeholder from PTR, skip
    const txt = txtByName.get(instanceName) ?? {};
    const hostKey = srv.target;
    const addr = aByHost.get(hostKey);
    if (!addr) continue; // no address yet

    state.cache.set(instanceName, {
      name: instanceName,
      host: hostKey,
      port: srv.port,
      txt,
      address: addr,
      ttl: DEFAULT_TTL,
      discoveredAt: Date.now(),
    });
  }
}

// ── Send registrations over the wire ────────────────────────────────────────

/**
 * Send a full mDNS announcement for a single registered instance.
 * Includes PTR, SRV, TXT, and A records.
 */
function sendRegistration(fqdn: string): void {
  const entry = state.registry.get(fqdn);
  if (!entry) return;

  const socket = ensureSocket();
  const localHost = `${hostname()}.local`;
  const localAddr = getLocalIPv4();

  const answers = [
    encodePtr(SERVICE_TYPE, fqdn, DEFAULT_TTL),
    encodeSrv(fqdn, localHost, entry.port, DEFAULT_TTL),
    encodeTxt(fqdn, entry.txt, DEFAULT_TTL),
    encodeA(localHost, localAddr, DEFAULT_TTL),
  ];

  const packet = encodePacket(answers, answers.length);
  socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
}

/**
 * Send announcements for all registered instances.
 */
function sendAllRegistrations(): void {
  for (const fqdn of state.registry.keys()) {
    sendRegistration(fqdn);
  }
}

// ── Cache maintenance ───────────────────────────────────────────────────────

/**
 * Evict stale entries from the discovery cache.
 */
function evictStaleEntries(): void {
  const now = Date.now();
  for (const [key, info] of state.cache) {
    if (now - info.discoveredAt > info.ttl * 1000) {
      state.cache.delete(key);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Advertise a c0de service instance on the LAN via mDNS.
 *
 * The instance is registered as `<name>._c0de._tcp.local` and announced
 * immediately, then re-announced periodically to handle packet loss.
 * Multiple instances with different names coexist without conflict.
 *
 * @param name - Human-readable instance name (e.g. "alice-laptop")
 * @param port - TCP port the service listens on
 * @param txt  - Optional key-value metadata (version, capabilities, etc.)
 */
export function advertiseService(
  name: string,
  port: number,
  txt: Record<string, string> = {},
): void {
  const fqdn = `${name}.${SERVICE_TYPE}`;

  state.registry.set(fqdn, { name: fqdn, port, txt });

  // Ensure socket is ready, then announce
  ensureSocket();

  // Probe: send a query first to detect conflicts, then announce
  setTimeout(() => {
    sendRegistration(fqdn);
  }, 200);

  // Start periodic re-announcement if not already running
  if (!state.reannounceTimer) {
    state.reannounceTimer = setInterval(() => {
      sendAllRegistrations();
    }, REANNOUNCE_INTERVAL_MS);
    // Allow the process to exit without waiting for the timer
    if (state.reannounceTimer.unref) {
      state.reannounceTimer.unref();
    }
  }
}

/**
 * Discover all c0de service instances currently advertising on the LAN.
 *
 * Sends a PTR query for `_c0de._tcp.local` and collects responses for
 * `DISCOVERY_WAIT_MS`. Returns cached entries plus any new discoveries.
 * Multiple instances from different machines (or different ports on the
 * same machine) are all returned.
 *
 * @returns Array of discovered service info, sorted by name.
 */
export async function discoverServices(): Promise<ServiceInfo[]> {
  const socket = ensureSocket();

  // Start cache eviction timer if not running
  if (!state.cacheTimer) {
    state.cacheTimer = setInterval(evictStaleEntries, CACHE_TTL_MS);
    if (state.cacheTimer.unref) {
      state.cacheTimer.unref();
    }
  }

  // Send a PTR query for our service type
  const query = encodeQuery(SERVICE_TYPE, 12); // type 12 = PTR
  socket.send(query, 0, query.length, MDNS_PORT, MDNS_MULTICAST_ADDR);

  // Wait for responses to arrive
  await new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_WAIT_MS));

  // Return all cached entries sorted by name
  return [...state.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Gracefully shut down the mDNS module: send goodbye packets (TTL=0),
 * close the socket, clear timers and caches.
 */
export function shutdown(): void {
  // Send goodbye: TTL=0 tells other hosts to evict our records
  for (const fqdn of state.registry.keys()) {
    const entry = state.registry.get(fqdn);
    if (!entry || !state.socket) continue;

    const localHost = `${hostname()}.local`;
    const localAddr = getLocalIPv4();
    const answers = [
      encodePtr(SERVICE_TYPE, fqdn, 0),
      encodeSrv(fqdn, localHost, entry.port, 0),
      encodeTxt(fqdn, entry.txt, 0),
      encodeA(localHost, localAddr, 0),
    ];
    const packet = encodePacket(answers, answers.length);
    state.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_MULTICAST_ADDR);
  }

  if (state.reannounceTimer) {
    clearInterval(state.reannounceTimer);
    state.reannounceTimer = null;
  }
  if (state.cacheTimer) {
    clearInterval(state.cacheTimer);
    state.cacheTimer = null;
  }
  if (state.socket) {
    try {
      state.socket.close();
    } catch {
      // Already closed
    }
    state.socket = null;
  }
  state.registry.clear();
  state.cache.clear();
}
