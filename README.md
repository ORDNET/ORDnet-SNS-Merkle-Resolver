# ORDnet-SNS-Merkle-Resolver

An SNS (web3-name) resolver **without a trusted operator**: it resolves names from
a committed state snapshot and puts a **merkle proof to the on-chain root**
in every answer. Anyone can run it — no indexer, no database, no signing
key — and no one has to believe it, because every answer is math.

```
GET /resolve/info@earthlog.web3
→ { holder_script, origin, current, as_of_height,
    proof: { leaf, path, positions, root, commit_txid, ruleset } }
```

The classic resolver model asks you to trust (or verify) a signature from
one operator. This resolver has **no key at all**: the answer's authority
is the merkle path from the name's leaf to a root that ODNCA has inscribed
on the BSV chain (genesis commit `b65b03f0…e60c6ec9`, height 961546,
651,482 names — see [ODNCA-verify](https://github.com/ORDNET/ODNCA-verify)).
A lying resolver cannot produce a path that folds to the committed root.

**Zero dependencies.** Node ≥ 18. One process, three files.

**Scope: SNS.** This resolver speaks the SNS address grammar
(`name.tld`, `mailbox@name.tld` — exactly one dot, per SNS-NAME-1). The
commitment layer underneath is multi-protocol by design (`sns-commit`,
`opns-commit`), so an OpNS variant — bare names, genesis-lineage
verification — can follow as its own resolver against the `opns-commit`
chain without touching this one.

## The trustless bootstrap

The resolver refuses to be wrong. At startup it:

1. loads the state snapshot (`{"h":<height>,"entries":[…]}`),
2. **recomputes the full merkle root** from all entries,
3. compares it to the configured on-chain commit root — and **refuses to
   serve** on any mismatch.

Consequence: the snapshot's *source* does not matter — ODNCA, a mirror, a
friend, a torrent — only its *root* does. Get the bytes from anywhere;
the chain decides whether they are the committed state.

## Get a snapshot

ODNCA publishes the committed state after every successful commit. These are
plain files on a static host — no account, no API key, no rate limit:

| File | What it is |
|---|---|
| `https://odnca.org/snapshots/sns-latest.json.gz` | the newest committed state, gzipped (~33 MB, ~206 MB unpacked) |
| `https://odnca.org/snapshots/sns-latest.meta.json` | its height, byte size, and the sha256 of both the gzip and the unpacked JSON |
| `https://odnca.org/snapshots/sns-<height>.json.gz` | a specific height; the last 7 are kept |

Bootstrap in five lines:

```bash
curl -sO https://odnca.org/snapshots/sns-latest.json.gz
curl -s  https://odnca.org/snapshots/sns-latest.meta.json    # note sha256_gz and h
sha256sum sns-latest.json.gz                                 # must equal sha256_gz
gunzip -c sns-latest.json.gz > state/sns.json
curl -s  https://odnca.org/commits                           # root + txid for height h
```

Then start the resolver with `RESOLVER_COMMIT_ROOT` set to that root. It
rebuilds the whole tree from the file and **refuses to serve** if the result
does not reproduce it.

That refusal is the reason the download source does not matter. The sha256
above only tells you the bytes survived the wire; the root tells you they are
the state ODNCA actually committed to the chain. A tampered snapshot from
odnca.org itself fails exactly as loudly as one from a stranger — which is the
point.

## Run

```bash
RESOLVER_STATE_FILE=./state/sns.json \
RESOLVER_COMMIT_ROOT=<root from the on-chain commit inscription> \
RESOLVER_COMMIT_TXID=<txid of that inscription> \
node src/server.js
```

| Variable | Default | Meaning |
|---|---|---|
| `RESOLVER_STATE_FILE` | `./state/sns.json` | The state snapshot to serve |
| `RESOLVER_COMMIT_ROOT` | *(empty)* | On-chain root the snapshot must reproduce; empty = serve unanchored (dev only) |
| `RESOLVER_COMMIT_TXID` | *(empty)* | Commit inscription txid, echoed in every proof |
| `RESOLVER_RULESET_HASH` | *(empty)* | Frozen ruleset hash, echoed in every proof |
| `RESOLVER_HOST` / `RESOLVER_PORT` | `127.0.0.1` / `8792` | Listen address |
| `RESOLVER_RATE_LIMIT` | `120` | Per-IP requests per minute |

Snapshots are produced by the commitment pipeline in
[ODNCA-verify/reference-implementation](https://github.com/ORDNET/ODNCA-verify)
(the same export the daily on-chain commits are built from) — or by any
conformant indexer following the published ruleset.

## Routes

| Route | Answer |
|---|---|
| `GET /resolve/<address>` | The proven answer (above); `name.tld` and `mailbox@name.tld` forms per ODNCA-STD-001 §4 |
| `GET /root` | The served root, height, name count, commit anchor |
| `GET /health` | Status incl. the TLD set (derived from the committed state itself) |
| `GET /selftest/<address>` | Server folds its own proof — a liveness check for operators |

Errors are machine-readable per STD-001 §8 (`invalid_address`,
`unknown_tld`, `not_registered`, `rate_limited`).

## What a client verifies

1. **Membership:** fold `proof.leaf` through `proof.path`/`positions`
   (SHA-256, `0x00` leaf / `0x01` node domains) — it must land on
   `proof.root`. Offline, ~10 lines in any language; reference fold in
   [ODNCA-verify](https://github.com/ORDNET/ODNCA-verify).
2. **Anchor:** confirm `proof.commit_txid` exists on-chain and was posted
   by the published commitment wallet.
3. **Liveness:** the snapshot is a committed *photo*, not a live feed —
   check `current.txid:vout` is unspent at any node (STD-001 §9 level 3)
   before treating the holder as current.

Honest by design: a snapshot resolver has no mailbox-alias data, so every
`mailbox@` query resolves to the domain holder with `fallback: true`
disclosed (STD-001 §5).

## Tests

```bash
npm test
```

34 tests on bare Node, including: refusal of a snapshot whose root does not
match the anchor, an **independently reimplemented** proof fold, tamper
detection, non-ASCII exact-byte matching, the frozen canonical leaf
form (`v,name,origin,outpoint,script,pubkey,h`), and a hostile-input suite
that fires malformed percent-escapes at both decoding routes and asserts
the process is still serving afterwards.

## Related

- [ODNCA-verify](https://github.com/ORDNET/ODNCA-verify) — the commitment pipeline and offline certificate verifier
- [ODNCA-standards](https://github.com/ORDNET/ODNCA-standards) — STD-001 (resolution), STD-004 (root registry & commitments)
- [ORDnet-SNS-client](https://github.com/ORDNET/ORDnet-SNS-client) — client library for the signed-answer resolver model

## License

MIT © ORDnet / ODNCA
