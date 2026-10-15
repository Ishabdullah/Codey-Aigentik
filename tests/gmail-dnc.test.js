// tests/gmail-dnc.test.js — NEW-927/928 (WP2.1 group 8): do-not-contact
// choke point added inside gmail.js's sendEmail/sendCalendarInvite/
// sendCalendarCancellation wrappers. Mocks ../email-provider.js and
// ../do-not-contact.js the same way tests/http-server.test.js does
// (jest.unstable_mockModule, then a dynamic import of the module under
// test), since gmail.js is a thin ESM wrapper around both.
import { jest } from '@jest/globals';
import config from '../config.json' with { type: 'json' };

const sendEmailMock = jest.fn(async () => true);
const sendReplyMock = jest.fn(async () => true);
const sendOwnerNotificationMock = jest.fn(async () => true);
const sendCalendarInviteMock = jest.fn(async () => true);
const sendCalendarCancellationMock = jest.fn(async () => true);

jest.unstable_mockModule('../email-provider.js', () => ({
  getEmailProvider: () => ({
    sendEmail: sendEmailMock,
    sendReply: sendReplyMock,
    sendOwnerNotification: sendOwnerNotificationMock,
    sendCalendarInvite: sendCalendarInviteMock,
    sendCalendarCancellation: sendCalendarCancellationMock
  })
}));

const isBlockedMock = jest.fn(async () => false);
jest.unstable_mockModule('../do-not-contact.js', () => ({
  isBlocked: isBlockedMock
}));

const gmail = await import('../gmail.js');

describe('gmail.js do-not-contact choke point (NEW-927/928)', () => {
  beforeEach(() => {
    sendEmailMock.mockClear();
    sendReplyMock.mockClear();
    sendOwnerNotificationMock.mockClear();
    sendCalendarInviteMock.mockClear();
    sendCalendarCancellationMock.mockClear();
    isBlockedMock.mockClear();
    isBlockedMock.mockResolvedValue(false);
  });

  describe('sendCalendarInvite', () => {
    it('does not reach the provider for a do-not-contact-listed recipient, and returns false', async () => {
      isBlockedMock.mockResolvedValue(true);
      const result = await gmail.sendCalendarInvite({ id: 1, title: 'Appt' }, 'blocked@example.com', 'body');
      expect(result).toBe(false);
      expect(sendCalendarInviteMock).not.toHaveBeenCalled();
      expect(isBlockedMock).toHaveBeenCalledWith('blocked@example.com');
    });

    it('still sends exactly as before for a non-blocked recipient (regression)', async () => {
      const appt = { id: 1, title: 'Appt' };
      const result = await gmail.sendCalendarInvite(appt, 'ok@example.com', 'body');
      expect(result).toBe(true);
      expect(sendCalendarInviteMock).toHaveBeenCalledWith(appt, 'ok@example.com', 'body');
    });

    it('propagates (does not swallow) a Core-unreachable isBlocked() rejection — fail closed', async () => {
      isBlockedMock.mockRejectedValue(new Error('core down'));
      await expect(gmail.sendCalendarInvite({ id: 1 }, 'someone@example.com', 'body')).rejects.toThrow('core down');
      expect(sendCalendarInviteMock).not.toHaveBeenCalled();
    });
  });

  describe('sendCalendarCancellation', () => {
    it('does not reach the provider for a do-not-contact-listed recipient, and returns false', async () => {
      isBlockedMock.mockResolvedValue(true);
      const result = await gmail.sendCalendarCancellation({ id: 1, title: 'Appt' }, 'blocked@example.com', 'body');
      expect(result).toBe(false);
      expect(sendCalendarCancellationMock).not.toHaveBeenCalled();
    });

    it('still sends exactly as before for a non-blocked recipient (regression)', async () => {
      const appt = { id: 1, title: 'Appt' };
      const result = await gmail.sendCalendarCancellation(appt, 'ok@example.com', 'body');
      expect(result).toBe(true);
      expect(sendCalendarCancellationMock).toHaveBeenCalledWith(appt, 'ok@example.com', 'body');
    });

    it('propagates (does not swallow) a Core-unreachable isBlocked() rejection — fail closed', async () => {
      isBlockedMock.mockRejectedValue(new Error('core down'));
      await expect(gmail.sendCalendarCancellation({ id: 1 }, 'someone@example.com', 'body')).rejects.toThrow('core down');
      expect(sendCalendarCancellationMock).not.toHaveBeenCalled();
    });
  });

  describe('sendEmail', () => {
    it('throws and never reaches the provider for a do-not-contact-listed recipient', async () => {
      isBlockedMock.mockResolvedValue(true);
      await expect(gmail.sendEmail('blocked@example.com', 'subj', 'body')).rejects.toThrow(/do-not-contact/);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('still sends exactly as before for a non-blocked recipient (regression)', async () => {
      const result = await gmail.sendEmail('ok@example.com', 'subj', 'body', 'html');
      expect(result).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledWith('ok@example.com', 'subj', 'body', 'html');
    });

    it('propagates (does not swallow) a Core-unreachable isBlocked() rejection — fail closed', async () => {
      isBlockedMock.mockRejectedValue(new Error('core down'));
      await expect(gmail.sendEmail('someone@example.com', 'subj', 'body')).rejects.toThrow('core down');
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe('admin-address carve-out (NEW-927/928 warning 2)', () => {
    const adminEmail = config.owner?.admin_email || config.gmail.email;

    it('sendCalendarInvite still reaches the provider for the admin address even when isBlocked rejects (Core outage)', async () => {
      isBlockedMock.mockRejectedValue(new Error('core down'));
      const appt = { id: 1, title: 'Appt' };
      const result = await gmail.sendCalendarInvite(appt, adminEmail, 'body');
      expect(result).toBe(true);
      expect(sendCalendarInviteMock).toHaveBeenCalledWith(appt, adminEmail, 'body');
      expect(isBlockedMock).not.toHaveBeenCalled();
    });

    it('sendCalendarCancellation still reaches the provider for the admin address even when isBlocked rejects (Core outage)', async () => {
      isBlockedMock.mockRejectedValue(new Error('core down'));
      const appt = { id: 1, title: 'Appt' };
      const result = await gmail.sendCalendarCancellation(appt, adminEmail, 'body');
      expect(result).toBe(true);
      expect(sendCalendarCancellationMock).toHaveBeenCalledWith(appt, adminEmail, 'body');
      expect(isBlockedMock).not.toHaveBeenCalled();
    });

    it('non-admin recipients are still DNC-checked as before (regression)', async () => {
      isBlockedMock.mockResolvedValue(true);
      const result = await gmail.sendCalendarInvite({ id: 1 }, 'someone-else@example.com', 'body');
      expect(result).toBe(false);
      expect(isBlockedMock).toHaveBeenCalledWith('someone-else@example.com');
    });
  });

  describe('sendOwnerNotification — must stay completely unaffected', () => {
    it('calls straight through to the provider even when isBlocked would reject, and never calls isBlocked', async () => {
      // isBlocked is set to reject rather than resolve true/false, so this
      // test fails loudly (a thrown error) if a future change routes
      // sendOwnerNotification through a DNC check — a silent resolved
      // value could otherwise mask that regression.
      isBlockedMock.mockRejectedValue(new Error('should never be called'));
      const result = await gmail.sendOwnerNotification('owner alert text');
      expect(result).toBe(true);
      expect(sendOwnerNotificationMock).toHaveBeenCalledWith('owner alert text');
      expect(isBlockedMock).not.toHaveBeenCalled();
    });
  });

  describe('sendReply — deliberately unchanged, no new DNC check', () => {
    // Not gated here because every current caller already checks the
    // recipient against do-not-contact earlier in the same flow before
    // ever reaching gmail.sendReply (see the comment above sendReply in
    // gmail.js for the full per-caller breakdown). Asserting isBlocked
    // is never called, with isBlocked set to reject, makes this test
    // fail loudly if a future change adds a check here unexpectedly.
    it('calls straight through to the provider even when isBlocked would reject, and never calls isBlocked', async () => {
      isBlockedMock.mockRejectedValue(new Error('should never be called'));
      const result = await gmail.sendReply('someone@example.com', 'Original subject', 'body', 'html');
      expect(result).toBe(true);
      expect(sendReplyMock).toHaveBeenCalledWith('someone@example.com', 'Original subject', 'body', 'html');
      expect(isBlockedMock).not.toHaveBeenCalled();
    });
  });
});
