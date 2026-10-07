// tests/http-server.test.js — WP0.1 (CODEY_OS_MASTER_BLUEPRINT.md §21,
// NEW-764): first tests for http-server.js (previously zero). Covers the
// two things that made this route a live, unaudited path to emailing
// real people: an unauthenticated caller must be rejected, and a
// do-not-contact-listed recipient must be rejected even with a valid
// token. Uses a real HTTP server on a dedicated test port (not the
// production 8081) and real sockets, since this module's whole job is
// request/response plumbing -- mocking at that level would test nothing.
import { jest } from '@jest/globals';
import http from 'http';

const TEST_TOKEN = 'wp0-1-test-token';
const TEST_PORT = 18091;
process.env.AIGENTIK_INTERNAL_TOKEN = TEST_TOKEN;
process.env.AIGENTIK_HTTP_PORT = String(TEST_PORT);

const sendEmailMock = jest.fn(async () => {});
const sendCalendarInviteMock = jest.fn(async () => {});
const sendCalendarCancellationMock = jest.fn(async () => {});
jest.unstable_mockModule('../email-provider.js', () => ({
  getEmailProvider: () => ({
    sendEmail: sendEmailMock,
    sendCalendarInvite: sendCalendarInviteMock,
    sendCalendarCancellation: sendCalendarCancellationMock
  })
}));

const isBlockedMock = jest.fn(async () => false);
jest.unstable_mockModule('../do-not-contact.js', () => ({
  isBlocked: isBlockedMock
}));

const { startHttpServer } = await import('../http-server.js');

function post(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('http-server internal API (WP0.1)', () => {
  let server;

  beforeAll(() => {
    server = startHttpServer();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    sendEmailMock.mockClear();
    sendCalendarInviteMock.mockClear();
    sendCalendarCancellationMock.mockClear();
    isBlockedMock.mockClear();
    isBlockedMock.mockResolvedValue(false);
  });

  it('rejects an unauthenticated /send-email request and never calls the provider', async () => {
    const res = await post('/send-email', { to: 'someone@example.com', subject: 's', text: 't' });
    expect(res.status).toBe(401);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated /send-invite request', async () => {
    const res = await post('/send-invite', { to: 'someone@example.com', appointment: {}, text: 't' });
    expect(res.status).toBe(401);
    expect(sendCalendarInviteMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated /send-cancellation request', async () => {
    const res = await post('/send-cancellation', { to: 'someone@example.com', appointment: {}, text: 't' });
    expect(res.status).toBe(401);
    expect(sendCalendarCancellationMock).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong bearer token', async () => {
    const res = await post('/send-email', { to: 'someone@example.com', subject: 's', text: 't' },
      { Authorization: 'Bearer wrong-token' });
    expect(res.status).toBe(401);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rejects a do-not-contact-listed address even with a valid token', async () => {
    isBlockedMock.mockResolvedValue(true);
    const res = await post('/send-email', { to: 'blocked@example.com', subject: 's', text: 't' },
      { Authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.status).toBe(403);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(isBlockedMock).toHaveBeenCalledWith('blocked@example.com');
  });

  it('fails closed (500, never sends) if the do-not-contact check itself throws', async () => {
    // do-not-contact.js throws rather than silently degrading when Core
    // is unreachable (NEW-311's decision) -- the one failure mode where
    // a bug here would mean actually re-contacting a suppressed person,
    // so this needs to be a permanent, not ad-hoc, test.
    isBlockedMock.mockRejectedValue(new Error('core down'));
    const res = await post('/send-email', { to: 'someone@example.com', subject: 's', text: 't' },
      { Authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.status).toBe(500);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends when authenticated and the recipient is not on the do-not-contact list', async () => {
    const res = await post('/send-email', { to: 'ok@example.com', subject: 's', text: 't' },
      { Authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(sendEmailMock).toHaveBeenCalledWith('ok@example.com', 's', 't', undefined);
  });

  it('gates /send-invite the same way: DNC-listed recipient is rejected', async () => {
    isBlockedMock.mockResolvedValue(true);
    const res = await post('/send-invite', { to: 'blocked@example.com', appointment: { id: 1 }, text: 't' },
      { Authorization: `Bearer ${TEST_TOKEN}` });
    expect(res.status).toBe(403);
    expect(sendCalendarInviteMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request with a malformed body as 401, not a body-parse 500 (auth checked before the body is read)', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: TEST_PORT, path: '/send-email', method: 'POST',
        headers: { 'Content-Type': 'application/json' } // no Authorization header
      }, r => {
        let chunks = '';
        r.on('data', c => { chunks += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(chunks) }));
      });
      req.on('error', reject);
      req.write('this is not json');
      req.end();
    });
    expect(res.status).toBe(401);
  });

  it('a malformed JSON body still returns a clean error, not a crash', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: TEST_PORT, path: '/send-email', method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` }
      }, r => {
        let chunks = '';
        r.on('data', c => { chunks += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(chunks) }));
      });
      req.on('error', reject);
      req.write('not json');
      req.end();
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 404 for an unknown route', async () => {
    const res = await post('/not-a-real-route', {});
    expect(res.status).toBe(404);
  });
});
