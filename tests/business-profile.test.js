import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import config from '../config.json' with { type: 'json' };
import { loadProfile, sendOnboardingEmail } from '../index.js';
import { handleRename, handleSetBusinessInfo, handleSetOwnerName } from '../owner-command.js';
import { getEmailProvider } from '../email-provider.js';

describe('business-profile (Core write-through)', () => {
  let fetchSpy;
  let sendOwnerNotificationSpy;
  const profilePath = path.join(config.paths.data_dir, 'profile.json');
  let originalProfileContent = null;

  beforeAll(() => {
    if (fs.existsSync(profilePath)) {
      originalProfileContent = fs.readFileSync(profilePath, 'utf8');
    }
  });

  afterAll(() => {
    if (originalProfileContent !== null) {
      fs.writeFileSync(profilePath, originalProfileContent);
    } else if (fs.existsSync(profilePath)) {
      fs.unlinkSync(profilePath);
    }
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    const provider = getEmailProvider();
    sendOwnerNotificationSpy = jest.spyOn(provider, 'sendOwnerNotification').mockResolvedValue(true);
    // Reset config values
    config.aigentik_name = 'Aigentik';
    config.owner_name = null;
    config.business_name = null;
    config.business_description = null;
    // Write fresh default profile to profile.json
    const fresh = {
      configured: false,
      aigentik_name: 'Aigentik',
      agent_name_set: false,
      setup_date: new Date().toISOString(),
      owner_name: null,
      business_name: null,
      business_description: null,
      onboarding_sent: false
    };
    fs.writeFileSync(profilePath, JSON.stringify(fresh, null, 2));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    sendOwnerNotificationSpy.mockRestore();
  });

  function mockResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  }

  describe('loadProfile', () => {
    it('fetches profile from Core API and populates config & cache', async () => {
      const coreProfile = {
        id: 1,
        aigentik_name: 'Jarvis',
        owner_name: 'Bob',
        business_name: 'Bob Renovations LLC',
        business_description: 'Residential remodeling',
        configured: 1,
        agent_name_set: 1,
        onboarding_sent: 1
      };
      fetchSpy.mockResolvedValue(mockResponse(200, { business_profile: coreProfile }));

      const profile = await loadProfile();
      expect(fetchSpy).toHaveBeenCalled();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/business-profile');
      expect(options.method).toBe('GET');
      expect(options.headers.Authorization).toMatch(/^Bearer /);

      expect(config.aigentik_name).toBe('Jarvis');
      expect(config.owner_name).toBe('Bob');
      expect(config.business_name).toBe('Bob Renovations LLC');
      expect(config.business_description).toBe('Residential remodeling');
      expect(profile.aigentik_name).toBe('Jarvis');
    });

    it('falls back gracefully when Core API returns 404', async () => {
      fetchSpy.mockResolvedValue(mockResponse(404, { error: 'Business profile not configured' }));

      const profile = await loadProfile();
      expect(profile).toBeDefined();
      expect(config.aigentik_name).toBe('Aigentik');
    });

    it('falls back gracefully when Core API request fails with network error', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));

      const profile = await loadProfile();
      expect(profile).toBeDefined();
      expect(config.aigentik_name).toBe('Aigentik');
    });
  });

  describe('sendOnboardingEmail', () => {
    it('sends onboarding notification and updates onboarding_sent in Core API', async () => {
      const coreProfile = {
        id: 1,
        aigentik_name: 'Aigentik',
        owner_name: null,
        business_name: null,
        business_description: null,
        configured: 0,
        agent_name_set: 0,
        onboarding_sent: 0
      };
      // 1st call for GET, 2nd call for POST
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: { ...coreProfile } }))
        .mockResolvedValueOnce(mockResponse(200, { business_profile: { ...coreProfile, onboarding_sent: 1 } }));

      await sendOnboardingEmail();

      expect(sendOwnerNotificationSpy).toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const [postUrl, postOptions] = fetchSpy.mock.calls[1];
      expect(String(postUrl)).toContain('/api/v1/business-profile');
      expect(postOptions.method).toBe('POST');
      const body = JSON.parse(postOptions.body);
      expect(body.onboarding_sent).toBe(1);
    });

    it('does not send email if onboarding_sent is already 1', async () => {
      const coreProfile = {
        id: 1,
        aigentik_name: 'Aigentik',
        owner_name: null,
        business_name: null,
        business_description: null,
        configured: 0,
        agent_name_set: 0,
        onboarding_sent: 1
      };
      fetchSpy.mockResolvedValue(mockResponse(200, { business_profile: coreProfile }));

      await sendOnboardingEmail();
      expect(sendOwnerNotificationSpy).not.toHaveBeenCalled();
    });

    it('does not send email if owner and business are configured and agent_name_set is true', async () => {
      const coreProfile = {
        id: 1,
        aigentik_name: 'Aigentik',
        owner_name: 'Alice',
        business_name: 'Alice Roofing',
        business_description: 'Roofing',
        configured: 1,
        agent_name_set: 1,
        onboarding_sent: 0
      };
      config.owner_name = 'Alice';
      config.business_name = 'Alice Roofing';
      fetchSpy.mockResolvedValue(mockResponse(200, { business_profile: coreProfile }));

      await sendOnboardingEmail();
      expect(sendOwnerNotificationSpy).not.toHaveBeenCalled();
    });
  });

  describe('owner-command handlers (handleRename, handleSetBusinessInfo, handleSetOwnerName)', () => {
    it('handleRename updates config, local cache, and calls Core API POST', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        business_profile: { id: 1, aigentik_name: 'Codey', agent_name_set: 1 }
      }));
      const replies = [];
      const customReply = async (msg) => { replies.push(msg); };

      await handleRename('codey', customReply);

      expect(config.aigentik_name).toBe('Codey');
      expect(replies.length).toBe(1);
      expect(replies[0]).toContain('Codey');

      expect(fetchSpy).toHaveBeenCalled();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/business-profile');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.aigentik_name).toBe('Codey');
      expect(body.agent_name_set).toBe(1);
    });

    it('handleSetBusinessInfo updates config, local cache, and calls Core API POST', async () => {
      fetchSpy.mockResolvedValue(mockResponse(200, {
        business_profile: { id: 1, business_name: 'Restoricon LLC', business_description: 'General Contractor', configured: 1 }
      }));
      const replies = [];
      const customReply = async (msg) => { replies.push(msg); };

      await handleSetBusinessInfo('Restoricon LLC', 'General Contractor', 'Ish', customReply);

      expect(config.business_name).toBe('Restoricon LLC');
      expect(config.business_description).toBe('General Contractor');
      expect(config.owner_name).toBe('Ish');
      expect(replies.length).toBe(1);
      expect(replies[0]).toContain('Restoricon LLC');

      expect(fetchSpy).toHaveBeenCalled();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/business-profile');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.business_name).toBe('Restoricon LLC');
      expect(body.business_description).toBe('General Contractor');
      expect(body.owner_name).toBe('Ish');
      expect(body.configured).toBe(1);
    });

    it('handleSetOwnerName updates config, local cache, and calls Core API POST', async () => {
      config.business_name = 'Restoricon LLC';
      fetchSpy.mockResolvedValue(mockResponse(200, {
        business_profile: { id: 1, owner_name: 'Ish', configured: 1 }
      }));
      const replies = [];
      const customReply = async (msg) => { replies.push(msg); };

      await handleSetOwnerName('Ish', customReply);

      expect(config.owner_name).toBe('Ish');
      expect(replies.length).toBe(1);
      expect(replies[0]).toContain('Ish');

      expect(fetchSpy).toHaveBeenCalled();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/v1/business-profile');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.owner_name).toBe('Ish');
      expect(body.configured).toBe(1);
    });
  });
});
