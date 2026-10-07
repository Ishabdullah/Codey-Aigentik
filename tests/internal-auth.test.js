// tests/internal-auth.test.js — WP0.1 code-review finding #1: a missing
// token file must not poison the module's cache forever. install.sh can
// generate the file after this server's process has already started and
// made one (failing) getExpectedToken() call from its own startup
// warning; a subsequent request must still succeed once the file exists,
// with no restart required.
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('internal-auth getExpectedToken (file-backed, no env override)', () => {
  let tmpDir;
  let tokenPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-internal-auth-'));
    tokenPath = path.join(tmpDir, 'aigentik_internal_token');
    delete process.env.AIGENTIK_INTERNAL_TOKEN;
    process.env.AIGENTIK_INTERNAL_TOKEN_PATH = tokenPath;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AIGENTIK_INTERNAL_TOKEN_PATH;
  });

  it('returns null while the file does not exist, then picks it up once it does (no restart needed)', async () => {
    jest.resetModules();
    const auth = await import(`../internal-auth.js?t=${Date.now()}-a`);

    expect(auth.getExpectedToken()).toBeNull();
    expect(auth.getExpectedToken()).toBeNull(); // a second miss must also retry, not stay cached

    fs.writeFileSync(tokenPath, 'now-it-exists\n');
    expect(auth.getExpectedToken()).toBe('now-it-exists');
  });

  it('caches a successful read (does not re-read the file on every call once found)', async () => {
    fs.writeFileSync(tokenPath, 'stable-token');
    jest.resetModules();
    const auth = await import(`../internal-auth.js?t=${Date.now()}-b`);

    expect(auth.getExpectedToken()).toBe('stable-token');
    fs.writeFileSync(tokenPath, 'changed-after-cache');
    // Still the cached value -- this module's contract is "read once it's
    // found", matching install.sh's own "generated once" comment.
    expect(auth.getExpectedToken()).toBe('stable-token');
  });
});
