/**
 * Model-code match keys — the small, shared core of every code comparison.
 *
 * All matching is directional: we test `retailerText.includes(key)`. That breaks
 * when our catalog code is MORE specific than what the retailer displays, because
 * the longer catalog string is never a substring of the shorter retail one.
 *
 * The common offender is the 2-letter MARKET PREFIX that Samsung (and some other
 * MEA electronics) put in front of the panel code — QA/UA (Asia-MEA), QE/UE
 * (Europe), QN/UN (North America). Egyptian retailers routinely drop it, listing
 * `55Q70C` for our catalog's `QA55Q70C`, so `55q70c`.includes(`qa55q70c`) is false
 * and the product silently misses on every site.
 *
 * codeKeys() therefore returns each code as one or more normalized keys — the full
 * code plus, when a market prefix is present, the prefix-stripped core. Matchers
 * accept a hit on ANY key. The core still carries size+series(+suffix), so it stays
 * cousin-safe: a different model never shares it.
 */

/** Lowercase and strip everything but [a-z0-9] — the canonical code form. */
export function normCode(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A leading market prefix: [Q|U] (QLED|LED) + [A|E|N] (Asia-MEA|Europe|N.America),
// but only when it sits in front of the size digits — a genuine series-first code
// (e.g. 55QN80F) starts with the size, so this never strips a real series.
const MARKET_PREFIX = /^[qu][aen](?=\d)/;

/**
 * Normalized match keys for a model code, most-specific first.
 * Always includes the full normalized code; adds the market-prefix-stripped core
 * when one applies and the core is still specific enough (>= 5 chars) to be safe.
 */
export function codeKeys(modelCode: string): string[] {
  const full = normCode(modelCode);
  const keys = [full];
  const core = full.replace(MARKET_PREFIX, "");
  if (core !== full && core.length >= 5 && !keys.includes(core)) keys.push(core);
  return keys;
}

/** True when any of the code's keys is a substring of the (raw) haystack. */
export function matchesAnyKey(haystack: string, keys: string[]): boolean {
  const h = normCode(haystack);
  return keys.some((k) => h.includes(k));
}
