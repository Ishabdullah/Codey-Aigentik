// tests/scheduling-concurrency.test.js — Final scheduling round Phase 6.
// Covers NEW-467 (graceful handling of a Core 400 capacity rejection at the
// appointment-write call sites) end to end through index.js's confirmAndClose
// and owner-command.js's schedule_appointment/reschedule_appointment handlers.
//
// gmail.js is mocked at both sites so these tests never attempt a real
// IMAP/SMTP connection — neither call site under test (the "found
// alternative offers" branch) actually reaches a gmail.* call, but index.js
// and owner-command.js both import/dynamic-import gmail.js at module load,
// so it still needs a safe mock in place.
import { jest } from '@jest/globals';

jest.unstable_mockModule('../gmail.js', () => ({
  sendCalendarInvite: jest.fn(async () => {}),
  sendOwnerNotification: jest.fn(async () => {}),
  sendReply: jest.fn(async () => {}),
  connect: jest.fn(),
  sendCalendarCancellation: jest.fn(async () => {})
}));

const { confirmAndClose } = await import('../index.js');
const { executeInterpretedCommand } = await import('../owner-command.js');
const calendar = await import('../calendar.js');

function mockResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Routes a fetch call to a canned response based on method + pathname +
// (for the /update endpoints) whether the body is a confirm/status-change
// write, so call ORDER doesn't have to be hardcoded the way the chained
// mockResolvedValueOnce tests elsewhere in this suite do — confirmAndClose's
// re-offer path makes several Core round trips (confirm attempt, re-load
// schedule-config/calendar, re-save offered_slots) and hardcoding their
// exact count/order would make this test brittle against unrelated changes.
function buildCoreMock({ existingRow, confirmStatus, confirmBody, scheduleConfig = {} }) {
  return jest.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const pathname = url.pathname;

    if (pathname === '/api/v1/appointments' && method === 'GET') {
      return mockResponse(200, { appointments: existingRow ? [existingRow] : [] });
    }
    if (pathname === '/api/v1/schedule-config' && method === 'GET') {
      return mockResponse(200, { schedule_config: scheduleConfig });
    }
    if (pathname === '/api/v1/appointment-types' && method === 'GET') {
      return mockResponse(200, { appointment_types: [] });
    }
    if (pathname.startsWith('/api/v1/appointments/') && pathname.endsWith('/update') && method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.status === 'confirmed') {
        return mockResponse(confirmStatus, confirmBody);
      }
      // Any other update (e.g. updateNegotiationOffers writing offered_slots)
      // succeeds and echoes the row back with the update applied.
      return mockResponse(200, { appointment: { ...existingRow, ...body } });
    }
    return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
  });
}

describe('NEW-467 — confirmAndClose (index.js) graceful 400 handling', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('re-offers slots instead of throwing when Core rejects the confirm with a 400', async () => {
    const negotiation = {
      id: 'appt_1',
      contact_id: null, // skip contacts.getContactById entirely
      appointment_type: 'call',
      appointment_type_id: null
    };
    const slot = { start: new Date('2026-09-14T10:00:00'), end: new Date('2026-09-14T10:30:00') };

    fetchSpy.mockImplementation(buildCoreMock({
      existingRow: { id: 1, external_id: 'appt_1', status: 'negotiating' },
      confirmStatus: 400,
      confirmBody: { error: 'Booking would exceed the concurrency cap (1) for this appointment type in the requested time window' }
    }));

    const reply = jest.fn(async () => {});

    await expect(confirmAndClose({
      negotiation, slot, attendeeEmail: 'jake@example.com', adminEmail: 'admin@example.com',
      senderLabel: 'Jake', reply
    })).resolves.toBeUndefined(); // does NOT throw / propagate the raw 400

    expect(reply).toHaveBeenCalledTimes(1);
    const replyText = reply.mock.calls[0][0];
    expect(replyText).toMatch(/just filled/i);
    expect(replyText).not.toMatch(/concurrency cap/i); // no raw Core error text leaks to the customer
  });

  it('still throws (does not swallow) a non-400 failure from Core', async () => {
    const negotiation = { id: 'appt_2', contact_id: null, appointment_type: 'call', appointment_type_id: null };
    const slot = { start: new Date('2026-09-14T10:00:00'), end: new Date('2026-09-14T10:30:00') };

    fetchSpy.mockImplementation(buildCoreMock({
      existingRow: { id: 2, external_id: 'appt_2', status: 'negotiating' },
      confirmStatus: 500,
      confirmBody: { error: 'internal error' }
    }));

    const reply = jest.fn(async () => {});

    await expect(confirmAndClose({
      negotiation, slot, attendeeEmail: 'jake@example.com', adminEmail: 'admin@example.com',
      senderLabel: 'Jake', reply
    })).rejects.toThrow(/500/);

    expect(reply).not.toHaveBeenCalled();
  });
});

describe('NEW-467 — owner-command.js schedule_appointment/reschedule_appointment graceful 400 handling', () => {
  let fetchSpy;
  beforeEach(() => { fetchSpy = jest.spyOn(global, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('schedule_appointment: re-offers instead of throwing when createAppointment 400s', async () => {
    fetchSpy.mockImplementation(async (url, init = {}) => {
      const method = init.method || 'GET';
      const pathname = url.pathname;
      if (pathname === '/api/v1/appointments' && method === 'POST') {
        return mockResponse(400, { error: 'Booking would exceed the concurrency cap (1) for this appointment type in the requested time window' });
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
      // contacts.js's findContact/findOrCreateByEmail chain, exercised
      // because executeInterpretedCommand resolves `cmd.target` through it
      // before ever reaching the calendar write this test cares about.
      if (pathname === '/api/v1/contacts' && method === 'GET') {
        return mockResponse(200, { contacts: [] }); // findContact('jake@example.com') -> no match -> createContact
      }
      if (pathname === '/api/v1/contacts' && method === 'POST') {
        return mockResponse(201, {
          contact: { id: 1, external_id: 'contact_0001', name: null, emails: ['jake@example.com'], phones: [] }
        });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    const cmd = { action: 'schedule_appointment', content: 'next tuesday at 2pm' };

    // Route through a raw email address so contacts.js's findOrCreateByEmail
    // path is exercised deterministically instead of a fuzzy name lookup.
    await expect(
      executeInterpretedCommand({ ...cmd, target: 'jake@example.com' }, 'schedule appointment with jake@example.com next tuesday at 2pm', 'Owner')
    ).resolves.toBeUndefined();
  });

  it('reschedule_appointment: re-offers instead of throwing when rescheduleAppointment 400s', async () => {
    const existingAppt = {
      id: 7, external_id: 'appt_7', title: 'Inspection', status: 'confirmed',
      contact_external_id: 'contact_0005',
      start_time: new Date('2026-08-31T09:00:00').toISOString(),
      end_time: new Date('2026-08-31T09:30:00').toISOString()
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
        if (body.status === 'confirmed') {
          return mockResponse(400, { error: 'Booking would exceed the concurrency cap (1) for this appointment type in the requested time window' });
        }
        return mockResponse(200, { appointment: { ...existingAppt, ...body } });
      }
      return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
    });

    const cmd = { action: 'reschedule_appointment', target: 'Jake', content: 'next friday at 3pm' };
    await expect(
      executeInterpretedCommand(cmd, 'move Jake to next friday at 3pm', 'Owner')
    ).resolves.toBeUndefined();
  });
});
