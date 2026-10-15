// tests/invite-send-failure-reply.test.js — NEW-927/928 (WP2.1 group 8,
// blocking finding): every contact-facing call site that calls
// gmail.sendCalendarInvite/sendCalendarCancellation must branch its
// owner/customer-facing reply on the real return value instead of
// assuming success — a do-not-contact block or provider failure returns
// `false`, and telling the owner/customer "invite sent" anyway is a lie.
//
// Follows the same test harness as scheduling-concurrency.test.js: mock
// gmail.js directly (these tests are about the caller's branching logic,
// not the do-not-contact gate itself — that's covered by
// tests/gmail-dnc.test.js) and mock Core via a fetch spy.
import { jest } from '@jest/globals';

const sendCalendarInviteMock = jest.fn(async () => true);
const sendCalendarCancellationMock = jest.fn(async () => true);
const sendOwnerNotificationMock = jest.fn(async () => {});
const sendReplyMock = jest.fn(async () => {});

jest.unstable_mockModule('../gmail.js', () => ({
  sendCalendarInvite: sendCalendarInviteMock,
  sendCalendarCancellation: sendCalendarCancellationMock,
  sendOwnerNotification: sendOwnerNotificationMock,
  sendReply: sendReplyMock,
  connect: jest.fn()
}));

const { confirmAndClose } = await import('../index.js');
const { executeInterpretedCommand, handleOwnerCommand } = await import('../owner-command.js');

function mockResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// owner-command.js's `reply()` calls are deliberately fire-and-forget at
// every one of its call sites (not just the ones touched by this round) —
// executeInterpretedCommand/handleOwnerCommand resolve as soon as their own
// synchronous body finishes, which can be before reply()'s own internal
// awaits (its dynamic `import('./gmail.js')`, then `gmail.sendReply`/
// `sendOwnerNotification`) land. Flush the microtask queue before reading
// the mock calls so these tests observe the settled state, not a race.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('NEW-927/928 — reply text reflects the real invite-send result', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    sendCalendarInviteMock.mockClear();
    sendCalendarCancellationMock.mockClear();
    sendOwnerNotificationMock.mockClear();
    sendReplyMock.mockClear();
    sendCalendarInviteMock.mockResolvedValue(true);
    sendCalendarCancellationMock.mockResolvedValue(true);
  });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('index.js confirmAndClose: tells the customer the invite was NOT sent when gmail.sendCalendarInvite returns false', async () => {
    const existingRow = { id: 1, external_id: 'appt_1', status: 'negotiating' };
    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [existingRow] });
      }
      if (pathname === '/api/v1/appointments/1/update' && method === 'POST') {
        const body = JSON.parse(init.body);
        return mockResponse(200, { appointment: { ...existingRow, ...body } });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    // Only the contact-facing send fails; the admin-copy send still
    // "succeeds" in this mock (its own reporting is lower-priority, per
    // the task scope, and untouched here).
    sendCalendarInviteMock.mockImplementation(async (appt, toEmail) => toEmail !== 'jake@example.com');

    const negotiation = { id: 'appt_1', contact_id: null, appointment_type: 'call', appointment_type_id: null };
    const slot = { start: new Date('2026-09-14T10:00:00'), end: new Date('2026-09-14T10:30:00') };
    const reply = jest.fn(async () => {});

    await confirmAndClose({
      negotiation, slot, attendeeEmail: 'jake@example.com', adminEmail: 'admin@example.com',
      senderLabel: 'Jake', reply
    });

    expect(reply).toHaveBeenCalledTimes(1);
    const replyText = reply.mock.calls[0][0];
    expect(replyText).not.toMatch(/sent a calendar invite to your email/i);
    expect(replyText).toMatch(/wasn't able to send a calendar invite/i);
  });

  it('index.js confirmAndClose: regression — still claims the invite was sent when gmail.sendCalendarInvite returns true', async () => {
    const existingRow = { id: 2, external_id: 'appt_2', status: 'negotiating' };
    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [existingRow] });
      }
      if (pathname === '/api/v1/appointments/2/update' && method === 'POST') {
        const body = JSON.parse(init.body);
        return mockResponse(200, { appointment: { ...existingRow, ...body } });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    const negotiation = { id: 'appt_2', contact_id: null, appointment_type: 'call', appointment_type_id: null };
    const slot = { start: new Date('2026-09-14T11:00:00'), end: new Date('2026-09-14T11:30:00') };
    const reply = jest.fn(async () => {});

    await confirmAndClose({
      negotiation, slot, attendeeEmail: 'jake@example.com', adminEmail: 'admin@example.com',
      senderLabel: 'Jake', reply
    });

    const replyText = reply.mock.calls[0][0];
    expect(replyText).toMatch(/sent a calendar invite to your email/i);
    expect(replyText).not.toMatch(/wasn't able to send a calendar invite/i);
  });
});

describe('NEW-927/928 — owner-command.js tells the owner when a contact-facing send was refused', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    sendCalendarInviteMock.mockClear();
    sendCalendarCancellationMock.mockClear();
    sendOwnerNotificationMock.mockClear();
    sendCalendarInviteMock.mockResolvedValue(true);
    sendCalendarCancellationMock.mockResolvedValue(true);
  });
  afterEach(() => { fetchSpy.mockRestore(); });

  // reply() (owner-command.js) routes to gmail.sendOwnerNotification
  // whenever no email reply-target has been set for the current command —
  // true here since these tests call executeInterpretedCommand/
  // handleOwnerCommand directly rather than through a real inbound SMS/
  // email, so this is the channel the owner-facing text actually lands on.
  function lastOwnerMessage() {
    const calls = sendOwnerNotificationMock.mock.calls;
    return calls[calls.length - 1][0];
  }

  it('schedule_appointment: reports the invite was NOT sent when gmail.sendCalendarInvite returns false', async () => {
    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/appointments' && method === 'POST') {
        return mockResponse(201, {
          appointment: { id: 10, external_id: 'appt_0010', title: 'Appointment with jake@example.com', status: 'confirmed' }
        });
      }
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [] });
      }
      if (pathname === '/api/v1/schedule-config' && method === 'GET') {
        return mockResponse(200, { schedule_config: {} });
      }
      if (pathname === '/api/v1/appointment-types' && method === 'GET') {
        return mockResponse(200, { appointment_types: [] });
      }
      if (pathname === '/api/v1/contacts' && method === 'GET') {
        return mockResponse(200, { contacts: [] });
      }
      if (pathname === '/api/v1/contacts' && method === 'POST') {
        return mockResponse(201, {
          contact: { id: 1, external_id: 'contact_0001', name: null, emails: ['jake@example.com'], phones: [] }
        });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    sendCalendarInviteMock.mockImplementation(async (appt, toEmail) => toEmail !== 'jake@example.com');

    await expect(
      executeInterpretedCommand({ action: 'schedule_appointment', target: 'jake@example.com', content: 'next tuesday at 2pm' },
        'schedule appointment with jake@example.com next tuesday at 2pm', 'Owner')
    ).resolves.toBeUndefined();
    await flush();

    expect(lastOwnerMessage()).toMatch(/NOT sent/);
    expect(lastOwnerMessage()).not.toMatch(/^✅ Booked.*Invite sent to/);
  });

  it('schedule_appointment: regression — still reports the invite as sent when gmail.sendCalendarInvite returns true', async () => {
    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/appointments' && method === 'POST') {
        return mockResponse(201, {
          appointment: { id: 11, external_id: 'appt_0011', title: 'Appointment with jake@example.com', status: 'confirmed' }
        });
      }
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [] });
      }
      if (pathname === '/api/v1/schedule-config' && method === 'GET') {
        return mockResponse(200, { schedule_config: {} });
      }
      if (pathname === '/api/v1/appointment-types' && method === 'GET') {
        return mockResponse(200, { appointment_types: [] });
      }
      if (pathname === '/api/v1/contacts' && method === 'GET') {
        return mockResponse(200, { contacts: [] });
      }
      if (pathname === '/api/v1/contacts' && method === 'POST') {
        return mockResponse(201, {
          contact: { id: 1, external_id: 'contact_0001', name: null, emails: ['jake@example.com'], phones: [] }
        });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    await expect(
      executeInterpretedCommand({ action: 'schedule_appointment', target: 'jake@example.com', content: 'next tuesday at 2pm' },
        'schedule appointment with jake@example.com next tuesday at 2pm', 'Owner')
    ).resolves.toBeUndefined();
    await flush();

    expect(lastOwnerMessage()).toMatch(/Invite sent to jake@example.com/);
    expect(lastOwnerMessage()).not.toMatch(/NOT sent/);
  });

  it('reschedule_appointment: reports the updated invite was NOT sent when gmail.sendCalendarInvite returns false', async () => {
    const existingAppt = {
      id: 7, external_id: 'appt_7', title: 'Inspection', status: 'confirmed',
      contact_external_id: 'contact_0005',
      start_time: new Date('2026-08-31T09:00:00').toISOString(),
      end_time: new Date('2026-08-31T09:30:00').toISOString(),
      attendee_email: 'jake@example.com'
    };

    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/contacts/find' && method === 'GET') {
        return mockResponse(200, { contact: { id: 5, external_id: 'contact_0005', name: 'Jake', emails: ['jake@example.com'] } });
      }
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [existingAppt] });
      }
      if (pathname === '/api/v1/schedule-config' && method === 'GET') {
        return mockResponse(200, { schedule_config: {} });
      }
      if (pathname === '/api/v1/appointment-types' && method === 'GET') {
        return mockResponse(200, { appointment_types: [] });
      }
      if (pathname === '/api/v1/appointments/7/update' && method === 'POST') {
        const body = JSON.parse(init.body);
        return mockResponse(200, { appointment: { ...existingAppt, ...body } });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    sendCalendarInviteMock.mockImplementation(async (appt, toEmail) => toEmail !== 'jake@example.com');

    const cmd = { action: 'reschedule_appointment', target: 'Jake', content: 'next friday at 3pm' };
    await expect(
      executeInterpretedCommand(cmd, 'move Jake to next friday at 3pm', 'Owner')
    ).resolves.toBeUndefined();
    await flush();

    expect(lastOwnerMessage()).toMatch(/updated invite was NOT sent/);
  });

  it('cancel_appointment: reports the cancellation notice was NOT sent when gmail.sendCalendarCancellation returns false', async () => {
    const existingAppt = {
      id: 7, external_id: 'appt_7', title: 'Inspection', status: 'confirmed',
      contact_external_id: 'contact_0005',
      start_time: new Date('2026-08-31T09:00:00').toISOString(),
      end_time: new Date('2026-08-31T09:30:00').toISOString(),
      attendee_email: 'jake@example.com'
    };

    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/contacts/find' && method === 'GET') {
        return mockResponse(200, { contact: { id: 5, external_id: 'contact_0005', name: 'Jake', emails: ['jake@example.com'] } });
      }
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [existingAppt] });
      }
      if (pathname === '/api/v1/appointments/7/update' && method === 'POST') {
        const body = JSON.parse(init.body);
        return mockResponse(200, { appointment: { ...existingAppt, ...body } });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    sendCalendarCancellationMock.mockImplementation(async (appt, toEmail) => toEmail !== 'jake@example.com');

    const cmd = { action: 'cancel_appointment', target: 'Jake' };
    // First call sets the pending confirmation and asks the owner to
    // confirm — mirrors handleOwnerCommand's real two-step flow.
    await executeInterpretedCommand(cmd, 'cancel Jake\'s appointment', 'Owner');
    // Second message ("yes") is handled entirely by handleOwnerCommand's
    // pendingConfirmations check, before any NLU classification, so no
    // extra Core/llama mocking is needed for this step.
    await handleOwnerCommand({ address: 'owner-sms', body: 'yes' });
    await flush();

    expect(lastOwnerMessage()).toMatch(/cancellation notice was NOT sent/);
  });

  it('cancel_appointment: regression — still reports a plain cancellation when gmail.sendCalendarCancellation returns true', async () => {
    const existingAppt = {
      id: 8, external_id: 'appt_8', title: 'Inspection', status: 'confirmed',
      contact_external_id: 'contact_0006',
      start_time: new Date('2026-08-31T09:00:00').toISOString(),
      end_time: new Date('2026-08-31T09:30:00').toISOString(),
      attendee_email: 'jake2@example.com'
    };

    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/contacts/find' && method === 'GET') {
        return mockResponse(200, { contact: { id: 6, external_id: 'contact_0006', name: 'Jake2', emails: ['jake2@example.com'] } });
      }
      if (pathname === '/api/v1/appointments' && method === 'GET') {
        return mockResponse(200, { appointments: [existingAppt] });
      }
      if (pathname === '/api/v1/appointments/8/update' && method === 'POST') {
        const body = JSON.parse(init.body);
        return mockResponse(200, { appointment: { ...existingAppt, ...body } });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    const cmd = { action: 'cancel_appointment', target: 'Jake2' };
    await executeInterpretedCommand(cmd, 'cancel Jake2\'s appointment', 'Owner');
    await handleOwnerCommand({ address: 'owner-sms', body: 'yes' });
    await flush();

    expect(lastOwnerMessage()).toMatch(/^🚫 Cancelled/);
    expect(lastOwnerMessage()).not.toMatch(/NOT sent/);
  });
});
