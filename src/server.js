// ORDnet Merkle Resolver — resolve web3 names from a committed state
// snapshot, with a merkle proof to the on-chain root in every answer.
//
// The trust model inverts the classic resolver: there is NO signing key.
// At startup the full snapshot is verified against the on-chain committed
// root (recomputed, not trusted); every answer then carries the leaf, the
// merkle path, and the commit anchor — provable by anyone, offline.
//
// Zero dependencies. Node >= 18.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { buildTree, getProof, leafJson, verifyProof } from "./merkle.js";
import { parseAddress } from "./names.js";
import { config } from "./config.js";

/* ------------------------------------------------------------------ *
 * Load + verify the state snapshot (trustless bootstrap)
 * ------------------------------------------------------------------ */

function loadState() {
  const raw = JSON.parse(readFileSync(config.stateFile, "utf8"));
  if (!raw || !Array.isArray(raw.entries) || !Number.isInteger(raw.h)) {
    throw new Error(`state file ${config.stateFile}: expected {"h":<int>,"entries":[...]}`);
  }
  const tree = buildTree(raw.entries);
  const root = tree.root.toString("hex");
  if (config.commitRoot && root !== config.commitRoot.toLowerCase()) {
    throw new Error(
      `STATE REFUSED: recomputed root ${root} does not match the configured ` +
      `on-chain commit root ${config.commitRoot}. The snapshot is not the ` +
      `committed state — obtain a correct one; its source does not matter, its root does.`
    );
  }
  const tlds = new Set();
  for (const e of tree.leaves) {
    const dot = e.name.lastIndexOf(".");
    if (dot > 0) tlds.add(e.name.slice(dot + 1));
  }
  return { tree, h: raw.h, root, tlds, names: tree.leaves.length };
}

console.log(`[resolver] loading state from ${config.stateFile} …`);
const state = loadState();
console.log(
  `[resolver] state VERIFIED: ${state.names} names, h=${state.h}, root=${state.root.slice(0, 16)}…` +
  (config.commitRoot ? ` (matches on-chain commit${config.commitTxid ? " " + config.commitTxid.slice(0, 12) + "…" : ""})` : " (no commit root configured — serving UNANCHORED)")
);

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}
const fail = (res, status, code, message) => json(res, status, { ok: false, error: code, message });

const buckets = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (buckets.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= config.rateLimit) { buckets.set(ip, arr); return true; }
  arr.push(now); buckets.set(ip, arr);
  if (buckets.size > 50_000) buckets.clear();
  return false;
}

/* ------------------------------------------------------------------ *
 * The proven answer
 * ------------------------------------------------------------------ */

function answerFor(parsed) {
  const i = state.tree.index.get(parsed.name);
  if (i === undefined) {
    const dot = parsed.name.lastIndexOf(".");
    const tld = dot > 0 ? parsed.name.slice(dot + 1) : "";
    if (tld && !state.tlds.has(tld)) return { err: [404, "unknown_tld", "TLD not present in the committed namespace"] };
    return { err: [404, "not_registered", "name not in committed state"] };
  }
  const entry = state.tree.leaves[i];
  const { path, positions } = getProof(state.tree, i);
  const [otx, ovout] = entry.origin.split("_");
  const [ctx, cvout] = entry.outpoint.split("_");
  return {
    body: {
      ok: true,
      v: 1,
      name: parsed.name,
      mailbox: parsed.mailbox,
      // A snapshot resolver has no alias data: every mailbox resolves to the
      // domain holder (ODNCA-STD-001 §5) and says so honestly.
      fallback: parsed.mailbox !== null,
      holder_script: entry.script,
      origin: { txid: otx, vout: parseInt(ovout, 10) },
      current: { txid: ctx, vout: parseInt(cvout, 10) },
      as_of_height: state.h,
      proof: {
        leaf: JSON.parse(leafJson(entry)),
        path,
        positions,
        root: state.root,
        commit_txid: config.commitTxid || null,
        ruleset: config.rulesetHash || null,
      },
      note: "verify: fold leaf through path to root; confirm the commit inscription on-chain; check current outpoint unspent for liveness",
    },
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

const server = createServer((req, res) => {
  const ip = req.socket.remoteAddress || "?";
  if (limited(ip)) return fail(res, 429, "rate_limited", "slow down");
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method !== "GET") return fail(res, 405, "method_not_allowed", "GET only");

  if (parts[0] === "health") {
    return json(res, 200, {
      ok: true, service: "ordnet-merkle-resolver", names: state.names,
      h: state.h, root: state.root, commit_txid: config.commitTxid || null,
      anchored: Boolean(config.commitRoot), tlds: [...state.tlds].sort(),
    });
  }

  if (parts[0] === "root") {
    return json(res, 200, {
      ok: true, root: state.root, h: state.h, names: state.names,
      commit_txid: config.commitTxid || null, ruleset: config.rulesetHash || null,
    });
  }

  if (parts[0] === "resolve" && parts.length === 2) {
    const parsed = parseAddress(decodeURIComponent(parts[1]));
    if (!parsed) return fail(res, 400, "invalid_address", "expected name.tld or mailbox@name.tld");
    const r = answerFor(parsed);
    return r.err ? fail(res, ...r.err) : json(res, 200, r.body);
  }

  // Self-check: fold the proof server-side once more before answering.
  if (parts[0] === "selftest" && parts.length === 2) {
    const parsed = parseAddress(decodeURIComponent(parts[1]));
    if (!parsed) return fail(res, 400, "invalid_address", "bad address");
    const r = answerFor(parsed);
    if (r.err) return fail(res, ...r.err);
    const p = r.body.proof;
    const ok = verifyProof(p.leaf, p.path, p.positions, p.root);
    return json(res, 200, { ok, name: parsed.name, folds_to_root: ok });
  }

  return fail(res, 404, "not_found", "routes: /resolve/<address>, /root, /health, /selftest/<address>");
});

server.listen(config.port, config.host, () => {
  console.log(`[resolver] listening on ${config.host}:${config.port}`);
});
