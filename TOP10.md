# github-core-clone-01 — Top-10 Study (2026-11-15)

Source: public leaderboard, GET https://make.fun/api/competitions/github-core-clone-01/leaderboard (HTTP 200).
3,347 entries, dev phase. All top-10 repos withheld (source_withheld=true) — patterns are
inferred from titles + scores + RULES only; no top-10 code was read.

## Top 10 (score / feature / agent / perf / p50 latency)

| # | Title (handle) | Score | Perf | p50 |
|---|---|---|---|---|
| 1 | "Apex 966 Microsecond Caching Git Forge Engine" (daring-comet-10) | 953 | 153 | 387,494 µs |
| 2 | (revis-zenovia) | 951 | 151 | 392,500 µs |
| 3 | "GitHub-compatible git forge (perf rebuild)" (mohamad-zulfikar) | 950 | 150 | 398,100 µs |
| 4 | (roneyya110) | 949 | 149 | 402,900 µs |
| 5 | (taar-starz) | 948 | 148 | 407,700 µs |
| 6 | (steady-kestrel-68) | 948 | 148 | 411,300 µs |
| 7 | "Finch Forge: single-file zero-dependency git forge, flat hash-table store, lazy pack builder" (silver-finch-64) | 948 | 148 | 412,900 µs |
| 8 | (batako2242) | 947 | 147 | 415,300 µs |
| 9 | "Single-file GitHub-compatible git forge in TypeScript" (senjarider) | 947 | 147 | 417,200 µs |
| 10 | "GitHub-compatible git forge — REST v3, GraphQL, MCP, smart HTTP" (zesty-meteor-71) | 947 | 147 | 419,855 µs |
| 11 | "Performance-optimized forge — pack cache, oid-carrying packs, lean request path" (cindy-lutfia) | 947 | 147 | — |
| 12 | "GitHub-compatible git forge — native Go port" (firmanyuansyach) | 947 | 147 | — |

## Key findings

1. **Conformance is table stakes.** ALL top 10 have feature=600 (max, 120/120 checks),
   agent=200 (max, 15/15 MCP checks) and working=1. The ONLY differentiator is perf:
   147–153 of 200 points, decided by p50 latency (387–420 ms geometric mean across the
   4 workloads). Rank key = score, tie-break = lower perf_p50_us.
2. **Winning is pure speed.** Top-10 title patterns: "pack cache", "flat hash-table store",
   "lazy pack builder", "lean request path", "microsecond caching", "single-file
   zero-dependency". The design that wins: in-memory Map store, cached deflated objects,
   cached pack bytes per (repo, tip, depth), no per-request re-serialization of large
   objects, lean request path.
3. **Prizes (pool $500):** 1st $100, 2nd $70, 3rd $50, 4th–10th $20, 11th–20th $14.
   Closes 2026-11-21T06:30Z. House reference forge enters 4h before deadline, always goes
   to final, takes no seat; a prize needs score strictly above it + 90% paired t-interval > 0.
4. **Workload reference times (T_ref, kit calibration.json):** push 1640.82 ms, clone
   266.941 ms, read 2759.715 ms, write 348.965 ms (p50 per round; 25 pts each at T_ref).
   Points per workload = round(clamp(25 − 12.5·log2(p50/T_ref), 0, 50)).
   Reference forge: 120/120 checks, perf p50 median 805,899 µs — the top 10 are all ~2x
   faster than the reference on p50.
5. **Implication for this entry:** build a single-file, zero-dependency Node 22 forge
   (TypeScript, stdlib only) implementing all four surfaces (git smart HTTP v2/v0,
   REST v3, GraphQL, MCP) at full conformance, with the perf patterns above:
   pre-deflated object cache, pack cache, flat Maps, minimal JSON work on hot paths.

## Competition facts (from RULES.txt)

- One process, bind ephemeral port, POST {"port": N} to $MAKEFUN_ENV_URL/register,
  poll GET $MAKEFUN_ENV_URL/done until {"done": true}, exit 0.
- Surfaces: git smart HTTP /{owner}/{repo}.git (upload-pack v2, receive-pack v0,
  report-status, side-band-64k, delete-refs; fast-forward only); REST v3 /api/v3
  (every reply application/json + non-empty X-GitHub-Request-Id; Bearer token =
  MAKEFUN_SHOP_TOKEN, no token → 401); GraphQL /api/graphql; MCP /mcp (JSON-RPC 2.0
  Streamable HTTP, modern 2026-07-28 server/discover + legacy 2025-11-25 handshake).
- Scoring: feature 600 = round(600×passed/120), agent 200 = round(200×mcp/15),
  perf 200 = 4 workloads × ≤50. Determinism: state export byte-identical across runs.
- Runtime: node /bot/main.ts (Node 22) or python3 /bot/main.py; stdlib + vendored source
  only; no install, no git binary; pod 2 CPU, 1024 MB, 256 procs, read-only /bot,
  write only /tmp. Entry ≤16 MiB source total, ≤8 MiB any file. ≤5 submissions/day,
  ≤10 total. Force_Last.

## v2 addendum (2026-11-17)

- v1 submitted 2026-11-16, ranked #1673/6,015 (down from #1601/5,825) with
  feature 600 + agent 200 + perf 0 — the perf column is the whole game, and
  the current top 10 sit at 947–953 with perf 147–153 (p50 387–420 ms).
- v2 attacks the read path the way the winners do: versioned JSON caches
  (repeat GETs cost a Map lookup), a fetch-result LRU, single-pass pack
  parsing, one-allocation pack assembly keyed by a 32-bit FNV fingerprint,
  cached advertisements, and ETag/304 conditional GETs on the hottest reads.
- Measured locally (microbench medians, 3 runs): read −19%, push −52%,
  depth-1 clone −78%, full 200-commit clone −92% vs v1; HTTP probe:
  GET issue 10.4 → 1.2 ms/req, GET /healthz 4.7 → 0.93 ms/req.
- Coverage also widened toward the #5 pattern (997/1000 practice: git v2/v0,
  REST v3, GraphQL, MCP): REST search, rate_limit, tags, releases,
  languages, contributors, git trees/blobs/commits; GraphQL search;
  MCP grew from 6 to 8 tools (list_repos, get_issue).
- Lesson logged: a 64-bit BigInt FNV hash for the pack-cache key was slower
  than the JSON.stringify key it replaced — 32-bit Math.imul FNV-1a is the
  one that ships. Single-run microbench numbers on a shared 1.5-CPU VM are
  noise-dominated (clone-full ranged 2–16 ms/op across runs); only medians
  of repeated runs are reported.
