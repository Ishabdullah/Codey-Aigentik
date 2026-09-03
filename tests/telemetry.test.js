// tests/telemetry.test.js — Codey-OS telemetry layer, sub-task T1
// (category F). Covers:
//   - schema-hash parity (telemetry.mjs's copy vs. the checked-in
//     constant, and vs. Codey-OS's copy when present on this device)
//   - envelope shape / honest-null / size-cap behaviour
//   - the pruneOldLogs() collision interlock (design §1.4), non-
//     destructively — see the comment above the interlock describe()
//     block for why this suite never calls the real pruneOldLogs()
//     against real data
//   - the four-outcome grounding taxonomy vs. isAddressGrounded()
//     equivalence (design §2.F)
//   - chat()'s new optional third `meta` param staying backward-
//     compatible with every existing call shape
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import config from '../config.json' with { type: 'json' };
import * as telemetry from '../telemetry.mjs';
import * as llama from '../llama.js';

// Checked into both repos per design §3.3 ("A test on each side asserts
// its copy's SHA-256 equals a constant checked into both repos"). Update
// this together with telemetry/schema/v1.json's own content — never
// change one without the other.
const EXPECTED_SCHEMA_SHA256_12 = '8a45d9fc8c23';

describe('telemetry — schema parity (design §3.3)', () => {
  it("this repo's schema copy hashes to the checked-in constant", () => {
    expect(telemetry.SCHEMA_SHA256_12).toBe(EXPECTED_SCHEMA_SHA256_12);
    expect(telemetry.SCHEMA_VERSION).toBe(1);
  });

  it("matches Codey-OS's copy byte-for-byte when both repos are present on this device", () => {
    // Best-effort cross-repo check (design §3.3's "codey-metrics schema
    // --verify compares the two files directly when both are present").
    // Deliberately NOT a hard dependency — Aigentik must work standalone
    // (§3.3: "Aigentik has no configured path to the Codey-OS tree").
    const codeyOsPath = path.join(
      path.dirname(path.dirname(process.cwd())),
      'Codey-OS',
      'telemetry',
      'schema',
      'v1.json'
    );
    if (!fs.existsSync(codeyOsPath)) {
      return; // Codey-OS checkout not present next to this repo — skip
    }
    const ownBytes = fs.readFileSync(path.join(process.cwd(), 'telemetry', 'schema', 'v1.json'));
    const theirBytes = fs.readFileSync(codeyOsPath);
    expect(ownBytes.equals(theirBytes)).toBe(true);
  });
});

describe('telemetry — envelope shape and honest-null contract', () => {
  it('builds an envelope with every required field and honest nulls for boot_id/correlation_id when absent', () => {
    const record = telemetry.buildEnvelope({
      category: 'extraction',
      eventType: 'grounding_check',
      emitter: 'aigentik',
      pid: 12345,
      runId: 'abcdef0123456789',
      body: { field: 'address', outcome: 'rejected' }
    });

    expect(record.schema_version).toBe(telemetry.SCHEMA_VERSION);
    expect(record.schema_sha256).toBe(telemetry.SCHEMA_SHA256_12);
    expect(record.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(record.run_id).toBe('abcdef0123456789');
    expect(typeof record.seq).toBe('number');
    expect(typeof record.ts_wall).toBe('number');
    expect(typeof record.ts_mono).toBe('number');
    expect(record.category).toBe('extraction');
    expect(record.event_type).toBe('grounding_check');
    expect(record.emitter).toBe('aigentik');
    expect(record.pid).toBe(12345);
    expect(record.correlation_id).toBeNull();
    // No ambient correlation context was supplied -> honest null with a
    // reason, never a bare null (schema.py's validate() would flag this
    // as `correlation_id is null with no entry in nulls` otherwise).
    expect(record.nulls.correlation_id).toBe('correlation_id_not_yet_available');
    expect(record.body).toEqual({ field: 'address', outcome: 'rejected' });
  });

  it('seq is monotonic across calls within a process', () => {
    const a = telemetry.buildEnvelope({
      category: 'meta',
      eventType: 'writer_started',
      emitter: 'aigentik',
      pid: 1,
      runId: 'r',
      body: {}
    });
    const b = telemetry.buildEnvelope({
      category: 'meta',
      eventType: 'writer_started',
      emitter: 'aigentik',
      pid: 1,
      runId: 'r',
      body: {}
    });
    expect(b.seq).toBe(a.seq + 1);
  });

  it('truncates the largest oversize string body field and records why, rather than dropping the record', () => {
    const record = telemetry.buildEnvelope({
      category: 'extraction',
      eventType: 'grounding_check',
      emitter: 'aigentik',
      pid: 1,
      runId: 'r',
      body: { huge: 'x'.repeat(20000), small: 'ok' }
    });
    const serialized = JSON.stringify(record);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(telemetry.RECORD_SIZE_CAP_BYTES);
    expect(record.body._truncated_fields).toContain('huge');
    expect(record.nulls['body.huge']).toBe('truncated_oversize_record');
    expect(record.body.small).toBe('ok'); // untouched — only the oversize field shrinks
  });
});

// The prune interlock (design §1.4 / fact 0.14) is tested two ways,
// deliberately NEVER by calling the real log.pruneOldLogs() against real
// data: logger.js's module-level `pruneOldLogs()` call at import time (and
// pruneOldLogs(0) itself) operate on config.paths.logs_dir as read from
// the real, unmocked config.json in this repo — that is the exact
// directory holding this business's real aigentik-*.log history (the
// "shrinking horizon" this whole sub-task exists to stop losing). Calling
// it with retentionDays=0 here would delete real production logs as a
// side effect of running the test suite. Instead:
//   1. the containment check is exercised directly against the real
//      config (no mocking needed — a synthetic root nested under the
//      real logs_dir is enough to trigger it, and is cleaned up after);
//   2. the filename convention is checked against a faithful
//      reproduction of pruneOldLogs()'s own filter predicate, keeping the
//      test aligned with logger.js's actual logic (see its source, quoted
//      in the comment below) without invoking it.
describe('telemetry — pruneOldLogs collision interlock (design §1.4)', () => {
  // Mirrors logger.js's pruneOldLogs() filter exactly:
  //   if (!file.startsWith('aigentik-') || !file.endsWith('.log')) continue;
  function matchesPruneOldLogsPattern(filename) {
    return filename.startsWith('aigentik-') && filename.endsWith('.log');
  }

  it('telemetry filenames never match pruneOldLogs()\'s aigentik-*.log pattern', () => {
    for (const category of ['inference', 'gate', 'device', 'cotenancy', 'task', 'extraction', 'provenance', 'meta']) {
      const filename = `${category}.deadbeefdeadbeef.jsonl`;
      expect(matchesPruneOldLogsPattern(filename)).toBe(false);
    }
  });

  it('refuses to initialize (and emits one writer_disabled meta record) when its root is nested inside the real logs_dir', () => {
    telemetry.resetForTests();
    const insideLogsDir = fs.mkdtempSync(path.join(config.paths.logs_dir, 'telemetry-interlock-test-'));
    try {
      const store = telemetry.getStoreForTests(insideLogsDir);
      expect(store).toBeNull();

      const dateStr = new Date().toISOString().slice(0, 10);
      const files = fs.readdirSync(path.join(insideLogsDir, 'events', dateStr));
      expect(files.length).toBe(1);
      const record = JSON.parse(
        fs.readFileSync(path.join(insideLogsDir, 'events', dateStr, files[0]), 'utf8').trim()
      );
      expect(record.category).toBe('meta');
      expect(record.event_type).toBe('writer_disabled');
      expect(record.body.reason).toBe('metrics_root_inside_prunable_logs_dir');
    } finally {
      fs.rmSync(insideLogsDir, { recursive: true, force: true });
      telemetry.resetForTests();
    }
  });

  it('initializes normally and writes records when its root is NOT inside logs_dir', async () => {
    telemetry.resetForTests();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-telemetry-store-'));
    try {
      const store = telemetry.getStoreForTests(outsideRoot);
      expect(store).not.toBeNull();

      const record = telemetry.buildEnvelope({
        category: 'extraction',
        eventType: 'grounding_check',
        emitter: 'aigentik',
        pid: process.pid,
        runId: store.runId,
        body: { field: 'address', outcome: 'passed_numeric_match' }
      });
      store.enqueue(record);
      await store._flush();

      const dateStr = new Date().toISOString().slice(0, 10);
      const expectedPath = path.join(outsideRoot, 'events', dateStr, `extraction.${store.runId}.jsonl`);
      expect(fs.existsSync(expectedPath)).toBe(true);
      const lines = fs.readFileSync(expectedPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]).event_type).toBe('grounding_check');
    } finally {
      await telemetry.getStoreForTests(outsideRoot)?.shutdown();
      fs.rmSync(outsideRoot, { recursive: true, force: true });
      telemetry.resetForTests();
    }
  });
});

describe('classifyAddressGrounding vs isAddressGrounded (design §2.F four-outcome taxonomy)', () => {
  it('not_applicable_no_value: no address extracted at all', () => {
    expect(llama.classifyAddressGrounding(null, 'some message')).toBe('not_applicable_no_value');
    expect(llama.classifyAddressGrounding('', 'some message')).toBe('not_applicable_no_value');
    expect(llama.classifyAddressGrounding(undefined, 'some message')).toBe('not_applicable_no_value');
  });

  it('passed_no_numeric_token: an address with no 2+-digit run passes WITHOUT verification', () => {
    expect(llama.classifyAddressGrounding('Hartford, CT', 'I live in Hartford')).toBe('passed_no_numeric_token');
    expect(llama.isAddressGrounded('Hartford, CT', 'I live in Hartford')).toBe(true);
  });

  it('passed_numeric_match: a numeric token in the address appears verbatim in the source', () => {
    const source = 'my address is 123 Main St, unit 4';
    expect(llama.classifyAddressGrounding('123 Main St', source)).toBe('passed_numeric_match');
    expect(llama.isAddressGrounded('123 Main St', source)).toBe(true);
  });

  it('rejected: numeric tokens present in the address but absent from the source (likely hallucinated)', () => {
    const source = 'no numbers mentioned here at all';
    expect(llama.classifyAddressGrounding('456 Elm St', source)).toBe('rejected');
    expect(llama.isAddressGrounded('456 Elm St', source)).toBe(false);
  });

  it('rejected: truthy address with falsy sourceText (edge case not settled by the design doc — documented call in llama.js)', () => {
    expect(llama.classifyAddressGrounding('123 Main St', '')).toBe('rejected');
    expect(llama.isAddressGrounded('123 Main St', '')).toBe(false);
  });

  it('classifyAddressGrounding(a, s) === "rejected" <=> !isAddressGrounded(a, s), for every non-falsy address', () => {
    const fixtures = [
      ['123 Main St', 'my address is 123 Main St'],
      ['123 Main St', 'no match here'],
      ['Hartford, CT', 'just a city'],
      ['456 Oak Ave Apt 12', 'I am at 456 Oak Ave, apartment twelve'],
      ['789 Pine Rd', ''],
      ['   ', 'whitespace-only address string']
    ];
    for (const [address, sourceText] of fixtures) {
      const classified = llama.classifyAddressGrounding(address, sourceText);
      const grounded = llama.isAddressGrounded(address, sourceText);
      expect(classified === 'rejected').toBe(!grounded);
    }
  });
});

describe("chat()'s new optional third `meta` param stays backward-compatible", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    if (!config.llm) config.llm = {};
    config.llm.provider = 'local';
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  const mockResult = { choices: [{ message: { role: 'assistant', content: '  Hello there.  ' } }] };

  it('chat(messages) — no maxTokens, no meta — works exactly as before', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, mockResult));
    const text = await llama.chat([{ role: 'user', content: 'hi' }]);
    expect(text).toBe('Hello there.');
    const reqBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(reqBody.max_tokens).toBe(config.llama.max_tokens);
  });

  it('chat(messages, maxTokens) — existing two-arg call shape — unaffected', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, mockResult));
    const text = await llama.chat([{ role: 'user', content: 'hi' }], 77);
    expect(text).toBe('Hello there.');
    const reqBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(reqBody.max_tokens).toBe(77);
  });

  it('chat(messages, maxTokens, meta) — new third arg — does not change the request and does not throw', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200, mockResult));
    const text = await llama.chat([{ role: 'user', content: 'hi' }], 77, { correlationId: 'abc123' });
    expect(text).toBe('Hello there.');
    const reqBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(reqBody.max_tokens).toBe(77);
    // meta is reserved/unused in T1 — asserting it changes nothing about
    // the outbound request is exactly the backward-compatibility claim.
  });
});

// ── T2: category-G run provenance ────────────────────────────────────────
// docs/telemetry_layer_design.md §2.G, §3.1, §3.4, §8 item 4. Covers the
// JS-side counterpart to recorders.record_run_start(): git/device/mem
// provenance, the env/config allow-list closed against secrets, the
// model-digest cache (background hashing, never inline), and
// runs/<run_id>.json's write-once convention.

describe('telemetry — T2 git/device/mem provenance helpers', () => {
  it('getGitProvenance() reads this repo\'s real git state without throwing', () => {
    const info = telemetry.getGitProvenance(process.cwd());
    expect(info.commit_sha === null || /^[0-9a-f]{40}$/.test(info.commit_sha)).toBe(true);
    expect(typeof info.dirty === 'boolean' || info.dirty === null).toBe(true);
  });

  it('getGitProvenance() returns all-null shape (not a throw) when git is unavailable', () => {
    const info = telemetry.getGitProvenance('/definitely/not/a/git/repo/at/all');
    expect(info).toEqual({ commit_sha: null, dirty: null, dirty_file_count: null, branch: null });
  });

  it('getDeviceProvenance() never throws and always has node_version', () => {
    const info = telemetry.getDeviceProvenance();
    expect(info.node_version).toBe(process.version);
    // cpu_core_count is null (not 0) on this device -- os.cpus() reads
    // /proc/stat internally, which is permission-denied here (fact 0.1),
    // so it returns [] rather than throwing. 0 would be a fabricated
    // confirmed-zero value; null is the honest one.
    expect(info.cpu_core_count === null || info.cpu_core_count > 0).toBe(true);
  });

  it('getRamSwapBytes() reads real /proc/meminfo values on this device', () => {
    const mem = telemetry.getRamSwapBytes();
    expect(mem.ram_total_bytes).toBeGreaterThan(0);
    expect(mem.swap_total_bytes).toBeGreaterThanOrEqual(0);
  });
});

describe('telemetry — T2 env/config allow-list (design §8 item 4, hard constraint 1)', () => {
  const originalEnv = process.env.AIGENTIK_TELEMETRY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AIGENTIK_TELEMETRY;
    else process.env.AIGENTIK_TELEMETRY = originalEnv;
  });

  it('buildEnvOverrides() only ever carries AIGENTIK_TELEMETRY, nothing else from process.env', () => {
    process.env.AIGENTIK_TELEMETRY = '1';
    const overrides = telemetry.buildEnvOverrides();
    expect(Object.keys(overrides)).toEqual(['AIGENTIK_TELEMETRY']);
    expect(overrides.AIGENTIK_TELEMETRY).toBe('1');
  });

  it('buildConfigSnapshot() never leaks core_api.token — presence-only boolean', () => {
    const snapshot = telemetry.buildConfigSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(config.core_api.token);
    expect(snapshot.core_api_token_set).toBe(true);
  });

  it('buildConfigSnapshot() never leaks gmail.app_password — presence-only boolean', () => {
    const snapshot = telemetry.buildConfigSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(config.gmail.app_password);
    expect(snapshot.gmail_app_password_set).toBe(true);
  });

  it('buildConfigSnapshot() reports presence-only false for unset secrets (gemini/vertex api_key)', () => {
    const snapshot = telemetry.buildConfigSnapshot();
    expect(snapshot.gemini_api_key_set).toBe(false);
    expect(snapshot.vertex_api_key_set).toBe(false);
  });

  it('buildConfigSnapshot() is a closed projection — every value is a scalar, never a nested sub-object that could smuggle an unreviewed field through', () => {
    // Note: some allow-listed key NAMES legitimately contain "token"/"key"
    // as a substring (e.g. "llama.max_tokens" — nothing to do with a
    // credential), so key-name pattern-matching isn't the right check
    // here; see the dedicated "never leaks core_api.token" /
    // "never leaks gmail.app_password" tests above for the actual secret-
    // value assertions. What this test pins instead: buildConfigSnapshot()
    // can only ever emit primitive values (string/number/boolean/null),
    // never a nested object — which would defeat the whole point of an
    // explicit per-field allow-list by re-introducing a subtree dump.
    const snapshot = telemetry.buildConfigSnapshot();
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === '_policy') continue;
      expect(value === null || typeof value !== 'object').toBe(true);
    }
  });

  it('buildConfigSnapshot() carries the small non-secret projection fields', () => {
    const snapshot = telemetry.buildConfigSnapshot();
    expect(snapshot['llm.provider']).toBe(config.llm.provider);
    expect(snapshot['llama.context_size']).toBe(config.llama.context_size);
  });
});

describe('telemetry — T2 model-digest cache', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-telemetry-digest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('buildModelEntries() never hashes synchronously — cold cache reports not_computed', () => {
    const modelFile = path.join(tmpDir, 'fake-model.gguf');
    fs.writeFileSync(modelFile, Buffer.alloc(10000, 'x'));
    const cacheFile = path.join(tmpDir, 'model_digests.json');

    const entries = telemetry.buildModelEntries([['primary', modelFile]], cacheFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('primary');
    expect(entries[0].sha256_source).toBe('not_computed');
    expect(entries[0].sha256).toBeNull();
    expect(fs.existsSync(cacheFile)).toBe(false); // cache-read only, never created by a cold read
  });

  it('scheduleColdModelDigests() hashes in the background, caches the result, and does not re-hash on a second buildModelEntries() call', async () => {
    const modelFile = path.join(tmpDir, 'fake-model.gguf');
    const contents = Buffer.alloc(50000, 'y');
    fs.writeFileSync(modelFile, contents);
    const cacheFile = path.join(tmpDir, 'model_digests.json');
    const expectedDigest = crypto.createHash('sha256').update(contents).digest('hex');

    const entries = telemetry.buildModelEntries([['primary', modelFile]], cacheFile);
    expect(entries[0].sha256_source).toBe('not_computed');

    let capturedModels = null;
    const originalRecordRunStartAmended = telemetry.recordRunStartAmended;
    // Can't reassign an ESM named export directly; instead assert via the
    // real emitted JSONL record, which is simpler and exercises the real
    // path end-to-end (this test also proves the amendment actually
    // reaches the store, not just that a callback fired).
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-telemetry-digest-store-'));
    telemetry.resetForTests();
    try {
      const store = telemetry.getStoreForTests(outsideRoot);
      expect(store).not.toBeNull();

      telemetry.scheduleColdModelDigests({
        models: entries,
        runId: store.runId,
        emitter: 'aigentik',
        pid: process.pid,
        cachePath: cacheFile
      });

      // Poll for the cache file to appear (background hash completing) —
      // deterministic bound rather than a fixed sleep.
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(cacheFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(cacheFile)).toBe(true);

      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(cache[modelFile].sha256).toBe(expectedDigest);

      // Flush the store and confirm a run_start_amended record landed.
      await store._flush();
      const dateStr = new Date().toISOString().slice(0, 10);
      const provenanceFile = path.join(outsideRoot, 'events', dateStr, `provenance.${store.runId}.jsonl`);
      const lines = fs
        .readFileSync(provenanceFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const amended = lines.find((r) => r.event_type === 'run_start_amended');
      expect(amended).toBeDefined();
      expect(amended.body.models[0].sha256).toBe(expectedDigest);
      expect(amended.body.models[0].sha256_source).toBe('computed');
      capturedModels = amended.body.models;
    } finally {
      await telemetry.getStoreForTests(outsideRoot)?.shutdown();
      fs.rmSync(outsideRoot, { recursive: true, force: true });
      telemetry.resetForTests();
      void originalRecordRunStartAmended; // referenced only to document the ESM-reassignment constraint above
    }

    expect(capturedModels).not.toBeNull();

    // Second read must now report "cached", not hash again.
    const entriesAgain = telemetry.buildModelEntries([['primary', modelFile]], cacheFile);
    expect(entriesAgain[0].sha256_source).toBe('cached');
    expect(entriesAgain[0].sha256).toBe(expectedDigest);
  });

  it('scheduleColdModelDigests() is a no-op (spawns nothing observable) when every entry is already cached', async () => {
    const modelFile = path.join(tmpDir, 'fake-model.gguf');
    fs.writeFileSync(modelFile, Buffer.alloc(100, 'z'));
    const cacheFile = path.join(tmpDir, 'model_digests.json');
    const stat = fs.statSync(modelFile);
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        [modelFile]: {
          size_bytes: stat.size,
          mtime_ns: Math.round(stat.mtimeMs * 1e6),
          sha256: 'c'.repeat(64),
          computed_at: 1
        }
      })
    );

    const entries = telemetry.buildModelEntries([['primary', modelFile]], cacheFile);
    expect(entries[0].sha256_source).toBe('cached');

    const before = fs.statSync(cacheFile).mtimeMs;
    telemetry.scheduleColdModelDigests({
      models: entries,
      runId: 'nocoldrun0000001',
      emitter: 'aigentik',
      pid: process.pid,
      cachePath: cacheFile
    });
    await new Promise((r) => setTimeout(r, 300)); // give a would-be background task a chance to fire
    const after = fs.statSync(cacheFile).mtimeMs;
    expect(after).toBe(before); // cache file untouched -- nothing was hashed
  });
});

describe('telemetry — T2 runs/<run_id>.json (design §3.1)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-telemetry-runs-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeRunProvenanceFile() writes runs/<run_id>.json exactly once and never overwrites it', () => {
    const first = { run_id: 'samerunidjs00001', body: { marker: 'first' } };
    const second = { run_id: 'samerunidjs00001', body: { marker: 'second' } };
    telemetry.writeRunProvenanceFile(first, tmpDir);
    telemetry.writeRunProvenanceFile(second, tmpDir);

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'runs', 'samerunidjs00001.json'), 'utf8'));
    expect(onDisk.body.marker).toBe('first');
  });

  it('writeRunProvenanceFile() never throws on an unwritable path', () => {
    expect(() => {
      telemetry.writeRunProvenanceFile({ run_id: 'x', body: {} }, '/definitely/not/writable/at/all');
    }).not.toThrow();
  });

  it('recordRunStart() end-to-end: writes runs/<run_id>.json, emits into the JSONL stream, and closes every honest-null the way schema.py\'s validate() would check', async () => {
    telemetry.resetForTests();
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-telemetry-runstart-store-'));
    const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-telemetry-runstart-runs-'));
    try {
      const store = telemetry.getStoreForTests(storeRoot);
      expect(store).not.toBeNull();

      telemetry.recordRunStart({
        emitter: 'aigentik',
        pid: process.pid,
        repo: 'Codey-Aigentik',
        startedTsWall: Date.now() / 1000,
        runId: store.runId,
        runsRoot,
        cachePath: path.join(tmpDir, 'model_digests.json')
      });

      const runFile = path.join(runsRoot, 'runs', `${store.runId}.json`);
      expect(fs.existsSync(runFile)).toBe(true);
      const record = JSON.parse(fs.readFileSync(runFile, 'utf8'));
      expect(record.category).toBe('provenance');
      expect(record.event_type).toBe('run_start');
      expect(record.body.repo).toBe('Codey-Aigentik');

      // Honest-null contract (§2.0.1): every null body field must have a
      // matching nulls[`body.<field>`] entry.
      for (const [key, value] of Object.entries(record.body)) {
        if (value === null) {
          expect(record.nulls[`body.${key}`]).toBeTruthy();
        }
      }
      expect(record.nulls['body.device_uptime_sec']).toBe('proc_uptime_permission_denied');
      expect(record.nulls['body.llama_build_info']).toBe('call_site_not_yet_tagged');
      expect(record.nulls['body.llama_server_argv']).toBe('call_site_not_yet_tagged');
    } finally {
      await telemetry.getStoreForTests(storeRoot)?.shutdown();
      fs.rmSync(storeRoot, { recursive: true, force: true });
      fs.rmSync(runsRoot, { recursive: true, force: true });
      telemetry.resetForTests();
    }
  });
});
