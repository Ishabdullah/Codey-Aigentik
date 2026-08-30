// contacts-sync.js — Aigentik Android contacts sync
// Pulls real phone contacts via termux-contact-list
// Merges into Restoricon Core contacts via Core API /api/v1/contacts/sync
//
// Track B Phase B2 cutover: write-through directly to Core API.

import { execSync } from 'child_process';
import config from './config.json' with { type: 'json' };
import log from './logger.js';
import { normalizePhone, coreRequest } from './contacts.js';

let customFetchAndroidContacts = null;

function setFetchAndroidContactsForTest(fn) {
  customFetchAndroidContacts = fn;
}

// Fetch all Android contacts via termux-api
function fetchAndroidContacts() {
  if (customFetchAndroidContacts) {
    return customFetchAndroidContacts();
  }
  try {
    const raw = execSync('termux-contact-list', {
      timeout: 15000,
      encoding: 'utf8'
    });
    const parsed = JSON.parse(raw);
    return parsed.filter(c => c.name && c.number);
  } catch (e) {
    log.error('contacts-sync', 'Failed to fetch Android contacts', { error: e.message });
    return [];
  }
}

// Main sync function — calls Core API /api/v1/contacts/sync
async function syncContacts() {
  log.info('contacts-sync', 'Syncing Android contacts...');

  const androidContacts = fetchAndroidContacts();
  if (!androidContacts || androidContacts.length === 0) {
    log.warn('contacts-sync', 'No Android contacts found');
    return { android: 0, added: 0, updated: 0, total: 0 };
  }

  const payload = androidContacts.map(ac => ({
    name: ac.name,
    phones: [ac.number],
    aliases: [ac.name.toLowerCase()],
    source: 'android_contacts'
  }));

  try {
    const res = await coreRequest('POST', '/api/v1/contacts/sync', {
      body: { contacts: payload }
    });

    if (!res.ok || !res.data?.stats) {
      log.error('contacts-sync', 'Sync request failed', { status: res.status });
      return { android: androidContacts.length, added: 0, updated: 0, total: 0 };
    }

    const stats = res.data.stats;
    log.info('contacts-sync', 'Sync complete', stats);
    return stats;
  } catch (e) {
    log.error('contacts-sync', 'Failed to sync with Core API', { error: e.message });
    return { android: androidContacts.length, added: 0, updated: 0, total: 0 };
  }
}

// Run once on startup only — no auto-interval
// Owner can trigger manual sync by texting "sync contacts"
async function startAutoSync() {
  const result = await syncContacts();
  if (result) {
    log.info('contacts-sync', `Initial sync: ${result.added} new, ${result.updated} updated, ${result.total} total contacts`);
  }
  return result;
}

export { syncContacts, startAutoSync, fetchAndroidContacts, setFetchAndroidContactsForTest };