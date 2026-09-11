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

describe('effectiveHoursForType', () => {
  const businessHours = {
    mon: { start: '08:00', end: '18:00' },
    tue: { start: '08:00', end: '18:00' },
    wed: null // business closed Wednesdays
  };

  it('empty type hours ({}) inherits the business day unchanged', () => {
    expect(calendar.effectiveHoursForType(businessHours, {}, 'mon')).toEqual({ start: '08:00', end: '18:00' });
  });

  it('undefined type hours also inherits the business day unchanged', () => {
    expect(calendar.effectiveHoursForType(businessHours, undefined, 'mon')).toEqual({ start: '08:00', end: '18:00' });
  });

  it('an explicit day in a non-empty grid wins and is intersected with business hours', () => {
    const typeHours = { mon: { start: '10:00', end: '16:00' } };
    expect(calendar.effectiveHoursForType(businessHours, typeHours, 'mon')).toEqual({ start: '10:00', end: '16:00' });
  });

  it('an explicit null day in a non-empty grid means closed for the type that day', () => {
    const typeHours = { mon: { start: '10:00', end: '16:00' }, tue: null };
    expect(calendar.effectiveHoursForType(businessHours, typeHours, 'tue')).toBeNull();
  });

  it('a non-empty grid with the day absent is treated as "not offered that day" (chosen interpretation)', () => {
    const typeHours = { tue: { start: '10:00', end: '16:00' } }; // mon absent
    expect(calendar.effectiveHoursForType(businessHours, typeHours, 'mon')).toBeNull();
  });

  it('narrows correctly when the type window only partially overlaps business hours', () => {
    const typeHours = { mon: { start: '06:00', end: '11:00' } }; // starts before business opens
    expect(calendar.effectiveHoursForType(businessHours, typeHours, 'mon')).toEqual({ start: '08:00', end: '11:00' });
  });

  it('returns closed when the intersection inverts (type window entirely outside business hours)', () => {
    const typeHours = { mon: { start: '19:00', end: '20:00' } }; // after business closes at 18:00
    expect(calendar.effectiveHoursForType(businessHours, typeHours, 'mon')).toBeNull();
  });

  it('business closed that day beats a type window that claims to be open', () => {
    const typeHours = { wed: { start: '10:00', end: '12:00' } };
    expect(calendar.effectiveHoursForType(businessHours, typeHours, 'wed')).toBeNull();
  });
});

describe('hasConflict — capacity (Final scheduling round Phase 6)', () => {
  const start = new Date('2026-09-14T10:00:00');
  const end = new Date('2026-09-14T10:30:00');
  const bufferMinutes = 15;

  describe('no appointmentType (null/undefined) — legacy fail-closed any-type cap-1', () => {
    it('conflicts with an overlapping confirmed appointment of ANY type', () => {
      const appts = [
        { id: 'a1', status: 'confirmed', appointment_type_id: 99, start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' }
      ];
      expect(calendar.hasConflict(start, end, appts, bufferMinutes, null)).toBe(true);
    });

    it('does not conflict when nothing overlaps', () => {
      const appts = [
        { id: 'a1', status: 'confirmed', start: '2026-09-14T14:00:00', end: '2026-09-14T14:30:00' }
      ];
      expect(calendar.hasConflict(start, end, appts, bufferMinutes, null)).toBe(false);
    });

    it('ignores non-confirmed statuses', () => {
      const appts = [
        { id: 'a1', status: 'negotiating', start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' },
        { id: 'a2', status: 'cancelled', start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' }
      ];
      expect(calendar.hasConflict(start, end, appts, bufferMinutes, null)).toBe(false);
    });
  });

  describe('appointmentType given — same-type-only capacity cap', () => {
    const typeA = { id: 1, max_concurrent: 2 };
    const typeB = { id: 2, max_concurrent: 2 };

    it('allows up to max_concurrent overlapping confirmed same-type appointments', () => {
      const oneExisting = [
        { id: 'a1', status: 'confirmed', appointment_type_id: 1, start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' }
      ];
      expect(calendar.hasConflict(start, end, oneExisting, bufferMinutes, null, typeA)).toBe(false);

      const twoExisting = [
        ...oneExisting,
        { id: 'a2', status: 'confirmed', appointment_type_id: 1, start: '2026-09-14T10:10:00', end: '2026-09-14T10:40:00' }
      ];
      expect(calendar.hasConflict(start, end, twoExisting, bufferMinutes, null, typeA)).toBe(true);
    });

    it('different types do not interact', () => {
      const appts = [
        { id: 'a1', status: 'confirmed', appointment_type_id: 2, start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' },
        { id: 'a2', status: 'confirmed', appointment_type_id: 2, start: '2026-09-14T10:10:00', end: '2026-09-14T10:40:00' }
      ];
      // Both existing are type 2 (at its own cap), but we're checking type 1's availability
      expect(calendar.hasConflict(start, end, appts, bufferMinutes, null, typeA)).toBe(false);
      expect(calendar.hasConflict(start, end, appts, bufferMinutes, null, typeB)).toBe(true);
    });

    it('excludes negotiating/cancelled same-type rows from the count, matching Core', () => {
      const appts = [
        { id: 'a1', status: 'negotiating', appointment_type_id: 1, start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' },
        { id: 'a2', status: 'cancelled', appointment_type_id: 1, start: '2026-09-14T10:10:00', end: '2026-09-14T10:40:00' }
      ];
      expect(calendar.hasConflict(start, end, appts, bufferMinutes, null, typeA)).toBe(false);
    });

    it('defaults max_concurrent to 1 when the type row omits it', () => {
      const typeNoCap = { id: 3 };
      const oneExisting = [
        { id: 'a1', status: 'confirmed', appointment_type_id: 3, start: '2026-09-14T10:15:00', end: '2026-09-14T10:45:00' }
      ];
      expect(calendar.hasConflict(start, end, oneExisting, bufferMinutes, null, typeNoCap)).toBe(true);
    });

    it('buffer parity: same boundary behavior as the untyped case', () => {
      const type1 = { id: 1, max_concurrent: 1 };
      // Existing ends at 10:30, buffer 15min -> buffered end 10:45. A new
      // slot starting exactly at 10:45 should NOT conflict (matches the
      // untyped hasConflict's own boundary math: start.getTime() < aEnd).
      const appts = [
        { id: 'a1', status: 'confirmed', appointment_type_id: 1, start: '2026-09-14T09:30:00', end: '2026-09-14T10:30:00' }
      ];
      const adjacentStart = new Date('2026-09-14T10:45:00');
      const adjacentEnd = new Date('2026-09-14T11:15:00');
      expect(calendar.hasConflict(adjacentStart, adjacentEnd, appts, bufferMinutes, null, type1)).toBe(false);
      // One minute earlier still falls inside the buffer -> conflict.
      const withinBufferStart = new Date('2026-09-14T10:44:00');
      const withinBufferEnd = new Date('2026-09-14T11:14:00');
      expect(calendar.hasConflict(withinBufferStart, withinBufferEnd, appts, bufferMinutes, null, type1)).toBe(true);
    });

    it('exercises the same predicate against appointments produced by mapCoreToJS (end-to-end field-name wiring)', () => {
      const coreRow = {
        id: 55, external_id: 'appt_55', status: 'confirmed',
        start_time: '2026-09-14T10:15:00.000Z', end_time: '2026-09-14T10:45:00.000Z',
        appointment_type_id: 1
      };
      const jsAppt = calendar.mapCoreToJS(coreRow);
      expect(jsAppt.appointment_type_id).toBe(1); // wiring check, not just behavior
      const capOneType = { id: 1, max_concurrent: 1 };
      const utcStart = new Date('2026-09-14T10:00:00.000Z');
      const utcEnd = new Date('2026-09-14T10:30:00.000Z');
      expect(calendar.hasConflict(utcStart, utcEnd, [jsAppt], bufferMinutes, null, capOneType)).toBe(true);
    });
  });
});

describe('isSlotAvailable — hours + capacity combined', () => {
  const scheduleConfig = {
    working_hours: { mon: { start: '09:00', end: '17:00' } },
    buffer_minutes: 15
  };

  it('rejects a slot outside the type-narrowed hours even though business hours would allow it', () => {
    const type = { id: 1, max_concurrent: 5, scheduling_hours: { mon: { start: '09:00', end: '11:00' } } };
    const start = new Date('2026-09-14T12:00:00'); // a Monday
    const end = new Date('2026-09-14T12:30:00');
    expect(calendar.isSlotAvailable(start, end, scheduleConfig, [], null, type)).toBe(false);
  });

  it('accepts a slot within the type-narrowed hours', () => {
    const type = { id: 1, max_concurrent: 5, scheduling_hours: { mon: { start: '09:00', end: '11:00' } } };
    const start = new Date('2026-09-14T09:30:00');
    const end = new Date('2026-09-14T10:00:00');
    expect(calendar.isSlotAvailable(start, end, scheduleConfig, [], null, type)).toBe(true);
  });
});

describe('mapCoreToJS & mapJSToCore — appointment_type_id round trip', () => {
  it('maps appointment_type_id both directions', () => {
    const core = { id: 1, external_id: 'appt_1', appointment_type_id: 7 };
    const js = calendar.mapCoreToJS(core);
    expect(js.appointment_type_id).toBe(7);
    const backToCore = calendar.mapJSToCore(js);
    expect(backToCore.appointment_type_id).toBe(7);
  });

  it('defaults to null when absent on either side', () => {
    expect(calendar.mapCoreToJS({ id: 1, external_id: 'appt_1' }).appointment_type_id).toBeNull();
    expect(calendar.mapJSToCore({ id: 'appt_1' }).appointment_type_id).toBeNull();
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

    it('loadAppointmentTypes fetches the array from Core', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        appointment_types: [{ id: 1, name: 'Estimate', active: 1, max_concurrent: 2, scheduling_hours: {} }]
      }));
      const types = await calendar.loadAppointmentTypes();
      expect(fetchSpy.mock.calls[0][0].pathname).toBe('/api/v1/appointment-types');
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe('Estimate');
    });

    it('loadAppointmentTypes returns [] on a Core failure, does not throw', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(calendar.loadAppointmentTypes()).resolves.toEqual([]);
    });

    it('loadAppointmentTypes returns [] on a network failure, does not throw', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      await expect(calendar.loadAppointmentTypes()).resolves.toEqual([]);
    });

    it('fetches schedule config from Core API or falls back to defaults on 404', async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, { error: 'Not found' }));
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.default_duration_minutes).toBe(30);
      expect(cfg.booking_window_days).toBe(365);
    });

    const ALL_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    function mockScheduleConfig(schedule_config) {
      fetchSpy.mockResolvedValue(mockResponse(200, { schedule_config }));
    }

    it('empty working_hours {} from Core → full 7-day open week from DEFAULT (NEW-465)', async () => {
      mockScheduleConfig({ working_hours: {}, default_duration_minutes: 30 });
      const cfg = await calendar.loadScheduleConfig();
      for (const day of ALL_DAYS) {
        expect(cfg.working_hours[day]).toEqual({ start: '00:00', end: '23:59' });
      }
    });

    it('missing working_hours key entirely from Core → full DEFAULT week', async () => {
      mockScheduleConfig({ default_duration_minutes: 45 });
      const cfg = await calendar.loadScheduleConfig();
      for (const day of ALL_DAYS) {
        expect(cfg.working_hours[day]).toEqual({ start: '00:00', end: '23:59' });
      }
      expect(cfg.default_duration_minutes).toBe(45);
    });

    it('partial working_hours from Core → present day custom, other 6 from DEFAULT', async () => {
      mockScheduleConfig({ working_hours: { mon: { start: '08:00', end: '12:00' } } });
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.working_hours.mon).toEqual({ start: '08:00', end: '12:00' });
      for (const day of ALL_DAYS.filter(d => d !== 'mon')) {
        expect(cfg.working_hours[day]).toEqual({ start: '00:00', end: '23:59' });
      }
    });

    it('explicit working_hours {tue: null} from Core → tue is a day off, others DEFAULT', async () => {
      mockScheduleConfig({ working_hours: { tue: null } });
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.working_hours.tue).toBeNull();
      for (const day of ALL_DAYS.filter(d => d !== 'tue')) {
        expect(cfg.working_hours[day]).toEqual({ start: '00:00', end: '23:59' });
      }
    });

    it('full 7-day grid from Core → passed through unchanged (no default bleed)', async () => {
      const grid = {
        sun: null,
        mon: { start: '09:00', end: '17:00' },
        tue: { start: '09:00', end: '17:00' },
        wed: { start: '09:00', end: '17:00' },
        thu: { start: '09:00', end: '17:00' },
        fri: { start: '09:00', end: '15:00' },
        sat: null
      };
      mockScheduleConfig({ working_hours: grid });
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.working_hours).toEqual(grid);
    });

    it('other top-level fields still take the Core value when present', async () => {
      mockScheduleConfig({
        working_hours: {},
        buffer_minutes: 5,
        default_duration_minutes: 60,
        booking_window_days: 90
      });
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.buffer_minutes).toBe(5);
      expect(cfg.default_duration_minutes).toBe(60);
      expect(cfg.booking_window_days).toBe(90);
    });

    it('404 branch returns a fresh working_hours, not the DEFAULT constant', async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, { error: 'Not found' }));
      const first = await calendar.loadScheduleConfig();
      first.working_hours.sat = null; // simulates setDayOff mutating the loaded config
      const second = await calendar.loadScheduleConfig();
      expect(second.working_hours.sat).toEqual({ start: '00:00', end: '23:59' });
    });

    it('does not mutate DEFAULT_SCHEDULE_CONFIG across calls', async () => {
      mockScheduleConfig({ working_hours: { mon: { start: '08:00', end: '12:00' } } });
      await calendar.loadScheduleConfig();
      mockScheduleConfig({ working_hours: {} });
      const cfg = await calendar.loadScheduleConfig();
      expect(cfg.working_hours.mon).toEqual({ start: '00:00', end: '23:59' });
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

    it('createAppointment tags a Core 400 (capacity rejection) onto the thrown error as .status (NEW-467)', async () => {
      fetchSpy.mockResolvedValue(mockResponse(400, {
        error: 'Booking would exceed the concurrency cap (1) for this appointment type in the requested time window'
      }));
      let caught = null;
      try {
        await calendar.createAppointment({ title: 'X', start: '2026-09-14T10:00:00.000Z', end: '2026-09-14T10:30:00.000Z' });
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(caught.status).toBe(400);
    });

    it('createAppointment tags a 500 as .status too (so callers can distinguish 400 from everything else)', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'internal error' }));
      let caught = null;
      try {
        await calendar.createAppointment({ title: 'X', start: '2026-09-14T10:00:00.000Z', end: '2026-09-14T10:30:00.000Z' });
      } catch (e) {
        caught = e;
      }
      expect(caught.status).toBe(500);
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

    it('confirmNegotiation propagates a Core 400 (capacity rejection) with .status set (NEW-467)', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          appointments: [
            { id: 20, external_id: 'appt_20', title: 'Negotiation', status: 'negotiating', appointment_type_id: 1 }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(400, {
          error: 'Booking would exceed the concurrency cap (1) for this appointment type in the requested time window'
        }));

      let caught = null;
      try {
        await calendar.confirmNegotiation('appt_20', '2026-09-14T10:00:00.000Z', '2026-09-14T10:30:00.000Z', 'x@example.com');
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeNull();
      expect(caught.status).toBe(400);
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

  describe('generateOfferSlots — appointmentTypeId end-to-end (resolution + hours + cap)', () => {
    // Exercises the FULL production path in one test: appointmentTypeId ->
    // resolveAppointmentType -> loadAppointmentTypes() Core fetch -> type
    // lookup by id -> threaded into findNextAvailableSlot -> isSlotAvailable
    // -> effectiveHoursForType + hasConflict's capacity branch. Every other
    // test above passes a pre-resolved type object directly, which proves
    // the hours/cap MATH is right but not that a real appointmentTypeId
    // actually resolves and reaches it (the exact class of wiring gap
    // NEW-259 was).
    it('offers avoid a same-type capped window and stay inside the type-narrowed hours', async () => {
      // 2026-08-31 is a Monday. Business hours: Mon 09:00-17:00. The type
      // narrows Monday to 10:00-12:00 and caps at 1 concurrent — an existing
      // confirmed same-type appointment 10:00-10:30 (+15min buffer either
      // side) occupies the type's cap through 10:45.
      fetchSpy.mockImplementation(async (url, init = {}) => {
        const method = init.method || 'GET';
        const pathname = url.pathname;
        if (pathname === '/api/v1/appointment-types' && method === 'GET') {
          return mockResponse(200, {
            appointment_types: [
              { id: 1, name: 'Consultation', active: 1, max_concurrent: 1, scheduling_hours: { mon: { start: '10:00', end: '12:00' } } }
            ]
          });
        }
        if (pathname === '/api/v1/schedule-config' && method === 'GET') {
          return mockResponse(200, {
            schedule_config: {
              working_hours: { mon: { start: '09:00', end: '17:00' } },
              buffer_minutes: 15,
              default_duration_minutes: 30,
              booking_window_days: 30
            }
          });
        }
        if (pathname === '/api/v1/appointments' && method === 'GET') {
          return mockResponse(200, {
            appointments: [
              {
                id: 1, external_id: 'appt_1', status: 'confirmed', appointment_type_id: 1,
                // Local wall-clock 10:00-10:30 on 2026-08-31, stored as the
                // ISO string loadCalendar would actually hand back (same
                // pattern the rest of this file uses: `new Date(...).toISOString()`
                // rather than a hand-typed "Z" literal, so this test is
                // timezone-independent).
                start_time: new Date('2026-08-31T10:00:00').toISOString(),
                end_time: new Date('2026-08-31T10:30:00').toISOString()
              }
            ]
          });
        }
        return mockResponse(404, { error: `unhandled in test mock: ${method} ${pathname}` });
      });

      const afterDate = new Date('2026-08-31T00:00:00');
      const offers = await calendar.generateOfferSlots({
        durationMinutes: 30, afterDate, count: 2, appointmentTypeId: 1
      });

      expect(offers).toHaveLength(2);
      // Both offers land after the buffered-cap window (10:45) and inside
      // the type's 10:00-12:00 narrowed hours -- neither the raw business
      // hours (09:00-17:00) nor "no cap at all" would produce this result.
      expect(offers[0].start.getHours()).toBe(10);
      expect(offers[0].start.getMinutes()).toBe(45);
      expect(offers[0].end.getHours()).toBe(11);
      expect(offers[0].end.getMinutes()).toBe(15);
      expect(offers[1].start.getHours()).toBe(11);
      expect(offers[1].start.getMinutes()).toBe(30);
      expect(offers[1].end.getHours()).toBe(12);
      expect(offers[1].end.getMinutes()).toBe(0);
    });
  });
});
