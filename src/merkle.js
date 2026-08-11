// Merkle core for SNS state commitments (spec File B §1).
// - canonical leaf JSON (fixed key order, no whitespace)
// - leaves sorted bytewise by name
// - SHA256 with domain separation: leaf 0x00, node 0x01
// - odd node at a level is PROMOTED (not duplicated)
import { createHash } from "node:crypto";

const sha256 = (buf) => createHash("sha256").update(buf).digest();

/** Canonical leaf serialization — key order is part of the protocol. */
export function leafJson(entry) {
  const { name, origin, outpoint, script, pubkey = "", h } = entry;
  for (const [k, v] of Object.entries({ name, origin, outpoint, script })) {
    if (typeof v !== "string" || v.length === 0) throw new Error(`leaf missing ${k}`);
  }
  if (!Number.isInteger(h)) throw new Error("leaf missing height");
  return JSON.stringify({ v: 1, name, origin, outpoint, script, pubkey, h });
}

export const leafHash = (entry) =>
  sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(leafJson(entry), "utf8")]));

const nodeHash = (left, right) =>
  sha256(Buffer.concat([Buffer.from([0x01]), left, right]));

/**
 * Build the full tree from state entries.
 * Returns { root, leaves, levels, index } where:
 *  - leaves: entries sorted bytewise by name (the canonical order)
 *  - levels: array of hash arrays, levels[0] = leaf hashes ... top = [root]
 *  - index: Map name -> position in leaves
 */
export function buildTree(entries) {
  if (!entries.length) throw new Error("empty state");
  const leaves = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8")));
  const index = new Map();
  leaves.forEach((e, i) => {
    if (index.has(e.name)) throw new Error(`duplicate name in state: ${e.name}`);
    index.set(e.name, i);
  });

  const levels = [leaves.map(leafHash)];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i + 1 < prev.length; i += 2) next.push(nodeHash(prev[i], prev[i + 1]));
    if (prev.length % 2 === 1) next.push(prev[prev.length - 1]); // promote
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], leaves, levels, index };
}

/**
 * Proof for the leaf at position i.
 * positions: one char per path element — 'L' = sibling is LEFT of the
 * running hash, 'R' = sibling is RIGHT. Promoted (odd) nodes add nothing.
 */
export function getProof(tree, i) {
  const path = [];
  let positions = "";
  let pos = i;
  for (let lvl = 0; lvl < tree.levels.length - 1; lvl++) {
    const level = tree.levels[lvl];
    const isRight = pos % 2 === 1;
    const sibling = isRight ? pos - 1 : pos + 1;
    if (sibling < level.length) {
      path.push(level[sibling].toString("hex"));
      positions += isRight ? "L" : "R";
    } // else: promoted node, no sibling this level
    pos = Math.floor(pos / 2);
  }
  return { path, positions };
}

/** Fold a proof; returns true iff it lands exactly on rootHex. */
export function verifyProof(entry, path, positions, rootHex) {
  if (!Array.isArray(path) || typeof positions !== "string" || path.length !== positions.length) return false;
  let acc;
  try { acc = leafHash(entry); } catch { return false; }
  for (let i = 0; i < path.length; i++) {
    if (!/^[0-9a-f]{64}$/i.test(path[i])) return false;
    const sib = Buffer.from(path[i], "hex");
    if (positions[i] === "L") acc = nodeHash(sib, acc);
    else if (positions[i] === "R") acc = nodeHash(acc, sib);
    else return false;
  }
  return acc.toString("hex") === String(rootHex).toLowerCase();
}

/** Canonical commit-inscription content (spec File B §2).
 *  Protocol-scoped: sns -> "sns-commit", opns -> "opns-commit", ... */
export function commitJson({ proto = "sns", root, h, names, ruleset, prev }) {
  return JSON.stringify({ p: `${proto}-commit`, v: 1, root, h, names, ruleset, prev: prev ?? null });
}
