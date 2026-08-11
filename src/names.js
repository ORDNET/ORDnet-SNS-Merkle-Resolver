// Address normalization — ODNCA-STD-001 §4.1–4.2 (same code as ORDnet-SNS-client).
const SCHEME_RE = /^(sns:|ordns:|web3:\/\/|ord:\/\/)/i
const ASCII_RE = /^[\x00-\x7F]*$/

const lowerAsciiOnly = (s) => (ASCII_RE.test(s) ? s.toLowerCase() : s)

/* ------------------------------------------------------------------ *
 * Parsing — STD-001 §4.1–4.2
 * ------------------------------------------------------------------ */

/**
 * Parse a candidate address (`name.tld` or `mailbox@name.tld`).
 * Returns { address, name, mailbox, tld } or null when the shape is not an
 * SNS address at all. Never throws. Non-ASCII is matched on exact UTF-8
 * bytes — no Unicode normalization, ever (STD-001 §10).
 */
export function parseAddress (raw) {
  let s = String(raw || '').trim()
  s = s.replace(SCHEME_RE, '').replace(/^@/, '').replace(/\/.*$/, '').trim()
  if (!s || /\s/.test(s)) return null
  const at = s.indexOf('@')
  if (at !== s.lastIndexOf('@')) return null
  let mailbox = null
  let name = s
  if (at > -1) {
    mailbox = s.slice(0, at)
    name = s.slice(at + 1)
    if (!mailbox || !name) return null
  }
  const dot = name.indexOf('.')
  if (dot <= 0 || dot !== name.lastIndexOf('.') || dot === name.length - 1) return null
  const label = lowerAsciiOnly(name.slice(0, dot))
  const tld = name.slice(dot + 1).toLowerCase()
  const canonical = `${label}.${tld}`
  const mb = mailbox === null ? null : lowerAsciiOnly(mailbox)
  return {
    address: mb === null ? canonical : `${mb}@${canonical}`,
    name: canonical,
    mailbox: mb,
    tld
  }
}

