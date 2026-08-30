// contacts.js — Aigentik contact memory system
// Builds and maintains a growing directory of contacts
//
// Track B Phase B2 cutover: this module used to store contacts in
// data/contacts.json. It now writes through to Restoricon Core's
// /api/v1/contacts* routes — Core is the single source of truth,
// Core-only, with no local-JSON fallback.

import config from './config.json' with { type: 'json' };
import log from './logger.js';
import { normalizeTrade } from './trades.js';

const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;
const LIST_LIMIT = 1000;

// ─── HTTP Core API Helpers ──────────────────────────────────────────────────

async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('contacts: config.core_api.base_url/token not configured');
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
    log.error('contacts', 'Core API request failed', { method, path: urlPath, error: e.message });
    throw e;
  }
  let data = null;
  let parseError = null;
  try {
    data = await response.json();
  } catch (e) {
    parseError = e;
  }
  return { status: response.status, ok: response.ok && !parseError, data, parseError };
}

// Explicit Mapping between Core API and JS model
function mapCoreToJS(coreObj) {
  if (!coreObj) return null;
  const jsObj = { ...coreObj };
  jsObj.id = coreObj.external_id || (coreObj.id ? `contact_${String(coreObj.id).padStart(4, '0')}` : null);
  jsObj._core_id = coreObj.id;
  jsObj.aliases = coreObj.aliases || [];
  jsObj.phones = coreObj.phones || [];
  jsObj.emails = coreObj.emails || [];
  jsObj.roles = coreObj.roles || [];
  jsObj.references = coreObj.references || [];
  jsObj.history = coreObj.history || [];

  const boolFields = ['licensed', 'gl_insurance', 'wc_insurance', 'has_tools'];
  for (const field of boolFields) {
    if (coreObj[field] === 1 || coreObj[field] === true) jsObj[field] = true;
    else if (coreObj[field] === 0 || coreObj[field] === false) jsObj[field] = false;
    else jsObj[field] = null;
  }
  return jsObj;
}

function mapJSToCore(jsObj) {
  if (!jsObj) return null;
  const coreObj = { ...jsObj };
  if (jsObj.id && typeof jsObj.id === 'string' && jsObj.id.startsWith('contact_')) {
    coreObj.external_id = jsObj.id;
  }
  const boolFields = ['licensed', 'gl_insurance', 'wc_insurance', 'has_tools'];
  for (const field of boolFields) {
    if (jsObj[field] === true) coreObj[field] = 1;
    else if (jsObj[field] === false) coreObj[field] = 0;
    else if (jsObj[field] === null) coreObj[field] = null;
  }
  return coreObj;
}

// Normalize phone number to last 10 digits for comparison
function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/[^0-9]/g, '').slice(-10);
}

// Normalize email to lowercase
function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

// Find a contact by ID, phone, email, or name via Core API
async function findContact(identifier) {
  if (!identifier) return null;
  try {
    const res = await coreRequest('GET', '/api/v1/contacts/find', {
      query: { q: identifier }
    });
    if (res.status === 404 || !res.data?.contact) return null;
    if (!res.ok) {
      log.error('contacts', 'findContact error', { identifier, status: res.status });
      return null;
    }
    return mapCoreToJS(res.data.contact);
  } catch (e) {
    log.error('contacts', 'findContact failed', { identifier, error: e.message });
    return null;
  }
}

// Find a contact by its exact id
async function getContactById(id) {
  if (!id) return null;
  try {
    const res = await coreRequest('GET', `/api/v1/contacts/${encodeURIComponent(id)}`);
    if (res.status === 404 || !res.data?.contact) return null;
    if (!res.ok) {
      log.error('contacts', 'getContactById error', { id, status: res.status });
      return null;
    }
    return mapCoreToJS(res.data.contact);
  } catch (e) {
    log.error('contacts', 'getContactById failed', { id, error: e.message });
    return null;
  }
}

// Load contacts from Core API
async function loadContacts() {
  try {
    const res = await coreRequest('GET', '/api/v1/contacts', {
      query: { limit: LIST_LIMIT }
    });
    if (!res.ok || !res.data?.contacts) return [];
    return res.data.contacts.map(mapCoreToJS);
  } catch (e) {
    log.warn('contacts', 'Could not load contacts from Core API', { error: e.message });
    return [];
  }
}

// Save contacts (no-op warning under write-through)
function saveContacts(contacts) {
  log.warn('contacts', 'saveContacts called under write-through architecture — operations persist directly to Core API');
}

// Which of `required` (any of 'name','email','phone','address') this
// contact doesn't have yet
function getMissingFields(contact, required) {
  if (!contact) return [...required];
  return required.filter(f => {
    if (f === 'name') return !contact.name;
    if (f === 'email') return !(contact.emails?.length);
    if (f === 'phone') return !(contact.phones?.length);
    if (f === 'address') return !contact.address;
    return false;
  });
}

// Apply LLM-extracted { name, email, phone, address } onto a contact
async function applyExtractedDetails(id, extracted) {
  const updates = {};
  if (extracted?.name) updates.name = extracted.name;
  if (extracted?.email) updates.emails = extracted.email;
  if (extracted?.phone) updates.phones = extracted.phone;
  if (extracted?.address) updates.address = extracted.address;
  if (Object.keys(updates).length === 0) return null;
  return await updateContact(id, updates);
}

// Apply a parsed subcontractor application onto a contact
async function applySubcontractorDetails(id, parsed) {
  if (!parsed) return null;
  const updates = { type: 'subcontractor' };
  if (parsed.business_name) updates.business_name = parsed.business_name;
  if (parsed.trade) updates.trade = parsed.trade;
  if (parsed.trade_raw) updates.trade_raw = parsed.trade_raw;
  if (parsed.principal_name) updates.name = parsed.principal_name;
  if (parsed.phone) updates.phones = [parsed.phone].flat();
  if (parsed.email) updates.emails = [parsed.email].flat();
  if (parsed.licensed !== null && parsed.licensed !== undefined) updates.licensed = parsed.licensed;
  if (parsed.license_number) updates.license_number = parsed.license_number;
  if (parsed.gl_insurance !== null && parsed.gl_insurance !== undefined) updates.gl_insurance = parsed.gl_insurance;
  if (parsed.wc_insurance !== null && parsed.wc_insurance !== undefined) updates.wc_insurance = parsed.wc_insurance;
  if (parsed.has_tools !== null && parsed.has_tools !== undefined) updates.has_tools = parsed.has_tools;
  if (parsed.crew_size != null) updates.crew_size = parsed.crew_size;
  if (parsed.weekly_capacity) updates.weekly_capacity = parsed.weekly_capacity;
  if (parsed.references?.length) updates.references = parsed.references;
  return await updateContact(id, updates);
}

// Subcontractors on file whose trade matches a freeform query
async function findSubcontractorsByTrade(tradeQuery) {
  if (!tradeQuery) return [];
  const norm = normalizeTrade(tradeQuery);
  const q = tradeQuery.toLowerCase().trim();
  const allContacts = await loadContacts();
  return allContacts.filter(c => {
    if (c.type !== 'subcontractor') return false;
    if (norm && c.trade === norm) return true;
    if (c.trade_raw && c.trade_raw.toLowerCase().includes(q)) return true;
    return false;
  });
}

// Trade/license/insurance/crew block appended to a subcontractor's contact info
function formatSubcontractorDetails(contact) {
  if (!contact || contact.type !== 'subcontractor') return '';
  const lines = [];
  if (contact.business_name) lines.push('🏢 Business: ' + contact.business_name);
  if (contact.trade_raw || contact.trade) lines.push('🛠️ Trade: ' + (contact.trade_raw || contact.trade));
  if (contact.licensed !== null && contact.licensed !== undefined) {
    lines.push('📄 Licensed: ' + (contact.licensed ? 'Yes' + (contact.license_number ? ' (#' + contact.license_number + ')' : '') : 'No'));
  }
  if (contact.gl_insurance !== null && contact.gl_insurance !== undefined) lines.push('🛡️ GL Insurance: ' + (contact.gl_insurance ? 'Yes' : 'No'));
  if (contact.wc_insurance !== null && contact.wc_insurance !== undefined) lines.push('🛡️ WC Insurance: ' + (contact.wc_insurance ? 'Yes' : 'No'));
  if (contact.has_tools !== null && contact.has_tools !== undefined) lines.push('🧰 Own tools/crew: ' + (contact.has_tools ? 'Yes' : 'No'));
  if (contact.crew_size != null) lines.push('👷 Crew size: ' + contact.crew_size);
  if (contact.weekly_capacity) lines.push('🗓️ Capacity: ' + contact.weekly_capacity);
  if (contact.references?.length) lines.push('📇 References: ' + contact.references.map(r => r.raw || r).join('; '));
  return lines.join('\n');
}

// Find contact by relationship label
async function findByRelationship(relationship) {
  if (!relationship) return null;
  const allContacts = await loadContacts();
  const rel = relationship.toLowerCase().trim();
  return allContacts.find(c => c.relationship?.toLowerCase() === rel) || null;
}

// Create a new contact
async function createContact({ name, phones, emails, relationship, type, notes, source, ...extra }) {
  const contactPayload = mapJSToCore({
    name: name || null,
    phones: phones ? [phones].flat().filter(Boolean) : [],
    emails: emails ? [emails].flat().filter(Boolean) : [],
    relationship: relationship || null,
    type: type || 'unknown',
    notes: notes || null,
    instructions: null,
    reply_behavior: 'auto',
    roles: type === 'subcontractor' ? ['SUBCONTRACTOR'] : ['CUSTOMER'],
    active_role: type === 'subcontractor' ? 'SUBCONTRACTOR' : 'CUSTOMER',
    source: source || 'auto',
    first_seen: new Date().toISOString(),
    last_contact: new Date().toISOString(),
    contact_count: 1,
    history: [],
    ...extra
  });

  const res = await coreRequest('POST', '/api/v1/contacts', { body: contactPayload });
  if (!res.ok || !res.data?.contact) {
    throw new Error(`contacts: createContact failed with status ${res.status}`);
  }

  const created = mapCoreToJS(res.data.contact);
  log.info('contacts', `New contact created: ${name || phones || emails}`, { id: created.id });
  return created;
}

// Update an existing contact with new info
async function updateContact(id, updates) {
  if (!id) return null;
  const existing = await getContactById(id);
  if (!existing) {
    log.warn('contacts', `Contact not found for update: ${id}`);
    return null;
  }

  const coreUpdates = {};

  if (updates.phones) {
    const existingPhones = existing.phones || [];
    const newPhones = [updates.phones].flat().filter(Boolean);
    const merged = [...existingPhones];
    newPhones.forEach(p => {
      if (!merged.some(ep => normalizePhone(ep) === normalizePhone(p))) {
        merged.push(p);
      }
    });
    coreUpdates.phones = merged;
  }

  if (updates.emails) {
    const existingEmails = existing.emails || [];
    const newEmails = [updates.emails].flat().filter(Boolean);
    const merged = [...existingEmails];
    newEmails.forEach(e => {
      if (!merged.some(ee => normalizeEmail(ee) === normalizeEmail(e))) {
        merged.push(e);
      }
    });
    coreUpdates.emails = merged;
  }

  if (updates.aliases) {
    const existingAliases = existing.aliases || [];
    const newAliases = [updates.aliases].flat().filter(Boolean);
    const merged = [...existingAliases];
    newAliases.forEach(a => {
      if (!merged.includes(a)) merged.push(a);
    });
    coreUpdates.aliases = merged;
  }

  if (updates.name && (!existing.name || updates.forceName)) coreUpdates.name = updates.name;
  if (updates.relationship) coreUpdates.relationship = updates.relationship;
  if (updates.type) coreUpdates.type = updates.type;
  if (updates.roles) {
    const existingRoles = new Set(existing.roles || []);
    [updates.roles].flat().filter(Boolean).forEach(r => existingRoles.add(r));
    coreUpdates.roles = Array.from(existingRoles);
  }
  if (updates.active_role) coreUpdates.active_role = updates.active_role;
  if (updates.notes) coreUpdates.notes = updates.notes;
  if (updates.address) coreUpdates.address = updates.address;
  if (updates.business_name) coreUpdates.business_name = updates.business_name;
  if (updates.trade) coreUpdates.trade = updates.trade;
  if (updates.trade_raw) coreUpdates.trade_raw = updates.trade_raw;
  if (updates.licensed !== undefined) coreUpdates.licensed = updates.licensed ? 1 : 0;
  if (updates.license_number) coreUpdates.license_number = updates.license_number;
  if (updates.gl_insurance !== undefined) coreUpdates.gl_insurance = updates.gl_insurance ? 1 : 0;
  if (updates.wc_insurance !== undefined) coreUpdates.wc_insurance = updates.wc_insurance ? 1 : 0;
  if (updates.has_tools !== undefined) coreUpdates.has_tools = updates.has_tools ? 1 : 0;
  if (updates.crew_size != null) coreUpdates.crew_size = updates.crew_size;
  if (updates.weekly_capacity) coreUpdates.weekly_capacity = updates.weekly_capacity;
  if (updates.references) coreUpdates.references = updates.references;
  if (updates.instructions) coreUpdates.instructions = updates.instructions;
  if (updates.reply_behavior) coreUpdates.reply_behavior = updates.reply_behavior;
  if (updates.history) coreUpdates.history = updates.history;

  coreUpdates.last_contact = updates.last_contact || new Date().toISOString();
  coreUpdates.contact_count = (existing.contact_count || 0) + 1;

  const res = await coreRequest('POST', `/api/v1/contacts/${encodeURIComponent(id)}/update`, {
    body: coreUpdates
  });
  if (!res.ok || !res.data?.contact) {
    log.error('contacts', `updateContact failed for ${id}`, { status: res.status });
    return null;
  }

  const updated = mapCoreToJS(res.data.contact);
  log.debug('contacts', `Contact updated: ${id}`, { updates: Object.keys(updates) });
  return updated;
}

// Delete a contact entirely
async function deleteContact(identifier) {
  if (!identifier) return false;
  const contact = (await getContactById(identifier)) || (await findContact(identifier)) || (await findByRelationship(identifier));
  if (!contact) return false;

  const res = await coreRequest('POST', `/api/v1/contacts/${encodeURIComponent(contact.id)}/delete`);
  if (!res.ok) {
    log.error('contacts', `deleteContact failed for ${identifier}`, { status: res.status });
    return false;
  }
  log.info('contacts', `Contact deleted: ${contact.name || contact.id}`, { id: contact.id });
  return true;
}

// Explicitly overwrite a contact's name
async function renameContact(identifier, newName) {
  const contact = (await getContactById(identifier)) || (await findContact(identifier)) || (await findByRelationship(identifier));
  if (!contact) return null;

  const res = await coreRequest('POST', `/api/v1/contacts/${encodeURIComponent(contact.id)}/update`, {
    body: { name: newName }
  });
  if (!res.ok || !res.data?.contact) return null;
  log.info('contacts', `Contact renamed to ${newName}`, { id: contact.id });
  return mapCoreToJS(res.data.contact);
}

// Add a history entry to a contact
async function addHistory(identifier, historyEntry) {
  const contact = (await getContactById(identifier)) || (await findContact(identifier));
  if (!contact) return;

  const history = contact.history ? [...contact.history] : [];
  history.push({
    ...historyEntry,
    timestamp: new Date().toISOString()
  });
  const slicedHistory = history.length > 50 ? history.slice(-50) : history;

  await updateContact(contact.id, {
    history: slicedHistory,
    last_contact: new Date().toISOString()
  });
}

// Process extracted entities and update/create contacts automatically
async function processEntities(entities, source) {
  if (!entities) return;

  const names = entities.names || [];
  const phones = entities.phones || [];
  const emails = entities.emails || [];
  const businesses = entities.businesses || [];
  const relationships = entities.relationships || [];

  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    let contact = await findContact(phone);
    if (!contact) {
      await createContact({
        name: names[i] || null,
        phones: phone,
        relationship: relationships[i] || null,
        type: 'unknown',
        source
      });
    } else {
      await updateContact(contact.id, {
        phones: phone,
        ...(names[i] ? { aliases: names[i] } : {}),
        ...(relationships[i] ? { relationship: relationships[i] } : {})
      });
    }
  }

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    let contact = await findContact(email);
    if (!contact) {
      await createContact({
        name: names[i] || null,
        emails: email,
        relationship: relationships[i] || null,
        type: 'person',
        source
      });
    } else {
      await updateContact(contact.id, {
        emails: email,
        ...(names[i] ? { aliases: names[i] } : {}),
        ...(relationships[i] ? { relationship: relationships[i] } : {})
      });
    }
  }

  for (const biz of businesses) {
    let contact = await findContact(biz);
    if (!contact) {
      await createContact({
        name: biz,
        type: 'business',
        source
      });
    }
  }
}

// Get a formatted contact summary for display
function formatContact(contact) {
  if (!contact) return 'Unknown contact';
  const parts = [];
  if (contact.name) parts.push(contact.name);
  if (contact.relationship) parts.push(`(${contact.relationship})`);
  if (contact.phones?.length) parts.push(`📱 ${contact.phones[0]}`);
  if (contact.emails?.length) parts.push(`✉️ ${contact.emails[0]}`);
  if (contact.type !== 'unknown') {
    const tradeSuffix = contact.type === 'subcontractor' && (contact.trade_raw || contact.trade)
      ? `: ${contact.trade_raw || contact.trade}` : '';
    parts.push(`[${contact.type}${tradeSuffix}]`);
  }
  return parts.join(' ') || contact.id;
}

// List all contacts as a summary
async function listContacts() {
  const allContacts = await loadContacts();
  if (allContacts.length === 0) return 'No contacts saved yet.';
  return allContacts.map(c => formatContact(c)).join('\n');
}

// Find or create contact by phone
async function findOrCreateByPhone(phone, additionalInfo = {}) {
  let contact = await findContact(phone);
  if (!contact) {
    contact = await createContact({
      phones: phone,
      type: additionalInfo.type || 'unknown',
      name: additionalInfo.name || null,
      relationship: additionalInfo.relationship || null,
      source: 'sms'
    });
  }
  return contact;
}

// Find or create contact by email
async function findOrCreateByEmail(email, name, additionalInfo = {}) {
  let contact = await findContact(email);
  if (!contact) {
    contact = await createContact({
      emails: email,
      name: name || null,
      type: 'person',
      relationship: additionalInfo.relationship || null,
      source: 'email'
    });
  } else if (name && !contact.name) {
    contact = await updateContact(contact.id, { name });
  }
  return contact;
}

// Set instructions for how to handle a specific contact
async function setContactInstructions(identifier, instructions, behavior) {
  const contact = (await getContactById(identifier)) || (await findContact(identifier)) || (await findByRelationship(identifier));
  if (!contact) return null;

  const updates = {};
  if (instructions) updates.instructions = instructions;
  if (behavior) updates.reply_behavior = behavior;

  const res = await updateContact(contact.id, updates);
  log.info('contacts', 'Contact instructions updated', { id: contact.id, instructions, behavior });
  return res;
}

// Find ALL contacts matching a name — for disambiguation
async function findAllByName(name) {
  const allContacts = await loadContacts();
  const nameLower = name.toLowerCase().trim();
  return allContacts.filter(c =>
    c.name?.toLowerCase().includes(nameLower) ||
    c.aliases?.some(a => a.toLowerCase().includes(nameLower))
  );
}

// Format contact info for SMS display
function formatContactInfo(contact) {
  const lines = [];
  if (contact.name) lines.push('👤 ' + contact.name);
  if (contact.relationship) lines.push('🔗 ' + contact.relationship);
  if (contact.phones?.length) lines.push('📱 ' + contact.phones.join(', '));
  if (contact.emails?.length) lines.push('✉️ ' + contact.emails.join(', '));
  if (contact.address) lines.push('🏠 ' + contact.address);
  if (contact.notes) lines.push('📝 ' + contact.notes);
  const subDetails = formatSubcontractorDetails(contact);
  if (subDetails) lines.push(subDetails);
  return lines.join('\n');
}

export {
  findContact,
  getContactById,
  getMissingFields,
  applyExtractedDetails,
  applySubcontractorDetails,
  findSubcontractorsByTrade,
  formatSubcontractorDetails,
  findByRelationship,
  findAllByName,
  createContact,
  updateContact,
  deleteContact,
  renameContact,
  addHistory,
  processEntities,
  formatContact,
  formatContactInfo,
  listContacts,
  findOrCreateByPhone,
  findOrCreateByEmail,
  loadContacts,
  saveContacts,
  normalizePhone,
  normalizeEmail,
  setContactInstructions,
  coreRequest,
  mapCoreToJS,
  mapJSToCore
};