// Zero-dependency test suite for the ORDnet Merkle Resolver.
//   node test/run-tests.js
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildTree, leafJson } from "../src/merkle.js";
import { parseAddress } from "../src/names.js";

let passed = 0;
const failed = [];
const check = (name, cond) => {
  if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed.push(name); console.log(`FAIL  ${name}`); }
};
const sha256 = (b) => createHash("sha256").update(b).digest();

/* ------------------------------------------------------------ *
 * Fixture state (5 names, odd count exercises node promotion)
 * ------------------------------------------------------------ */
const H = 961546;
const mk = (name, n) => ({
  name,
  origin: `${"a".repeat(63)}${n}_0`,
  outpoint: `${"b".repeat(63)}${n}_0`,
  script: `76a914${String(n).repeat(2).padStart(2, "0").repeat(20).slice(0, 40)}88ac`,
  pubkey: "",
  h: H,
});
const entries = [mk("ordnet.web3", 1), mk("earthlog.web3", 2), mk("alex.bitcoin", 3), mk("café.web3", 4), mk("spiek.web3", 5)];
const tree = buildTree(entries);
const ROOT = tree.root.toString("hex");

mkdirSync("/tmp/mr-test", { recursive: true });
writeFileSync("/tmp/mr-test/state.json", JSON.stringify({ h: H, entries }));

/* ------------------------------------------------------------ *
 * 1. Startup: trustless bootstrap
 * ------------------------------------------------------------ */
console.log("\n[bootstrap]");

function boot(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["src/server.js"], {
      env: { ...process.env, RESOLVER_STATE_FILE: "/tmp/mr-test/state.json", RESOLVER_PORT: "18792", ...env },
    });
    let out = "";
    const done = (code) => resolve({ p, out, code });
    p.stdout.on("data", (d) => { out += d; if (out.includes("listening")) done(null); });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => done(code));
    setTimeout(() => done("timeout"), 5000);
  });
}

// wrong root -> refuse to serve
const bad = await boot({ RESOLVER_COMMIT_ROOT: "00".repeat(32) });
check("snapshot with non-matching root is REFUSED at startup", bad.code !== null && /STATE REFUSED/.test(bad.out));

// correct root -> serves
const srv = await boot({ RESOLVER_COMMIT_ROOT: ROOT, RESOLVER_COMMIT_TXID: "c".repeat(64) });
check("snapshot matching the anchor boots and serves", srv.code === null && /state VERIFIED/.test(srv.out));

const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:18792${path}`);
  return { status: res.status, body: await res.json() };
};

/* ------------------------------------------------------------ *
 * 2. Proven answers
 * ------------------------------------------------------------ */
console.log("\n[resolve]");
let r = await get("/resolve/ordnet.web3");
check("registered name resolves", r.status === 200 && r.body.ok === true);
check("answer carries holder_script + current outpoint", /^76a914/.test(r.body.holder_script) && /^b+1$/.test(r.body.current.txid.replace(/b/g, "b")));
check("answer carries the commit anchor", r.body.proof.root === ROOT && r.body.proof.commit_txid === "c".repeat(64));
check("as_of_height is the commit height", r.body.as_of_height === H);

// Independent fold — reimplemented here, NOT imported from src.
function foldIndependently(proof) {
  let acc = sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(proof.leaf), "utf8")]));
  for (let i = 0; i < proof.path.length; i++) {
    const sib = Buffer.from(proof.path[i], "hex");
    acc = proof.positions[i] === "L"
      ? sha256(Buffer.concat([Buffer.from([1]), sib, acc]))
      : sha256(Buffer.concat([Buffer.from([1]), acc, sib]));
  }
  return acc.toString("hex");
}
check("proof folds to the root in an INDEPENDENT implementation", foldIndependently(r.body.proof) === ROOT);

const tampered = JSON.parse(JSON.stringify(r.body.proof));
tampered.leaf.script = "76a914" + "00".repeat(20) + "88ac";
check("tampered holder script no longer folds to the root", foldIndependently(tampered) !== ROOT);

r = await get("/resolve/caf%C3%A9.web3");
check("non-ASCII name resolves on exact bytes", r.status === 200 && r.body.name === "café.web3");

r = await get("/resolve/info@earthlog.web3");
check("mailbox resolves to domain holder with fallback disclosed", r.body.ok === true && r.body.fallback === true && r.body.mailbox === "info");

r = await get("/resolve/ORDNET.WEB3");
check("ASCII case-insensitive per STD-001 normalization", r.status === 200 && r.body.name === "ordnet.web3");

r = await get("/resolve/sns%3Aordnet.web3");
check("sns: scheme accepted and stripped", r.status === 200);

/* ------------------------------------------------------------ *
 * 3. Errors
 * ------------------------------------------------------------ */
console.log("\n[errors]");
r = await get("/resolve/niemand.web3");
check("unknown name -> 404 not_registered", r.status === 404 && r.body.error === "not_registered");
r = await get("/resolve/naam.nergens");
check("TLD outside the committed namespace -> unknown_tld", r.status === 404 && r.body.error === "unknown_tld");
r = await get("/resolve/a@b@c.web3");
check("double @ -> 400 invalid_address", r.status === 400 && r.body.error === "invalid_address");

/* ------------------------------------------------------------ *
 * 4. Meta routes + self test
 * ------------------------------------------------------------ */
console.log("\n[meta]");
r = await get("/health");
check("health reports names, height, root, anchored", r.body.names === 5 && r.body.h === H && r.body.root === ROOT && r.body.anchored === true);
check("health derives the TLD set from the committed state", r.body.tlds.join(",") === "bitcoin,web3");
r = await get("/root");
check("root route serves the anchor", r.body.root === ROOT);
r = await get("/selftest/spiek.web3");
check("server-side selftest folds its own proof", r.body.folds_to_root === true);

/* ------------------------------------------------------------ *
 * 5. Hostile input must never take the process down  (K3)
 * ------------------------------------------------------------ */
console.log("\n[survives hostile input]");

// A raw fetch that tolerates a dead server, so a crash shows up as a
// failed assertion instead of an unhandled rejection in the test run.
const rawGet = async (path) => {
  try {
    const res = await fetch(`http://127.0.0.1:18792${path}`);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body is fine here */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  }
};

// The exact request from the audit: decodeURIComponent used to throw here,
// and an uncaught throw in a Node request handler kills the process.
r = await rawGet("/resolve/%ZZ");
check("malformed percent-escape returns 400 instead of crashing", r.status === 400 && r.body?.error === "invalid_address");

check("server is STILL ALIVE after the malformed escape", (await rawGet("/health")).status === 200);

// The same family of malformed input, on both decoding routes.
for (const [label, path] of [
  ["lone percent", "/resolve/%"],
  ["truncated escape", "/resolve/%E0%A4"],
  ["invalid hex digits", "/resolve/%GG.web3"],
  ["percent at end", "/resolve/name.web3%"],
  ["overlong surrogate", "/resolve/%ED%A0%80"],
  ["malformed on selftest route", "/selftest/%ZZ"],
]) {
  r = await rawGet(path);
  check(`${label} -> 4xx, no crash`, r.status >= 400 && r.status < 500);
}

check("server is STILL ALIVE after the whole malformed batch", (await rawGet("/health")).status === 200);

// Absurd input must be refused cheaply rather than parsed.
r = await rawGet("/resolve/" + "a".repeat(5000) + ".web3");
check("over-long address is rejected", r.status === 400);
check("server is STILL ALIVE after the over-long address", (await rawGet("/health")).status === 200);

// Valid percent-encoding must keep working exactly as before.
r = await rawGet("/resolve/caf%C3%A9.web3");
check("valid percent-encoding still decodes correctly", r.status === 200 && r.body.name === "café.web3");

// A route that decodes but is not an address is a 400, not a 500.
r = await rawGet("/resolve/%2F%2F%2F");
check("decodable but non-address input is a clean 400", r.status === 400);

/* ------------------------------------------------------------ *
 * 6. Canonical leaf form stays frozen
 * ------------------------------------------------------------ */
console.log("\n[frozen leaf form]");
check("leaf JSON key order is v,name,origin,outpoint,script,pubkey,h",
  Object.keys(JSON.parse(leafJson(entries[0]))).join(",") === "v,name,origin,outpoint,script,pubkey,h");
check("parseAddress agrees with the SNS client rules", parseAddress("Info@EarthLog.web3").address === "info@earthlog.web3");

srv.p.kill();
console.log(`\nRESULT: ${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
