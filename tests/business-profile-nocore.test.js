import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Exercise the no-Core fallback branch of owner-command.js's profile handlers.
// CORE_API_BASE_URL / CORE_API_TOKEN are bound at module-evaluation time from
// config.json, so this file mocks the config import to (a) omit the core_api
// block and (b) point paths.data_dir at a private scratch dir, so it never
// races the real ../data/profile.json with the parallel business-profile suite.
const realConfig = JSON.parse(
  fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')
);
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-nocore-'));

jest.unstable_mockModule('../config.json', () => {
  const { core_api, ...withoutCore } = realConfig;
  return {
    default: {
      ...withoutCore,
      paths: {
        data_dir: scratchDir,
        logs_dir: path.join(scratchDir, 'logs'),
        conversations_dir: path.join(scratchDir, 'conversations')
      }
    }
  };
});

const config = (await import('../config.json')).default;
const { handleRename } = await import('../owner-command.js');

describe('business-profile — no Core configured', () => {
  const profilePath = path.join(config.paths.data_dir, 'profile.json');
  let fetchSpy;

  afterAll(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    config.aigentik_name = 'Aigentik';
    fs.writeFileSync(profilePath, JSON.stringify({ aigentik_name: 'Aigentik' }, null, 2));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('handleRename writes the local cache and updates config, with no network call', async () => {
    const replies = [];
    await handleRename('codey', async (m) => { replies.push(m); });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(config.aigentik_name).toBe('Codey');
    const written = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    expect(written.aigentik_name).toBe('Codey');
    expect(written.agent_name_set).toBe(true);
    expect(replies[0]).toContain('Codey');
    expect(replies[0]).toMatch(/Done!/);
  });
});
