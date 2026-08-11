// ORDnet Merkle Resolver — configuration (all via env vars).
export const config = {
  // The state snapshot: {"h":<height>,"entries":[{name,origin,outpoint,script,pubkey?,h}...]}
  stateFile: process.env.RESOLVER_STATE_FILE || "./state/sns.json",

  // The on-chain anchor this snapshot must reproduce. With commitRoot set,
  // the resolver REFUSES to serve a snapshot whose recomputed root differs.
  commitRoot: process.env.RESOLVER_COMMIT_ROOT || "",
  commitTxid: process.env.RESOLVER_COMMIT_TXID || "",
  rulesetHash: process.env.RESOLVER_RULESET_HASH || "",

  host: process.env.RESOLVER_HOST || "127.0.0.1",
  port: parseInt(process.env.RESOLVER_PORT || "8792", 10),
  rateLimit: parseInt(process.env.RESOLVER_RATE_LIMIT || "120", 10),
};
