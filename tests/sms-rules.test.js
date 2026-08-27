// tests/sms-rules.test.js — Unit tests for the SMS rule engine.
// Converted from local-JSON I/O to Restoricon Core write-through calls in
// B2 task 4 (CODEY_MASTER_PLAN.md §6.4) — these tests mock the Core API's
// HTTP responses via `global.fetch`, following do-not-contact.test.js's
// established pattern.
//
// The rule-precedence and channel-isolation assertions this module's spec
// calls for are NOT done here with a mocked fetch — see
// tests/email-rules.test.js's header for why; they're verified against a
// real live Core server instead (see the round's live-verification
// output).

import { jest } from '@jest/globals';
import * as smsRules from '../sms-rules.js';

describe('sms-rules (Core write-through)', () => {
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

  describe('loadRules', () => {
    it('GETs /api/v1/automation-rules with channel=sms and a high limit', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { automation_rules: [] }));
      await smsRules.loadRules();
      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/automation-rules');
      expect(String(url)).toContain('channel=sms');
      expect(String(url)).toContain('limit=1000');
    });

    it('throws instead of silently returning an empty list on a Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(smsRules.loadRules()).rejects.toThrow();
    });
  });

  describe('addRule', () => {
    it('POSTs to /api/v1/automation-rules with a client-generated sr_ external_id', async () => {
      const created = {
        id: 1, external_id: 'sr_1234', channel: 'sms', description: 'block spam number',
        condition_type: 'from_number', condition_value: '5551234567', action: 'spam',
        added_by: 'owner', match_count: 0
      };
      fetchSpy.mockResolvedValue(mockResponse(201, { automation_rule: created }));
      const result = await smsRules.addRule({
        description: 'block spam number', condition_type: 'from_number', condition_value: '5551234567', action: 'spam'
      });
      expect(result).toEqual(created);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/automation-rules');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.channel).toBe('sms');
      expect(body.external_id).toMatch(/^sr_\d+$/);
    });

    it('throws on a Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(smsRules.addRule({ description: 'x', condition_type: 'from_number', action: 'spam' })).rejects.toThrow();
    });
  });

  describe('removeRule', () => {
    it('resolves the identifier client-side then deletes by real id', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          automation_rules: [
            { id: 9, external_id: 'sr_888', description: 'block spam number', action: 'spam' }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, { deleted: true }));

      const result = await smsRules.removeRule('spam number');
      expect(result).toBe(true);
      const [deleteUrl, deleteOptions] = fetchSpy.mock.calls[1];
      expect(String(deleteUrl)).toContain('/api/v1/automation-rules/9/delete');
      expect(deleteOptions.method).toBe('POST');
    });

    it('returns false without calling delete when no rule matches', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { automation_rules: [] }));
      const result = await smsRules.removeRule('nonexistent');
      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('throws on a delete Core failure', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { automation_rules: [{ id: 9, description: 'x', action: 'spam' }] }))
        .mockResolvedValueOnce(mockResponse(500, { error: 'boom' }));
      await expect(smsRules.removeRule('x')).rejects.toThrow();
    });
  });

  describe('checkRules', () => {
    it('matches a from_number rule and calls POST .../match before returning', async () => {
      const rule = { id: 3, condition_type: 'from_number', condition_value: '5551234567', action: 'spam', description: 'block spam number' };
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { automation_rules: [rule] }))
        .mockResolvedValueOnce(mockResponse(200, { automation_rule: { ...rule, match_count: 1 } }));

      const result = await smsRules.checkRules({ address: '(555) 123-4567', body: 'hello' });
      expect(result).toEqual({ action: 'spam', rule });
      const [matchUrl, matchOptions] = fetchSpy.mock.calls[1];
      expect(String(matchUrl)).toContain('/api/v1/automation-rules/3/match');
      expect(matchOptions.method).toBe('POST');
    });

    it('matches a message_contains rule (real for SMS, unlike email)', async () => {
      const rule = { id: 4, condition_type: 'message_contains', condition_value: 'stop', action: 'review', description: 'flag stop requests' };
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { automation_rules: [rule] }))
        .mockResolvedValueOnce(mockResponse(200, { automation_rule: { ...rule, match_count: 1 } }));

      const result = await smsRules.checkRules({ address: '5559999999', body: 'please STOP texting me' });
      expect(result.action).toBe('review');
    });

    it('returns the default action when no rule matches', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { automation_rules: [] }));
      const result = await smsRules.checkRules({ address: '5551112222', body: 'hi' });
      expect(result).toEqual({ action: 'auto-reply', rule: null });
    });

    it('throws instead of silently defaulting on a Core list failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500, { error: 'boom' }));
      await expect(smsRules.checkRules({ address: '5551112222', body: 'hi' })).rejects.toThrow();
    });
  });

  describe('listRulesForSms', () => {
    it('formats an empty list', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { automation_rules: [] }));
      const result = await smsRules.listRulesForSms();
      expect(result).toContain('No SMS rules set yet');
    });

    it('formats a populated list', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        automation_rules: [{ action: 'spam', description: 'block spam number' }]
      }));
      const result = await smsRules.listRulesForSms();
      expect(result).toContain('SMS Rules (1)');
      expect(result).toContain('[SPAM] block spam number');
    });
  });
});
