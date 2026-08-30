// tests/contacts-sync.test.js — Unit tests for Aigentik Android contacts sync
// (Track B Phase B2 cutover: Restoricon Core API write-through)

import { jest } from '@jest/globals';
import * as contactsSync from '../contacts-sync.js';

describe('contacts-sync (Restoricon Core write-through)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    contactsSync.setFetchAndroidContactsForTest(null);
  });

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  describe('syncContacts', () => {
    it('returns zeroes when fetchAndroidContacts finds no contacts', async () => {
      contactsSync.setFetchAndroidContactsForTest(() => []);
      const result = await contactsSync.syncContacts();
      expect(result.android).toBe(0);
      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
    });

    it('posts contacts payload to Core API and returns stats', async () => {
      contactsSync.setFetchAndroidContactsForTest(() => [
        { name: 'Diana Prince', number: '8609990001' },
        { name: 'Clark Kent', number: '8609990002' }
      ]);

      fetchSpy.mockResolvedValue(mockResponse(200, {
        status: 'ok',
        stats: {
          android: 2,
          added: 1,
          updated: 1,
          total: 10
        }
      }));

      const result = await contactsSync.syncContacts();

      expect(result.android).toBe(2);
      expect(result.added).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.total).toBe(10);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          href: expect.stringContaining('/api/v1/contacts/sync')
        }),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Diana Prince')
        })
      );
    });
  });

  describe('startAutoSync', () => {
    it('runs initial sync on startup', async () => {
      contactsSync.setFetchAndroidContactsForTest(() => []);
      const result = await contactsSync.startAutoSync();
      expect(result).toBeDefined();
      expect(typeof result.total).toBe('number');
    });
  });
});
