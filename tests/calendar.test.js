// tests/calendar.test.js — Unit tests for calendar.js's pure logic
// (phrase parsing). File-backed slot-finding/booking is exercised manually
// against a sandbox data dir rather than here, since calendar.js reads its
// paths from the real config.json — same limitation contacts.js/queue.js
// already have with no dedicated test file.

import { jest } from '@jest/globals';
import * as calendar from '../calendar.js';

describe('parseWorkingHoursPhrase', () => {
  it('expands a weekday range', () => {
    const result = calendar.parseWorkingHoursPhrase('9am to 5pm monday through friday');
    expect(result).toEqual({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' });
  });

  it('understands "weekdays" shorthand and bare hour numbers', () => {
    const result = calendar.parseWorkingHoursPhrase('9 to 5 weekdays');
    expect(result).toEqual({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' });
  });

  it('handles a single day', () => {
    const result = calendar.parseWorkingHoursPhrase('10am to 2pm on saturdays');
    expect(result).toEqual({ days: ['sat'], start: '10:00', end: '14:00' });
  });

  it('returns null when it cannot find a time range', () => {
    expect(calendar.parseWorkingHoursPhrase('whenever works')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(calendar.parseWorkingHoursPhrase(null)).toBeNull();
  });
});

describe('detectAppointmentTypeFromText', () => {
  it('recognizes in-person phrasing', () => {
    expect(calendar.detectAppointmentTypeFromText('I would like an in-person visit')).toBe('in_person');
    expect(calendar.detectAppointmentTypeFromText('can you come by my house')).toBe('in_person');
  });

  it('recognizes call/phone phrasing', () => {
    expect(calendar.detectAppointmentTypeFromText('can we just do a phone call')).toBe('call');
    expect(calendar.detectAppointmentTypeFromText('a quick zoom would be fine')).toBe('call');
  });

  it('returns null when the type is not stated', () => {
    expect(calendar.detectAppointmentTypeFromText('I need an appointment sometime this week')).toBeNull();
    expect(calendar.detectAppointmentTypeFromText(null)).toBeNull();
  });
});

describe('parseDayOffPhrase', () => {
  it('recognizes "don\'t work on Sundays"', () => {
    expect(calendar.parseDayOffPhrase("I don't work on Sundays")).toEqual(['sun']);
  });

  it('recognizes "closed on weekends"', () => {
    expect(calendar.parseDayOffPhrase('closed on weekends')).toEqual(['sat', 'sun']);
  });

  it('recognizes "no appointments on Saturday"', () => {
    expect(calendar.parseDayOffPhrase('no appointments on saturday')).toEqual(['sat']);
  });

  it('does not misfire on an hours-setting phrase', () => {
    expect(calendar.parseDayOffPhrase('9am to 5pm monday through friday')).toBeNull();
  });

  it('returns null when no day is found', () => {
    expect(calendar.parseDayOffPhrase("I'm off")).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(calendar.parseDayOffPhrase(null)).toBeNull();
  });
});

describe('formatOfferList', () => {
  it('numbers each offered slot', () => {
    const offers = [
      { start: new Date('2026-08-05T14:00:00'), end: new Date('2026-08-05T14:30:00') },
      { start: new Date('2026-08-05T15:00:00'), end: new Date('2026-08-05T15:30:00') }
    ];
    const formatted = calendar.formatOfferList(offers);
    expect(formatted).toContain('1.');
    expect(formatted).toContain('2.');
    expect(formatted.split('\n')).toHaveLength(2);
  });
});

describe('parseDatetimePhrase (forwardDate)', () => {
  it('rolls an already-passed month/day forward to next year instead of returning a past date', () => {
    const anchor = new Date('2026-08-02T14:00:00');
    const result = calendar.parseDatetimePhrase('July 3rd 1pm', anchor);
    expect(result.getTime()).toBeGreaterThan(anchor.getTime());
    expect(result.getFullYear()).toBe(2027);
  });
});

describe('parseDatetimeDetailed', () => {
  const anchor = new Date('2026-08-02T14:00:00');

  it('flags an explicit weekday/date as certain', () => {
    const result = calendar.parseDatetimeDetailed('Tuesday at 2pm', anchor);
    expect(result.hasExplicitDate).toBe(true);
  });

  it('flags a bare time with no date as not certain', () => {
    const result = calendar.parseDatetimeDetailed('Could we do 11 AM', anchor);
    expect(result.hasExplicitDate).toBe(false);
  });

  it('returns null when chrono finds nothing', () => {
    expect(calendar.parseDatetimeDetailed('sounds good', anchor)).toBeNull();
  });
});

describe('combineTimeWithDate', () => {
  it('applies the time-of-day from one date onto the calendar day of another', () => {
    const timeOnly = new Date('2026-08-02T15:00:00'); // 11am-ish local, whatever TZ
    const anchorDate = new Date('2026-08-05T00:00:00');
    const combined = calendar.combineTimeWithDate(timeOnly, anchorDate);
    expect(combined.getDate()).toBe(anchorDate.getDate());
    expect(combined.getHours()).toBe(timeOnly.getHours());
    expect(combined.getMinutes()).toBe(timeOnly.getMinutes());
  });
});

describe('mentionsToday', () => {
  it('recognizes "today" and "tonight"', () => {
    expect(calendar.mentionsToday('can you fit me in today at 3pm')).toBe(true);
    expect(calendar.mentionsToday('tonight around 7')).toBe(true);
  });

  it('does not match unrelated phrases, including ones that only imply "today"', () => {
    expect(calendar.mentionsToday('next tuesday at 2pm')).toBe(false);
    expect(calendar.mentionsToday('as soon as possible')).toBe(false);
    expect(calendar.mentionsToday(null)).toBe(false);
  });
});

describe('startOfTomorrow', () => {
  it('returns midnight of the day after the given date', () => {
    const result = calendar.startOfTomorrow(new Date('2026-08-02T15:30:00'));
    expect(result.getDate()).toBe(3);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it('rolls over the month/year correctly', () => {
    const result = calendar.startOfTomorrow(new Date('2026-12-31T23:00:00'));
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
  });
});

describe('parseDatetimePhrase', () => {
  const anchor = new Date('2026-08-02T12:00:00');

  it('resolves a relative weekday + time phrase to a real Date', () => {
    const result = calendar.parseDatetimePhrase('next tuesday at 2pm', anchor);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(anchor.getTime());
  });

  it('returns null when no date is mentioned', () => {
    expect(calendar.parseDatetimePhrase('asap', anchor)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(calendar.parseDatetimePhrase(null, anchor)).toBeNull();
  });
});

describe('calendar (Core write-through)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  describe('mapCoreToJS & mapJSToCore', () => {
    it('correctly maps between Core Appointment and JS object', () => {
      const core = {
        id: 42,
        external_id: 'appt_12345',
        uid: 'appt_12345@aigentik.local',
        ics_sequence: 1,
        title: 'Roof Inspection',
        start_time: '2026-08-30T10:00:00.000Z',
        end_time: '2026-08-30T10:30:00.000Z',
        contact_external_id: 'contact_001',
        customer_id: 10,
        attendee_name: 'Bob',
        attendee_email: 'bob@example.com',
        appointment_type: 'in_person',
        status: 'confirmed',
        rsvp_status: 'accepted',
        pending_reschedule: null,
        form_sent: 1,
        offered_slots: [],
        requested_datetime: '2026-08-30T10:00:00.000Z',
        created_via: 'owner',
        notes: 'Check south slope',
        created_at: '2026-08-27T00:00:00.000Z',
        updated_at: '2026-08-27T01:00:00.000Z',
        history: [{ event: 'created', at: '2026-08-27T00:00:00.000Z' }]
      };

      const js = calendar.mapCoreToJS(core);
      expect(js.id).toBe('appt_12345');
      expect(js._core_id).toBe(42);
      expect(js.contact_id).toBe('contact_001');
      expect(js.form_sent).toBe(true);
      expect(js.start).toBe('2026-08-30T10:00:00.000Z');

      const backToCore = calendar.mapJSToCore(js);
      expect(backToCore.external_id).toBe('appt_12345');
      expect(backToCore.contact_external_id).toBe('contact_001');
      expect(backToCore.form_sent).toBe(1);
      expect(backToCore.start_time).toBe('2026-08-30T10:00:00.000Z');
    });
  });

  describe('loadCalendar & loadScheduleConfig', () => {
    it('fetches appointments from Core API', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        appointments: [
          { id: 1, external_id: 'appt_1', title: 'Inspection', status: 'confirmed', start_time: '2026-08-30T10:00:00Z', end_time: '2026-08-30T10:30:00Z' }
        ]
      }));

      const appts = await calendar.loadCalendar();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0].pathname).toBe('/api/v1/appointments');
      expect(appts).toHaveLength(1);
      expect(appts[0].id).toBe('appt_1');
      expect(appts[0]._core_id).toBe(1);
    });

    it('fetches schedule config from Core API or falls back to defaults on 404', async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, { error: 'Not found' }));
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.default_duration_minutes).toBe(30);
      expect(cfg.booking_window_days).toBe(365);
    });
  });

  describe('createAppointment & proposeAppointment', () => {
    it('creates a confirmed appointment via POST /api/v1/appointments', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        appointment: {
          id: 5,
          external_id: 'appt_555',
          title: 'Consultation',
          status: 'confirmed',
          start_time: '2026-08-30T14:00:00.000Z',
          end_time: '2026-08-30T14:30:00.000Z',
          attendee_name: 'Charlie'
        }
      }));

      const created = await calendar.createAppointment({
        title: 'Consultation',
        start: '2026-08-30T14:00:00.000Z',
        end: '2026-08-30T14:30:00.000Z',
        attendeeName: 'Charlie'
      });

      expect(created.id).toBe('appt_555');
      expect(created._core_id).toBe(5);
      expect(created.status).toBe('confirmed');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0].pathname).toBe('/api/v1/appointments');
      expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    });

    it('proposes a negotiating appointment via POST /api/v1/appointments', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        appointment: {
          id: 6,
          external_id: 'appt_666',
          title: 'Negotiation',
          status: 'negotiating',
          offered_slots: [{ start: '2026-08-30T10:00:00.000Z', end: '2026-08-30T10:30:00.000Z' }]
        }
      }));

      const proposed = await calendar.proposeAppointment({
        title: 'Negotiation',
        offeredSlots: [{ start: new Date('2026-08-30T10:00:00.000Z'), end: new Date('2026-08-30T10:30:00.000Z') }]
      });

      expect(proposed.id).toBe('appt_666');
      expect(proposed.status).toBe('negotiating');
      expect(proposed.offered_slots).toHaveLength(1);
    });
  });

  describe('updateAppointment / reschedule / cancel', () => {
    it('reschedules an appointment and increments ics_sequence', async () => {
      // 1st call for loadCalendar, 2nd call for update
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 10, external_id: 'appt_10', title: 'Inspection', status: 'confirmed', ics_sequence: 1, start_time: '2026-08-30T10:00:00.000Z', end_time: '2026-08-30T10:30:00.000Z' }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 10, external_id: 'appt_10', title: 'Inspection', status: 'confirmed', ics_sequence: 1, start_time: '2026-08-30T10:00:00.000Z', end_time: '2026-08-30T10:30:00.000Z' }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          appointment: {
            id: 10,
            external_id: 'appt_10',
            title: 'Inspection',
            status: 'confirmed',
            ics_sequence: 2,
            start_time: '2026-08-31T11:00:00.000Z',
            end_time: '2026-08-31T11:30:00.000Z'
          }
        }));

      const updated = await calendar.rescheduleAppointment('appt_10', '2026-08-31T11:00:00.000Z', '2026-08-31T11:30:00.000Z');
      expect(updated.ics_sequence).toBe(2);
      expect(updated.start).toBe('2026-08-31T11:00:00.000Z');
      expect(fetchSpy.mock.calls[2][0].pathname).toBe('/api/v1/appointments/10/update');
    });

    it('updateAppointment sends attendee_name through to the Core update body', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 8, external_id: 'appt_8', title: 'New appointment request', status: 'confirmed', attendee_name: '8609822868' }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          appointment: { id: 8, external_id: 'appt_8', title: 'Appointment with Jake', status: 'confirmed', attendee_name: 'Jake' }
        }));

      const updated = await calendar.updateAppointment('appt_8', { attendee_name: 'Jake', title: 'Appointment with Jake' });

      expect(updated.attendee_name).toBe('Jake');
      const sentBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(sentBody.attendee_name).toBe('Jake');
      expect(sentBody.title).toBe('Appointment with Jake');
    });

    it('confirmNegotiation overwrites a stale phone-number attendee_name/title with the resolved contact name', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 8, external_id: 'appt_8', title: 'New appointment request', status: 'negotiating', attendee_name: null }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          appointment: { id: 8, external_id: 'appt_8', title: 'Appointment with Jake', status: 'confirmed', attendee_name: 'Jake' }
        }));

      const appt = await calendar.confirmNegotiation('appt_8', '2026-09-05T14:00:00.000Z', '2026-09-05T14:30:00.000Z', 'jake@example.com', 'Jake');

      expect(appt.attendee_name).toBe('Jake');
      const sentBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(sentBody.status).toBe('confirmed');
      expect(sentBody.attendee_name).toBe('Jake');
      expect(sentBody.title).toBe('Appointment with Jake');
    });

    it('confirmNegotiation leaves title/attendee_name untouched when no name is resolved', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 9, external_id: 'appt_9', title: 'New appointment request', status: 'negotiating', attendee_name: null }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          appointment: { id: 9, external_id: 'appt_9', title: 'New appointment request', status: 'confirmed', attendee_name: null }
        }));

      await calendar.confirmNegotiation('appt_9', '2026-09-05T14:00:00.000Z', '2026-09-05T14:30:00.000Z', null, null);

      const sentBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(sentBody).not.toHaveProperty('attendee_name');
      expect(sentBody).not.toHaveProperty('title');
    });

    it('cancels an appointment', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 12, external_id: 'appt_12', title: 'Meeting', status: 'confirmed' }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          appointment: { id: 12, external_id: 'appt_12', title: 'Meeting', status: 'cancelled' }
        }));

      const cancelled = await calendar.cancelAppointment('appt_12');
      expect(cancelled.status).toBe('cancelled');
      expect(fetchSpy.mock.calls[1][0].pathname).toBe('/api/v1/appointments/12/update');
    });
  });

  describe('findNextAvailableSlot', () => {
    const scheduleConfig = {
      working_hours: {
        mon: { start: '09:00', end: '17:00' },
        tue: { start: '09:00', end: '17:00' },
        wed: { start: '09:00', end: '17:00' },
        thu: { start: '09:00', end: '17:00' },
        fri: { start: '09:00', end: '17:00' }
      },
      buffer_minutes: 15,
      default_duration_minutes: 30,
      booking_window_days: 14
    };

    it('finds the next available slot without preferredDate when calendar is empty', async () => {
      const afterDate = new Date('2026-08-31T08:00:00');
      const slot = await calendar.findNextAvailableSlot({
        afterDate,
        durationMinutes: 30,
        scheduleConfig,
        appointments: []
      });

      expect(slot).not.toBeNull();
      expect(slot.start).toBeInstanceOf(Date);
      expect(slot.end).toBeInstanceOf(Date);
      expect(slot.start.getHours()).toBe(9);
      expect(slot.start.getMinutes()).toBe(0);
      expect(slot.end.getHours()).toBe(9);
      expect(slot.end.getMinutes()).toBe(30);
    });

    it('finds the next available slot without preferredDate when earlier slots are occupied', async () => {
      const afterDate = new Date('2026-08-31T08:00:00');
      const mockAppointments = [
        {
          id: 'appt_1',
          status: 'confirmed',
          start: new Date('2026-08-31T09:00:00').toISOString(),
          end: new Date('2026-08-31T09:30:00').toISOString()
        }
      ];

      const slot = await calendar.findNextAvailableSlot({
        afterDate,
        durationMinutes: 30,
        scheduleConfig,
        appointments: mockAppointments
      });

      expect(slot).not.toBeNull();
      expect(slot.start.getHours()).toBe(9);
      expect(slot.start.getMinutes()).toBe(45);
      expect(slot.end.getHours()).toBe(10);
      expect(slot.end.getMinutes()).toBe(15);
    });

    it('finds next available slot mid-day without preferredDate', async () => {
      const afterDate = new Date('2026-08-31T11:20:00');
      const slot = await calendar.findNextAvailableSlot({
        afterDate,
        durationMinutes: 30,
        scheduleConfig,
        appointments: []
      });

      expect(slot).not.toBeNull();
      expect(slot.start.getHours()).toBe(11);
      expect(slot.start.getMinutes()).toBe(30);
      expect(slot.end.getHours()).toBe(12);
      expect(slot.end.getMinutes()).toBe(0);
    });
  });
});
