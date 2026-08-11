# Security Policy

## Reporting a vulnerability

Please report security issues privately first. Do not open a public issue
for anything that could take a running resolver down or cause it to serve
an answer that does not fold to the committed root.

**Preferred channel:** [GitHub private vulnerability reporting](https://github.com/ORDNET/ORDnet-SNS-Merkle-Resolver/security/advisories/new)
— the "Report a vulnerability" button on the Security tab of this
repository. This creates a private advisory only the maintainers can see.

Please include what the issue is, which file and line, how to reproduce it,
and what an attacker gains.

## What to expect

- **Acknowledgement:** within 3 working days.
- **Assessment:** within 10 working days.
- **Credit:** we will name you in the release notes unless you prefer
  otherwise.

We do not currently operate a bug bounty.

## Threat model

This resolver has **no signing key** and serves read-only data. The two
things that matter:

1. **Availability.** It holds a large in-memory tree that is expensive to
   rebuild, so a single request must never be able to end the process. Any
   input that crashes it is a vulnerability, however malformed that input is.
2. **Answer integrity.** Every answer carries a merkle path to the root the
   resolver recomputed at startup. An answer that does not fold to that root,
   or a way to make the resolver serve a snapshot whose root does not match
   the configured on-chain commit, is a vulnerability.

Out of scope: the correctness of the snapshot's *contents* (that is the
indexer's and the commitment's problem — the resolver's job is to prove the
snapshot reproduces the anchored root, not to judge what the anchor says),
and third-party services an operator puts in front of it.

## Known history

Version 1.0.0 could be terminated by a single unauthenticated GET request:
`decodeURIComponent` on a path segment sat outside any try/catch, so a
malformed percent-escape such as `/resolve/%ZZ` raised a `URIError` that
became an uncaught exception. Without a supervisor the resolver stayed down;
with one it entered a restart loop, rebuilding the full tree each time.

Fixed in **1.0.1**. Anyone running 1.0.0 should upgrade. See
[SECURITY-FIXES-v1.0.1.md](SECURITY-FIXES-v1.0.1.md).
