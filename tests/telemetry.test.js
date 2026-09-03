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
