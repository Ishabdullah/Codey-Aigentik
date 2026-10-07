// internal-auth.js — WP0.1 (CODEY_OS_MASTER_BLUEPRINT.md §21, NEW-764).
//
// http-server.js's /send-email, /send-invite, /send-cancellation had no
// auth at all: any local process could POST to 127.0.0.1:8081 and send
// real email to real people, bypassing every gate the inbound reply
// pipeline applies. This is the shared-secret check that closes that.
//
// Deliberately a flat shared secret, not a full Core-issued bearer token
// (unlike do-not-contact.js's CORE_API_TOKEN, which authenticates
// *outbound* calls to a multi-tenant Core API): this server only ever
// needs to authenticate its one legitimate local caller
// (restoricon_core/services/notification_service.py), and both sides run
// as the same device user, so a locally-generated static token is the
// right amount of mechanism. install.sh (Codey-OS) generates the file;
// both sides read the same path.
import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN_PATH = process.env.AIGENTIK_INTERNAL_TOKEN_PATH
  || path.join(os.homedir(), '.codeyOS', 'aigentik_internal_token');

let cachedFileToken;

function readTokenFile() {
  if (cachedFileToken) return cachedFileToken;
  // Only a successful, non-empty read is cached -- a miss (file absent,
  // or install.sh hasn't run yet) must keep retrying on every call, since
  // this server's process can start before install.sh creates the file.
  // Caching the miss would mean a 401 that no restart ever recovers from.
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (raw) cachedFileToken = raw;
  } catch {
    // fall through, cachedFileToken stays unset -- retry next call
  }
  return cachedFileToken ?? null;
}

// Env override takes priority (tests, and anyone who wants to rotate
// without touching the shared file) over the on-disk file, which is read
// once and cached since install.sh only writes it once at setup time.
export function getExpectedToken() {
  return process.env.AIGENTIK_INTERNAL_TOKEN || readTokenFile();
}

// Fails closed: an unconfigured expected token means no request can be
// authorized, rather than every request being treated as trusted.
export function isAuthorized(req) {
  const expected = getExpectedToken();
  if (!expected) return false;
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return !!match && match[1] === expected;
}
