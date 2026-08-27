// sms-rules.js — Aigentik SMS rule engine
// Checks incoming SMS against saved rules
// Returns: auto-reply, review, spam, or no-match
//
// B2 task 4 write-through (2026-08-27): this module used to store rules in
// a local data/sms-rules.json file. It now writes through to Restoricon
// Core's /api/v1/automation-rules* routes instead (channel=sms) — Core is
// the single source of truth, Core-only, no local-JSON fallback, same
// throw-on-failure shape the do-not-contact.js pilot already established
// (see CODEY_MASTER_PLAN.md §6.4 task 4). The condition-type matching
// logic (`checkRules`'s switch) is pure, no I/O, and stays local/
// synchronous unchanged. email-rules.js is this module's structural twin
// (both convert together per that task's spec — a partial conversion
// would leave one channel silently divergent from the other's cutover
// state) — differs only in RULES_FILE-equivalent (channel), id prefix
// (sr_), and the extra `message_contains` condition_type case, which is
// real for this channel (unlike email-rules.js's NEW-228 dead rule).
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CHANNEL = 'sms';
const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;

// Every real rule fetch requests a high limit rather than relying on
// list_rules's default limit=100 — at 0 real rules today this is
// invisible, but a future 101st rule must not go silently inert.
const LIST_LIMIT = 1000;

// Single choke point for every Core automation-rules call — mirrors
// do-not-contact.js's/email-rules.js's coreRequest() exactly. Duplicated
// per-module rather than shared, matching the existing pattern (there is
// no shared HTTP helper module in this codebase to extract into).
async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('sms-rules: config.core_api.base_url/token not configured');
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
    log.error('sms-rules', 'Core API request failed', { method, path: urlPath, error: e.message });
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

// Full list of SMS rules from Core, newest-first (Core's list_rules
// preserves addRule's pre-write-through "newest rule wins" precedence via
// `ORDER BY id DESC` — a pinned contract, not incidental).
async function loadRules() {
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/automation-rules', {
    query: { channel: CHANNEL, limit: LIST_LIMIT }
  });
  if (!ok) throw new Error(`Core automation-rules list failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return data.automation_rules || [];
}

async function addRule({ description, condition_type, condition_value, action, added_by }) {
  const externalId = `sr_${Date.now()}`;
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
  log.info('sms-rules', `Rule added: ${description}`, { action });
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
  if (data.deleted) log.info('sms-rules', `Rule removed: ${removed.description}`);
  return !!data.deleted;
}

async function checkRules(sms) {
  const rules = await loadRules();
  const { address, body } = sms;
  const addressNorm = (address || '').replace(/[^0-9]/g, '').slice(-10);
  const bodyLower = (body || '').toLowerCase();

  for (const rule of rules) {
    const val = (rule.condition_value || '').toLowerCase();
    const valNorm = val.replace(/[^0-9]/g, '').slice(-10);
    let matched = false;

    switch (rule.condition_type) {
      case 'from_number':
        matched = addressNorm === valNorm || addressNorm.includes(valNorm);
        break;
      case 'message_contains':
        matched = bodyLower.includes(val);
        break;
      case 'any':
        matched = bodyLower.includes(val) || addressNorm.includes(valNorm);
        break;
    }

    if (matched) {
      const { ok, status, data, parseError } = await coreRequest('POST', `/api/v1/automation-rules/${rule.id}/match`);
      if (!ok) throw new Error(`Core automation-rules match failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);

      log.info('sms-rules', `Rule matched: "${rule.description}" → ${rule.action}`, {
        from: address
      });
      return { action: rule.action, rule };
    }
  }

  const defaultAction = config.behavior?.default_unmatched_sms_action || 'auto-reply';
  log.debug('sms-rules', `No rule matched for SMS from ${address} — defaulting to ${defaultAction}`);
  return { action: defaultAction, rule: null };
}

async function listRulesForSms() {
  const rules = await loadRules();
  if (rules.length === 0) return '📋 No SMS rules set yet.\n\nText: "add sms rule [description]" to add one.';
  const lines = [`📋 SMS Rules (${rules.length}):\n`];
  rules.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.action.toUpperCase()}] ${r.description}`);
  });
  return lines.join('\n');
}

export { addRule, removeRule, checkRules, listRulesForSms, loadRules };
