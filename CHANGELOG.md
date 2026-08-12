# Changelog — ORDnet SNS Merkle Resolver

All notable changes to the snapshot resolver.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.1] — 2026-08-11 — security release

### Security

- **A single malformed GET could terminate the process.** `decodeURIComponent`
  on a path segment sat outside any try/catch, so `/resolve/%ZZ` raised a
  `URIError` that became an uncaught exception. Without a supervisor the
  resolver stayed down; with one it rebuilt the merkle tree on every restart.
  Guarded on both decoding routes, the whole handler now runs inside one
  try/catch, and process-level nets keep this read-only service serving.
  See [SECURITY-FIXES-v1.0.1.md](SECURITY-FIXES-v1.0.1.md).

### Added

- Hostile-input test suite: tests go from 21 to 34, and assert the server is
  still answering `/health` after each batch of malformed requests.
- `SECURITY.md`.

### Unchanged

- `merkle.js`, `names.js` and `config.js`. Answers are byte-identical to 1.0.0.

---

## [1.0.0] — 2026-08 — initial public release

Zero-dependency snapshot resolver with no signing key: it rebuilds the merkle
root from the snapshot and refuses to serve when that root does not match the
on-chain commit. Every answer carries a merkle proof.
