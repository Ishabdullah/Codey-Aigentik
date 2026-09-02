import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import config from '../config.json' with { type: 'json' };
import { loadProfile, sendOnboardingEmail } from '../index.js';
import { handleRename, handleSetBusinessInfo, handleSetOwnerName, getAigentikName } from '../owner-command.js';
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
    // Full Core profile echoed back by both the GET pre-read and the POST response.
    function coreProfile(overrides = {}) {
      return {
        id: 1,
        configured: 1,
        aigentik_name: 'Aigentik',
        agent_name_set: 0,
        owner_name: null,
        business_name: null,
        business_description: null,
        onboarding_sent: 0,
        setup_date: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        ...overrides
      };
    }
    function postCall() {
      return fetchSpy.mock.calls.find((c) => c[1] && c[1].method === 'POST');
    }

    it('handleRename builds the POST from Core, not the local file, and refreshes config from the response', async () => {
      fs.writeFileSync(profilePath, JSON.stringify({ aigentik_name: 'FromDisk', business_name: 'FromDiskBiz' }, null, 2));
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, {
          business_profile: coreProfile({ aigentik_name: 'FromCore', business_name: 'FromCoreBiz' })
        }))
        .mockResolvedValueOnce(mockResponse(200, {
          business_profile: coreProfile({ aigentik_name: 'Newname', business_name: 'FromCoreBiz', agent_name_set: 1 })
        }));
      const replies = [];
      await handleRename('newname', async (m) => { replies.push(m); });

      // pre-read was the Core GET
      expect(fetchSpy.mock.calls[0][1].method).toBe('GET');
      // old name came from Core, not the stale disk value
      expect(replies[0]).toContain('FromCore');
      expect(replies[0]).not.toContain('FromDisk');
      // POST body carries the Core business_name through, renamed agent name
      const body = JSON.parse(postCall()[1].body);
      expect(body.business_name).toBe('FromCoreBiz');
      expect(body.aigentik_name).toBe('Newname');
      expect(body.agent_name_set).toBe(1);
      // config refreshed from the POST response, not from local disk
      expect(config.aigentik_name).toBe('Newname');
      expect(config.business_name).toBe('FromCoreBiz');
    });

    it('handleSetOwnerName guards against a lost update — POST carries the current Core business_name, not the stale local one', async () => {
      fs.writeFileSync(profilePath, JSON.stringify({ business_name: 'STALE' }, null, 2));
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile({ business_name: 'CURRENT' }) }))
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile({ business_name: 'CURRENT', owner_name: 'X' }) }));
      await handleSetOwnerName('X', async () => {});

      const postOptions = postCall()[1];
      expect(JSON.parse(postOptions.body).business_name).toBe('CURRENT');
    });

    it('a thrown Core error still persists the rename locally and warns the owner it did not sync', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile({ aigentik_name: 'Original' }) }))
        .mockRejectedValueOnce(new Error('Core unreachable'));
      const replies = [];
      await handleRename('brandnew', async (m) => { replies.push(m); });

      // Durable: local cache + in-memory config both updated despite the failure.
      expect(config.aigentik_name).toBe('Brandnew');
      expect(JSON.parse(fs.readFileSync(profilePath, 'utf8')).aigentik_name).toBe('Brandnew');
      // Degraded reply — not the normal "Done!" success line.
      expect(replies[0]).not.toMatch(/Done!/);
      expect(replies[0]).toMatch(/couldn't reach/i);
    });

    it('a non-2xx Core response (ok:false, no throw) still persists locally and warns', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile({ aigentik_name: 'Original' }) }))
        .mockResolvedValueOnce(mockResponse(401, { error: 'token expired' }));
      const replies = [];
      await handleRename('brandnew', async (m) => { replies.push(m); });

      expect(config.aigentik_name).toBe('Brandnew');
      expect(JSON.parse(fs.readFileSync(profilePath, 'utf8')).aigentik_name).toBe('Brandnew');
      expect(replies[0]).not.toMatch(/Done!/);
      expect(replies[0]).toMatch(/couldn't reach/i);
    });

    it('getAigentikName() reads config only, never the filesystem', () => {
      const spy = jest.spyOn(fs, 'readFileSync');
      config.aigentik_name = 'Cached';
      expect(getAigentikName()).toBe('Cached');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('a successful POST refreshes the local config cache from the response body', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile() }))
        .mockResolvedValueOnce(mockResponse(200, {
          business_profile: coreProfile({ aigentik_name: 'Renamed', owner_name: 'Ish', business_name: 'Restoricon LLC' })
        }));
      await handleRename('whatever', async () => {});
      // config reflects the POST response body, not the 'whatever' we sent
      expect(config.aigentik_name).toBe('Renamed');
      expect(config.owner_name).toBe('Ish');
      expect(config.business_name).toBe('Restoricon LLC');
    });

    it('handleRename still writes the local cache and updates config when Core echoes the new name', async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile() }))
        .mockResolvedValueOnce(mockResponse(200, {
          business_profile: coreProfile({ aigentik_name: 'Codey', agent_name_set: 1 })
        }));
      const replies = [];
      await handleRename('codey', async (m) => { replies.push(m); });

      expect(config.aigentik_name).toBe('Codey');
      expect(replies[0]).toContain('Codey');
      const written = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      expect(written.aigentik_name).toBe('Codey');
      expect(postCall()[1].method).toBe('POST');
    });

    it('handleSetBusinessInfo posts business fields and refreshes config from the response', async () => {
      const echoed = coreProfile({
        business_name: 'Restoricon LLC', business_description: 'General Contractor',
        owner_name: 'Ish', configured: 1
      });
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile() }))
        .mockResolvedValueOnce(mockResponse(200, { business_profile: echoed }));
      const replies = [];
      await handleSetBusinessInfo('Restoricon LLC', 'General Contractor', 'Ish', async (m) => { replies.push(m); });

      expect(config.business_name).toBe('Restoricon LLC');
      expect(config.business_description).toBe('General Contractor');
      expect(config.owner_name).toBe('Ish');
      expect(replies[0]).toContain('Restoricon LLC');

      const body = JSON.parse(postCall()[1].body);
      expect(body.business_name).toBe('Restoricon LLC');
      expect(body.business_description).toBe('General Contractor');
      expect(body.owner_name).toBe('Ish');
      expect(body.configured).toBe(1);
    });

    it('handleSetOwnerName derives POST `configured` from the Core-fresh profile, not the stale boot config', async () => {
      // Boot-time config has no business_name (or a stale one), but Core — read
      // fresh in the pre-read — knows a business was set by another client.
      config.business_name = null;
      fetchSpy
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile({ business_name: 'Restoricon LLC' }) }))
        .mockResolvedValueOnce(mockResponse(200, { business_profile: coreProfile({ owner_name: 'Ish', business_name: 'Restoricon LLC', configured: 1 }) }));
      const replies = [];
      await handleSetOwnerName('Ish', async (m) => { replies.push(m); });

      expect(config.owner_name).toBe('Ish');
      expect(replies[0]).toContain('Ish');
      const body = JSON.parse(postCall()[1].body);
      expect(body.owner_name).toBe('Ish');
      // Fails if `configured` is derived from config.business_name (null -> 0).
      expect(body.configured).toBe(1);
    });
  });
});
