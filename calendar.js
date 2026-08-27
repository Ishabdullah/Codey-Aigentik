// calendar.js — Aigentik self-hosted appointment calendar
// No external calendar API/OAuth — Aigentik is the source of truth for
// appointments, pushed to real calendars via .ics invite emails
// (see email-provider.js).
//
// B2 task 4 write-through (2026-08-27): this module used to store
// appointments in data/calendar.json and schedule config in data/schedule-config.json.
// It now writes through to Restoricon Core's /api/v1/appointments* and
// /api/v1/schedule-config routes instead — Core is the single source of truth,
// Core-only, with no local-JSON fallback.

import * as chrono from 'chrono-node';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CORE_API_BASE_URL = config.core_api?.base_url;
const CORE_API_TOKEN = config.core_api?.token;
const LIST_LIMIT = 1000;

// Fully open by default (all 7 days, 00:00-23:59) — Aigentik doesn't know your
// real availability until you tell it, so it shouldn't invent a 9-5 Mon-Fri
// assumption on your behalf. Narrow it down with "set working hours ...".
const OPEN_DAY = { start: '00:00', end: '23:59' };
const DEFAULT_SCHEDULE_CONFIG = {
  working_hours: {
    sun: { ...OPEN_DAY }, mon: { ...OPEN_DAY }, tue: { ...OPEN_DAY }, wed: { ...OPEN_DAY },
    thu: { ...OPEN_DAY }, fri: { ...OPEN_DAY }, sat: { ...OPEN_DAY }
  },
  default_duration_minutes: 30,
  buffer_minutes: 15,
  booking_window_days: 365,
  duration_by_relationship: {}
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ─── HTTP Core API Helpers ──────────────────────────────────────────────────

async function coreRequest(method, urlPath, { query, body } = {}) {
  if (!CORE_API_BASE_URL || !CORE_API_TOKEN) {
    throw new Error('calendar: config.core_api.base_url/token not configured');
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
    log.error('calendar', 'Core API request failed', { method, path: urlPath, error: e.message });
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

function mapCoreToJS(core) {
  if (!core) return null;
  return {
    id: core.external_id || (core.id ? `appt_${String(core.id).padStart(4, '0')}` : null),
    _core_id: core.id,
    uid: core.uid || (core.external_id ? `${core.external_id}@aigentik.local` : null),
    ics_sequence: core.ics_sequence || 0,
    title: core.title || '',
    start: core.start_time || null,
    end: core.end_time || null,
    contact_id: core.contact_external_id || (core.customer_id ? String(core.customer_id) : null),
    attendee_name: core.attendee_name || null,
    attendee_email: core.attendee_email || null,
    appointment_type: core.appointment_type || null,
    status: core.status || 'confirmed',
    rsvp_status: core.rsvp_status || 'pending',
    pending_reschedule: core.pending_reschedule || null,
    form_sent: Boolean(core.form_sent),
    offered_slots: core.offered_slots || [],
    requested_datetime: core.requested_datetime || null,
    created_via: core.created_via || 'owner',
    notes: core.notes || null,
    created_at: core.created_at || null,
    updated_at: core.updated_at || null,
    history: core.history || []
  };
}

function mapJSToCore(js) {
  if (!js) return null;
  const core = {
    external_id: js.id || null,
    uid: js.uid || null,
    ics_sequence: js.ics_sequence || 0,
    title: js.title || '',
    start_time: js.start ? new Date(js.start).toISOString() : null,
    end_time: js.end ? new Date(js.end).toISOString() : null,
    contact_external_id: js.contact_id ? String(js.contact_id) : null,
    attendee_name: js.attendee_name || null,
    attendee_email: js.attendee_email || null,
    appointment_type: js.appointment_type || null,
    status: js.status || 'confirmed',
    rsvp_status: js.rsvp_status || 'pending',
    pending_reschedule: js.pending_reschedule || null,
    form_sent: js.form_sent ? 1 : 0,
    offered_slots: js.offered_slots || [],
    requested_datetime: js.requested_datetime || null,
    created_via: js.created_via || 'owner',
    notes: js.notes || null,
    history: js.history || []
  };
  if (js.customer_id) core.customer_id = js.customer_id;
  return core;
}

// ─── Storage (Core API) ─────────────────────────────────────────────────────

async function loadCalendar() {
  const { ok, status, data, parseError } = await coreRequest('GET', '/api/v1/appointments', {
    query: { limit: LIST_LIMIT }
  });
  if (!ok) throw new Error(`Core appointments list failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return (data.appointments || []).map(mapCoreToJS);
}

async function loadScheduleConfig() {
  try {
    const { ok, status, data } = await coreRequest('GET', '/api/v1/schedule-config');
    if (ok && data?.schedule_config) {
      return { ...DEFAULT_SCHEDULE_CONFIG, ...data.schedule_config };
    }
    if (status === 404) {
      return { ...DEFAULT_SCHEDULE_CONFIG };
    }
  } catch (e) {
    log.warn('calendar', 'Could not load schedule config from Core, using defaults', { error: e.message });
  }
  return { ...DEFAULT_SCHEDULE_CONFIG };
}

async function saveScheduleConfig(scheduleConfig) {
  const { ok, status, data, parseError } = await coreRequest('POST', '/api/v1/schedule-config', {
    body: {
      working_hours: scheduleConfig.working_hours,
      default_duration_minutes: scheduleConfig.default_duration_minutes,
      buffer_minutes: scheduleConfig.buffer_minutes,
      booking_window_days: scheduleConfig.booking_window_days,
      duration_by_relationship: scheduleConfig.duration_by_relationship
    }
  });
  if (!ok) throw new Error(`Core schedule-config save failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return data.schedule_config;
}

// ─── Working hours / duration rules ────────────────────────────────────────

async function getDurationForRelationship(relationship, scheduleConfig) {
  const configObj = scheduleConfig || await loadScheduleConfig();
  if (relationship) {
    const rel = relationship.toLowerCase().trim();
    if (configObj.duration_by_relationship?.[rel]) {
      return configObj.duration_by_relationship[rel];
    }
  }
  return configObj.default_duration_minutes;
}

async function setWorkingHours(days, start, end) {
  const scheduleConfig = await loadScheduleConfig();
  days.forEach(day => {
    const key = day.toLowerCase().slice(0, 3);
    if (DAY_KEYS.includes(key)) {
      scheduleConfig.working_hours[key] = { start, end };
    }
  });
  await saveScheduleConfig(scheduleConfig);
  log.info('calendar', 'Working hours updated', { days, start, end });
  return scheduleConfig.working_hours;
}

async function setDayOff(days) {
  const scheduleConfig = await loadScheduleConfig();
  days.forEach(day => {
    const key = day.toLowerCase().slice(0, 3);
    if (DAY_KEYS.includes(key)) {
      scheduleConfig.working_hours[key] = null;
    }
  });
  await saveScheduleConfig(scheduleConfig);
  return scheduleConfig.working_hours;
}

async function setDurationForRelationship(relationship, minutes) {
  const scheduleConfig = await loadScheduleConfig();
  scheduleConfig.duration_by_relationship[relationship.toLowerCase().trim()] = minutes;
  await saveScheduleConfig(scheduleConfig);
  log.info('calendar', `Appointment duration set for ${relationship}: ${minutes}min`);
  return scheduleConfig;
}

async function formatWorkingHours(scheduleConfig) {
  const configObj = scheduleConfig || await loadScheduleConfig();
  const lines = DAY_KEYS.filter(k => k !== 'sun' || true).map(key => {
    const label = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' }[key];
    const hours = configObj.working_hours?.[key];
    return `${label}: ${hours ? `${hours.start}-${hours.end}` : 'off'}`;
  });
  return lines.join(', ');
}

// ─── Natural-language phrase parsing (deterministic, no LLM date math) ────

function parseDatetimePhrase(phrase, anchorDate) {
  if (!phrase) return null;
  const result = chrono.parseDate(phrase, anchorDate ? new Date(anchorDate) : new Date(), { forwardDate: true });
  return result || null;
}

function parseDatetimeDetailed(phrase, anchorDate) {
  if (!phrase) return null;
  const results = chrono.parse(phrase, anchorDate ? new Date(anchorDate) : new Date(), { forwardDate: true });
  if (results.length === 0) return null;
  const start = results[0].start;
  const hasExplicitDate = start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month');
  return { date: start.date(), hasExplicitDate };
}

function combineTimeWithDate(timeOnlyDate, anchorDate) {
  const combined = new Date(anchorDate);
  combined.setHours(timeOnlyDate.getHours(), timeOnlyDate.getMinutes(), 0, 0);
  return combined;
}

const DAY_NAME_TO_KEY = {
  sunday: 'sun', sun: 'sun', monday: 'mon', mon: 'mon', tuesday: 'tue', tue: 'tue', tues: 'tue',
  wednesday: 'wed', wed: 'wed', thursday: 'thu', thu: 'thu', thurs: 'thu',
  friday: 'fri', fri: 'fri', saturday: 'sat', sat: 'sat'
};
const DAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function extractDaysFromPhrase(lower) {
  if (/weekday/.test(lower)) return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (/weekend/.test(lower)) return ['sat', 'sun'];

  const dayNamesPattern = Object.keys(DAY_NAME_TO_KEY).sort((a, b) => b.length - a.length).join('|');
  const dayRangeRegex = new RegExp(`\\b(${dayNamesPattern})\\b\\s*(?:through|to|-)\\s*\\b(${dayNamesPattern})\\b`);
  const rangeMatch = lower.match(dayRangeRegex);
  if (rangeMatch && DAY_NAME_TO_KEY[rangeMatch[1]] && DAY_NAME_TO_KEY[rangeMatch[2]]) {
    const days = [];
    const startIdx = DAY_ORDER.indexOf(DAY_NAME_TO_KEY[rangeMatch[1]]);
    const endIdx = DAY_ORDER.indexOf(DAY_NAME_TO_KEY[rangeMatch[2]]);
    for (let i = startIdx; ; i = (i + 1) % 7) {
      days.push(DAY_ORDER[i]);
      if (i === endIdx) break;
    }
    return days;
  }

  const days = Object.keys(DAY_NAME_TO_KEY)
    .filter(name => lower.includes(name))
    .map(name => DAY_NAME_TO_KEY[name]);
  return [...new Set(days)];
}

function parseWorkingHoursPhrase(phrase) {
  if (!phrase) return null;
  const lower = phrase.toLowerCase();

  const timeRangeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|through|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!timeRangeMatch) return null;

  const to24h = (h, m, meridiem, fallbackMeridiem) => {
    let hour = parseInt(h, 10);
    const min = m ? parseInt(m, 10) : 0;
    const mer = meridiem || fallbackMeridiem;
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  const [, sh, sm, sMer, eh, em, eMer] = timeRangeMatch;
  const startMeridiem = sMer || (parseInt(sh, 10) < 12 ? 'am' : 'pm');
  const endMeridiem = eMer || sMer || 'pm';

  const start = to24h(sh, sm, sMer, startMeridiem);
  const end = to24h(eh, em, eMer, endMeridiem);

  const days = extractDaysFromPhrase(lower);
  if (days.length === 0) return null;
  return { days, start, end };
}

const DAY_OFF_KEYWORDS = /\b(don'?t work|do not work|not working|off|closed|no appointments|no work|unavailable|not available)\b/i;
function parseDayOffPhrase(phrase) {
  if (!phrase) return null;
  const lower = phrase.toLowerCase();
  if (!DAY_OFF_KEYWORDS.test(lower)) return null;

  const days = extractDaysFromPhrase(lower);
  return days.length > 0 ? days : null;
}

function mentionsToday(phrase) {
  return /\btoday\b|\btonight\b/i.test(phrase || '');
}

function startOfTomorrow(from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Slot finding ───────────────────────────────────────────────────────────

function fitsWorkingHours(start, end, dayHours) {
  if (!dayHours) return false;
  const dayStart = new Date(start);
  const [sh, sm] = dayHours.start.split(':').map(Number);
  dayStart.setHours(sh, sm, 0, 0);
  const dayEnd = new Date(start);
  const [eh, em] = dayHours.end.split(':').map(Number);
  dayEnd.setHours(eh, em, 0, 0);
  return start >= dayStart && end <= dayEnd;
}

function hasConflict(start, end, appointments, bufferMinutes, excludeId) {
  const bufferMs = bufferMinutes * 60 * 1000;
  return appointments.some(a => {
    if (a.status !== 'confirmed') return false;
    if (excludeId && (a.id === excludeId || a._core_id === excludeId)) return false;
    const aStart = new Date(a.start).getTime() - bufferMs;
    const aEnd = new Date(a.end).getTime() + bufferMs;
    return start.getTime() < aEnd && end.getTime() > aStart;
  });
}

function isSlotAvailable(start, end, scheduleConfig, appointments, excludeId) {
  const dayKey = DAY_KEYS[start.getDay()];
  const dayHours = scheduleConfig.working_hours?.[dayKey];
  if (!fitsWorkingHours(start, end, dayHours)) return false;
  if (hasConflict(start, end, appointments, scheduleConfig.buffer_minutes, excludeId)) return false;
  return true;
}

async function findNextAvailableSlot({ afterDate, durationMinutes, preferredDate, excludeId, scheduleConfig, appointments } = {}) {
  const cfg = scheduleConfig || await loadScheduleConfig();
  const appts = appointments || await loadCalendar();
  const duration = durationMinutes || cfg.default_duration_minutes;
  const now = afterDate ? new Date(afterDate) : new Date();

  if (preferredDate) {
    const start = new Date(preferredDate);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    if (start > now && isSlotAvailable(start, end, cfg, appts, excludeId)) {
      return { start, end };
    }
  }

  const searchStart = preferredDate && new Date(preferredDate) > now ? new Date(preferredDate) : now;
  const windowEnd = new Date(now.getTime() + cfg.booking_window_days * 24 * 60 * 60 * 1000);

  for (let dayOffset = 0; dayOffset < cfg.booking_window_days; dayOffset++) {
    const day = new Date(searchStart);
    day.setDate(day.getDate() + dayOffset);
    const dayKey = DAY_KEYS[day.getDay()];
    const dayHours = cfg.working_hours?.[dayKey];
    if (!dayHours) continue;

    const [sh, sm] = dayHours.start.split(':').map(Number);
    const [eh, em] = dayHours.end.split(':').map(Number);
    const dayStart = new Date(day);
    dayStart.setHours(sh, sm, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(eh, em, 0, 0);

    const baseTime = dayOffset === 0 && searchStart > dayStart ? searchStart.getTime() : dayStart.getTime();
    let slotStart = new Date(Math.ceil(baseTime / (15 * 60 * 1000)) * (15 * 60 * 1000));

    while (slotStart.getTime() + duration * 60 * 1000 <= dayEnd.getTime()) {
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
      if (slotStart > windowEnd) return null;
      if (isSlotAvailable(slotStart, slotEnd, cfg, appts, excludeId)) {
        return { start: slotStart, end: slotEnd };
      }
      slotStart = new Date(slotStart.getTime() + 15 * 60 * 1000);
    }
  }

  return null;
}

async function generateOfferSlots({ durationMinutes, preferredDate, afterDate, count = 3 } = {}) {
  const scheduleConfig = await loadScheduleConfig();
  const appointments = await loadCalendar();
  const offers = [];
  let cursor = afterDate;
  let firstPreferred = preferredDate;
  for (let i = 0; i < count; i++) {
    const slot = await findNextAvailableSlot({ afterDate: cursor, durationMinutes, preferredDate: firstPreferred, scheduleConfig, appointments });
    if (!slot) break;
    offers.push(slot);
    cursor = new Date(slot.end.getTime() + 15 * 60 * 1000);
    firstPreferred = null;
  }
  return offers;
}

function formatOfferList(offers) {
  return offers.map((s, i) => `${i + 1}. ${new Date(s.start).toLocaleString()}`).join('\n');
}

function detectRelativeTimeRequest(text) {
  const lower = (text || '').toLowerCase();
  if (/\b(later|push (it )?back|something after|anything after)\b/.test(lower)) return 'later';
  if (/\b(earlier|sooner|move (it )?up|something before|anything before)\b/.test(lower)) return 'earlier';
  return null;
}

async function findEarlierSlotsSameDay({ beforeDate, durationMinutes, count = 3, excludeId } = {}) {
  const scheduleConfig = await loadScheduleConfig();
  const appointments = await loadCalendar();
  const duration = durationMinutes || scheduleConfig.default_duration_minutes;
  const before = new Date(beforeDate);
  const dayKey = DAY_KEYS[before.getDay()];
  const dayHours = scheduleConfig.working_hours?.[dayKey];
  if (!dayHours) return [];

  const [sh, sm] = dayHours.start.split(':').map(Number);
  const dayStart = new Date(before);
  dayStart.setHours(sh, sm, 0, 0);

  const found = [];
  let slotStart = dayStart;
  while (slotStart.getTime() + duration * 60 * 1000 <= before.getTime()) {
    const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
    if (isSlotAvailable(slotStart, slotEnd, scheduleConfig, appointments, excludeId)) {
      found.push({ start: slotStart, end: slotEnd });
    }
    slotStart = new Date(slotStart.getTime() + 15 * 60 * 1000);
  }
  return found.slice(-count);
}

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

function matchOfferedSlotSelection(text, offerCount) {
  const lower = (text || '').toLowerCase().trim();

  const bareOrOptionNumber = lower.match(/^(?:#|option|number|choice)?\s*(\d+)\.?$/) ||
    lower.match(/\b(?:option|number|choice)\s*#?\s*(\d+)\b/);
  if (bareOrOptionNumber) {
    const n = parseInt(bareOrOptionNumber[1], 10);
    if (n >= 1 && n <= offerCount) return n - 1;
  }

  if (/\b(last|final)\s+(one|option|slot|time)?\b/.test(lower) || lower === 'last') {
    return offerCount - 1;
  }

  for (let i = 0; i < ORDINAL_WORDS.length && i < offerCount; i++) {
    const word = ORDINAL_WORDS[i];
    if (new RegExp(`\\b${word}\\b`).test(lower) || lower.includes(`${i + 1}st`) || lower.includes(`${i + 1}nd`) || lower.includes(`${i + 1}rd`) || lower.includes(`${i + 1}th`)) {
      return i;
    }
  }

  return null;
}

// ─── Appointments (CRUD / Mutations via Core API) ───────────────────────────

async function createAppointment({ title, start, end, contactId, attendeeName, attendeeEmail, createdVia, notes, appointmentType }) {
  const externalId = `appt_${Date.now()}`;
  const now = new Date().toISOString();
  const jsAppt = {
    id: externalId,
    uid: `${externalId}@aigentik.local`,
    ics_sequence: 0,
    title: title || `Appointment with ${attendeeName || attendeeEmail || 'contact'}`,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    contact_id: contactId || null,
    attendee_name: attendeeName || null,
    attendee_email: attendeeEmail || null,
    appointment_type: appointmentType || null,
    status: 'confirmed',
    rsvp_status: 'pending',
    pending_reschedule: null,
    created_via: createdVia || 'owner',
    notes: notes || null,
    created_at: now,
    updated_at: now,
    history: [{ event: 'created', at: now }]
  };

  const coreBody = mapJSToCore(jsAppt);
  const { ok, status, data, parseError } = await coreRequest('POST', '/api/v1/appointments', {
    body: coreBody
  });
  if (!ok) throw new Error(`Core appointment creation failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);

  const created = mapCoreToJS(data.appointment);
  log.action('calendar', `Appointment created: ${created.title}`, { id: created.id, start: created.start });
  return created;
}

async function proposeAppointment({ title, contactId, attendeeName, attendeeEmail, createdVia, offeredSlots = [], appointmentType = null }) {
  const externalId = `appt_${Date.now()}`;
  const primary = offeredSlots[0] || null;
  const now = new Date().toISOString();
  const jsAppt = {
    id: externalId,
    uid: `${externalId}@aigentik.local`,
    ics_sequence: 0,
    title: title || `Appointment with ${attendeeName || attendeeEmail || 'contact'}`,
    start: primary ? new Date(primary.start).toISOString() : null,
    end: primary ? new Date(primary.end).toISOString() : null,
    contact_id: contactId || null,
    attendee_name: attendeeName || null,
    attendee_email: attendeeEmail || null,
    appointment_type: appointmentType,
    status: 'negotiating',
    form_sent: false,
    rsvp_status: 'pending',
    pending_reschedule: null,
    offered_slots: offeredSlots.map(s => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
    requested_datetime: null,
    created_via: createdVia || 'owner',
    notes: null,
    created_at: now,
    updated_at: now,
    history: [{ event: 'proposed', at: now }]
  };

  const coreBody = mapJSToCore(jsAppt);
  const { ok, status, data, parseError } = await coreRequest('POST', '/api/v1/appointments', {
    body: coreBody
  });
  if (!ok) throw new Error(`Core appointment proposal failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);

  const proposed = mapCoreToJS(data.appointment);
  log.action('calendar', `Appointment proposed: ${proposed.title}`, { id: proposed.id });
  return proposed;
}

async function updateAppointment(id, updates) {
  const appts = await loadCalendar();
  const existing = appts.find(a => a.id === id || a._core_id === id);
  if (!existing) return null;

  const coreId = existing._core_id;
  const coreUpdates = {};
  if (updates.title !== undefined) coreUpdates.title = updates.title;
  if (updates.start !== undefined) coreUpdates.start_time = updates.start ? new Date(updates.start).toISOString() : null;
  if (updates.end !== undefined) coreUpdates.end_time = updates.end ? new Date(updates.end).toISOString() : null;
  if (updates.appointment_type !== undefined) coreUpdates.appointment_type = updates.appointment_type;
  if (updates.status !== undefined) coreUpdates.status = updates.status;
  if (updates.rsvp_status !== undefined) coreUpdates.rsvp_status = updates.rsvp_status;
  if (updates.notes !== undefined) coreUpdates.notes = updates.notes;
  if (updates.form_sent !== undefined) coreUpdates.form_sent = updates.form_sent ? 1 : 0;
  if (updates.requested_datetime !== undefined) coreUpdates.requested_datetime = updates.requested_datetime;
  if (updates.offered_slots !== undefined) coreUpdates.offered_slots = updates.offered_slots;
  if (updates.pending_reschedule !== undefined) coreUpdates.pending_reschedule = updates.pending_reschedule;
  if (updates.ics_sequence !== undefined) coreUpdates.ics_sequence = updates.ics_sequence;
  if (updates.attendee_email !== undefined) coreUpdates.attendee_email = updates.attendee_email;
  if (updates.history !== undefined) coreUpdates.history = updates.history;

  const { ok, status, data, parseError } = await coreRequest('POST', `/api/v1/appointments/${coreId}/update`, {
    body: coreUpdates
  });
  if (!ok) throw new Error(`Core appointment update failed (${status}): ${data?.error || parseError?.message || 'unknown error'}`);
  return mapCoreToJS(data.appointment);
}

async function setAppointmentType(id, type) {
  return updateAppointment(id, { appointment_type: type });
}

async function markFormSent(id) {
  return updateAppointment(id, { form_sent: true });
}

async function setAppointmentNotes(id, notes) {
  return updateAppointment(id, { notes });
}

async function setRequestedDatetime(id, isoString) {
  return updateAppointment(id, { requested_datetime: isoString });
}

function detectAppointmentTypeFromText(text) {
  const lower = (text || '').toLowerCase();
  const matchesCall = /\b(call|phone call|video call|zoom|virtual|over the phone|on the phone|call me|give (me|us) a call|just (talk|discuss) (over|on) the phone)\b/.test(lower);
  const negatesVisit = /\b(no need|don'?t need|not necessary|no reason)\b[^.!?]{0,40}\b(come|visit|stop by|in[\s-]?person)\b/.test(lower);
  if (negatesVisit && matchesCall) return 'call';
  if (/\b(in[\s-]?person|come (over|by|out|check|take a look|look at)|someone (come|stop by|here|out)|(send|need) someone (here|out)|someone (to )?(come|look|take|check)|stop by|at (my|your|the) (home|house|office|place)|visit|on[\s-]?site|drop by)\b/.test(lower)) return 'in_person';
  if (matchesCall) return 'call';
  return null;
}

async function updateNegotiationOffers(id, offeredSlots) {
  const iso = offeredSlots.map(s => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));
  return updateAppointment(id, { offered_slots: iso, start: iso[0]?.start, end: iso[0]?.end });
}

async function confirmNegotiation(id, start, end, attendeeEmail) {
  const updates = {
    status: 'confirmed',
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    offered_slots: []
  };
  if (attendeeEmail) updates.attendee_email = attendeeEmail;
  const appt = await updateAppointment(id, updates);
  if (appt) log.action('calendar', `Negotiation confirmed as appointment: ${appt.title}`, { id });
  return appt;
}

async function findNegotiationsByContact(contactId) {
  if (!contactId) return [];
  const appts = await loadCalendar();
  return appts.filter(a => a.contact_id === String(contactId) && a.status === 'negotiating');
}

async function setPendingReschedule(id, slot) {
  return updateAppointment(id, {
    pending_reschedule: { start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() }
  });
}

async function clearPendingReschedule(id) {
  return updateAppointment(id, { pending_reschedule: null });
}

async function rescheduleAppointment(id, newStart, newEnd) {
  const appt = await getAppointment(id);
  if (!appt) return null;
  const fromStart = appt.start;
  const updated = await updateAppointment(id, {
    start: new Date(newStart).toISOString(),
    end: new Date(newEnd).toISOString(),
    status: 'confirmed',
    rsvp_status: 'pending',
    pending_reschedule: null,
    ics_sequence: (appt.ics_sequence || 0) + 1
  });
  if (updated) log.action('calendar', `Appointment rescheduled: ${updated.title}`, { id, from: fromStart, to: updated.start });
  return updated;
}

async function cancelAppointment(id) {
  const updated = await updateAppointment(id, { status: 'cancelled' });
  if (updated) log.action('calendar', `Appointment cancelled: ${updated.title}`, { id });
  return updated;
}

async function getAppointment(id) {
  const appts = await loadCalendar();
  return appts.find(a => a.id === id || a._core_id === id) || null;
}

async function findAppointmentsByContact(contactId) {
  if (!contactId) return [];
  const appts = await loadCalendar();
  return appts.filter(a => a.contact_id === String(contactId) && a.status === 'confirmed');
}

async function findUpcomingAppointmentForContact(contactId) {
  if (!contactId) return null;
  const appts = await findAppointmentsByContact(contactId);
  const now = new Date();
  return appts.filter(a => new Date(a.start) >= now).sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
}

async function findAppointmentByAttendeeEmail(email) {
  if (!email) return null;
  const norm = email.toLowerCase().trim();
  const appts = await loadCalendar();
  const matches = appts
    .filter(a => a.status === 'confirmed' && a.attendee_email?.toLowerCase().trim() === norm)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  if (matches.length === 0) return null;
  return matches.find(a => a.rsvp_status === 'pending') || matches[0];
}

async function setRsvpStatus(id, status) {
  const updated = await updateAppointment(id, { rsvp_status: status });
  if (updated) log.info('calendar', `RSVP recorded for ${updated.title}: ${status}`, { id });
  return updated;
}

async function findUpcoming(days = 30) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const appts = await loadCalendar();
  return appts
    .filter(a => a.status === 'confirmed' && new Date(a.start) >= now && new Date(a.start) <= until)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

async function findForDate(date) {
  const target = new Date(date);
  const dayStart = new Date(target);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(target);
  dayEnd.setHours(23, 59, 59, 999);
  const appts = await loadCalendar();
  return appts
    .filter(a => a.status === 'confirmed' && new Date(a.start) >= dayStart && new Date(a.start) <= dayEnd)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function formatAppointment(appt) {
  if (!appt) return 'Unknown appointment';
  const start = new Date(appt.start);
  const typeLabel = appt.appointment_type === 'in_person' ? ' [🏠 in-person]' : appt.appointment_type === 'call' ? ' [📞 call]' : '';
  return `${appt.title} — ${start.toLocaleString()} (${appt.attendee_name || appt.attendee_email || 'no contact'})${typeLabel}`;
}

async function listUpcomingForSms(days = 14) {
  const upcoming = await findUpcoming(days);
  if (upcoming.length === 0) return `📅 No appointments in the next ${days} days.`;
  const lines = [`📅 Upcoming appointments:\n`];
  upcoming.forEach(a => lines.push(`#${(a.id || '').replace('appt_', '')} ${formatAppointment(a)}`));
  return lines.join('\n');
}

async function listForDateForSms(date) {
  const appts = await findForDate(date);
  const label = new Date(date).toLocaleDateString();
  if (appts.length === 0) return `📅 No appointments on ${label}.`;
  const lines = [`📅 Appointments on ${label}:\n`];
  appts.forEach(a => lines.push(`#${(a.id || '').replace('appt_', '')} ${formatAppointment(a)}`));
  return lines.join('\n');
}

export {
  mapCoreToJS,
  mapJSToCore,
  loadCalendar,
  loadScheduleConfig,
  saveScheduleConfig,
  parseDatetimePhrase,
  parseDatetimeDetailed,
  combineTimeWithDate,
  parseWorkingHoursPhrase,
  parseDayOffPhrase,
  mentionsToday,
  startOfTomorrow,
  getDurationForRelationship,
  setWorkingHours,
  setDayOff,
  setDurationForRelationship,
  formatWorkingHours,
  findNextAvailableSlot,
  generateOfferSlots,
  formatOfferList,
  matchOfferedSlotSelection,
  detectRelativeTimeRequest,
  findEarlierSlotsSameDay,
  detectAppointmentTypeFromText,
  createAppointment,
  proposeAppointment,
  updateAppointment,
  setAppointmentType,
  markFormSent,
  setAppointmentNotes,
  setRequestedDatetime,
  updateNegotiationOffers,
  confirmNegotiation,
  findNegotiationsByContact,
  setPendingReschedule,
  clearPendingReschedule,
  rescheduleAppointment,
  cancelAppointment,
  getAppointment,
  findAppointmentsByContact,
  findUpcomingAppointmentForContact,
  findAppointmentByAttendeeEmail,
  setRsvpStatus,
  findUpcoming,
  findForDate,
  formatAppointment,
  listUpcomingForSms,
  listForDateForSms
};
