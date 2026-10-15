// gmail.js — Aigentik Gmail integration
// Compatibility wrapper for EmailProvider
// Preserves all existing public APIs while using modern imapflow backend

import { getEmailProvider } from './email-provider.js';
import config from './config.json' with { type: 'json' };
import log from './logger.js';
// Namespace import, not a named `{ isBlocked }` import: a test that mocks
// './do-not-contact.js' with a factory lacking `isBlocked` would otherwise
// fail at ESM link time for every test that merely loads this module,
// instead of only the ones that actually call a gated function. Matches
// the import style already used in index.js/owner-command.js.
import * as doNotContact from './do-not-contact.js';

let emailProvider = null;
let onNewEmailCallback = null;
const STARTUP_TIME = new Date();

log.info('gmail', `Startup time: ${STARTUP_TIME.toISOString()} — older emails will be skipped`);

// NEW-927/928 (WP2.1 group 8, warning 2): the do-not-contact list is
// customer-facing — it exists to protect contacts who asked not to be
// reached, never the owner's own address. Mirrors the admin-email
// resolution `sendOwnerNotification`'s callers already use elsewhere
// (`config.owner?.admin_email || config.gmail.email`), so this carve-out
// recognizes the exact same address as "the owner", not a second notion
// of it.
function isAdminAddress(toEmail) {
  const adminEmail = config.owner?.admin_email || config.gmail.email;
  return typeof toEmail === 'string' && typeof adminEmail === 'string' &&
    toEmail.toLowerCase() === adminEmail.toLowerCase();
}

// Initialize email provider lazily
function getProvider() {
  if (!emailProvider) {
    emailProvider = getEmailProvider({
      config,
      logger: log
    });
  }
  return emailProvider;
}

// ─── PUBLIC API (Backward Compatible) ─────────────────────────────────────────

/**
 * Connect to Gmail IMAP and start monitoring for new emails
 * @param {Function} onNewEmail - Callback function for new emails
 */
function connect(onNewEmail) {
  onNewEmailCallback = onNewEmail;
  if (!config.gmail.email || !config.gmail.app_password) {
    log.error('gmail', 'Gmail credentials not configured');
    return;
  }
  log.info('gmail', `Connecting to Gmail as ${config.gmail.email}...`);

  const provider = getProvider();

  // Wrap callback to handle async errors
  const wrappedCallback = async (email) => {
    try {
      await onNewEmail(email);
    } catch (e) {
      log.error('gmail', 'Error in onNewEmail callback', { error: e.message });
    }
  };

  // Start connection in background (non-blocking)
  provider.connect(wrappedCallback).catch((err) => {
    log.error('gmail', 'Connection failed', { error: err.message });
  });
}

/**
 * Disconnect from Gmail IMAP
 */
async function disconnect() {
  if (emailProvider) {
    await emailProvider.disconnect();
    emailProvider = null;
  }
  log.info('gmail', 'IMAP disconnected');
}

// ─── EMAIL SENDING ────────────────────────────────────────────────────────────

/**
 * Send email reply
 *
 * NEW-927/928 (WP2.1 group 8): deliberately NOT given a do-not-contact
 * check here. Every current caller of this function already checks the
 * recipient against do-not-contact earlier in the same flow before ever
 * reaching this call (owner-command.js's `reply()` helper at line ~108
 * always targets the admin's own address — `handleOwnerCommand` is only
 * reached from the admin phone/email in the first place, so there's no
 * customer identifier to check there; its `approve_reply` call at line
 * ~736 checks `doNotContact.isBlocked(item.sender)` immediately above;
 * index.js's `handleSubcontractorApplication` checks
 * `doNotContact.isBlocked(email.from_email)` before its sendReply call;
 * index.js's `handleSchedulingMessage`'s email-channel reply target is
 * `email.from_email`, already checked via `checkDoNotContact()` in
 * `handleNewEmail` before `handleSchedulingMessage` is ever invoked; and
 * index.js's auto-reply sendReply call is likewise downstream of that
 * same `checkDoNotContact()` call in `handleNewEmail`). Adding a second
 * check here would be redundant, not safer. If a future caller reaches
 * this function with an unchecked identifier, it needs its own check at
 * that call site (or this reasoning needs to be revisited) — do not
 * assume this comment still holds without re-deriving it against the
 * actual caller list.
 */
async function sendReply(toEmail, originalSubject, body, html) {
  const provider = getProvider();
  return provider.sendReply(toEmail, originalSubject, body, html);
}

/**
 * Send new email
 *
 * NEW-927 (WP2.1 group 8): gated on the do-not-contact list. Matches
 * provider.sendEmail's own failure contract (throw), since callers
 * already have to be ready for this function to throw on a provider-
 * level send failure — a DNC block is reported the same way.
 *
 * `doNotContact.isBlocked()` throws, rather than returning false, when
 * Core is unreachable (do-not-contact.js, by design — no silent
 * fallback). That rejection is deliberately left unhandled here and
 * propagates straight out of this function: a Core outage must fail
 * closed (no send), not be swallowed into "assume not blocked".
 */
async function sendEmail(toEmail, subject, body, html) {
  if (await doNotContact.isBlocked(toEmail)) {
    log.warn('gmail', 'Refused to send email to do-not-contact address', { to: toEmail });
    throw new Error(`Recipient is on the do-not-contact list: ${toEmail}`);
  }
  const provider = getProvider();
  return provider.sendEmail(toEmail, subject, body, html);
}

/**
 * Send notification to owner via email
 *
 * Deliberately NOT gated on do-not-contact (NEW-927/928 scope). This
 * always sends to the owner's own admin address, never to a customer/
 * contact identifier — gating an internal owner alert on a customer's
 * DNC status would be a bug, not a safety improvement. Keep this
 * function routed straight to `provider.sendOwnerNotification`, a
 * genuinely separate provider method from `sendEmail`/`sendReply`, not
 * the one being gated below.
 */
async function sendOwnerNotification(message) {
  const provider = getProvider();
  return provider.sendOwnerNotification(message);
}

/**
 * Send a calendar invite (.ics, METHOD:REQUEST) for an appointment
 *
 * NEW-927/928 (WP2.1 group 8): gated on the do-not-contact list. Returns
 * `false` on a block, matching provider.sendCalendarInvite's own
 * contract of catching a provider-level send failure and returning
 * `false` rather than throwing — callers that don't check the return
 * value (several don't) continue to behave the same as a provider-level
 * send failure: no exception, no invite sent.
 *
 * As with sendEmail above, `doNotContact.isBlocked()`'s Core-unreachable
 * rejection is left unhandled here on purpose, so it propagates as a
 * thrown rejection (fail closed) instead of being caught and turned into
 * a `false` return, which would silently treat "Core is down" the same
 * as "not blocked".
 *
 * NEW-927/928 (warning 2): skips the do-not-contact check entirely when
 * `toEmail` is the owner's own configured admin address — see
 * isAdminAddress() above. The DNC list protects customers; it was never
 * meant to block the owner's own calendar copy, and doing so during a
 * Core outage would be a pure availability cost with no safety benefit.
 */
async function sendCalendarInvite(appointment, toEmail, bodyText) {
  if (!isAdminAddress(toEmail) && await doNotContact.isBlocked(toEmail)) {
    log.warn('gmail', 'Refused to send calendar invite to do-not-contact address', { to: toEmail });
    return false;
  }
  const provider = getProvider();
  return provider.sendCalendarInvite(appointment, toEmail, bodyText);
}

/**
 * Send a calendar cancellation (.ics, METHOD:CANCEL) for an appointment
 *
 * See sendCalendarInvite above — same gating, same false-on-block
 * contract match, same deliberate fail-closed propagation of a
 * Core-unreachable error from isBlocked(), and the same admin-address
 * carve-out (NEW-927/928 warning 2).
 */
async function sendCalendarCancellation(appointment, toEmail, bodyText) {
  if (!isAdminAddress(toEmail) && await doNotContact.isBlocked(toEmail)) {
    log.warn('gmail', 'Refused to send calendar cancellation to do-not-contact address', { to: toEmail });
    return false;
  }
  const provider = getProvider();
  return provider.sendCalendarCancellation(appointment, toEmail, bodyText);
}

// ─── EMAIL MANAGEMENT ─────────────────────────────────────────────────────────

/**
 * Search emails by criteria
 */
async function searchEmails(criteria) {
  const provider = getProvider();
  return provider.searchEmails(criteria);
}

/**
 * Delete emails permanently (move to Trash)
 */
async function deleteEmails(criteria) {
  const provider = getProvider();
  return provider.deleteEmails(criteria);
}

/**
 * Archive emails (move to All Mail)
 */
async function archiveEmails(criteria) {
  const provider = getProvider();
  return provider.archiveEmails(criteria);
}

/**
 * Mark emails as spam
 */
async function markAsSpam(criteria) {
  const provider = getProvider();
  return provider.markAsSpam(criteria);
}

/**
 * Scan the inbox and move to spam only messages matching predicate({from, subject, body})
 */
async function spamMatchingEmails(predicate) {
  const provider = getProvider();
  return provider.spamMatchingEmails(predicate);
}

/**
 * Move a single message to spam by its exact UID
 */
async function spamByUid(uid) {
  const provider = getProvider();
  return provider.spamByUid(uid);
}

/**
 * Mark emails as read
 */
async function markAsRead(criteria) {
  const provider = getProvider();
  return provider.markAsRead(criteria);
}

/**
 * Mark emails as unread
 */
async function markAsUnread(criteria) {
  const provider = getProvider();
  return provider.markAsUnread(criteria);
}

/**
 * Add a label to emails
 */
async function labelEmails(criteria, labelName) {
  const provider = getProvider();
  return provider.labelEmails(criteria, labelName);
}

/**
 * Mark all current inbox emails as seen
 */
async function markAllAsSeen() {
  const provider = getProvider();
  return provider.markAllAsSeen();
}

// ─── GOOGLE VOICE EMAIL PARSING ───────────────────────────────────────────────

/**
 * Check if an email is a Google Voice forwarded text message
 */
function isGoogleVoiceText(email) {
  const provider = getProvider();
  return provider.isGoogleVoiceText(email);
}

/**
 * Detect whether an email is a calendar invite accept/decline/tentative response
 */
function isCalendarResponse(email) {
  const provider = getProvider();
  return provider.isCalendarResponse(email);
}

/**
 * Parse a calendar invite-response email into { status, attendeeEmail, subject }
 */
function parseCalendarResponse(email) {
  const provider = getProvider();
  return provider.parseCalendarResponse(email);
}

/**
 * Parse a Google Voice forwarded email into an SMS-like object
 */
function parseGoogleVoiceEmail(email) {
  const provider = getProvider();
  return provider.parseGoogleVoiceEmail(email);
}

/**
 * Reply to a Google Voice forwarded text by replying to the email
 */
async function replyToGoogleVoiceText(voiceMessage, replyText) {
  const provider = getProvider();
  return provider.replyToGoogleVoiceText(voiceMessage, replyText);
}

// Export all public APIs
export {
  connect,
  disconnect,
  sendReply,
  sendEmail,
  sendOwnerNotification,
  sendCalendarInvite,
  sendCalendarCancellation,
  deleteEmails,
  archiveEmails,
  markAsSpam,
  spamMatchingEmails,
  spamByUid,
  markAsRead,
  markAsUnread,
  labelEmails,
  markAllAsSeen,
  isGoogleVoiceText,
  isCalendarResponse,
  parseCalendarResponse,
  parseGoogleVoiceEmail,
  replyToGoogleVoiceText
};

// Default export for backward compatibility
export default {
  connect,
  disconnect,
  sendReply,
  sendEmail,
  sendOwnerNotification,
  sendCalendarInvite,
  sendCalendarCancellation,
  deleteEmails,
  archiveEmails,
  markAsSpam,
  spamMatchingEmails,
  spamByUid,
  markAsRead,
  markAsUnread,
  labelEmails,
  markAllAsSeen,
  isGoogleVoiceText,
  isCalendarResponse,
  parseCalendarResponse,
  parseGoogleVoiceEmail,
  replyToGoogleVoiceText
};