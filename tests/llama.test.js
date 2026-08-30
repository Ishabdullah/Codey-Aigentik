// tests/llama.test.js — Unit tests for AI model-layer admission routing & proxy
import { jest } from '@jest/globals';
import config from '../config.json' with { type: 'json' };
import * as llama from '../llama.js';

describe('llama (Core API Model-Layer Admission Routing)', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    // Ensure default provider is local
    if (!config.llm) config.llm = {};
    config.llm.provider = 'local';
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

  describe('chatLocal via Core API /api/v1/ai/chat proxy', () => {
    it('routes requests to POST /api/v1/ai/chat with required budget & admission fields', async () => {
      const mockResult = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '  Hello! I am ready to help.  '
            }
          }
        ]
      };
      fetchSpy.mockResolvedValue(mockResponse(200, mockResult));

      const messages = [{ role: 'user', content: 'Hello' }];
      const text = await llama.chatLocal(messages, 256);

      expect(text).toBe('Hello! I am ready to help.');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/ai/chat');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers.Authorization).toBe(`Bearer ${config.core_api.token}`);

      const reqBody = JSON.parse(options.body);
      expect(reqBody.model).toBe(config.llama.model);
      expect(reqBody.messages).toEqual(messages);
      expect(reqBody.max_tokens).toBe(256);
      expect(reqBody.temperature).toBe(config.llama.temperature);
      expect(reqBody.enable_thinking).toBe(false);
    });

    it('throws when Core API returns 429 admission refusal', async () => {
      fetchSpy.mockResolvedValue(mockResponse(429, {
        error: 'AI model context-budget admission refused: Queue capacity exceeded'
      }));

      const messages = [{ role: 'user', content: 'Heavy query' }];
      await expect(llama.chatLocal(messages, 512)).rejects.toThrow(
        /Core AI proxy returned 429: AI model context-budget admission refused/
      );
    });

    it('throws when Core API returns 502/503 upstream error', async () => {
      fetchSpy.mockResolvedValue(mockResponse(502, {
        error: 'AI completion upstream error: Connection refused'
      }));

      const messages = [{ role: 'user', content: 'Hi' }];
      await expect(llama.chatLocal(messages, 100)).rejects.toThrow(
        /Core AI proxy returned 502: AI completion upstream error/
      );
    });

    it('throws when Core API returns empty content or empty choices', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, { choices: [{ message: { content: '   ' } }] }));

      const messages = [{ role: 'user', content: 'Hi' }];
      await expect(llama.chatLocal(messages, 100)).rejects.toThrow(
        /Empty response from Core AI proxy/
      );
    });

    it('throws on network timeout / fetch rejection', async () => {
      fetchSpy.mockRejectedValue(new Error('Network timeout'));

      const messages = [{ role: 'user', content: 'Hi' }];
      await expect(llama.chatLocal(messages, 100)).rejects.toThrow(
        /Network timeout/
      );
    });
  });

  describe('chat dispatcher & provider selection', () => {
    it('dispatches to chatLocal when provider is local', async () => {
      llama.setLlmProvider('local');
      fetchSpy.mockResolvedValue(mockResponse(200, {
        choices: [{ message: { content: 'local response' } }]
      }));

      const res = await llama.chat([{ role: 'user', content: 'test' }], 50);
      expect(res).toBe('local response');
    });

    it('manages provider switching properly', () => {
      const prevGeminiKey = config.gemini?.api_key;
      config.gemini = config.gemini || {};
      config.gemini.api_key = 'test-key';

      const switchResult = llama.setLlmProvider('gemini');
      expect(switchResult.ok).toBe(true);
      expect(llama.getLlmProvider()).toBe('gemini');

      const invalidSwitch = llama.setLlmProvider('invalid-provider');
      expect(invalidSwitch.ok).toBe(false);
      expect(llama.getLlmProvider()).toBe('gemini');

      llama.setLlmProvider('local');
      expect(llama.getLlmProvider()).toBe('local');

      config.gemini.api_key = prevGeminiKey;
    });
  });

  describe('warmUp', () => {
    it('returns true when warm-up chat succeeds', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        choices: [{ message: { content: 'ready' } }]
      }));

      const ok = await llama.warmUp();
      expect(ok).toBe(true);
    });

    it('returns false when warm-up chat fails', async () => {
      fetchSpy.mockRejectedValue(new Error('Core API down'));

      const ok = await llama.warmUp();
      expect(ok).toBe(false);
    });
  });
});
