// tests/email-rules.test.js — Unit tests for the email rule engine.
// Converted from local-JSON I/O to Restoricon Core write-through calls in
// B2 task 4 (CODEY_MASTER_PLAN.md §6.4) — these tests mock the Core API's
// HTTP responses via `global.fetch`, following do-not-contact.test.js's
// established pattern. `isPromotional`'s pure-function behavior is
// asserted directly, since it's the one piece of this module that stayed
// synchronous and local through the cutover.
//
// The rule-precedence and channel-isolation assertions this module's spec
// calls for are NOT done here with a mocked fetch — a mock returns
// whatever order the test author hardcodes, so it can't actually verify
// list_rules's real `ORDER BY id DESC` or routes.py's real `channel`
// query-param filtering. Those two properties are verified against a real
// live Core server instead — see the round's live-verification output.

import { jest } from '@jest/globals';
import * as emailRules from '../email-rules.js';

describe('email-rules (Core write-through)', () => {
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

  describe('isPromotional (pure, no I/O)', () => {
    it('detects known promotional keywords', () => {
      expect(emailRules.isPromotional({ from: 'deals@shop.com', subject: 'Big Sale!', body: '' })).toBe(true);
      expect(emailRules.isPromotional({ from: 'friend@example.com', subject: 'Hi', body: 'lunch tomorrow?' })).toBe(false);
    });

    it('never calls fetch', () => {
      emailRules.isPromotional({ from: 'a@b.com', subject: '', body: '' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('loadRules', () => {
    it('GETs /api/v1/automation-rules with channel=email and a high limit', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { automation_rules: [] }));
      await emailRules.loadRules();
      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/automation-rules');
      expect(String(url)).toContain('channel=email');
      expect(String(url)).toContain('limit=1000');
    });

    it('throws instead of silently returning an empty list on a Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(emailRules.loadRules()).rejects.toThrow();
    });
  });

  describe('addRule', () => {
    it('POSTs to /api/v1/automation-rules with a client-generated er_ external_id', async () => {
      const created = {
        id: 1, external_id: 'er_1234', channel: 'email', description: 'spam amazon',
        condition_type: 'domain', condition_value: 'amazon.com', action: 'spam',
        added_by: 'owner', match_count: 0
      };
      fetchSpy.mockResolvedValue(mockResponse(201, { automation_rule: created }));
      const result = await emailRules.addRule({
        description: 'spam amazon', condition_type: 'domain', condition_value: 'amazon.com', action: 'spam'
      });
      expect(result).toEqual(created);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/automation-rules');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.channel).toBe('email');
      expect(body.external_id).toMatch(/^er_\d+$/);
      expect(body.condition_value).toBe('amazon.com');
    });

    it('throws on a Core failure', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'boom' }));
      await expect(emailRules.addRule({ description: 'x', condition_type: 'from', action: 'spam' })).rejects.toThrow();
    });
  });

  describe('removeRule', () => {
    it('resolves the identifier client-side (id, external_id, or description substring) then deletes by real id', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          automation_rules: [
            { id: 5, external_id: 'er_999', description: 'Mark CarGurus emails as spam', action: 'spam' }
          ]
        }))
        .mockResolvedValueOnce(mockResponse(200, { deleted: true }));

      const result = await emailRules.removeRule('cargurus');
      expect(result).toBe(true);
      const [deleteUrl, deleteOptions] = fetchSpy.mock.calls[1];
      expect(String(deleteUrl)).toContain('/api/v1/automation-rules/5/delete');
      expect(deleteOptions.method).toBe('POST');
    });

    it('returns false without calling delete when no rule matches', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { automation_rules: [] }));
      const result = await emailRules.removeRule('nonexistent');
      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('throws on a delete Core failure', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { automation_rules: [{ id: 5, description: 'x', action: 'spam' }] }))
        .mockResolvedValueOnce(mockResponse(500, { error: 'boom' }));
      await expect(emailRules.removeRule('x')).rejects.toThrow();
    });
  });

  describe('checkRules', () => {
    it('matches a rule and calls POST .../match before returning', async () => {
      const rule = { id: 7, condition_type: 'from', condition_value: 'boss@company.com', action: 'review', description: 'flag boss' };
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { automation_rules: [rule] }))
        .mockResolvedValueOnce(mockResponse(200, { automation_rule: { ...rule, match_count: 1 } }));

      const result = await emailRules.checkRules({ from: 'boss@company.com', subject: 'hi', body: '' });
      expect(result).toEqual({ action: 'review', rule, reason: 'flag boss' });
      const [matchUrl, matchOptions] = fetchSpy.mock.calls[1];
      expect(String(matchUrl)).toContain('/api/v1/automation-rules/7/match');
      expect(matchOptions.method).toBe('POST');
    });

    it('has no message_contains case (NEW-228) — such a rule never matches', async () => {
      const deadRule = { id: 9, condition_type: 'message_contains', condition_value: 'spam', action: 'spam', description: 'dead rule' };
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { automation_rules: [deadRule] }));

      const result = await emailRules.checkRules({ from: 'x@y.com', subject: '', body: 'this is spam' });
      expect(result.action).toBe('auto-reply'); // falls through to default, never matches
      expect(result.rule).toBeNull();
      // Only the list call happened -- no /match call for the dead rule.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns the default action when no rule matches', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(200, { automation_rules: [] }));
      const result = await emailRules.checkRules({ from: 'nobody@example.com', subject: '', body: '' });
      expect(result).toEqual({ action: 'auto-reply', rule: null, reason: 'default' });
    });

    it('throws instead of silently defaulting on a Core list failure', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(500, { error: 'boom' }));
      await expect(emailRules.checkRules({ from: 'a@b.com' })).rejects.toThrow();
    });
  });

  describe('listRulesForSms', () => {
    it('formats an empty list', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { automation_rules: [] }));
      const result = await emailRules.listRulesForSms();
      expect(result).toContain('No email rules set');
    });

    it('formats a populated list', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        automation_rules: [
          { action: 'spam', description: 'Mark CarGurus emails as spam' }
        ]
      }));
      const result = await emailRules.listRulesForSms();
      expect(result).toContain('Email Rules (1)');
      expect(result).toContain('[SPAM] Mark CarGurus emails as spam');
    });
  });
});
