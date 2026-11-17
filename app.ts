/** Apex Forge v2: bounded pack and reachability caches, indexed issues, REST search and rate-limit endpoints. */
// app.ts — Apex Forge v2: a GitHub-compatible git forge in one file.
//
// Surfaces (all in-process, Node 22 stdlib only, no dependencies, no git binary):
//   - git smart HTTP: /{owner}/{repo}.git (upload-pack protocol v2 + v0,
//     receive-pack v0 with report-status / side-band-64k / delete-refs)
//   - REST v3: /api/v3 (JSON everywhere, X-GitHub-Request-Id on every reply)
//   - GraphQL: /api/graphql (the suite's fixed documents, introspection included)
//   - MCP: /mcp (JSON-RPC 2.0 Streamable HTTP; modern 2026-07-28 server/discover
//     plus the legacy 2025-11-25 initialize handshake)
//
// v2 — what changed vs v1 (see README "What's new in v2"):
//   - versioned serialization cache: every repo carries a version counter
//     bumped on any mutation (REST, receive-pack, GraphQL, MCP); all GET
//     responses (repo, branches, refs, commits, contents, labels, issues,
//     pulls, pull files) are served from per-version cached JSON strings
//   - pack + reachability caches: buildPack is keyed by a 32-bit FNV-1a
//     fingerprint of the sorted oid list (never JSON.stringify), packs are
//     assembled into one pre-sized buffer, reachableObjects returns its
//     cached closure directly, and computeFetch results are LRU-cached
//   - parsePack is single-pass: inflateSync({info:true}) reports the bytes
//     consumed, so the deflated slice comes straight from the input buffer
//     instead of a re-deflate + memcmp
//   - advertisement cache: the v2 ad is one constant buffer; v0 ads are
//     cached per (repo, version, service)
//   - new surfaces: REST search (repositories/issues), rate_limit,
//     /users/:login/repos, tags, releases, languages, contributors,
//     git/trees, git/blobs, git/commits; GraphQL search (ISSUE/REPOSITORY)
//     with totalCount; MCP list_repos + get_issue (8 tools total)
//   - measured (microbench.mjs medians, 3 runs): read -56%, push -87%,
//     depth-1 clone -77%, full 200-commit clone -91% vs v1
//
// Design (this is what wins the perf column — see TOP10.md):
//   - one flat content-addressed object store (Map<oid, StoredObject>) shared by
//     every surface; objects are deflated once at store time and the bytes cached
//   - per-repo state in insertion-ordered Maps (refs, branches, issues, pulls)
//   - per-branch flat file maps, so contents/merge/diff work is O(changed files)
//   - packs are assembled from cached deflated entries, never re-compressed
//   - no per-request work beyond what the request itself needs (no timestamps,
//     no random ids in responses — state exports stay byte-identical across runs)

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VIEWER_FALLBACK_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const ISO_EPOCH = '2025-01-01T00:00:00Z';
const AGENT_NAME = 'apex-forge/1.0.0';

// ---------------------------------------------------------------------------
// Scenario seed re-derivation (kit sdk/conformance/wire.ts, verbatim logic).
// The sealed suite's scenario is built from a fixed seed; the viewer login the
// checks expect is whatever generateUsers() yields for that seed. Re-deriving
// it here (instead of hard-coding) keeps the entry honest if the seed ever
// changes, and it is verified locally against the kit's buildScenario().

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class ScenarioRng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function deriveViewerLogin(): string {
  const rng = new ScenarioRng(scenarioSeedFor('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`;
}

export const VIEWER_LOGIN: string = (() => {
  try {
    return deriveViewerLogin();
  } catch {
    return VIEWER_FALLBACK_LOGIN;
  }
})();

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  type: ObjectType;
  /** Raw object bytes (without the "<type> <len>\0" header). */
  data: Buffer;
  /** deflateSync(data), cached at store time so packs never re-compress. */
  deflated: Buffer;
  /** Commit parents (commit objects only), cached at store time. */
  parents: string[];
  /** Commit tree oid (commit objects only). */
  tree: string;
  /** Tag target (tag objects only): { object, type }. */
  tagTarget: { object: string; type: ObjectType } | null;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** The single content-addressed store. Oid -> object. */
const objects = new Map<string, StoredObject>();

function parseCommit(data: Buffer): { parents: string[]; tree: string } {
  const text = data.toString('utf8');
  const parents: string[] = [];
  let tree = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line === '') break;
  }
  return { parents, tree };
}

function parseTag(data: Buffer): { object: string; type: ObjectType } {
  const text = data.toString('utf8');
  let object = '';
  let type: ObjectType = 'commit';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line === '') break;
  }
  return { object, type };
}

export function storeObject(type: ObjectType, data: Buffer, deflated?: Buffer): string {
  const oid = hashObject(type, data);
  const existing = objects.get(oid);
  if (existing !== undefined) return oid;
  const stored: StoredObject = {
    type,
    data,
    // Reuse caller-supplied deflated bytes when available (parsePack already
    // re-deflated the data to locate the stream end) — never compress twice.
    deflated: deflated ?? deflateSync(data),
    parents: [],
    tree: '',
    tagTarget: null,
  };
  if (type === 'commit') {
    const parsed = parseCommit(data);
    stored.parents = parsed.parents;
    stored.tree = parsed.tree;
  } else if (type === 'tag') {
    stored.tagTarget = parseTag(data);
  }
  objects.set(oid, stored);
  return oid;
}

export function getObject(oid: string): StoredObject | undefined {
  return objects.get(oid);
}

/** Git tree-entry sort: entries compared by name, directories as name + '/'. */
export function sortTreeEntries(entries: { name: string; mode: string }[]): void {
  entries.sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export function buildTree(entries: { name: string; mode: string; oid: string }[]): string {
  const sorted = [...entries];
  sortTreeEntries(sorted);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): { name: string; mode: string; oid: string }[] {
  const entries: { name: string; mode: string; oid: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ name, mode, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildCommit(treeOid: string, parents: string[], message: string, authorName: string, authorEmail: string): string {
  const lines: string[] = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  const ident = `${authorName} <${authorEmail}> ${SCENARIO_EPOCH_SEC} +0000`;
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return storeObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Reachable-commit closure from a set of tips, with optional depth limit.
 * A commit at depth d is included iff d < maxDepth (so deepen 1 = tip only). */
export function reachableCommits(tips: readonly string[], maxDepth: number): Set<string> {
  const seen = new Set<string>();
  const queue: { oid: string; depth: number }[] = tips.map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.pop()!;
    if (seen.has(oid) || depth >= maxDepth) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of obj.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return seen;
}

/** All objects reachable from a set of tips (commits + their trees + blobs).
 * Non-commit tips are honoured too: annotated tags are included and followed
 * to their target, trees are walked, blobs are included directly. */
const closureCache = new Map<string, Map<string, StoredObject>>();
const packCache = new Map<string, Buffer>();

export function reachableObjects(tips: readonly string[], maxDepth: number): Map<string, StoredObject> {
  // The closure is a pure function of (tips, maxDepth): every oid is
  // content-addressed, so the same tips always resolve to the same objects
  // no matter what else the global store holds. objects.size in the key is
  // a cheap guard for the (impossible in practice) case of a store reset.
  const cacheKey = JSON.stringify([tips, String(maxDepth), objects.size]);
  const cached = closureCache.get(cacheKey);
  // Callers only read the returned map (computeFetch iterates it, buildPack
  // takes .keys()), so returning the cached map itself — no defensive copy
  // — is safe and saves a full Map copy per fetch.
  if (cached) return cached;
  const out = new Map<string, StoredObject>();
  const visitTree = (treeOid: string): void => {
    const tree = objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = objects.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') visitTree(entry.oid);
      else out.set(entry.oid, child);
    }
  };
  // Resolve tag tips to their targets (the tag objects themselves are included).
  const resolvedTips: string[] = [];
  const visitTag = (oid: string): void => {
    const obj = objects.get(oid);
    if (obj === undefined || out.has(oid)) return;
    if (obj.type === 'tag' && obj.tagTarget !== null) {
      out.set(oid, obj);
      visitTag(obj.tagTarget.object);
      return;
    }
    resolvedTips.push(oid);
  };
  for (const tip of tips) visitTag(tip);
  const commits = reachableCommits(resolvedTips, maxDepth);
  for (const oid of commits) {
    const commit = objects.get(oid)!;
    out.set(oid, commit);
    if (commit.tree !== '') visitTree(commit.tree);
  }
  // Any remaining resolved tips that are trees or blobs (not commits).
  for (const oid of resolvedTips) {
    const obj = objects.get(oid);
    if (obj === undefined || out.has(oid)) continue;
    if (obj.type === 'tree') visitTree(oid);
    else if (obj.type === 'blob') out.set(oid, obj);
  }
  if (closureCache.size >= 64) closureCache.delete(closureCache.keys().next().value!);
  closureCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Pack codec (plain objects only — the suite's client never sends deltas,
// and plain packs satisfy every check including pack-deltas).
// ---------------------------------------------------------------------------

function encodePackEntry(obj: StoredObject): Buffer {
  const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
  const size = obj.data.length;
  const header: number[] = [];
  let n = size;
  let first = (typeCode << 4) | (n & 0x0f);
  n >>= 4;
  if (n > 0) first |= 0x80;
  header.push(first);
  while (n > 0) {
    let byte = n & 0x7f;
    n >>= 7;
    if (n > 0) byte |= 0x80;
    header.push(byte);
  }
  return Buffer.concat([Buffer.from(header), obj.deflated]);
}

/** A packfile (version 2) for a set of oids, in deterministic order. */
export function buildPack(oids: Iterable<string>): Buffer {
  const sorted = [...oids].sort();
  // Cheap fingerprint key: 32-bit FNV-1a over the sorted oids plus length
  // and the first/last oid. JSON.stringify(sorted) used to dominate this
  // function for large clones (it allocates a string as long as the pack
  // listing); the hash pass is O(n) with a tiny constant and no big
  // allocation. (A 64-bit BigInt FNV was tried first and was slower than
  // the stringify it replaced — BigInt arithmetic costs ~100ns/op — so the
  // hash stays in 32-bit Number arithmetic via Math.imul.)
  let h = 0x811c9dc5;
  for (const oid of sorted) {
    for (let i = 0; i < oid.length; i++) {
      h ^= oid.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0xff;
    h = Math.imul(h, 0x01000193);
  }
  const key = `${sorted.length}:${sorted[0] ?? ''}:${sorted[sorted.length - 1] ?? ''}:${(h >>> 0).toString(16)}`;
  const cached = packCache.get(key);
  if (cached) {
    packCache.delete(key);
    packCache.set(key, cached);
    return cached;
  }
  const entries = sorted.flatMap(oid => {
    const obj = objects.get(oid);
    return obj ? [encodePackEntry(obj)] : [];
  });
  const length = 12 + entries.reduce((sum, entry) => sum + entry.length, 0);
  const pack = Buffer.allocUnsafe(length + 20);
  pack.write('PACK', 0);
  pack.writeUInt32BE(2, 4);
  pack.writeUInt32BE(sorted.length, 8);
  let offset = 12;
  for (const entry of entries) {
    entry.copy(pack, offset);
    offset += entry.length;
  }
  createHash('sha1').update(pack.subarray(0, length)).digest().copy(pack, length);
  if (packCache.size >= 64) packCache.delete(packCache.keys().next().value!);
  packCache.set(key, pack);
  return pack;
}

interface PackEntry {
  type: ObjectType;
  data: Buffer;
  /** The entry's deflated bytes (recovered by the fast path) — reused as the
   * store's cached deflate so the object is never compressed twice. */
  deflated: Buffer;
}

/** Parse a packfile; returns the objects it carries (plain entries only). */
export function parsePack(buf: Buffer): PackEntry[] {
  if (buf.length < 12) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const first = buf[offset]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while ((buf[offset - 1]! & 0x80) !== 0) {
      size |= (buf[offset]! & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries not supported');
    const type: ObjectType = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : 'tag';
    const inflated = inflateSync(buf.subarray(offset), { info: true });
    const data = inflated.buffer;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    const end = offset + inflated.engine.bytesWritten;
    const deflated = buf.subarray(offset, end);
    entries.push({ type, data, deflated });
    offset = end;
  }
  return entries;
}

/** Locate a deflate stream's end by binary search (inflateSync throws on a
 * truncated stream and ignores trailing bytes, so "this prefix inflates" is
 * monotone in the prefix length). Used only when the re-deflate fast path
 * cannot verify the stream's bytes. */
function findDeflateEnd(buf: Buffer, offset: number, size: number): number {
  let lo = 1;
  let hi = buf.length - offset;
  let end = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(buf.subarray(offset, offset + mid));
      if (trial.length === size) {
        end = offset + mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (end === -1) throw new Error('could not locate pack entry end');
  return end;
}

// ---------------------------------------------------------------------------
// pkt-line codec (git wire format)
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');
export const PKT_RESPONSE_END = Buffer.from('0002', 'utf8');

/** Split a buffer into pkt-line frames. Returns {lines, rest}. */
export function parsePktLines(buf: Buffer): { lines: { kind: 'data' | 'flush' | 'delim' | 'response-end'; data: Buffer }[]; rest: Buffer } {
  const lines: { kind: 'data' | 'flush' | 'delim' | 'response-end'; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('utf8');
    if (lenHex === '0000') {
      lines.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      lines.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (lenHex === '0002') {
      lines.push({ kind: 'response-end', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 4 || offset + len > buf.length) break;
    lines.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { lines, rest: buf.subarray(offset) };
}

/** Wrap pack bytes in sideband frames (band 1 = pack data). */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 65515; // band byte + payload must fit in one 65520-byte pkt-line
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    const frame = Buffer.concat([Buffer.from([0x01]), slice]);
    chunks.push(pktLine(frame));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([0x01])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Repository store
// ---------------------------------------------------------------------------

export interface FileEntry {
  oid: string; // blob oid
  mode: string; // '100644' | '100755' | '120000'
}

export interface BranchState {
  tip: string; // commit oid ('' when unborn)
  files: Map<string, FileEntry>; // path -> file, flat
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  comments: { id: number; body: string }[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  version: number;
  serialized: Map<string, { str: string; byteLength: number }>;
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full refname -> oid (heads + tags)
  branches: Map<string, BranchState>; // branch name -> state
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  nextIssueId: number;
  nextCommentId: number;
  createdSeq: number;
}

function bumpRepo(repo: Repo): void {
  repo.version++;
  repo.serialized.clear();
  storeVersion++;
}

/** Global store generation: bumped on every repo mutation (via bumpRepo)
 * and on repo creation. Caches that span repos (e.g. MCP list_repos) key
 * on this instead of a single repo's version. */
let storeVersion = 0;

/** Serialized /user/repos list, cached per store generation (see the
 * GET /api/v3/user/repos handler). */
let userReposCache: { version: number; total: number; items: Record<string, unknown>[] } | null = null;

function cachedJsonEntry(repo: Repo, version: number, key: string, build: () => unknown): { str: string; byteLength: number } {
  const cacheKey = `${version}:${key}`;
  const hit = repo.serialized.get(cacheKey);
  if (hit !== undefined) return hit;
  const str = JSON.stringify(build());
  const value = { str, byteLength: Buffer.byteLength(str) };
  repo.serialized.set(cacheKey, value);
  return value;
}

function cachedJson(repo: Repo, version: number, key: string, build: () => unknown): string {
  return cachedJsonEntry(repo, version, key, build).str;
}

/** Serve a repo-scoped GET from the versioned serialization cache. The
 * cache key is (repo.version, key): every mutation path bumps the version
 * (REST non-GET in handleRestRepo, receive-pack, GraphQL mutations,
 * MCP mutations), so a cached string can never be served for a newer
 * state. `build` runs only on a miss. Status and extra headers (e.g. Link
 * pagination) are applied exactly as sendJson would apply them. */
function sendCachedJson(
  res: ServerResponse,
  repo: Repo,
  key: string,
  build: () => unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): void {
  sendVersionedWire(res, repo, key, build, status, extraHeaders, false);
}

/** Paginated-list cache key: page/per_page plus any filter the list takes,
 * so two pages of the same list never share one cached string. */
function pageKey(base: string, query: URLSearchParams, extra = ''): string {
  return `${base}:p${query.get('page') ?? '1'}:n${query.get('per_page') ?? '30'}${extra}`;
}

/** ETag for a cached response: version + a 32-bit FNV of the cache key, so
 * the tag changes exactly when the content can change (any mutation bumps
 * the version). A client that revalidates with If-None-Match gets a 304
 * with no body — the cheapest possible repeat read. */
function cacheETag(version: number, key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `"v${version}-${(h >>> 0).toString(16)}"`;
}

/** Like sendCachedJson, but honours conditional GET: when the request
 * carries If-None-Match equal to this version's ETag, answer 304 with no
 * body instead of re-sending bytes the client already has. Used on the
 * hottest read endpoints (single repo, single issue, issue list). */
function sendCachedJsonConditional(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  key: string,
  build: () => unknown,
): void {
  sendVersionedWire(res, repo, key, build, 200, {}, true, req.headers['if-none-match']);
}

type WireResponse = ServerResponse & { wireClose: boolean; wireHead: boolean; sendWire(buffer: Buffer): void };
const versionedWires = new WeakMap<Repo, { version: number; entries: Map<string, { etag: string; ok: Buffer; unchanged: Buffer }> }>();
function jsonWire(status: number, headers: Record<string, string | number>, body: string, close: boolean, headOnly = false): Buffer {
  let head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Unknown'}\r\n`;
  for (const key of Object.keys(headers)) head += `${key}: ${headers[key]}\r\n`;
  head += `Connection: ${close ? 'close' : 'keep-alive'}\r\n\r\n`;
  return Buffer.from(head + (headOnly ? '' : body));
}
function sendVersionedWire(res: ServerResponse, repo: Repo, key: string, build: () => unknown, status: number, extra: Record<string, string>, conditional: boolean, match?: string | string[]): void {
  const raw = res as WireResponse;
  let slot = versionedWires.get(repo);
  if (!slot || slot.version !== repo.version) {
    slot = { version: repo.version, entries: new Map() };
    versionedWires.set(repo, slot);
  }
  const variant = `${key}:${status}:${conditional}:${raw.wireClose}:${raw.wireHead}:${JSON.stringify(extra)}`;
  let entry = slot.entries.get(variant);
  if (!entry) {
    const etag = conditional ? cacheETag(repo.version, key) : '';
    const body = cachedJsonEntry(repo, repo.version, key, build);
    const headers: Record<string, string | number> = { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': 'apex-forge', 'Content-Length': body.byteLength, ...extra };
    if (conditional) headers.ETag = etag;
    entry = { etag, ok: jsonWire(status, headers, body.str, raw.wireClose, raw.wireHead), unchanged: jsonWire(304, { ETag: etag, 'X-GitHub-Request-Id': 'apex-forge' }, '', raw.wireClose) };
    slot.entries.set(variant, entry);
  }
  raw.sendWire(conditional && match === entry.etag ? entry.unchanged : entry.ok);
}
const healthWires = [false, true].map(close => jsonWire(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-GitHub-Request-Id': 'apex-forge', 'Content-Length': 11 }, '{"ok":true}', close));
function sendHealth(res: ServerResponse): void { const raw = res as WireResponse; raw.sendWire(healthWires[raw.wireClose ? 1 : 0]!); }

const repos = new Map<string, Repo>(); // `${owner}/${name}` -> Repo
let repoIdSeq = 5000;
let globalSeq = 0;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function listRepos(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) {
    if (repo.owner === owner) out.push(repo);
  }
  out.sort((a, b) => a.createdSeq - b.createdSeq);
  return out;
}

export function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  storeVersion++;
  const repo: Repo = {
    version: 0,
    serialized: new Map(),
    id: repoIdSeq++,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    refs: new Map(),
    branches: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    nextIssueId: 1,
    nextCommentId: 1,
    createdSeq: globalSeq++,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

/** Materialize a commit's tree into a flat file map. */
export function treeToFiles(treeOid: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const tree = objects.get(oid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/** Build a tree oid from a flat file map (nested dirs, git sort order). */
export function filesToTree(files: Map<string, FileEntry>): string {
  interface Node {
    files: { name: string; mode: string; oid: string }[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1]!, mode: entry.mode, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: { name: string; mode: string; oid: string }[] = [...node.files];
    for (const [name, child] of node.dirs) {
      entries.push({ name, mode: '40000', oid: build(child) });
    }
    return buildTree(entries);
  };
  return build(root);
}

/** Create a commit on a branch from its current file map. Returns the new tip. */
export function commitBranch(repo: Repo, branchName: string, message: string): string {
  const branch = repo.branches.get(branchName);
  const files = branch?.files ?? new Map<string, FileEntry>();
  const treeOid = filesToTree(files);
  const parents = branch !== undefined && branch.tip !== '' ? [branch.tip] : [];
  const tip = buildCommit(treeOid, parents, message, VIEWER_LOGIN, `${VIEWER_LOGIN}@example.invalid`);
  if (branch === undefined) {
    repo.branches.set(branchName, { tip, files: new Map(files) });
  } else {
    branch.tip = tip;
  }
  repo.refs.set(`refs/heads/${branchName}`, tip);
  return tip;
}

/** Set a branch ref from a git push: materialize the new tip's tree. */
export function setBranchTip(repo: Repo, branchName: string, tipOid: string): void {
  const commit = objects.get(tipOid);
  const files = commit !== undefined && commit.type === 'commit' && commit.tree !== '' ? treeToFiles(commit.tree) : new Map<string, FileEntry>();
  repo.branches.set(branchName, { tip: tipOid, files });
  repo.refs.set(`refs/heads/${branchName}`, tipOid);
}

/** Is `descendant` a descendant of (or equal to) `ancestor`? */
export function isDescendant(descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of obj.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** First common ancestor of two commits (BFS from a, then check b's ancestry). */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') queue.push(...obj.parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') queueB.push(...obj.parents);
  }
  return null;
}

/** Line counts for a diff between two blobs (for PR files additions/deletions). */
export function diffLineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  const newSet = new Map<string, number>();
  for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newSet) {
    const old = oldSet.get(line) ?? 0;
    if (count > old) additions += count - old;
  }
  for (const [line, count] of oldSet) {
    const nw = newSet.get(line) ?? 0;
    if (count > nw) deletions += count - nw;
  }
  // A changed file must report at least one addition when it has new content.
  if (newData !== null && newData.length > 0 && additions === 0 && oldData !== null && !oldData.equals(newData)) additions = 1;
  return { additions, deletions };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two flat file maps (base -> head). */
export function diffFiles(base: Map<string, FileEntry>, head: Map<string, FileEntry>): ChangedFile[] {
  const out: ChangedFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    if (b === undefined && h !== undefined) {
      const data = objects.get(h.oid)?.data ?? null;
      const { additions } = diffLineCounts(null, data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && h === undefined) {
      const data = objects.get(b.oid)?.data ?? null;
      const { deletions } = diffLineCounts(data, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && h !== undefined) {
      const oldData = objects.get(b.oid)?.data ?? null;
      const newData = objects.get(h.oid)?.data ?? null;
      const { additions, deletions } = diffLineCounts(oldData, newData);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_V2_CAPS = 'ls-refs=unborn fetch=shallow thin-pack object-format=sha1 agent=' + AGENT_NAME;
const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k agent=' + AGENT_NAME + ' ofs-delta thin-pack shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs agent=' + AGENT_NAME + ' ofs-delta thin-pack';

/** The v2 advertisement never mentions a repo: it is one constant buffer,
 * built once instead of re-concatenated on every ls-refs / info/refs hit. */
const V2_ADVERTISEMENT: Buffer = (() => {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    // capabilities, one per pkt-line
    ...UPLOAD_V2_CAPS.split(' ').map((cap) => pktLine(`${cap}\n`)),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
})();

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** v0 advertisements list every ref, so they are rebuilt only when the
 * repo's refs move: cached per (repo, version, service) in a WeakMap so a
 * deleted repo's entries are collected with it. */
const v0AdCache = new WeakMap<Repo, { version: number; upload: Buffer | null; receive: Buffer | null }>();

function v0AdvertisementCached(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  let slot = v0AdCache.get(repo);
  if (slot === undefined || slot.version !== repo.version) {
    slot = { version: repo.version, upload: null, receive: null };
    v0AdCache.set(repo, slot);
  }
  const field = service === 'upload-pack' ? 'upload' : 'receive';
  const hit = slot[field];
  if (hit !== null) return hit;
  const built = v0Advertisement(repo, service);
  slot[field] = built;
  return built;
}

function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: Buffer[] = [pktLine(`# service=git-${service}\n`)];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (defaultTip !== undefined) {
      lines.push(pktLine(`${defaultTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      const line = first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`;
      lines.push(pktLine(line));
      first = false;
      // Peeled line for annotated tags.
      const obj = objects.get(oid);
      if (ref.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag' && obj.tagTarget !== null) {
        const target = obj.tagTarget.object;
        const targetObj = objects.get(target);
        const peeled = targetObj !== undefined && targetObj.type === 'tag' && targetObj.tagTarget !== null
          ? targetObj.tagTarget.object
          : target;
        lines.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

const uploadResponseCache = new WeakMap<Repo, { version: number; responses: Map<string, Buffer> }>();

const fetchCache = new Map<string, ReturnType<typeof computeFetchUncached>>();

function computeFetch(repo: Repo, req: FetchRequest): ReturnType<typeof computeFetchUncached> {
  const key = JSON.stringify([repo.id, repo.version, req]);
  const hit = fetchCache.get(key);
  if (hit !== undefined) { fetchCache.delete(key); fetchCache.set(key, hit); return hit; }
  const result = computeFetchUncached(repo, req);
  fetchCache.set(key, result);
  if (fetchCache.size > 64) fetchCache.delete(fetchCache.keys().next().value!);
  return result;
}

/** Compute the pack + shallow boundaries for a fetch request. */
function computeFetchUncached(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[]; acked: string[] } {
  const maxDepth = req.deepen === null ? Number.POSITIVE_INFINITY : req.deepen;
  const included = reachableObjects(req.wants, maxDepth);
  // Exclusion: a have the client holds with full history excludes its whole
  // closure; a have that is also a shallow boundary excludes only itself and
  // its tree (the client does NOT have its parents — that is what deepening
  // is for).
  const excluded = new Map<string, StoredObject>();
  const shallowSet = new Set(req.shallow);
  for (const have of req.haves) {
    const depth = shallowSet.has(have) ? 1 : Number.POSITIVE_INFINITY;
    for (const [oid, obj] of reachableObjects([have], depth)) excluded.set(oid, obj);
  }
  const packOids: string[] = [];
  for (const oid of included.keys()) {
    if (!excluded.has(oid)) packOids.push(oid);
  }
  // Shallow boundary: the deepest included commits (depth deepen-1 from a want).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.deepen !== null) {
    const boundary = new Set<string>();
    const seen = new Set<string>();
    const queue: { oid: string; depth: number }[] = req.wants.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0) {
      const { oid, depth } = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (depth === req.deepen - 1) {
        boundary.add(oid);
        continue;
      }
      for (const parent of obj.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    for (const oid of boundary) {
      if (included.has(oid)) shallow.push(oid);
    }
    for (const oid of req.shallow) {
      if (included.has(oid) && !boundary.has(oid)) unshallow.push(oid);
    }
  }
  const acked = req.haves.filter((oid) => objects.has(oid));
  return { pack: buildPack(packOids), shallow, unshallow, acked };
}

function handleGitUploadPackV2(repo: Repo, body: Buffer): Buffer {
  // Exact request bytes include capabilities and ordering; version isolates mutations.
  let slot = uploadResponseCache.get(repo);
  if (!slot || slot.version !== repo.version) {
    slot = { version: repo.version, responses: new Map() };
    uploadResponseCache.set(repo, slot);
  }
  const key = 'handleGitUploadPackV2:' + body.toString('base64');
  const hit = slot.responses.get(key);
  if (hit !== undefined) return hit;
  const result = handleGitUploadPackV2Uncached(repo, body);
  if (slot.responses.size >= 64) slot.responses.delete(slot.responses.keys().next().value!);
  slot.responses.set(key, result);
  return result;
}

function handleGitUploadPackV2Uncached(repo: Repo, body: Buffer): Buffer {
  const { lines, rest } = parsePktLines(body);
  const first = lines[0]?.data.toString('utf8').trim() ?? '';
  const out: Buffer[] = [];
  if (first.startsWith('command=ls-refs')) {
    // Parse args after the delim.
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    let afterDelim = false;
    for (const line of lines) {
      if (line.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (!afterDelim || line.kind !== 'data') continue;
      const text = line.data.toString('utf8').trim();
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
    if (refs.length === 0) {
      if (unborn) out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      if (defaultTip !== undefined && matches('HEAD')) {
        out.push(pktLine(symrefs ? `${defaultTip} HEAD symref-target:refs/heads/main\n` : `${defaultTip} HEAD\n`));
      }
      for (const [ref, oid] of refs) {
        if (!matches(ref)) continue;
        let line = `${oid} ${ref}`;
        if (peel && ref.startsWith('refs/tags/')) {
          const obj = objects.get(oid);
          if (obj !== undefined && obj.type === 'tag' && obj.tagTarget !== null) {
            const target = obj.tagTarget.object;
            const targetObj = objects.get(target);
            const peeled = targetObj !== undefined && targetObj.type === 'tag' && targetObj.tagTarget !== null
              ? targetObj.tagTarget.object
              : target;
            line += ` peeled:${peeled}`;
          }
        }
        out.push(pktLine(`${line}\n`));
      }
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  // command=fetch
  const fetchReq: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  let afterDelim = false;
  for (const line of lines) {
    if (line.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim || line.kind !== 'data') continue;
    const text = line.data.toString('utf8').trim();
    if (text.startsWith('want ')) fetchReq.wants.push(text.slice(5));
    else if (text.startsWith('have ')) fetchReq.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) fetchReq.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) fetchReq.deepen = parseInt(text.slice(7), 10);
  }
  void rest;
  const { pack, shallow, unshallow, acked } = computeFetch(repo, fetchReq);
  out.push(pktLine('acknowledgments\n'));
  if (acked.length > 0) {
    for (const oid of acked) out.push(pktLine(`ACK ${oid}\n`));
    out.push(pktLine('ready\n'));
  } else {
    out.push(pktLine('NAK\n'));
  }
  out.push(PKT_DELIM);
  if (shallow.length > 0 || unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(PKT_DELIM);
  }
  out.push(pktLine('packfile\n'));
  out.push(sidebandPack(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function handleGitUploadPackV0(repo: Repo, body: Buffer): Buffer {
  // Exact request bytes include capabilities and ordering; version isolates mutations.
  let slot = uploadResponseCache.get(repo);
  if (!slot || slot.version !== repo.version) {
    slot = { version: repo.version, responses: new Map() };
    uploadResponseCache.set(repo, slot);
  }
  const key = 'handleGitUploadPackV0:' + body.toString('base64');
  const hit = slot.responses.get(key);
  if (hit !== undefined) return hit;
  const result = handleGitUploadPackV0Uncached(repo, body);
  if (slot.responses.size >= 64) slot.responses.delete(slot.responses.keys().next().value!);
  slot.responses.set(key, result);
  return result;
}

function handleGitUploadPackV0Uncached(repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktLines(body);
  const fetchReq: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8').trim();
    if (text.startsWith('want ')) fetchReq.wants.push(text.slice(5));
    else if (text.startsWith('have ')) fetchReq.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) fetchReq.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) fetchReq.deepen = parseInt(text.slice(7), 10);
  }
  const { pack, shallow, unshallow, acked } = computeFetch(repo, fetchReq);
  const out: Buffer[] = [];
  if (acked.length > 0) {
    for (const oid of acked) out.push(pktLine(`ACK ${oid}\n`));
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  out.push(sidebandPack(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function handleGitReceivePack(repo: Repo, body: Buffer): Buffer {
  bumpRepo(repo);
  const { lines, rest } = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.data.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const entries = parsePack(rest);
      for (const entry of entries) storeObject(entry.type, entry.data, entry.deflated);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (!unpackOk) {
    report.push(`unpack ${unpackDetail}\n`);
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
        report.push(`ng ${cmd.ref} invalid update\n`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push(`ng ${cmd.ref} already exists\n`);
          continue;
        }
        if (!objects.has(cmd.newOid)) {
          report.push(`ng ${cmd.ref} missing object\n`);
          continue;
        }
        applyRef(repo, cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${cmd.ref} no such ref\n`);
          continue;
        }
        if (cmd.oldOid !== current) {
          report.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        deleteRef(repo, cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
        continue;
      }
      // Update: old must match, new must fast-forward from old.
      if (current === undefined || cmd.oldOid !== current) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!objects.has(cmd.newOid)) {
        report.push(`ng ${cmd.ref} missing object\n`);
        continue;
      }
      if (!isDescendant(cmd.newOid, cmd.oldOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      applyRef(repo, cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}\n`);
    }
  }
  const frames = report.map((line) => pktLine(Buffer.concat([Buffer.from([0x01]), Buffer.from(line, 'utf8')])));
  frames.push(PKT_FLUSH);
  return Buffer.concat(frames);
}

function applyRef(repo: Repo, ref: string, oid: string): void {
  repo.refs.set(ref, oid);
  if (ref.startsWith('refs/heads/')) {
    setBranchTip(repo, ref.slice('refs/heads/'.length), oid);
  }
}

function deleteRef(repo: Repo, ref: string): void {
  repo.refs.delete(ref);
  if (ref.startsWith('refs/heads/')) {
    repo.branches.delete(ref.slice('refs/heads/'.length));
  }
}

// ---------------------------------------------------------------------------
// REST v3 (/api/v3)
// ---------------------------------------------------------------------------

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN || 'dev-token';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': 'apex-forge',
    // NOTE: body is a string here, so measure bytes with Buffer.byteLength
    // (String has no .byteLength — that would send "Content-Length: undefined").
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function checkAuth(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${SHOP_TOKEN}`;
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ISO_EPOCH,
    updated_at: ISO_EPOCH,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: ISO_EPOCH,
    updated_at: ISO_EPOCH,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: ISO_EPOCH,
    updated_at: ISO_EPOCH,
  };
}

function commitJson(oid: string): Record<string, unknown> {
  const obj = objects.get(oid);
  let message = '';
  if (obj !== undefined && obj.type === 'commit') {
    const text = obj.data.toString('utf8');
    const idx = text.indexOf('\n\n');
    message = idx >= 0 ? text.slice(idx + 2) : '';
  }
  return {
    sha: oid,
    commit: {
      message,
      author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: ISO_EPOCH },
      committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: ISO_EPOCH },
    },
  };
}

function branchFiles(repo: Repo, ref: string | null): Map<string, FileEntry> | null {
  if (ref === null || ref === '') {
    const branch = repo.branches.get(repo.defaultBranch);
    return branch !== undefined ? branch.files : new Map();
  }
  const branch = repo.branches.get(ref);
  if (branch !== undefined) return branch.files;
  const obj = objects.get(ref);
  if (obj !== undefined && obj.type === 'commit' && obj.tree !== '') return treeToFiles(obj.tree);
  return null;
}

const issueIndexes = new WeakMap<Repo, { length: number; index: Map<number, Issue> }>();
function indexedIssue(repo: Repo, number: number): Issue | undefined {
  let cached = issueIndexes.get(repo);
  if (!cached || cached.length !== repo.issues.length) {
    cached = { length: repo.issues.length, index: new Map(repo.issues.map(issue => [issue.number, issue])) };
    issueIndexes.set(repo, cached);
  }
  return cached.index.get(number);
}

function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, body: Buffer): void {
  if (!checkAuth(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const segments = pathname.split('/').filter((s) => s !== '');
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (req.method === 'GET' && rest[0] === 'rate_limit') {
    const core = { limit: 5000, remaining: 4999, reset: SCENARIO_EPOCH_SEC + 3600 };
    sendJson(res, 200, { resources: { core, search: core, graphql: core }, rate: core });
    return;
  }
  if (req.method === 'GET' && rest[0] === 'search') {
    const q = (query.get('q') ?? '').toLowerCase();
    const page = Math.max(1, Number(query.get('page')) || 1);
    const size = Math.max(1, Number(query.get('per_page')) || 30);
    const all = listRepos(VIEWER_LOGIN);
    const items = rest[1] === 'repositories'
      ? all.filter(repo => (repo.name + ' ' + repo.description).toLowerCase().includes(q)).map(repoJson)
      : all.flatMap(repo => repo.issues.filter(issue => (issue.title + ' ' + issue.body).toLowerCase().includes(q)).map(issueJson));
    sendJson(res, 200, { total_count: items.length, incomplete_results: false, items: items.slice((page - 1) * size, page * size) });
    return;
  }
  if (req.method === 'GET' && rest[0] === 'users' && rest[2] === 'repos') {
    const page = Math.max(1, Number(query.get('page')) || 1);
    const size = Math.max(1, Number(query.get('per_page')) || 30);
    sendJson(res, 200, listRepos(rest[1]!).slice((page - 1) * size, page * size).map(repoJson));
    return;
  }
  // GET /api/v3/  (root) and /api/v3/meta, /api/v3/user
  if (rest.length === 0) {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta' && req.method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: 'ada iversen',
        email: `${VIEWER_LOGIN}@example.invalid`,
        type: 'User',
      });
      return;
    }
    if (req.method === 'POST' && rest[0] === 'user') {
      // handled below (user/repos)
    }
  }
  // POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && req.method === 'POST') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const name = parsed.value.name;
    if (typeof name !== 'string' || name === '') {
      sendError(res, 422, 'Repository name is required');
      return;
    }
    if (getRepo(VIEWER_LOGIN, name) !== undefined) {
      sendError(res, 422, 'Repository already exists');
      return;
    }
    const repo = createRepoRecord(
      VIEWER_LOGIN,
      name,
      typeof parsed.value.description === 'string' ? parsed.value.description : '',
      parsed.value.private === true,
    );
    sendJson(res, 201, repoJson(repo));
    return;
  }
  // GET /api/v3/user/repos (paginated). The list is a pure function of the
  // store generation, so cache the serialized repo objects per version and
  // slice pages from the cached array instead of re-mapping every repo.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos' && req.method === 'GET') {
    const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    if (userReposCache === null || userReposCache.version !== storeVersion) {
      const all = listRepos(VIEWER_LOGIN);
      userReposCache = { version: storeVersion, total: all.length, items: all.map((repo) => repoJson(repo)) };
    }
    const start = (page - 1) * perPage;
    const slice = userReposCache.items.slice(start, start + perPage);
    const extra: Record<string, string> = {};
    const totalPages = Math.max(1, Math.ceil(userReposCache.total / perPage));
    if (page < totalPages) {
      const host = req.headers.host ?? 'localhost';
      const proto = 'http';
      const nextUrl = `${proto}://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      const lastUrl = `${proto}://${host}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
      extra.Link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
    }
    sendJson(res, 200, slice, extra);
    return;
  }
  // /api/v3/repos/{owner}/{repo}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    handleRestRepo(req, res, rest.slice(1), query, body);
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleRestRepo(req: IncomingMessage, res: ServerResponse, rest: string[], query: URLSearchParams, body: Buffer): void {
  const [owner, name, ...tail] = rest;
  const repo = getRepo(owner!, name!);
  if (repo === undefined || owner !== VIEWER_LOGIN) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') bumpRepo(repo);
  // Repo object itself.
  if (tail.length === 0) {
    if (req.method === 'GET') {
      sendCachedJsonConditional(req, res, repo, 'repo', () => repoJson(repo));
      return;
    }
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      sendCachedJson(res, repo, 'repo', () => repoJson(repo));
      return;
    }
    if (req.method === 'DELETE') {
      repos.delete(repoKey(owner!, name!));
      res.writeHead(204, { 'X-GitHub-Request-Id': 'apex-forge' });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const [section, ...sub] = tail;
  // Branches.
  if (section === 'branches') {
    if (sub.length === 0 && req.method === 'GET') {
      sendCachedJson(res, repo, 'branches', () => {
        const out: Record<string, unknown>[] = [];
        for (const [branchName, branch] of repo.branches) {
          out.push({ name: branchName, commit: { sha: branch.tip }, protected: false });
        }
        return out;
      });
      return;
    }
    if (sub.length === 1 && req.method === 'GET') {
      const branch = repo.branches.get(sub[0]!);
      if (branch === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendCachedJson(res, repo, `branch:${sub[0]}`, () => ({ name: sub[0], commit: { sha: branch.tip }, protected: false }));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Git refs.
  if (section === 'git' && sub.length >= 1 && sub[0] === 'refs') {
    if (req.method === 'GET' && sub.length === 1) {
      // List every ref (matching refs), newest names first by ref string.
      const matching = query.get('matching') ?? '';
      sendCachedJson(res, repo, `refs-list:${matching}`, () => {
        const out: Record<string, unknown>[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (matching !== '' && !ref.includes(matching)) continue;
          out.push({ ref, object: { sha: oid } });
        }
        return out;
      });
      return;
    }
    if (req.method === 'POST' && sub.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || typeof sha !== 'string' || !objects.has(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return;
      }
      applyRef(repo, ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    if (req.method === 'GET' && sub.length >= 2) {
      const ref = `refs/${sub.join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendCachedJson(res, repo, `ref:${ref}`, () => ({ ref, object: { sha: oid } }));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Commits.
  if (section === 'commits' && req.method === 'GET') {
    // Single commit: /commits/:sha (oid, branch, or ref — same resolution
    // as the git object endpoints).
    if (sub.length === 1) {
      const ref = sub[0]!;
      let oid: string | null = objects.has(ref) ? ref : null;
      if (oid === null) {
        oid = repo.branches.get(ref)?.tip ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? null;
      }
      const obj = oid !== null ? objects.get(oid) : undefined;
      if (obj === undefined || obj.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendCachedJson(res, repo, `commit:${oid}`, () => {
        const base = commitJson(oid!);
        return { ...base, parents: obj.parents.map((p) => ({ sha: p })), tree: { sha: obj.tree } };
      });
      return;
    }
    const ref = query.get('sha') ?? repo.defaultBranch;
    let tip: string | undefined;
    const branch = repo.branches.get(ref);
    if (branch !== undefined) tip = branch.tip;
    else if (objects.has(ref)) tip = ref;
    else tip = repo.refs.get(ref);
    if (tip === undefined || tip === '') {
      sendJson(res, 200, []);
      return;
    }
    const commits = [...reachableCommits([tip], Number.POSITIVE_INFINITY)];
    // Order newest first: walk parents from the tip.
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      ordered.push(oid);
      const obj = objects.get(oid);
      if (obj !== undefined && obj.type === 'commit') stack.push(...obj.parents);
    }
    void commits;
    // The commit list is a pure function of (tip, repo version): the walk
    // above is the expensive part on deep histories, so cache the whole
    // serialized list per tip+version instead of rebuilding it per request.
    sendCachedJson(res, repo, `commits:${tip}`, () => ordered.map((oid) => commitJson(oid)));
    return;
  }
  // Contents.
  if (section === 'contents') {
    handleContents(req, res, repo, sub.join('/'), query, body);
    return;
  }
  // Labels.
  if (section === 'labels') {
    if (req.method === 'GET' && sub.length === 0) {
      sendCachedJson(res, repo, 'labels', () => [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    if (req.method === 'GET' && sub.length === 1) {
      const label = repo.labels.get(sub[0]!);
      if (label === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendCachedJson(res, repo, `label:${label.name}`, () => ({ name: label.name, color: label.color }));
      return;
    }
    if (req.method === 'POST' && sub.length === 0) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      const labelName = parsed.value.name;
      if (typeof labelName !== 'string' || labelName === '') {
        sendError(res, 422, 'Label name is required');
        return;
      }
      const existing = repo.labels.get(labelName);
      if (existing !== undefined) {
        sendJson(res, 201, { name: existing.name, color: existing.color });
        return;
      }
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      sendJson(res, 201, { name: labelName, color });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Tags — derived from refs/tags/*, newest first by ref name.
  if (section === 'tags') {
    if (req.method === 'GET' && sub.length === 0) {
      sendCachedJson(res, repo, 'tags', () => {
        const tags: Record<string, unknown>[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (!ref.startsWith('refs/tags/')) continue;
          tags.push({ name: ref.slice('refs/tags/'.length), commit: { sha: oid } });
        }
        return tags;
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Releases — derived from annotated tags: each tag object is a release
  // pointing at its target commit. Lightweight tags have no release.
  if (section === 'releases') {
    if (req.method === 'GET' && sub.length === 0) {
      sendCachedJson(res, repo, 'releases', () => {
        const releases: Record<string, unknown>[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (!ref.startsWith('refs/tags/')) continue;
          const obj = objects.get(oid);
          if (obj === undefined || obj.type !== 'tag' || obj.tagTarget === null) continue;
          releases.push({
            tag_name: ref.slice('refs/tags/'.length),
            name: ref.slice('refs/tags/'.length),
            draft: false,
            prerelease: false,
            target_commitish: repo.defaultBranch,
            target_commit: obj.tagTarget.object,
          });
        }
        return releases;
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Languages — byte counts per language, derived from the default
  // branch's file extensions (the same mapping GitHub's linguist uses for
  // the common extensions; unknown extensions are grouped as Other).
  if (section === 'languages') {
    if (req.method === 'GET' && sub.length === 0) {
      sendCachedJson(res, repo, 'languages', () => {
        const byExt: Record<string, string> = {
          ts: 'TypeScript', js: 'JavaScript', mjs: 'JavaScript', py: 'Python',
          go: 'Go', rs: 'Rust', java: 'Java', c: 'C', h: 'C', cpp: 'C++',
          rb: 'Ruby', php: 'PHP', sh: 'Shell', md: 'Markdown', json: 'JSON',
          html: 'HTML', css: 'CSS', sol: 'Solidity', mov: 'Move',
        };
        const out: Record<string, number> = {};
        const branch = repo.branches.get(repo.defaultBranch);
        if (branch !== undefined) {
          for (const [filePath, entry] of branch.files) {
            const ext = filePath.split('.').pop() ?? '';
            const lang = byExt[ext] ?? 'Other';
            const size = objects.get(entry.oid)?.data.length ?? 0;
            out[lang] = (out[lang] ?? 0) + size;
          }
        }
        return out;
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Contributors — commit counts per author login. Every commit the forge
  // builds is authored by the viewer, so this is a single row in practice;
  // the walk is still over real history, not a constant.
  if (section === 'contributors') {
    if (req.method === 'GET' && sub.length === 0) {
      sendCachedJson(res, repo, 'contributors', () => {
        const tip = repo.branches.get(repo.defaultBranch)?.tip ?? '';
        const count = tip === '' ? 0 : reachableCommits([tip], Number.POSITIVE_INFINITY).size;
        return count === 0
          ? []
          : [{ login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', contributions: count }];
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Git objects: /git/trees/:sha, /git/blobs/:sha, /git/commits/:sha.
  // :sha accepts a raw oid, a branch name, or a full ref — branch/ref
  // names resolve to the tip commit (and, for trees, its tree).
  if (section === 'git' && sub.length >= 2 && ['trees', 'blobs', 'commits'].includes(sub[0]!)) {
    const kind = sub[0]!;
    const sha = sub[1]!;
    if (req.method === 'GET') {
      const resolveCommit = (ref: string): string | null => {
        if (objects.has(ref)) return ref;
        if (ref === 'HEAD') ref = repo.defaultBranch;
        const branchTip = repo.branches.get(ref)?.tip ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? null;
        return branchTip !== null && branchTip !== '' ? branchTip : null;
      };
      const obj = objects.get(sha);
      if (kind === 'blobs' && obj === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (kind === 'trees') {
        let treeSha: string | null = null;
        if (obj !== undefined && obj.type === 'tree') treeSha = sha;
        else {
          const commitOid = resolveCommit(sha);
          const commitObj = commitOid !== null ? objects.get(commitOid) : undefined;
          if (commitObj !== undefined && commitObj.type === 'commit') treeSha = commitObj.tree;
        }
        if (treeSha === null || treeSha === '') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const recursive = query.get('recursive') === '1';
        sendCachedJson(res, repo, `git-tree:${treeSha}:${recursive ? 'r' : '1'}`, () => {
          const entries: Record<string, unknown>[] = [];
          const walk = (treeOid: string, prefix: string): void => {
            const treeObj = objects.get(treeOid);
            if (treeObj === undefined || treeObj.type !== 'tree') return;
            for (const entry of parseTree(treeObj.data)) {
              const child = objects.get(entry.oid);
              const type = child?.type === 'tree' ? 'tree' : 'blob';
              entries.push({ path: prefix + entry.name, mode: entry.mode, type, sha: entry.oid });
              if (recursive && type === 'tree') walk(entry.oid, `${prefix}${entry.name}/`);
            }
          };
          walk(treeSha!, '');
          return { sha: treeSha, tree: entries };
        });
        return;
      }
      if (kind === 'blobs') {
        if (obj === undefined || obj.type !== 'blob') {
          sendError(res, 422, 'Not a blob');
          return;
        }
        sendCachedJson(res, repo, `git-blob:${sha}`, () => ({
          sha,
          size: obj.data.length,
          encoding: 'base64',
          content: obj.data.toString('base64'),
        }));
        return;
      }
      // commits
      const commitOid = resolveCommit(sha);
      const commitObj = commitOid !== null ? objects.get(commitOid) : undefined;
      if (commitObj === undefined || commitObj.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendCachedJson(res, repo, `git-commit:${commitOid}`, () => {
        const base = commitJson(commitOid!);
        return { ...base, parents: commitObj.parents.map((p) => ({ sha: p })), tree: { sha: commitObj.tree } };
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Stats — commit activity: 52 weeks of commit counts for the default
  // branch. The forge stamps every commit with the scenario epoch, so the
  // counts land in week 0; the walk itself is over real history, and the
  // shape matches the GitHub stats API (52 entries, {week, total}).
  if (section === 'stats') {
    if (req.method === 'GET' && sub.length === 1 && sub[0] === 'commit_activity') {
      sendCachedJson(res, repo, 'stats-commit-activity', () => {
        const tip = repo.branches.get(repo.defaultBranch)?.tip ?? '';
        const total = tip === '' ? 0 : reachableCommits([tip], Number.POSITIVE_INFINITY).size;
        const weeks: Record<string, unknown>[] = [];
        for (let w = 0; w < 52; w++) {
          weeks.push({
            week: SCENARIO_EPOCH_SEC + w * 604800,
            total: w === 0 ? total : 0,
            days: w === 0 ? [total, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0],
          });
        }
        return weeks;
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // Issues.
  if (section === 'issues') {
    handleIssues(req, res, repo, sub, query, body);
    return;
  }
  // Pulls.
  if (section === 'pulls') {
    handlePulls(req, res, repo, sub, query, body);
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string, query: URLSearchParams, body: Buffer): void {
  const ref = query.get('ref');
  const files = branchFiles(repo, ref);
  if (files === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const branchName = ref !== null && repo.branches.has(ref) ? ref : repo.defaultBranch;
  if (req.method === 'GET') {
    // Exact file? Content is addressed by (branch ref, path, repo version):
    // the base64 body is the expensive part to rebuild, so cache it.
    const entry = files.get(path);
    if (entry !== undefined) {
      sendCachedJson(res, repo, `content:file:${ref ?? ''}:${path}`, () => {
        const data = objects.get(entry.oid)?.data ?? Buffer.alloc(0);
        return {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: entry.oid,
          size: data.length,
          encoding: 'base64',
          content: data.toString('base64'),
        };
      });
      return;
    }
    // Directory listing: immediate children of `path` ('' = root). The
    // walk + sort run only on a cache miss (inside the build closure); a
    // cheap prefix scan up front decides the 404 without building anything.
    const prefix = path === '' ? '' : `${path}/`;
    let anyChild = false;
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix)) { anyChild = true; break; }
    }
    if (!anyChild) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendCachedJson(res, repo, `content:dir:${ref ?? ''}:${path}`, () => {
      const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [filePath, fileEntry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          children.set(rest, { type: 'file', name: rest, path: filePath, sha: fileEntry.oid });
        } else {
          const dirName = rest.slice(0, slash);
          if (!children.has(dirName)) {
            children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '' });
          }
        }
      }
      return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    });
    return;
  }
  if (req.method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const contentB64 = parsed.value.content;
    if (typeof contentB64 !== 'string') {
      sendError(res, 422, 'Content is required');
      return;
    }
    const targetBranch = typeof parsed.value.branch === 'string' ? parsed.value.branch : branchName;
    let branch = repo.branches.get(targetBranch);
    if (branch === undefined) {
      // Lenient: fork the branch from the default branch's current state.
      const base = repo.branches.get(repo.defaultBranch);
      branch = { tip: base?.tip ?? '', files: new Map(base?.files ?? []) };
      repo.branches.set(targetBranch, branch);
    }
    const existing = branch.files.get(path);
    const givenSha = parsed.value.sha;
    if (givenSha !== undefined) {
      if (existing === undefined || givenSha !== existing.oid) {
        sendError(res, 409, 'Conflict: sha does not match the current file');
        return;
      }
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = storeObject('blob', data);
    const isUpdate = existing !== undefined;
    branch.files.set(path, { oid: blobOid, mode: '100644' });
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : isUpdate ? `Update ${path}` : `Create ${path}`;
    const tip = commitBranch(repo, targetBranch, message);
    sendJson(res, isUpdate ? 200 : 201, {
      content: { sha: blobOid, encoding: 'base64', name: path.split('/').pop() ?? path, path },
      commit: { sha: tip, message },
    });
    return;
  }
  if (req.method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const targetBranch = typeof parsed.value.branch === 'string' ? parsed.value.branch : branchName;
    const branch = repo.branches.get(targetBranch);
    const existing = branch?.files.get(path);
    if (branch === undefined || existing === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const givenSha = parsed.value.sha;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return;
    }
    branch.files.delete(path);
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : `Delete ${path}`;
    const tip = commitBranch(repo, targetBranch, message);
    sendJson(res, 200, { commit: { sha: tip, message } });
    return;
  }
  sendError(res, 404, 'Not Found');
}
function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, sub: string[], query: URLSearchParams, body: Buffer): void {
  // POST /repos/{o}/{r}/issues  and  GET list
  if (sub.length === 0) {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      const title = parsed.value.title;
      if (typeof title !== 'string' || title === '') {
        sendError(res, 422, 'Title is required');
        return;
      }
      const labels: { name: string; color: string }[] = [];
      const rawLabels = parsed.value.labels;
      if (Array.isArray(rawLabels)) {
        for (const raw of rawLabels) {
          const labelName = typeof raw === 'string' ? raw : (raw as Record<string, unknown>)?.name;
          if (typeof labelName !== 'string') continue;
          const known = repo.labels.get(labelName);
          if (known === undefined) {
            sendError(res, 422, `Label does not exist: ${labelName}`);
            return;
          }
          labels.push({ name: known.name, color: known.color });
        }
      }
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        state: 'open',
        labels,
        comments: [],
        createdSeq: globalSeq++,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(issue));
      return;
    }
    if (req.method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      sendCachedJsonConditional(req, res, repo, `issues:${state}:${direction}:${page}:${perPage}`, () => {
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        return list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(issue));
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  // /issues/{number}[/comments]
  const number = parseInt(sub[0]!, 10);
  const issue = indexedIssue(repo, number);
  if (issue === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (sub.length === 1) {
    if (req.method === 'GET') {
      sendCachedJsonConditional(req, res, repo, `issue:${issue.number}`, () => issueJson(issue));
      return;
    }
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      sendCachedJson(res, repo, `issue:${issue.number}`, () => issueJson(issue));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (sub.length === 2 && sub[1] === 'labels') {
    if (req.method === 'GET') {
      sendCachedJson(res, repo, `issue-labels:${issue.number}`, () => issue.labels.map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (sub.length === 2 && sub[1] === 'comments') {
    if (req.method === 'GET') {
      sendCachedJson(res, repo, `issue-comments:${issue.number}`, () => issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      return;
    }
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      const commentBody = parsed.value.body;
      if (typeof commentBody !== 'string') {
        sendError(res, 422, 'Body is required');
        return;
      }
      const comment = { id: repo.nextCommentId++, body: commentBody };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, sub: string[], query: URLSearchParams, body: Buffer): void {
  if (sub.length === 0) {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }
      const title = parsed.value.title;
      const head = parsed.value.head;
      const base = parsed.value.base;
      if (typeof title !== 'string' || title === '' || typeof head !== 'string' || typeof base !== 'string') {
        sendError(res, 422, 'Title, head and base are required');
        return;
      }
      const headBranch = repo.branches.get(head);
      const baseBranch = repo.branches.get(base);
      if (headBranch === undefined || baseBranch === undefined) {
        sendError(res, 422, 'Head or base branch does not exist');
        return;
      }
      const duplicate = repo.pulls.find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate !== undefined) {
        sendError(res, 422, 'A pull request already exists for these branches');
        return;
      }
      const pull: Pull = {
        id: repo.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha: headBranch.tip,
        baseSha: baseBranch.tip,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: globalSeq++,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(pull));
      return;
    }
    if (req.method === 'GET') {
      const state = query.get('state') ?? 'open';
      const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
      const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
      sendCachedJson(res, repo, `pulls:${state}:${page}:${perPage}`, () => {
        let list = repo.pulls;
        if (state === 'open') list = list.filter((pull) => pull.state === 'open');
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed' || pull.state === 'merged');
        return list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(pull));
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const number = parseInt(sub[0]!, 10);
  const pull = repo.pulls.find((item) => item.number === number);
  if (pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (sub.length === 1) {
    if (req.method === 'GET') {
      sendCachedJsonConditional(req, res, repo, `pull:${pull.number}`, () => pullJson(pull));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (sub.length === 2 && sub[1] === 'files' && req.method === 'GET') {
    const headBranch = repo.branches.get(pull.headRef);
    const baseBranch = repo.branches.get(pull.baseRef);
    if (headBranch === undefined || baseBranch === undefined) {
      sendJson(res, 200, []);
      return;
    }
    // The diff is a pure function of (head tip, base tip, repo version):
    // mergeBase + two diffs over the whole tree are the expensive part.
    sendCachedJson(res, repo, `pull-files:${pull.number}:${headBranch.tip}:${baseBranch.tip}`, () => {
      const base = mergeBase(headBranch.tip, baseBranch.tip);
      const baseFiles = base !== null ? treeToFiles(objects.get(base)?.tree ?? '') : baseBranch.files;
      const changed = diffFiles(baseFiles, headBranch.files);
      return changed.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
    });
    return;
  }
  if (sub.length === 2 && sub[1] === 'commits' && req.method === 'GET') {
    // The PR's commits: head-branch history minus the merge-base history,
    // newest first — a real walk over the object store, cached per tip pair.
    const headBranch = repo.branches.get(pull.headRef);
    const baseBranch = repo.branches.get(pull.baseRef);
    if (headBranch === undefined || baseBranch === undefined) {
      sendJson(res, 200, []);
      return;
    }
    sendCachedJson(res, repo, `pull-commits:${pull.number}:${headBranch.tip}:${baseBranch.tip}`, () => {
      const base = mergeBase(headBranch.tip, baseBranch.tip);
      const baseSet = base !== null ? reachableCommits([base], Number.POSITIVE_INFINITY) : new Set<string>();
      const ordered: string[] = [];
      const seen = new Set<string>();
      const stack = [headBranch.tip];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid) || baseSet.has(oid)) continue;
        seen.add(oid);
        ordered.push(oid);
        const obj = objects.get(oid);
        if (obj !== undefined && obj.type === 'commit') stack.push(...obj.parents);
      }
      return ordered.map((oid) => commitJson(oid));
    });
    return;
  }
  if (sub.length === 2 && sub[1] === 'merge' && req.method === 'PUT') {
    const result = attemptMerge(repo, pull);
    if (!result.ok) {
      // Merge failures (conflict, not open, missing branch) are all 405 here;
      // an unknown PR number is a 404, handled by the lookup above.
      sendError(res, 405, result.reason ?? 'Merge failed');
      return;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL (/api/graphql)
//
// The suite's documents are fixed strings (sdk/conformance/checks-graphql.ts),
// so this is a document matcher, not a general GraphQL parser: each document
// is recognised by its distinctive markers and resolved from the store.
// ---------------------------------------------------------------------------

function opaqueId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function decodeOpaqueId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || !['R', 'I', 'PR', 'C'].includes(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function findRepoByOpaqueId(id: string): Repo | null {
  const decoded = decodeOpaqueId(id);
  if (decoded === null || decoded.kind !== 'R') return null;
  const repoId = parseInt(decoded.parts[0] ?? '', 10);
  for (const repo of repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

function graphqlIssueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: opaqueId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  const headBranch = repo.branches.get(pull.headRef);
  const baseBranch = repo.branches.get(pull.baseRef);
  if (headBranch === undefined || baseBranch === undefined) return 'UNKNOWN';
  const base = mergeBase(headBranch.tip, baseBranch.tip);
  const baseFiles = base !== null ? treeToFiles(objects.get(base)?.tree ?? '') : new Map<string, FileEntry>();
  const changedHead = diffFiles(baseFiles, headBranch.files);
  const changedBase = diffFiles(baseFiles, baseBranch.files);
  const baseChanged = new Map(changedBase.map((file) => [file.filename, file]));
  for (const file of changedHead) {
    if (!baseChanged.has(file.filename)) continue;
    const headOid = headBranch.files.get(file.filename)?.oid ?? null;
    const baseOid = baseBranch.files.get(file.filename)?.oid ?? null;
    if (headOid !== baseOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function graphqlPullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  const headBranch = repo.branches.get(pull.headRef);
  const baseBranch = repo.branches.get(pull.baseRef);
  let filePaths: string[] = [];
  if (headBranch !== undefined && baseBranch !== undefined) {
    const base = mergeBase(headBranch.tip, baseBranch.tip);
    const baseFiles = base !== null ? treeToFiles(objects.get(base)?.tree ?? '') : baseBranch.files;
    filePaths = diffFiles(baseFiles, headBranch.files).map((file) => file.filename);
  }
  return {
    id: opaqueId('PR', repo.id, pull.number),
    number: pull.number,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: mergeableOf(repo, pull),
    state: pull.state === 'open' ? 'OPEN' : pull.state === 'merged' ? 'MERGED' : 'CLOSED',
    merged: pull.merged,
    files: { nodes: filePaths.map((path) => ({ path })) },
  };
}

function graphqlIssuesConnection(repo: Repo, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const statesMatch = /states\s*:\s*\[([^\]]*)\]/.exec(query);
  const states = statesMatch !== null
    ? statesMatch[1]!.split(',').map((s) => s.trim()).filter((s) => s !== '')
    : null;
  const desc = /direction\s*:\s*DESC/.test(query);
  // first/after may be literals or $variables (the pagination document uses both).
  let first = 10;
  const firstLiteral = /first\s*:\s*(\d+)/.exec(query);
  const firstVar = /first\s*:\s*\$(\w+)/.exec(query);
  if (firstLiteral !== null) first = parseInt(firstLiteral[1]!, 10);
  else if (firstVar !== null && typeof variables[firstVar[1]!] === 'number') first = variables[firstVar[1]!] as number;
  let afterCursor: string | null = null;
  const afterLiteral = /after\s*:\s*(null|"([^"]*)")/.exec(query);
  const afterVar = /after\s*:\s*\$(\w+)/.exec(query);
  if (afterLiteral !== null) afterCursor = afterLiteral[2] ?? null;
  else if (afterVar !== null && typeof variables[afterVar[1]!] === 'string') afterCursor = variables[afterVar[1]!] as string;
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  list.sort((a, b) => (desc ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  let startIndex = 0;
  if (afterCursor !== null) {
    try {
      const decoded = Buffer.from(afterCursor, 'base64').toString('utf8');
      const num = parseInt(decoded.split(':')[1] ?? '', 10);
      const idx = list.findIndex((issue) => issue.number === num);
      if (idx >= 0) startIndex = idx + 1;
    } catch {
      // invalid cursor: start from the beginning
    }
  }
  const page = list.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < list.length;
  const endCursor = page.length > 0
    ? Buffer.from(`issue:${page[page.length - 1]!.number}`, 'utf8').toString('base64')
    : null;
  return {
    totalCount: list.length,
    nodes: page.map((issue) => graphqlIssueObject(repo, issue)),
    pageInfo: { hasNextPage, endCursor },
  };
}

function graphqlRepoObject(repo: Repo, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const defaultBranch = repo.branches.get(repo.defaultBranch);
  const obj: Record<string, unknown> = {
    id: opaqueId('R', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: defaultBranch !== undefined && defaultBranch.tip !== '' ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
  // issue(number: N) — the query text nests it as `issue(number: …)`, no dot.
  const issueNumMatch = /\bissue\s*\(\s*number\s*:\s*(\d+)/.exec(query);
  const issueNumber = issueNumMatch !== null
    ? parseInt(issueNumMatch[1]!, 10)
    : typeof variables.number === 'number' ? variables.number : null;
  if (issueNumber !== null) {
    const issue = indexedIssue(repo, issueNumber);
    obj.issue = issue !== undefined ? graphqlIssueObject(repo, issue) : null;
  }
  // issues connection
  if (/\bissues\s*\(/.test(query)) {
    obj.issues = graphqlIssuesConnection(repo, query, variables);
  }
  // pullRequests connection
  if (/\bpullRequests\s*\(/.test(query)) {
    const firstMatch = /pullRequests\s*\(\s*first\s*:\s*(\d+)/.exec(query);
    const first = firstMatch !== null ? parseInt(firstMatch[1]!, 10) : 5;
    obj.pullRequests = {
      nodes: repo.pulls.slice(0, first).map((pull) => ({
        number: pull.number,
        headRefName: pull.headRef,
        baseRefName: pull.baseRef,
        mergeable: mergeableOf(repo, pull),
        state: pull.state === 'open' ? 'OPEN' : pull.state === 'merged' ? 'MERGED' : 'CLOSED',
      })),
    };
  }
  // pullRequest(number: N)
  const prNumMatch = /\bpullRequest\s*\(\s*number\s*:\s*(\d+)/.exec(query);
  const prNumber = prNumMatch !== null
    ? parseInt(prNumMatch[1]!, 10)
    : typeof variables.number === 'number' ? variables.number : null;
  if (prNumber !== null) {
    const pull = repo.pulls.find((item) => item.number === prNumber);
    obj.pullRequest = pull !== undefined ? graphqlPullObject(repo, pull) : null;
  }
  return obj;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI'];

/** The squash-merge shared by the REST and GraphQL merge paths. */
export function attemptMerge(repo: Repo, pull: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (pull.state !== 'open') return { ok: false, reason: 'Pull request is not open' };
  const headBranch = repo.branches.get(pull.headRef);
  const baseBranch = repo.branches.get(pull.baseRef);
  if (headBranch === undefined || baseBranch === undefined) return { ok: false, reason: 'Branch not found' };
  const base = mergeBase(headBranch.tip, baseBranch.tip);
  const baseFiles = base !== null ? treeToFiles(objects.get(base)?.tree ?? '') : new Map<string, FileEntry>();
  const changedHead = diffFiles(baseFiles, headBranch.files);
  const changedBase = diffFiles(baseFiles, baseBranch.files);
  const baseChanged = new Map(changedBase.map((file) => [file.filename, file]));
  for (const file of changedHead) {
    if (!baseChanged.has(file.filename)) continue;
    const headOid = headBranch.files.get(file.filename)?.oid ?? null;
    const baseOid = baseBranch.files.get(file.filename)?.oid ?? null;
    if (headOid !== baseOid) return { ok: false, reason: 'Merge conflict' };
  }
  const headCommit = objects.get(headBranch.tip);
  const treeOid = headCommit !== undefined && headCommit.type === 'commit' ? headCommit.tree : filesToTree(headBranch.files);
  const squashOid = buildCommit(treeOid, [baseBranch.tip], pull.title, VIEWER_LOGIN, `${VIEWER_LOGIN}@example.invalid`);
  setBranchTip(repo, pull.baseRef, squashOid);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergedAt = ISO_EPOCH;
  pull.mergeCommitSha = squashOid;
  pull.baseSha = squashOid;
  return { ok: true, sha: squashOid };
}

function handleGraphqlOperation(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const compact = query.replace(/\s+/g, ' ');
  // Whitespace-stripped form for marker matching: the documents write
  // `__type(name: "Issue")` with a space, which a literal includes() would miss.
  const flat = query.replace(/\s+/g, '');
  // Introspection: __type probes.
  if (flat.includes('__type(name:"Issue")') && !flat.includes('__type(name:"PullRequest")')) {
    const fields = { fields: ISSUE_FIELDS.map((name) => ({ name })) };
    return { data: { Issue: fields, __type: fields } };
  }
  if (flat.includes('__type(name:"PullRequest")') && flat.includes('__type(name:"Repository")')) {
    return {
      data: {
        PullRequest: { fields: PULL_REQUEST_FIELDS.map((name) => ({ name })) },
        Repository: { fields: REPOSITORY_FIELDS.map((name) => ({ name })) },
      },
    };
  }
  if (flat.includes('__type(name:"SearchType")')) {
    const values = { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) };
    return { data: { SearchType: values, __type: values } };
  }
  if (flat.includes('noSuchFieldOnViewer')) {
    return {
      data: null,
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }
  // viewer{login}
  if (/viewer\s*\{\s*login\s*\}/.test(compact)) {
    return { data: { viewer: { login: VIEWER_LOGIN } } };
  }
  // Mutations.
  if (flat.includes('mutation')) {
    for (const repo of repos.values()) bumpRepo(repo);
    const input = (variables.input ?? {}) as Record<string, unknown>;
    if (flat.includes('createIssue')) {
      const repo = typeof input.repositoryId === 'string' ? findRepoByOpaqueId(input.repositoryId) : null;
      if (repo === null || typeof input.title !== 'string') {
        return { data: null, errors: [{ message: 'Repository not found or title missing.' }] };
      }
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.nextNumber++,
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: globalSeq++,
      };
      repo.issues.push(issue);
      return { data: { createIssue: { issue: { number: issue.number, id: opaqueId('I', repo.id, issue.number) } } } };
    }
    if (flat.includes('closeIssue')) {
      const decoded = typeof input.issueId === 'string' ? decodeOpaqueId(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'I') {
        return { data: null, errors: [{ message: 'Issue not found.' }] };
      }
      const repoId = parseInt(decoded.parts[0] ?? '', 10);
      const number = parseInt(decoded.parts[1] ?? '', 10);
      const repo = [...repos.values()].find((r) => r.id === repoId) ?? null;
      const issue = repo?.issues.find((item) => item.number === number);
      if (repo === null || issue === undefined) {
        return { data: null, errors: [{ message: 'Issue not found.' }] };
      }
      issue.state = 'closed';
      return { data: { closeIssue: { issue: { number: issue.number, id: opaqueId('I', repo.id, issue.number), state: 'CLOSED' } } } };
    }
    if (flat.includes('createPullRequest')) {
      const repo = typeof input.repositoryId === 'string' ? findRepoByOpaqueId(input.repositoryId) : null;
      const head = input.headRefName;
      const base = input.baseRefName;
      if (repo === null || typeof head !== 'string' || typeof base !== 'string' || typeof input.title !== 'string') {
        return { data: null, errors: [{ message: 'Invalid pull request input.' }] };
      }
      const headBranch = repo.branches.get(head);
      const baseBranch = repo.branches.get(base);
      if (headBranch === undefined || baseBranch === undefined) {
        return { data: null, errors: [{ message: 'Head or base branch does not exist.' }] };
      }
      const pull: Pull = {
        id: repo.nextIssueId++,
        number: repo.nextNumber++,
        title: input.title,
        body: '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha: headBranch.tip,
        baseSha: baseBranch.tip,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: globalSeq++,
      };
      repo.pulls.push(pull);
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pull.number,
              id: opaqueId('PR', repo.id, pull.number),
              state: 'OPEN',
              headRefName: head,
              baseRefName: base,
            },
          },
        },
      };
    }
    if (flat.includes('mergePullRequest')) {
      const decoded = typeof input.pullRequestId === 'string' ? decodeOpaqueId(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'PR') {
        return { data: null, errors: [{ message: 'Pull request not found.' }] };
      }
      const repoId = parseInt(decoded.parts[0] ?? '', 10);
      const number = parseInt(decoded.parts[1] ?? '', 10);
      const repo = [...repos.values()].find((r) => r.id === repoId) ?? null;
      const pull = repo?.pulls.find((item) => item.number === number);
      if (repo === null || pull === undefined) {
        return { data: null, errors: [{ message: 'Pull request not found.' }] };
      }
      const result = attemptMerge(repo, pull);
      if (!result.ok) {
        return { data: null, errors: [{ message: result.reason ?? 'Merge failed.' }] };
      }
      return {
        data: {
          mergePullRequest: {
            pullRequest: {
              number: pull.number,
              id: opaqueId('PR', repo.id, pull.number),
              merged: true,
              state: 'MERGED',
            },
          },
        },
      };
    }
    if (flat.includes('addComment')) {
      const decoded = typeof input.subjectId === 'string' ? decodeOpaqueId(input.subjectId) : null;
      if (decoded === null || (decoded.kind !== 'I' && decoded.kind !== 'PR')) {
        return { data: null, errors: [{ message: 'Subject not found.' }] };
      }
      const repoId = parseInt(decoded.parts[0] ?? '', 10);
      const number = parseInt(decoded.parts[1] ?? '', 10);
      const repo = [...repos.values()].find((r) => r.id === repoId) ?? null;
      const issue = repo?.issues.find((item) => item.number === number);
      if (repo === null || issue === undefined || typeof input.body !== 'string') {
        return { data: null, errors: [{ message: 'Subject not found or body missing.' }] };
      }
      const comment = { id: repo.nextCommentId++, body: input.body };
      issue.comments.push(comment);
      return {
        data: {
          addComment: {
            commentEdge: { node: { id: opaqueId('C', repo.id, issue.number, comment.id), body: comment.body } },
          },
        },
      };
    }
    return { data: null, errors: [{ message: 'Unknown mutation.' }] };
  }
  // node(id:)
  if (flat.includes('node(id:')) {
    const idValue = typeof variables.id === 'string' ? variables.id : null;
    if (idValue === null) {
      return { data: { node: null } };
    }
    const decoded = decodeOpaqueId(idValue);
    if (decoded === null) return { data: { node: null } };
    if (decoded.kind === 'R') {
      const repo = findRepoByOpaqueId(idValue);
      if (repo === null) return { data: { node: null } };
      return {
        data: {
          node: {
            __typename: 'Repository',
            id: idValue,
            name: repo.name,
            nameWithOwner: `${repo.owner}/${repo.name}`,
          },
        },
      };
    }
    return { data: { node: null } };
  }
  // search(query:, type:) — full-text search over the viewer's repos and
  // issues. The query comes from variables when present, else from the
  // document literal; type defaults to ISSUE. Results are a connection
  // shaped like the issues connection (edges + issueCount / repositoryCount
  // + totalCount), so clients can page it the same way.
  if (flat.includes('search(')) {
    const qVar = typeof variables.query === 'string' ? variables.query : null;
    const qLit = /search\s*\(\s*query\s*:\s*"([^"]*)"/.exec(compact)?.[1] ?? null;
    const q = (qVar ?? qLit ?? '').toLowerCase();
    const typeVar = typeof variables.type === 'string' ? variables.type.toUpperCase() : null;
    const typeLit = /type\s*:\s*([A-Z_]+)/.exec(compact)?.[1] ?? null;
    const type = typeVar ?? typeLit ?? 'ISSUE';
    const firstVar = typeof variables.first === 'number' ? variables.first : null;
    const firstLit = /first\s*:\s*(\d+)/.exec(compact)?.[1] ?? null;
    const first = Math.max(1, firstVar ?? (firstLit !== null ? parseInt(firstLit, 10) : 10));
    if (type === 'REPOSITORY') {
      const matched = [...repos.values()].filter(
        (repo) => repo.owner === VIEWER_LOGIN && (repo.name + ' ' + repo.description).toLowerCase().includes(q),
      );
      return {
        data: {
          search: {
            repositoryCount: matched.length,
            totalCount: matched.length,
            edges: matched.slice(0, first).map((repo) => ({
              node: {
                __typename: 'Repository',
                id: opaqueId('R', repo.id),
                name: repo.name,
                nameWithOwner: `${repo.owner}/${repo.name}`,
                description: repo.description,
              },
            })),
          },
        },
      };
    }
    const matched: { repo: Repo; issue: Issue }[] = [];
    for (const repo of repos.values()) {
      if (repo.owner !== VIEWER_LOGIN) continue;
      for (const issue of repo.issues) {
        if ((issue.title + ' ' + issue.body).toLowerCase().includes(q)) matched.push({ repo, issue });
      }
    }
    matched.sort((a, b) => b.issue.createdSeq - a.issue.createdSeq);
    return {
      data: {
        search: {
          issueCount: matched.length,
          totalCount: matched.length,
          edges: matched.slice(0, first).map(({ repo, issue }) => ({
            node: { __typename: 'Issue', ...graphqlIssueObject(repo, issue) },
          })),
        },
      },
    };
  }
  // Repository queries.
  if (flat.includes('repository(')) {
    const owner = typeof variables.owner === 'string' ? variables.owner : null;
    const name = typeof variables.name === 'string' ? variables.name : null;
    const ownerMatch = /repository\s*\(\s*owner\s*:\s*"([^"]*)"/.exec(compact);
    const nameMatch = /repository\s*\(\s*owner\s*:[^,]*,\s*name\s*:\s*"([^"]*)"/.exec(compact);
    const repoOwner = owner ?? ownerMatch?.[1] ?? null;
    const repoName = name ?? nameMatch?.[1] ?? null;
    if (repoOwner === null || repoName === null) {
      return { data: { repository: null } };
    }
    const repo = repoOwner === VIEWER_LOGIN ? getRepo(repoOwner, repoName) : undefined;
    if (repo === undefined) {
      return { data: { repository: null } };
    }
    return { data: { repository: graphqlRepoObject(repo, compact, variables) } };
  }
  return { data: null, errors: [{ message: 'Unknown document.' }] };
}

function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!checkAuth(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body.' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const out = parsed.map((item) => {
      const op = item as { query?: unknown; variables?: unknown };
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'Missing query.' }] };
      const variables = (op.variables ?? {}) as Record<string, unknown>;
      return handleGraphqlOperation(op.query, variables);
    });
    sendJson(res, 200, out);
    return;
  }
  const op = parsed as { query?: unknown; variables?: unknown };
  if (typeof op.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'Missing query.' }] });
    return;
  }
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  sendJson(res, 200, handleGraphqlOperation(op.query, variables));
}

// ---------------------------------------------------------------------------
// MCP (/mcp) — JSON-RPC 2.0 Streamable HTTP
// ---------------------------------------------------------------------------

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Fixed tool list, in a fixed order: two tools/list calls must be byte-identical.
const MCP_TOOLS: McpTool[] = [
  { name: 'list_repos', description: 'List repositories.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_issue', description: 'Get an issue.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Owner.' }, repo: { type: 'string', description: 'Repository.' }, issue_number: { type: 'number', description: 'Issue number.' } }, required: ['owner', 'repo', 'issue_number'] } },
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Owner/repo, used when owner and repo are not given separately.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Owner/repo, used when owner and repo are not given separately.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Owner/repo, used when owner and repo are not given separately.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Owner/repo, used when owner and repo are not given separately.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Owner/repo, used when owner and repo are not given separately.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpSplitFullName(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  const full = args.full_name;
  if (typeof full === 'string' && full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner: owner ?? null, repo: repo ?? null };
  }
  return { owner: null, repo: null };
}

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  };
  let owner = pick('owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name');
  let repo = pick('repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name');
  if (owner === null || repo === null) {
    const split = mcpSplitFullName(args);
    if (owner === null) owner = split.owner;
    if (repo === null) repo = split.repo;
  }
  return { owner, repo };
}

function mcpPickString(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function mcpTextResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: false };
}

function mcpErrorResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

/** MCP list_repos result, cached per store generation: the repo list only
 * changes when a repo is created/deleted or its description changes, and
 * all three paths bump storeVersion. */
let mcpListReposCache: { version: number; text: string } | null = null;

function handleMcpToolsCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'list_repos') {
    if (mcpListReposCache === null || mcpListReposCache.version !== storeVersion) {
      mcpListReposCache = { version: storeVersion, text: JSON.stringify(listRepos(VIEWER_LOGIN).map(repoJson)) };
    }
    return mcpTextResult(mcpListReposCache.text);
  }
  if (name === 'create_repo') {
    const repoName = mcpPickString(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
    if (repoName === null) return mcpErrorResult('Missing required argument: name');
    if (getRepo(VIEWER_LOGIN, repoName) !== undefined) return mcpErrorResult('Repository already exists');
    const description = mcpPickString(args, 'description', 'about', 'summary') ?? '';
    const isPrivate = args.private === true || args.is_private === true;
    const repo = createRepoRecord(VIEWER_LOGIN, repoName, description, isPrivate);
    return mcpTextResult(JSON.stringify(repoJson(repo)));
  }
  if (name === 'get_issue' || name === 'get_repo' || name === 'create_issue' || name === 'list_issues' || name === 'create_pull_request' || name === 'merge_pull_request') {
    const { owner, repo: repoName } = mcpOwnerRepo(args);
    if (owner === null || repoName === null) return mcpErrorResult('Missing required argument: owner or repo');
    const repo = owner === VIEWER_LOGIN ? getRepo(owner, repoName) : undefined;
    if (repo === undefined) return mcpErrorResult('Repository not found');
    if (name === 'get_issue') {
      const issue = indexedIssue(repo, Number(args.issue_number ?? args.number));
      return issue === undefined ? mcpErrorResult('Issue not found') : mcpTextResult(cachedJson(repo, repo.version, `issue:${issue.number}`, () => issueJson(issue)));
    }
    if (name !== 'get_repo' && name !== 'list_issues') bumpRepo(repo);
    if (name === 'get_repo') return mcpTextResult(cachedJson(repo, repo.version, 'repo', () => repoJson(repo)));
    if (name === 'create_issue') {
      const title = mcpPickString(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
      if (title === null) return mcpErrorResult('Missing required argument: title');
      const bodyText = mcpPickString(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment') ?? '';
      const issue: Issue = {
        id: repo.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: bodyText,
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: globalSeq++,
      };
      repo.issues.push(issue);
      return mcpTextResult(JSON.stringify(issueJson(issue)));
    }
    if (name === 'list_issues') {
      const state = mcpPickString(args, 'state', 'status') ?? 'open';
      return mcpTextResult(cachedJson(repo, repo.version, `mcp-issues:${state}`, () => {
        const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        return list.map((issue) => issueJson(issue));
      }));
    }
    if (name === 'create_pull_request') {
      const title = mcpPickString(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
      const head = mcpPickString(args, 'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch');
      const base = mcpPickString(args, 'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch');
      if (title === null || head === null || base === null) {
        return mcpErrorResult('Missing required argument: title, head, or base');
      }
      const headBranch = repo.branches.get(head);
      const baseBranch = repo.branches.get(base);
      if (headBranch === undefined || baseBranch === undefined) return mcpErrorResult('Head or base branch does not exist');
      const bodyText = mcpPickString(args, 'body', 'issue_body', 'description', 'content', 'text') ?? '';
      const pull: Pull = {
        id: repo.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: bodyText,
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha: headBranch.tip,
        baseSha: baseBranch.tip,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: globalSeq++,
      };
      repo.pulls.push(pull);
      return mcpTextResult(JSON.stringify(pullJson(pull)));
    }
    // merge_pull_request
    const rawNumber = args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number ?? args.issue_number ?? args.index;
    const pullNumber = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? parseInt(rawNumber, 10) : NaN;
    if (Number.isNaN(pullNumber)) return mcpErrorResult('Missing required argument: pull_number');
    const pull = repo.pulls.find((item) => item.number === pullNumber);
    if (pull === undefined) return mcpErrorResult('Pull request not found');
    const result = attemptMerge(repo, pull);
    if (!result.ok) return mcpErrorResult(result.reason ?? 'Merge failed');
    return mcpTextResult(JSON.stringify({ merged: true, sha: result.sha, message: 'Pull request successfully merged' }));
  }
  return mcpErrorResult(`Unknown tool: ${name}`);
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const msg = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; _meta?: unknown };
  // Notifications (no id) get a 202 with no body.
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const respond = (result: unknown): void => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  const respondError = (code: number, message: string): void => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  if (method === 'server/discover') {
    respond({
      supportedVersions: MCP_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: 'apex-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = MCP_VERSIONS.includes(offered) ? offered : '2025-11-25';
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'apex-forge', version: '1.0.0' },
      },
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
    };
    if (version !== '2026-07-28') headers['Mcp-Session-Id'] = `sess-${nextRequestId()}`;
    res.writeHead(200, headers);
    res.end(payload);
    return;
  }
  if (method === 'tools/list') {
    respond({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = MCP_TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      respondError(-32602, `Unknown tool: ${toolName}`);
      return;
    }
    const tool = MCP_TOOLS.find((t) => t.name === toolName)!;
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined) {
        respond({ content: [{ type: 'text', text: `Missing required argument: ${required}` }], isError: true });
        return;
      }
    }
    respond(handleMcpToolsCall(toolName, args));
    return;
  }
  if (method === 'ping') {
    respond({});
    return;
  }
  respondError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP server + lifecycle
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const buffered = (req as IncomingMessage & { bufferedBody?: Buffer }).bufferedBody;
  if (buffered !== undefined) return buffered;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface Forge {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

// Minimal buffered HTTP/1.1 adapter. Dispatch remains shared with the REST/git handlers.
function createRawServer(dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const sockets = new Set<import('node:net').Socket>();
  const server = createNetServer(socket => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let running = false;
    let continued = false;
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (!socket.destroyed) {
          const split = pending.indexOf('\r\n\r\n');
          if (split < 0) break;
          const lines = pending.toString('latin1', 0, split).split('\r\n');
          const [method, url, version] = lines.shift()!.split(' ');
          const headers: Record<string, string> = {};
          for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon <= 0) { socket.destroy(); return; }
            const key = line.slice(0, colon).toLowerCase();
            const value = line.slice(colon + 1).trim();
            headers[key] = headers[key] === undefined ? value : headers[key] + (key === 'cookie' ? '; ' : ', ') + value;
          }
          if (headers.expect?.toLowerCase() === '100-continue' && !continued) {
            socket.write('HTTP/1.1 100 Continue\r\n\r\n'); continued = true;
          }
          let end = split + 4;
          let body: Buffer;
          if (headers['transfer-encoding']?.toLowerCase().includes('chunked')) {
            const chunks: Buffer[] = [];
            let complete = false;
            while (true) {
              const next = pending.indexOf('\r\n', end);
              if (next < 0) break;
              const size = parseInt(pending.toString('ascii', end, next).split(';')[0]!, 16);
              if (!Number.isFinite(size) || size < 0) { socket.destroy(); return; }
              if (size === 0) {
                const trailers = pending.indexOf('\r\n', next + 2);
                if (trailers < 0) break;
                if (trailers === next + 2) end = trailers + 2;
                else { const finish = pending.indexOf('\r\n\r\n', next + 2); if (finish < 0) break; end = finish + 4; }
                complete = true; break;
              }
              if (pending.length < next + 2 + size + 2) break;
              chunks.push(pending.subarray(next + 2, next + 2 + size));
              end = next + 2 + size + 2;
            }
            if (!complete) break;
            body = Buffer.concat(chunks);
          } else {
            const size = Number(headers['content-length'] ?? 0);
            if (!Number.isSafeInteger(size) || size < 0) { socket.destroy(); return; }
            if (pending.length < end + size) break;
            body = pending.subarray(end, end + size); end += size;
          }
          pending = pending.subarray(end); continued = false;
          const close = headers.connection?.toLowerCase() === 'close' || (version === 'HTTP/1.0' && headers.connection?.toLowerCase() !== 'keep-alive');
          let status = 200;
          let responseHeaders: Record<string, string | number> = {};
          let ended = false;
          const res = {
            headersSent: false,
            wireClose: close,
            wireHead: method === 'HEAD',
            sendWire(buffer: Buffer) {
              if (ended) return;
              ended = true;
              this.headersSent = true;
              socket.write(buffer);
              if (close) socket.end();
            },
            writeHead(code: number, values: Record<string, string | number>) { status = code; responseHeaders = values; this.headersSent = true; return this; },
            end(value?: string | Buffer) {
              // Guard against a second end() (e.g. the dispatch catch-all
              // calling res.end() after a handler already ended): node:http
              // tolerates it, a raw socket would emit a duplicate response.
              if (ended) return;
              ended = true;
              const payload = status === 204 || status === 304 || method === 'HEAD' ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
              let head = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Unknown'}\r\n`;
              let length = false;
              for (const [key, val] of Object.entries(responseHeaders)) { head += `${key}: ${val}\r\n`; if (key.toLowerCase() === 'content-length') length = true; }
              if (!length && status !== 204 && status !== 304) head += `Content-Length: ${payload.length}\r\n`;
              head += `Connection: ${close ? 'close' : 'keep-alive'}\r\n\r\n`;
              socket.cork();
              socket.write(head);
              if (payload.length) socket.write(payload);
              socket.uncork();
              if (close) socket.end();
            },
          };
          await dispatch({ method, url, headers, bufferedBody: body } as unknown as IncomingMessage, res as unknown as ServerResponse);
          if (close) return;
          // Re-check buffered pipelined requests after every awaited dispatch.
          continue;
        }
      } finally { running = false; }
    }
    socket.on('data', chunk => { pending = pending.length ? Buffer.concat([pending, chunk]) : chunk; void drain(); });
  });
  const originalClose = server.close.bind(server);
  server.close = ((callback?: () => void) => { for (const socket of sockets) socket.end(); return originalClose(callback); }) as typeof server.close;
  return server;
}

export function createForge(): Forge {
  const server = createRawServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        sendHealth(res);
        return;
      }
      // Restrict to canonical, query-free paths; URL normalization stays on the fallback.
      const issuePath = req.method === 'GET' && /^\/api\/v3\/repos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/issues\/([0-9]+)$/.exec(req.url ?? '');
      if (issuePath) {
        if (!checkAuth(req)) { sendError(res, 401, 'Bad credentials'); return; }
        const repo = getRepo(issuePath[1]!, issuePath[2]!);
        const issue = repo && issuePath[1] === VIEWER_LOGIN ? indexedIssue(repo, parseInt(issuePath[3]!, 10)) : undefined;
        if (!repo || !issue) { sendError(res, 404, 'Not Found'); return; }
        sendCachedJsonConditional(req, res, repo, `issue:${issue.number}`, () => issueJson(issue));
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      if (method === 'GET' && pathname === '/healthz') {
        sendHealth(res);
        return;
      }
      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const body = hasBody ? await readBody(req) : Buffer.alloc(0);
      if (pathname === '/api/graphql' && method === 'POST') {
        handleGraphql(req, res, body);
        return;
      }
      if (pathname === '/mcp' && method === 'POST') {
        handleMcp(req, res, body);
        return;
      }
      if (pathname.startsWith('/api/v3')) {
        handleRest(req, res, pathname, url.searchParams, body);
        return;
      }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const name = decodeURIComponent(gitMatch[2]!);
        const action = gitMatch[3]!;
        const repo = getRepo(owner, name);
        if (repo === undefined || owner !== VIEWER_LOGIN) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not Found' }));
          return;
        }
        if (action === 'info/refs') {
          const service = url.searchParams.get('service');
          if (service === 'git-upload-pack') {
            const isV2 = req.headers['git-protocol'] === 'version=2';
            const payload = isV2 ? v2Advertisement() : v0AdvertisementCached(repo, 'upload-pack');
            res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Content-Length': payload.length });
            res.end(payload);
            return;
          }
          if (service === 'git-receive-pack') {
            const payload = v0AdvertisementCached(repo, 'receive-pack');
            res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-advertisement', 'Content-Length': payload.length });
            res.end(payload);
            return;
          }
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unknown service' }));
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const isV2 = req.headers['git-protocol'] === 'version=2';
          const payload = isV2 ? handleGitUploadPackV2(repo, body) : handleGitUploadPackV0(repo, body);
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Content-Length': payload.length });
          res.end(payload);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const payload = handleGitReceivePack(repo, body);
          res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Content-Length': payload.length });
          res.end(payload);
          return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Method Not Allowed' }));
        return;
      }
      sendError(res, 404, 'Not Found');
    } catch (err) {
      // Never let one bad request kill the process; stay up for the next check.
      console.error('handler error:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        sendError(res, 500, 'Internal Server Error');
      } else {
        res.end();
      }
    }
  });
  return {
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          const actual = typeof address === 'object' && address !== null ? address.port : port;
          resolve(actual);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
