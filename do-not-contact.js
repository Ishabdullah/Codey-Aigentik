// do-not-contact.js — permanent contact suppression list
// Anyone added here is never auto-replied to, queued, or messaged again by
// Aigentik, on either channel (email or Google Voice/SMS).
//
// B2 task 4 write-through pilot (2026-08-27): this module used to store
// entries in a local data/do-not-contact.json file. It now writes through
// to Restoricon Core's /api/v1/do-not-contact* routes instead — Core is the
// single source of truth, Core-only, with no local-JSON fallback. That's a
// deliberate decision, not an oversight: a defensive fallback where a failed
// Core write silently degrades to a local-only write would mean isBlocked()
// checks against Core could miss an entry only the local file knows about —
// silently failing the one thing this list exists to guarantee (never
// re-contacting someone who opted out). So a failed Core call surfaces as a
// thrown error to the caller instead. See CODEY_MASTER_PLAN.md §6.4 task 4.
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;

// Deterministic phrase match for "stop contacting me" style requests — kept
// out of the LLM (same reasoning as calendar.js's date parsing) so a block
// this consequential never depends on a model guess.
// First-person phrasing only, deliberately — 'unsubscribe'/'opt out' alone
// are already treated as generic marketing-footer boilerplate elsewhere
// (see email-rules.js's PROMO_KEYWORDS), so they're excluded here. A false
// positive on this list is a permanent, silent block, unlike a promotional
// misclassification which is easily reversed — so this list stays narrow.
const OPT_OUT_PHRASES = [
  'remove me from your list', 'remove me from this list', 'take me off your list',
  'take me off this list', 'stop contacting me', 'stop texting me', 'stop emailing me',
  'stop messaging me', 'do not contact me', "don't contact me", 'do not text me',
  "don't text me", 'do not email me', "don't email me", 'do not message me',
  "don't message me", 'never contact me again', "never contact me", 'please stop contacting',
  'unsubscribe me', 'opt me out', 'lose my number', 'lose my contact',
  'remove my number', 'remove my email', 'stop reaching out'
];

// Single choke point for every Core do-not-contact call — resolves the base
// URL/token from config.core_api (Codey-Aigentik's own config-loading
// convention, same static import every other write-site module uses) and
// throws on any non-2xx response or network failure rather than swallowing
// it, per the Core-only decision above.
async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('do-not-contact: config.core_api.base_url/token not configured');
  }
  const url = new URL(urlPath, CORE_API_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CORE_API_TOKEN}`
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    log.error('do-not-contact', 'Core API request failed', { method, path: urlPath, error: e.message });
    throw e;
  }
  let data = null;
  let parseError = null;
  try {
    data = await response.json();
  } catch (e) {
    // A non-JSON/empty body is possible from a misbehaving server on
    // either a success or error status. Left as `data: null` here rather
    // than swallowed, specifically so a 2xx with an unparseable body still
    // surfaces as a clear thrown error from each caller below (via the
    // `parseError` check) instead of an opaque "Cannot read properties of
    // null" from blindly indexing into `data`.
    parseError = e;
  }
  return { status: response.status, ok: response.ok && !parseError, data, parseError };
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  return digits ? digits.slice(-10) : null;
}

function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

// Identify what kind of identifier was given so it's stored/matched
// consistently regardless of which channel it came in on.
function classifyIdentifier(identifier) {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (trimmed.includes('@')) return { type: 'email', value: normalizeEmail(trimmed) };
  const phone = normalizePhone(trimmed);
  if (phone && phone.length === 10) return { type: 'phone', value: phone };
  return null;
}

// Full list of do-not-contact entries from Core. Kept as its own exported
// function (matching the pre-write-through shape) even though nothing
// outside this module currently calls it directly.
async function loadEntries() {
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/do-not-contact');
  if (!ok) throw new Error(`Core do-not-contact list failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return data.do_not_contact || [];
}

// True if this email address or phone number is on the do-not-contact list.
// Classified client-side first (same as before the write-through change) so
// an unclassifiable identifier is rejected without a network round trip —
// Core's own is_blocked() can't distinguish "not on the list" from
// "malformed input" (NEW-221), so this client-side gate is load-bearing,
// not just an optimization.
async function isBlocked(identifier) {
  if (!identifier) return false;
  const classified = classifyIdentifier(identifier);
  if (!classified) return false;
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/do-not-contact/check', {
    query: { identifier }
  });
  if (!ok) throw new Error(`Core do-not-contact check failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return !!data.blocked;
}

// Add an identifier (email or phone) to the permanent block list. Idempotent
// — re-adding an existing entry just refreshes the reason/timestamp (Core's
// add_to_do_not_contact() upserts by type+value).
async function addToDoNotContact({ identifier, name, reason, source }) {
  const classified = classifyIdentifier(identifier);
  if (!classified) return null;

  const { ok, status, data, parseError } = await coreRequest('POST', '/api/v1/do-not-contact', {
    body: {
      identifier,
      name: name || null,
      reason: reason || 'requested removal',
      source: source || 'auto'
    }
  });
  if (status === 400) return null; // Core rejected it as unclassifiable — matches the pre-existing null return
  if (!ok) throw new Error(`Core do-not-contact add failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);

  const entry = data.do_not_contact;
  log.action('do-not-contact', `Added to do-not-contact: ${entry.value}`, { reason: entry.reason, source: entry.source });
  return entry;
}

async function removeFromDoNotContact(identifier) {
  const classified = classifyIdentifier(identifier);
  if (!classified) return false;
  const { ok, status, data, parseError } = await coreRequest('POST', '/api/v1/do-not-contact/remove', {
    body: { identifier }
  });
  if (!ok) throw new Error(`Core do-not-contact remove failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  const removed = !!data.removed;
  if (removed) log.action('do-not-contact', `Removed from do-not-contact: ${classified.value}`);
  return removed;
}

async function listDoNotContact() {
  const entries = await loadEntries();
  if (entries.length === 0) return '🚫 Do-not-contact list is empty.';
  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.name ? e.name + ' — ' : ''}${e.original} (${e.reason})`
  );
  return `🚫 Do-Not-Contact list (${entries.length}):\n` + lines.join('\n');
}

// Deterministic keyword check for opt-out language in an inbound message.
// Pure, no I/O — unchanged by the write-through cutover.
function detectOptOutRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return OPT_OUT_PHRASES.some(phrase => lower.includes(phrase));
}

export {
  isBlocked,
  addToDoNotContact,
  removeFromDoNotContact,
  listDoNotContact,
  detectOptOutRequest,
  loadEntries
};
