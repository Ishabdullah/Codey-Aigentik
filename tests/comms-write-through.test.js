// tests/comms-write-through.test.js — Unit tests for communications logging write-through and retry queue

import fs from 'fs';
import path from 'path';
import os from 'os';
import { jest } from '@jest/globals';
import { EmailProvider } from '../email-provider.js';

describe('Comms Write-Through & Reliable Retry Queue', () => {
  let provider;
  let tmpDir;
  let fetchSpy;
  let mockTransporter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-test-'));
    fetchSpy = jest.spyOn(global, 'fetch');

    provider = new EmailProvider({
      config: {
        gmail: {
          email: 'test@gmail.com',
          app_password: 'testpassword',
          imap_host: 'imap.gmail.com',
          imap_port: 993,
          smtp_host: 'smtp.gmail.com',
          smtp_port: 587
        },
        aigentik_name: 'TestAgent',
        paths: {
          data_dir: tmpDir,
          logs_dir: path.join(tmpDir, 'logs'),
          conversations_dir: path.join(tmpDir, 'conversations')
        },
        core_api: {
          base_url: 'http://127.0.0.1:8770',
          token: 'test-token-123'
        }
      }
    });

    mockTransporter = {
      sendMail: jest.fn().mockResolvedValue({
        messageId: '<test-msg-id-123@example.com>'
      }),
      close: jest.fn()
    };
    provider.getTransporter = () => mockTransporter;
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    if (provider) {
      provider.isShuttingDown = true;
      try {
        await provider.disconnect();
      } catch (e) {
        // Ignore
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  describe('Outbound logging', () => {
    it('logs outbound email when sendEmail is called', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        communication: { id: 1, channel: 'email', direction: 'outbound' }
      }));

      const result = await provider.sendEmail('customer@example.com', 'Subject A', 'Hello world');
      expect(result).toBe(true);
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('http://127.0.0.1:8770/api/v1/communications');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer test-token-123');

      const body = JSON.parse(options.body);
      expect(body).toMatchObject({
        channel: 'email',
        direction: 'outbound',
        content: 'Hello world',
        subject: 'Subject A',
        from_email: 'customer@example.com',
        provider_message_id: '<test-msg-id-123@example.com>'
      });
    });

    it('logs outbound SMS when replyToGoogleVoiceText is called', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        communication: { id: 2, channel: 'sms', direction: 'outbound' }
      }));

      const voiceMsg = {
        sender_name: 'John Doe',
        sender_phone: '8025551234',
        reply_to_email: 'relay-123@txt.voice.google.com',
        original_subject: 'New text message from John Doe (802) 555-1234'
      };

      const result = await provider.replyToGoogleVoiceText(voiceMsg, 'Sure, see you at 2pm.');
      expect(result).toBe(true);
      expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('http://127.0.0.1:8770/api/v1/communications');

      const body = JSON.parse(options.body);
      expect(body).toMatchObject({
        channel: 'sms',
        direction: 'outbound',
        content: 'Sure, see you at 2pm.',
        subject: 'Re: New text message from John Doe (802) 555-1234',
        from_email: 'relay-123@txt.voice.google.com',
        provider_message_id: '<test-msg-id-123@example.com>',
        metadata: { sender_phone: '8025551234' }
      });
    });
  });

  describe('Inbound logging in handleNewMail', () => {
    it('logs inbound regular email', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        communication: { id: 3, channel: 'email', direction: 'inbound' }
      }));

      provider.startupTime = new Date(Date.now() - 60000);
      provider.imapClient = {
        fetch: async function*() {
          yield { uid: 10, source: 'raw-source' };
        },
        messageFlagsAdd: jest.fn().mockResolvedValue()
      };
      provider.parseMessage = jest.fn().mockResolvedValue({
        from_email: 'client@example.com',
        subject: 'Inquiry',
        body: 'Can I get a quote?',
        date: new Date(),
        message_id: '<inbound-msg-001@example.com>'
      });
      provider.onNewMailCallback = jest.fn().mockResolvedValue();

      await provider.handleNewMail();

      expect(provider.onNewMailCallback).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('http://127.0.0.1:8770/api/v1/communications');

      const body = JSON.parse(options.body);
      expect(body).toMatchObject({
        channel: 'email',
        direction: 'inbound',
        content: 'Can I get a quote?',
        subject: 'Inquiry',
        from_email: 'client@example.com',
        provider_message_id: '<inbound-msg-001@example.com>'
      });
    });

    it('logs inbound Google Voice text as channel sms', async () => {
      fetchSpy.mockResolvedValue(mockResponse(201, {
        communication: { id: 4, channel: 'sms', direction: 'inbound' }
      }));

      provider.startupTime = new Date(Date.now() - 60000);
      provider.imapClient = {
        fetch: async function*() {
          yield { uid: 11, source: 'raw-source-gv' };
        },
        messageFlagsAdd: jest.fn().mockResolvedValue()
      };
      provider.parseMessage = jest.fn().mockResolvedValue({
        from_email: 'gv-relay@txt.voice.google.com',
        subject: 'New text message from (802) 555-9876',
        body: 'Hello, need emergency service!',
        date: new Date(),
        message_id: '<gv-msg-002@example.com>'
      });
      provider.onNewMailCallback = jest.fn().mockResolvedValue();

      await provider.handleNewMail();

      expect(provider.onNewMailCallback).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe('http://127.0.0.1:8770/api/v1/communications');

      const body = JSON.parse(options.body);
      expect(body).toMatchObject({
        channel: 'sms',
        direction: 'inbound',
        content: 'Hello, need emergency service!',
        from_email: 'gv-relay@txt.voice.google.com',
        provider_message_id: '<gv-msg-002@example.com>',
        metadata: { sender_phone: '8025559876' }
      });
    });
  });

  describe('Retry queue & error handling', () => {
    it('enqueues to retry queue when Core POST fails with 500 (sendEmail still succeeds)', async () => {
      fetchSpy.mockResolvedValue(mockResponse(500, { error: 'Internal Core Error' }));

      const result = await provider.sendEmail('client2@example.com', 'Subject 500', 'Body text');
      expect(result).toBe(true); // Must never throw on comms logging failure

      const retryFile = path.join(tmpDir, 'communications-retry.json');
      expect(fs.existsSync(retryFile)).toBe(true);

      const queue = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({
        channel: 'email',
        direction: 'outbound',
        from_email: 'client2@example.com',
        subject: 'Subject 500',
        content: 'Body text',
        provider_message_id: '<test-msg-id-123@example.com>'
      });
      expect(queue[0].first_attempt_at).toBeDefined();
    });

    it('enqueues to retry queue on network failure without throwing', async () => {
      fetchSpy.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

      const result = await provider.sendEmail('client3@example.com', 'Subject Net', 'Body net');
      expect(result).toBe(true);

      const retryFile = path.join(tmpDir, 'communications-retry.json');
      const queue = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
      expect(queue).toHaveLength(1);
      expect(queue[0].from_email).toBe('client3@example.com');
    });

    it('deduplicates items in retry queue on provider_message_id', () => {
      const item1 = {
        channel: 'email',
        direction: 'outbound',
        content: 'Try 1',
        provider_message_id: '<dup-msg-id-1>'
      };
      const item2 = {
        channel: 'email',
        direction: 'outbound',
        content: 'Try 2 (dup)',
        provider_message_id: '<dup-msg-id-1>'
      };

      const added1 = provider.enqueueCommsRetry(item1);
      const added2 = provider.enqueueCommsRetry(item2);

      expect(added1).toBe(true);
      expect(added2).toBe(false);

      const retryFile = path.join(tmpDir, 'communications-retry.json');
      const queue = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
      expect(queue).toHaveLength(1);
      expect(queue[0].content).toBe('Try 1');
    });

    it('drains retry queue on handleNewMail with 2xx success', async () => {
      // Setup retry queue with 2 items
      provider.enqueueCommsRetry({
        channel: 'email',
        direction: 'outbound',
        content: 'Queued item 1',
        provider_message_id: '<queued-1>'
      });
      provider.enqueueCommsRetry({
        channel: 'email',
        direction: 'outbound',
        content: 'Queued item 2',
        provider_message_id: '<queued-2>'
      });

      fetchSpy.mockResolvedValue(mockResponse(201, { communication: { id: 99 } }));

      // Empty IMAP inbox
      provider.startupTime = new Date();
      provider.imapClient = {
        fetch: async function*() {},
        messageFlagsAdd: jest.fn().mockResolvedValue()
      };
      provider.onNewMailCallback = jest.fn().mockResolvedValue();

      await provider.handleNewMail();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const retryFile = path.join(tmpDir, 'communications-retry.json');
      const queue = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
      expect(queue).toHaveLength(0);
    });

    it('isolates queue errors: drops 400 item, stops drain on 500 error', async () => {
      // Setup 3 items in queue
      provider.enqueueCommsRetry({
        channel: 'email',
        direction: 'outbound',
        content: 'Invalid item that causes 400',
        provider_message_id: '<item-400>'
      });
      provider.enqueueCommsRetry({
        channel: 'email',
        direction: 'outbound',
        content: 'Item that hits 500',
        provider_message_id: '<item-500>'
      });
      provider.enqueueCommsRetry({
        channel: 'email',
        direction: 'outbound',
        content: 'Item 3 waiting after 500',
        provider_message_id: '<item-after>'
      });

      fetchSpy
        .mockResolvedValueOnce(mockResponse(400, { error: 'Bad Request' }))
        .mockResolvedValueOnce(mockResponse(500, { error: 'Server Crash' }));

      const drainResult = await provider.drainCommsRetryQueue();

      expect(drainResult.drained).toBe(1); // Item 1 dropped on 400
      expect(drainResult.remaining).toBe(2); // Items 2 and 3 preserved
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const retryFile = path.join(tmpDir, 'communications-retry.json');
      const queue = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
      expect(queue).toHaveLength(2);
      expect(queue[0].provider_message_id).toBe('<item-500>');
      expect(queue[1].provider_message_id).toBe('<item-after>');
    });
  });
});
