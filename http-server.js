import http from 'http';
import { getEmailProvider } from './email-provider.js';
import { isBlocked } from './do-not-contact.js';
import { isAuthorized, getExpectedToken } from './internal-auth.js';
import logger from './logger.js';

// Overridable for tests so they don't fight a real running instance on
// the production port. Production never sets AIGENTIK_HTTP_PORT.
const PORT = process.env.AIGENTIK_HTTP_PORT ? parseInt(process.env.AIGENTIK_HTTP_PORT, 10) : 8081;
const HOST = '127.0.0.1';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// WP0.1 (NEW-764): every route here sends real email to a real address.
// Split in two so auth -- header-only, no body needed -- runs before the
// body is ever read off the socket, not just before the provider call.
// An unauthenticated caller should not get a full JSON body buffered
// into memory (rule 2's RAM discipline) or a parse-error leak back to it.
function checkAuth(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function checkNotBlocked(res, to) {
  if (await isBlocked(to)) {
    logger.warn(`Refused to send to do-not-contact address: ${to}`);
    sendJson(res, 403, { error: 'Recipient is on the do-not-contact list' });
    return false;
  }
  return true;
}

export function startHttpServer() {
  if (!getExpectedToken()) {
    logger.warn(
      'AIGENTIK_INTERNAL_TOKEN is not configured (checked env var and '
      + '~/.codeyOS/aigentik_internal_token) -- every request to this server '
      + 'will be rejected with 401 until it is. Run Codey-OS\'s install.sh to '
      + 'generate it.'
    );
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/send-email') {
      if (!checkAuth(req, res)) return;
      try {
        const data = await readJsonBody(req);
        if (!(await checkNotBlocked(res, data.to))) return;
        const emailProvider = getEmailProvider();
        if (!emailProvider) {
          sendJson(res, 500, { error: 'Email provider not initialized' });
          return;
        }
        await emailProvider.sendEmail(data.to, data.subject, data.text, data.html);
        sendJson(res, 200, { success: true });
      } catch (error) {
        logger.error('Error in /send-email:', error);
        sendJson(res, 500, { error: error.message });
      }
    } else if (req.method === 'POST' && req.url === '/send-invite') {
      if (!checkAuth(req, res)) return;
      try {
        const data = await readJsonBody(req);
        if (!(await checkNotBlocked(res, data.to))) return;
        const emailProvider = getEmailProvider();
        if (!emailProvider) {
          sendJson(res, 500, { error: 'Email provider not initialized' });
          return;
        }
        // NEW-506 finding: this call had appointment/email transposed
        // relative to sendCalendarInvite's real signature
        // (appointment, toEmail, bodyText) -- fixed.
        await emailProvider.sendCalendarInvite(data.appointment, data.to, data.text);
        sendJson(res, 200, { success: true });
      } catch (error) {
        logger.error('Error in /send-invite:', error);
        sendJson(res, 500, { error: error.message });
      }
    } else if (req.method === 'POST' && req.url === '/send-cancellation') {
      if (!checkAuth(req, res)) return;
      try {
        const data = await readJsonBody(req);
        if (!(await checkNotBlocked(res, data.to))) return;
        const emailProvider = getEmailProvider();
        if (!emailProvider) {
          sendJson(res, 500, { error: 'Email provider not initialized' });
          return;
        }
        await emailProvider.sendCalendarCancellation(data.appointment, data.to, data.text);
        sendJson(res, 200, { success: true });
      } catch (error) {
        logger.error('Error in /send-cancellation:', error);
        sendJson(res, 500, { error: error.message });
      }
    } else {
      sendJson(res, 404, { error: 'Not Found' });
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info(`Internal HTTP server running at http://${HOST}:${PORT}/`);
  });

  return server;
}
