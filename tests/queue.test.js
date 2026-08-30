// tests/queue.test.js — Unit tests for pending review queue

import fs from 'fs';
import path from 'path';
import os from 'os';
import * as queue from '../queue.js';

describe('queue (Pending Review Queue)', () => {
  let tmpQueueFile;

  beforeEach(() => {
    tmpQueueFile = path.join(os.tmpdir(), `test_queue_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    queue.setQueueFilePath(tmpQueueFile);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpQueueFile)) {
        fs.unlinkSync(tmpQueueFile);
      }
    } catch (e) {}
    queue.setQueueFilePath(null);
  });

  it('starts with an empty queue', () => {
    expect(queue.listQueue()).toEqual([]);
  });

  it('adds items with incrementing display_ids', () => {
    const item1 = queue.addToQueue({
      type: 'email',
      sender: 'user1@example.com',
      senderName: 'User One',
      subject: 'Question',
      body: 'Hello',
      draftReply: 'Hi'
    });
    expect(item1.display_id).toBe(1);
    expect(item1.sender).toBe('user1@example.com');
    expect(item1.status).toBe('pending');

    const item2 = queue.addToQueue({
      type: 'sms',
      sender: '8605551234',
      body: 'Text message',
      draftReply: 'Sure'
    });
    expect(item2.display_id).toBe(2);

    const items = queue.listQueue();
    expect(items.length).toBe(2);
  });

  it('gets item by display_id', () => {
    queue.addToQueue({ type: 'email', sender: 'test@example.com', subject: 'Subject' });
    const item = queue.getItem(1);
    expect(item).not.toBeNull();
    expect(item.display_id).toBe(1);
    expect(item.sender).toBe('test@example.com');

    expect(queue.getItem(999)).toBeNull();
  });

  it('updates draft reply for an item', () => {
    queue.addToQueue({ type: 'email', sender: 'test@example.com', draftReply: 'Old draft' });
    const updated = queue.updateDraft(1, 'New updated draft');
    expect(updated).toBe(true);

    const item = queue.getItem(1);
    expect(item.draft_reply).toBe('New updated draft');
    expect(item.draft_edited).toBe(true);
  });

  it('removes item by display_id', () => {
    queue.addToQueue({ type: 'email', sender: 'test@example.com' });
    expect(queue.listQueue().length).toBe(1);

    const removed = queue.removeItem(1);
    expect(removed).toBe(true);
    expect(queue.listQueue().length).toBe(0);

    expect(queue.removeItem(999)).toBe(false);
  });

  it('formats queue for SMS display', () => {
    expect(queue.formatQueueForSms()).toContain('No pending items');

    queue.addToQueue({
      type: 'email',
      sender: 'alice@example.com',
      senderName: 'Alice',
      subject: 'Estimate Inquiry'
    });
    const formatted = queue.formatQueueForSms();
    expect(formatted).toContain('1 pending item');
    expect(formatted).toContain('#1 ✉️ From: Alice');
    expect(formatted).toContain('Estimate Inquiry');
  });

  it('formatItemForSms provides detailed item preview', () => {
    const item = queue.addToQueue({
      type: 'sms',
      sender: '8605551234',
      senderName: 'Bob',
      body: 'Can you come by at 2pm?',
      draftReply: 'Yes, see you then.'
    });

    const sms = queue.formatItemForSms(item);
    expect(sms).toContain('Item #1');
    expect(sms).toContain('From: Bob');
    expect(sms).toContain('Message: Can you come by at 2pm?');
    expect(sms).toContain('Draft reply: Yes, see you then.');
  });
});
