// tests/do-not-contact.test.js — Unit tests for the do-not-contact
// suppression list. Converted from local-JSON I/O to Restoricon Core
// write-through calls in B2 task 4 (CODEY_MASTER_PLAN.md §6.4) — these
// tests mock the Core API's HTTP responses via `global.fetch` rather than
// mocking the filesystem, since every I/O function is now an async HTTP
// call. `classifyIdentifier`'s pure-function behavior (which of these
// resolve to `null`/`false` without ever calling `fetch`) is asserted
// directly, since it's the one piece of this module that stayed
// synchronous and local through the cutover.

import { jest } from '@jest/globals';
import * as doNotContact from '../do-not-contact.js';

describe('do-not-contact (Core write-through)', () => {
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

  describe('detectOptOutRequest (pure, no I/O)', () => {
    it('matches known opt-out phrasing', () => {
      expect(doNotContact.detectOptOutRequest('please stop texting me')).toBe(true);
      expect(doNotContact.detectOptOutRequest('Remove me from your list ASAP')).toBe(true);
    });

    it('does not match unrelated text', () => {
      expect(doNotContact.detectOptOutRequest('what is your availability tomorrow?')).toBe(false);
    });

    it('never calls fetch', () => {
      doNotContact.detectOptOutRequest('stop texting me');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('isBlocked', () => {
    it('returns false without calling fetch for an unclassifiable identifier', async () => {
      expect(await doNotContact.isBlocked('not-an-identifier')).toBe(false);
      expect(await doNotContact.isBlocked('')).toBe(false);
      expect(await doNotContact.isBlocked(null)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('calls GET /api/v1/do-not-contact/check and returns the blocked flag', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { blocked: true }));
      const result = await doNotContact.isBlocked('someone@example.com');
      expect(result).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/do-not-contact/check');
      expect(String(url)).toContain('identifier=someone%40example.com');
      expect(options.headers.Authorization).toMatch(/^Bearer /);
    });

    it('throws instead of silently returning false on a Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(doNotContact.isBlocked('someone@example.com')).rejects.toThrow();
    });

    it('throws (never returns undefined-as-blocked) on a 200 with an unparseable body', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }
      });
      await expect(doNotContact.isBlocked('someone@example.com')).rejects.toThrow();
    });
  });

  describe('addToDoNotContact', () => {
    it('returns null without calling fetch for an unclassifiable identifier', async () => {
      expect(await doNotContact.addToDoNotContact({ identifier: 'nope' })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs to /api/v1/do-not-contact and returns the created entry', async () => {
      const entry = {
        id: 1, type: 'email', value: 'a@b.com', original: 'a@b.com',
        name: 'A', reason: 'asked to be removed', source: 'auto',
        added_at: '2026-08-27T00:00:00Z'
      };
      fetchSpy.mockResolvedValue(mockResponse(201, { do_not_contact: entry }));
      const result = await doNotContact.addToDoNotContact({ identifier: 'a@b.com', name: 'A' });
      expect(result).toEqual(entry);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/do-not-contact');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toMatchObject({ identifier: 'a@b.com', name: 'A' });
    });

    it('returns null (not a throw) when Core responds 400', async () => {
      fetchSpy.mockResolvedValue(mockResponse(400, { error: 'Identifier could not be classified' }));
      // classifyIdentifier already accepts this locally (it's a valid-shaped
      // email), so the call reaches Core and Core's own 400 is what maps to null.
      const result = await doNotContact.addToDoNotContact({ identifier: 'a@b.com' });
      expect(result).toBeNull();
    });

    it('throws on a non-400 Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(doNotContact.addToDoNotContact({ identifier: 'a@b.com' })).rejects.toThrow();
    });
  });

  describe('removeFromDoNotContact', () => {
    it('returns false without calling fetch for an unclassifiable identifier', async () => {
      expect(await doNotContact.removeFromDoNotContact('nope')).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs to /api/v1/do-not-contact/remove and returns the removed flag', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { removed: true }));
      const result = await doNotContact.removeFromDoNotContact('a@b.com');
      expect(result).toBe(true);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/do-not-contact/remove');
      expect(options.method).toBe('POST');
    });

    it('returns false when Core reports nothing was removed', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { removed: false }));
      expect(await doNotContact.removeFromDoNotContact('a@b.com')).toBe(false);
    });

    it('throws on a Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(doNotContact.removeFromDoNotContact('a@b.com')).rejects.toThrow();
    });
  });

  describe('listDoNotContact / loadEntries', () => {
    it('formats an empty list', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { do_not_contact: [] }));
      expect(await doNotContact.listDoNotContact()).toBe('🚫 Do-not-contact list is empty.');
    });

    it('formats a populated list matching the pre-write-through numbering/format', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        do_not_contact: [
          { name: 'Alice', original: 'alice@example.com', reason: 'asked to stop' },
          { name: null, original: '5551234567', reason: 'blocked by owner' }
        ]
      }));
      const result = await doNotContact.listDoNotContact();
      expect(result).toBe(
        '🚫 Do-Not-Contact list (2):\n' +
        '1. Alice — alice@example.com (asked to stop)\n' +
        '2. 5551234567 (blocked by owner)'
      );
    });

    it('loadEntries throws on a Core failure rather than returning an empty list', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(doNotContact.loadEntries()).rejects.toThrow();
    });
  });
});
