// email-rules.js — Aigentik email rule engine v1.1
// Supports: from, domain, subject_contains, body_contains, promotional, any
// Default action when no rule matches: auto-reply
//
// B2 task 4 write-through (2026-08-27): this module used to store rules in
// a local data/email-rules.json file. It now writes through to Restoricon
// Core's /api/v1/automation-rules* routes instead (channel=email) — Core
// is the single source of truth, Core-only, no local-JSON fallback, same
// throw-on-failure shape the do-not-contact.js pilot already established
// (see CODEY_MASTER_PLAN.md §6.4 task 4 for the full reasoning: rules are
// config, not per-message safety state, but a hidden Core/local divergence
// is still worth avoiding, and a thrown error on outage is an existing,
// already-reviewed failure mode this module inherits rather than
// introduces). The condition-type matching logic (`checkRules`'s switch,
// `isPromotional`) is pure, no I/O, and stays local/synchronous unchanged.
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CHANNEL = 'email';
const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;

// Every real rule fetch requests a high limit rather than relying on
// list_rules's default limit=100 — at 2 real rules today this is
// invisible, but a future 101st rule must not go silently inert.
const LIST_LIMIT = 1000;

// Common promotional/marketing keywords for auto-detection
const PROMO_KEYWORDS = [
  'unsubscribe', 'opt-out', 'opt out', 'marketing', 'newsletter',
  'promotion', 'offer', 'deal', 'discount', 'sale', 'click here',
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notifications@', 'updates@', 'news@', 'info@', 'hello@',
  'mailing list', 'email preferences', 'manage your'
];

// Single choke point for every Core automation-rules call — mirrors
// do-not-contact.js's coreRequest() exactly (single choke point,
// AbortSignal.timeout, throw on non-2xx or network failure, no
// local-JSON fallback). Duplicated per-module rather than shared, matching
// the existing pattern (do-not-contact.js already keeps its own copy;
// there is no shared HTTP helper module in this codebase to extract into).
async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('email-rules: config.core_api.base_url/token not configured');
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
    log.error('email-rules', 'Core API request failed', { method, path: urlPath, error: e.message });
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

// Full list of email rules from Core, newest-first (Core's list_rules
// preserves addRule's pre-write-through "newest rule wins" precedence via
// `ORDER BY id DESC` — a pinned contract, not incidental, see the
// rule-precedence test in tests/email-rules.test.js).
async function loadRules() {
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/automation-rules', {
    query: { channel: CHANNEL, limit: LIST_LIMIT }
  });
  if (!ok) throw new Error(`Core automation-rules list failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return data.automation_rules || [];
}

async function addRule({ description, condition_type, condition_value, action, added_by }) {
  const externalId = `er_${Date.now()}`;
  const { ok, status, data, parseError } = await coreRequest('POST', '/api/v1/automation-rules', {
    body: {
      external_id: externalId,
      channel: CHANNEL,
      description,
      condition_type,
      condition_value: condition_value || '',
      action,
      added_by: added_by || 'owner'
    }
  });
  if (!ok) throw new Error(`Core automation-rules create failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  const rule = data.automation_rule;
  log.info('email-rules', `Rule added: ${description}`, { action });
  return rule;
}

async function removeRule(identifier) {
  const rules = await loadRules();
  const idx = rules.findIndex(r =>
    r.id === identifier ||
    r.external_id === identifier ||
    (r.description || '').toLowerCase().includes(identifier.toLowerCase())
  );
  if (idx === -1) return false;
  const removed = rules[idx];
  const { ok, status, data, parseError } = await coreRequest('POST', `/api/v1/automation-rules/${removed.id}/delete`);
  if (!ok) throw new Error(`Core automation-rules delete failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  if (data.deleted) log.info('email-rules', `Rule removed: ${removed.description}`);
  return !!data.deleted;
}

// Detect if email looks promotional
function isPromotional(email) {
  const combined = [
    email.from || '',
    email.subject || '',
    email.body?.substring(0, 500) || ''
  ].join(' ').toLowerCase();
  return PROMO_KEYWORDS.some(kw => combined.includes(kw));
}

// Check email against all rules
// Returns { action, rule, reason }
async function checkRules(email) {
  const rules = await loadRules();
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const body = (email.body || '').toLowerCase();

  for (const rule of rules) {
    const val = (rule.condition_value || '').toLowerCase();
    let matched = false;

    switch (rule.condition_type) {
      case 'from':
        matched = from.includes(val);
        break;
      case 'domain':
        matched = from.includes(`@${val}`) || from.includes(val);
        break;
      case 'subject_contains':
        matched = subject.includes(val);
        break;
      case 'body_contains':
        matched = body.includes(val);
        break;
      case 'promotional':
        matched = isPromotional(email);
        break;
      case 'any':
        matched = from.includes(val) || subject.includes(val) || body.includes(val);
        break;
      // NEW-228: no `message_contains` case here, deliberately. A
      // pre-existing production rule uses that condition_type and has
      // never matched anything since it was created — this must survive
      // the write-through cutover unchanged, not be "fixed" here (see
      // CODEY_MASTER_PLAN.md §6.4 task 4's NEW-228 note).
    }

    if (matched) {
      const { ok, status, data, parseError } = await coreRequest('POST', `/api/v1/automation-rules/${rule.id}/match`);
      if (!ok) throw new Error(`Core automation-rules match failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
      log.info('email-rules', `Rule matched: "${rule.description}" → ${rule.action}`);
      return { action: rule.action, rule, reason: rule.description };
    }
  }

  const defaultAction = config.behavior?.default_unmatched_action || 'auto-reply';
  log.debug('email-rules', `No rule matched for email from ${email.from} — default: ${defaultAction}`);
  return { action: defaultAction, rule: null, reason: 'default' };
}

async function listRulesForSms() {
  const rules = await loadRules();
  if (rules.length === 0) {
    return '📋 No email rules set.\n\nExamples:\n"spam all emails from amazon.com"\n"auto-reply to emails from boss@company.com"\n"delete emails with subject containing newsletter"';
  }
  const lines = [`📋 Email Rules (${rules.length}):\n`];
  rules.forEach((r, i) => {
    const icon = r.action === 'auto-reply' ? '↩️' : r.action === 'spam' ? '🚫' : r.action === 'delete' ? '🗑' : r.action === 'archive' ? '📦' : '👁';
    lines.push(`${i + 1}. ${icon} [${r.action.toUpperCase()}] ${r.description}`);
  });
  lines.push(`\nDefault for unmatched: ${config.behavior?.default_unmatched_action || 'auto-reply'}`);
  return lines.join('\n');
}

export { addRule, removeRule, checkRules, listRulesForSms, loadRules, isPromotional };
