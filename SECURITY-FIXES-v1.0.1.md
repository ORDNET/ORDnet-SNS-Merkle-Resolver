# Security fixes — ORDnet SNS Merkle Resolver v1.0.1

**Released:** 11 August 2026
**Supersedes:** v1.0.0

## K3 — A single GET request terminated the process

**Was**, in `src/server.js`:

```js
if (parts[0] === "resolve" && parts.length === 2) {
  const parsed = parseAddress(decodeURIComponent(parts[1]));
  ...
```

`decodeURIComponent` raises a `URIError` on a malformed percent-escape —
`%ZZ`, a lone `%`, a truncated multi-byte escape. That call sat outside any
`try/catch`, and in Node an uncaught throw inside a request handler becomes
an `uncaughtException`, which ends the process.

Reproduced against a running instance:

```
-- normal request --   200
-- request with %ZZ -- 000
-- afterwards --       000  (connection refused)

URIError: URI malformed
    at Server.<anonymous> (.../src/server.js:142:33)
[process terminated]
```

Without a supervisor the resolver stayed down. With one it entered a restart
loop, rebuilding the merkle tree over the full name set on every cycle.

The identical call was present on the `/selftest/` route.

**Now:**

```
-- normal request --   200
-- request with %ZZ -- 400  {"ok":false,"error":"invalid_address", ...}
-- afterwards --       200
-- 20 more malformed requests, then --  200
```

## What changed, precisely

Four things, in `src/server.js`:

1. **`safeDecode(segment)`** replaces the bare `decodeURIComponent` on both
   routes. It returns `null` instead of throwing, and callers treat that as
   a malformed address — which is what it is. It also refuses input longer
   than 2100 characters, since SNS-NAME-1 caps a name at 2048 bytes; absurd
   input is now rejected before it is parsed rather than after.

2. **The whole handler runs inside one `try/catch`.** The route logic moved
   into a `handle(req, res)` function, and `createServer` now calls it inside
   a try/catch that answers `500 internal_error` and keeps the process alive.
   This is the structural fix: the specific `decodeURIComponent` bug is
   closed by point 1, but *nothing* in a request handler may be able to
   escape, including bugs not yet found.

3. **`new URL(req.url, "http://x")` is guarded** and the method check moved
   ahead of it, so an unparseable request target is a clean `400`.

4. **Process-level nets:** a `clientError` handler for malformed HTTP below
   the request layer, plus `uncaughtException` and `unhandledRejection`
   handlers that log loudly and keep serving. Deliberate for this service:
   it is read-only, it already verified its snapshot against the anchor at
   startup, and the in-memory tree is expensive to rebuild — staying up beats
   a restart loop. Anything caught there is a bug and says so in the log.

Also: `x-content-type-options: nosniff` on every response.

`src/merkle.js`, `src/names.js` and `src/config.js` are **unchanged**. The
proof format, the leaf serialisation and the address grammar are untouched,
so answers from 1.0.1 are byte-identical to answers from 1.0.0.

## Tests

`npm test` — **34 tests**, up from 21. The new section fires malformed
percent-escapes at both decoding routes (lone `%`, truncated escape, invalid
hex, trailing `%`, overlong surrogate) and, critically, asserts after each
batch that the server still answers `/health` with 200. A regression that
reintroduces the crash fails the suite instead of passing it silently.

## Where this pattern may live elsewhere

The crash itself is HTTP-server-specific, so it does not exist in code that
has no request handler. But the *class* of bug — an unguarded call that can
throw on hostile input, in a place where a throw is fatal or user-visible —
travels. Worth grepping for in any codebase that shares this lineage:

```bash
grep -rn "decodeURIComponent\|decodeURI(" --include="*.js" --include="*.ts" .
```

Any hit that is not already wrapped in a `try/catch` — or fed by a value
that cannot be attacker-controlled — deserves a look. The two questions to
ask at each one: *can hostile input reach this?* and *what happens when it
throws?*

For the resolver the answer was "yes" and "the process dies". In a browser
or a wallet the same call throwing usually means a rejected navigation or a
broken UI rather than a crash, so the severity differs — but the fix is the
same three lines.
