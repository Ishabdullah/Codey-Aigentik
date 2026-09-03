// telemetry.mjs — Aigentik-side telemetry writer (Codey-OS telemetry layer,
// sub-task T1: category F — extraction/grounding). See
// ~/Codey-OS/docs/telemetry_layer_design.md for the full design, and
// ~/Codey-OS/telemetry/{envelope,store,schema,recorders}.py for the
// Python-side counterpart this module is written to match record-for-
// record: same envelope shape, same schema file (byte-identical copy at
// telemetry/schema/v1.json), same JSONL layout under the SAME store root
// (~/.codeyOS/metrics/) so both languages' records interleave into one
// dataset.
//
// Constraints this module exists under (design §5, CLAUDE.md rules 2-3):
//  - Never blocks the caller. No `fs.appendFileSync` on the hot path
//    (fact 0.15 calls this out explicitly as the pattern NOT to copy —
//    it's what logger.js does and it's a blocking call on Aigentik's
//    single event-loop thread). This module uses `fs.promises.appendFile`
//    on a buffered/batched timer instead.
//  - Never throws into the caller. Every public record_*() function is
//    wrapped so a telemetry failure degrades to a dropped-record count
//    plus a rate-limited warning, exactly like telemetry/store.py.
//  - Refuses to write inside Aigentik's own `logs_dir` (the prune
//    interlock, design §1.4) — pruneOldLogs() in logger.js unlinks any
//    `aigentik-*.log` file inside that directory on a 30-day cycle, and
//    the metrics store must never be reachable by that sweep.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'telemetry', 'schema', 'v1.json');

// Read the schema file as raw bytes for hashing — NOT via
// `import ... with { type: 'json' }`. That syntax hands back a re-
// serialized parsed object; JSON.stringify-ing it would not reproduce the
// original file bytes (whitespace/key-order differences), so its hash
// would not match Python's `hashlib.sha256(f.read())` over the same file.
// The raw bytes are parsed separately below for structured access.
const _schemaBytes = fs.readFileSync(SCHEMA_PATH);
const SCHEMA = JSON.parse(_schemaBytes.toString('utf8'));

export const SCHEMA_VERSION = SCHEMA.schema_version;
const _schemaSha256Full = crypto.createHash('sha256').update(_schemaBytes).digest('hex');
export const SCHEMA_SHA256_12 = _schemaSha256Full.slice(0, 12);
export const NULL_REASON_CODES = SCHEMA.null_reason_codes;
export const RECORD_SIZE_CAP_BYTES = SCHEMA.envelope.record_size_cap_bytes;

// ── kill switch ────────────────────────────────────────────────────────
// AIGENTIK_TELEMETRY=1 (default, enabled) / =0 (disabled). Checked once
// at import and stored in a module-level const — mirrors
// telemetry/store.py's TELEMETRY_ENABLED / design §5.3 exactly ("checked
// once at module import ... a single predictable branch").
export const TELEMETRY_ENABLED = (process.env.AIGENTIK_TELEMETRY ?? '1') === '1';

// ── boot_id ────────────────────────────────────────────────────────────
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
let _bootIdCache; // undefined = not yet read; null = read attempted, unreadable
export function getBootId() {
  if (_bootIdCache === undefined) {
    try {
      _bootIdCache = fs.readFileSync(BOOT_ID_PATH, 'utf8').trim() || null;
    } catch {
      // Honest-null path, not a crash (fact 0.3's read is still wrapped —
      // a permission/platform difference here must not raise into a
      // record-building call). boot_id is a nice-to-have grouping key,
      // never required for a record to be emitted.
      _bootIdCache = null;
    }
  }
  return _bootIdCache;
}

export function resetBootIdCacheForTests() {
  _bootIdCache = undefined;
}

// ── run_id / seq ───────────────────────────────────────────────────────
let _runId = null;
export function getRunId() {
  if (_runId === null) {
    _runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return _runId;
}
export function resetRunIdForTests() {
  _runId = null;
}

let _seq = 0;
export function nextSeq() {
  const value = _seq;
  _seq += 1;
  return value;
}
export function resetSeqForTests() {
  _seq = 0;
}

// ── envelope ───────────────────────────────────────────────────────────
// Same field set/semantics as telemetry/envelope.py's build_envelope():
// `nulls` keys use dotted paths ("boot_id" or "body.<field>"), `seq` is
// assigned here (at build time), and durations are never derived from
// `ts_wall` (see comment in Python's envelope.py — Android wall clock can
// step). `performance.now()/1000` mirrors the design's explicit choice
// for ts_mono (design §2.0's field table).
export function buildEnvelope({
  category,
  eventType,
  emitter,
  pid,
  runId,
  body,
  correlationId = null,
  nulls = null
}) {
  const recordNulls = nulls ? { ...nulls } : {};

  const bootId = getBootId();
  if (bootId === null && !('boot_id' in recordNulls)) {
    recordNulls.boot_id = 'boot_id_unreadable';
  }
  if (correlationId === null && !('correlation_id' in recordNulls)) {
    recordNulls.correlation_id = 'correlation_id_not_yet_available';
  }

  const record = {
    schema_version: SCHEMA_VERSION,
    schema_sha256: SCHEMA_SHA256_12,
    event_id: crypto.randomUUID().replace(/-/g, ''),
    run_id: runId,
    boot_id: bootId,
    seq: nextSeq(),
    ts_wall: Date.now() / 1000,
    ts_mono: performance.now() / 1000,
    category,
    event_type: eventType,
    emitter,
    pid,
    correlation_id: correlationId,
    nulls: recordNulls,
    body
  };

  return enforceSizeCap(record);
}

function enforceSizeCap(record) {
  let serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') <= RECORD_SIZE_CAP_BYTES) {
    return record;
  }

  const body = record.body;
  const truncatedFields = [];
  // Mirrors envelope.py's _enforce_size_cap: repeatedly halve the
  // currently-largest string body field until the record fits, bounded so
  // a pathological shape can't spin forever — the safer failure mode is
  // shipping an oversize record, not hanging the writer.
  const maxIterations = 64;
  for (let i = 0; i < maxIterations; i++) {
    serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') <= RECORD_SIZE_CAP_BYTES) break;

    const stringFields = Object.entries(body).filter(
      ([, v]) => typeof v === 'string' && v.length > 0
    );
    if (stringFields.length === 0) break; // nothing left worth truncating

    stringFields.sort((a, b) => b[1].length - a[1].length);
    const [fieldName] = stringFields[0];
    const original = body[fieldName];
    body[fieldName] = original.slice(0, Math.floor(original.length / 2));
    record.nulls[`body.${fieldName}`] = 'truncated_oversize_record';
    if (!truncatedFields.includes(fieldName)) truncatedFields.push(fieldName);
  }

  if (truncatedFields.length > 0) {
    body._truncated_fields = truncatedFields;
  }
  return record;
}

// Prunes null body fields the same way recorders.py's _emit() does: a
// null value is kept ONLY if the caller supplied a matching
// `nulls["body.<field>"]` reason (a genuine honest null) — otherwise the
// key is omitted from the body entirely rather than written as an
// unreasoned null.
function pruneBody(body, nulls) {
  const pruned = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== null && value !== undefined) {
      pruned[key] = value;
    } else if (nulls && Object.prototype.hasOwnProperty.call(nulls, `body.${key}`)) {
      pruned[key] = null;
    }
    // else: omitted, not applicable at this event_type (mirrors
    // recorders.py's documented rationale for the same omission).
  }
  return pruned;
}

export function sha256Hex(text) {
  if (text === null || text === undefined) return null;
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ── store: ring buffer + buffered async writer ────────────────────────

const DEFAULT_RING_BUFFER_SIZE = 512;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_FLUSH_BATCH = 64;
const DROP_WARNING_MIN_INTERVAL_MS = 60000;

function safeCategory(record) {
  return record && typeof record.category === 'string' && record.category
    ? record.category
    : 'unknown';
}

function dateForRecord(record) {
  const tsWall = record && record.ts_wall;
  let d;
  try {
    d = new Date(Number(tsWall) * 1000);
    if (Number.isNaN(d.getTime())) throw new Error('bad ts_wall');
  } catch {
    // Malformed/missing ts_wall must not lose the record — fall back to
    // "now" so it still lands somewhere on disk (mirrors store.py's
    // _date_for_record).
    d = new Date();
  }
  return d.toISOString().slice(0, 10);
}

export class Store {
  constructor(root, runId, opts = {}) {
    this.root = root;
    this.runId = runId;
    this.ringBufferSize = opts.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushBatch = opts.flushBatch ?? DEFAULT_FLUSH_BATCH;

    this._queue = [];
    this._droppedTotal = 0;
    this._droppedByCategory = {};
    this._bufferHighWater = 0;
    this._flushCount = 0;
    this._bytesWritten = 0;
    this._lastDropWarnTs = 0;
    this._stopped = false;
    this._flushing = false;

    this._timer = setInterval(() => {
      this._flush().catch(() => {
        // _flush() already catches and counts everything internally;
        // this is a final belt-and-braces guard so a rejected promise
        // from the timer callback can never surface as an
        // unhandledRejection and take down the host process.
      });
    }, this.flushIntervalMs);
    // Must not keep the Node event loop alive on its own — a telemetry
    // writer that prevents Aigentik from exiting would be a much worse
    // failure than a few seconds of unflushed records (see the shutdown()
    // best-effort flush below for the normal-exit path).
    this._timer.unref();
  }

  enqueue(record) {
    try {
      if (this._queue.length >= this.ringBufferSize) {
        this._recordDrop(safeCategory(record), 'ring_buffer_full');
        return;
      }
      this._queue.push(record);
      this._bufferHighWater = Math.max(this._bufferHighWater, this._queue.length);
    } catch {
      // A malformed record (unexpected shape) must not propagate into the
      // instrumented call site (extraction pipeline) — count it as a drop
      // instead, same discipline as store.py's enqueue().
      this._recordDrop(safeCategory(record), 'serialize_failed');
    }
  }

  stats() {
    return {
      dropped_total: this._droppedTotal,
      dropped_by_category: { ...this._droppedByCategory },
      buffer_high_water: this._bufferHighWater,
      flush_count: this._flushCount,
      bytes_written: this._bytesWritten
    };
  }

  async shutdown() {
    if (this._stopped) return;
    this._stopped = true;
    clearInterval(this._timer);
    await this._flush();
  }

  _recordDrop(category, reason) {
    this._droppedTotal += 1;
    this._droppedByCategory[category] = (this._droppedByCategory[category] || 0) + 1;
    const now = Date.now();
    const shouldWarn =
      this._droppedTotal === 1 || now - this._lastDropWarnTs >= DROP_WARNING_MIN_INTERVAL_MS;
    if (shouldWarn) {
      this._lastDropWarnTs = now;
      try {
        log.warn(
          'telemetry',
          `dropped record (category=${category}, reason=${reason}), dropped_total=${this._droppedTotal} this run`
        );
      } catch {
        // The logger itself failing (e.g. a closed stream) must not
        // propagate on top of the drop it's reporting — same guard as
        // store.py's _record_drop().
      }
    }
  }

  async _flush() {
    if (this._flushing) return; // avoid overlapping timer-driven flushes
    this._flushing = true;
    try {
      while (this._queue.length > 0) {
        const batch = this._queue.splice(0, this.flushBatch);
        await this._writeBatch(batch);
      }
    } finally {
      this._flushing = false;
    }
  }

  async _writeBatch(batch) {
    const grouped = new Map();
    for (const rec of batch) {
      try {
        const dateStr = dateForRecord(rec);
        const category = safeCategory(rec);
        const key = `${dateStr}|${category}`;
        if (!grouped.has(key)) grouped.set(key, { dateStr, category, records: [] });
        grouped.get(key).records.push(rec);
      } catch {
        this._recordDrop(safeCategory(rec), 'serialize_failed');
      }
    }

    for (const { dateStr, category, records } of grouped.values()) {
      try {
        const filePath = this._pathFor(dateStr, category);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        let lines = '';
        for (const rec of records) lines += JSON.stringify(rec) + '\n';
        // fs.promises.appendFile — non-blocking, the async counterpart of
        // store.py's O_APPEND write. Deliberately NOT fs.appendFileSync,
        // which fact 0.15 / design §5.2 call out as the pattern this
        // layer must not copy (logger.js's blocking call on the single
        // event-loop thread). No fsync here — matches store.py: no fsync
        // on the hot path, only at rotation/shutdown boundaries (not
        // implemented in T1; T4-equivalent territory).
        await fs.promises.appendFile(filePath, lines, 'utf8');
        this._flushCount += 1;
        this._bytesWritten += Buffer.byteLength(lines, 'utf8');
      } catch (exc) {
        for (const rec of records) this._recordDrop(category, 'write_failed');
        try {
          log.warn('telemetry', `write batch failed for category=${category}: ${exc}`);
        } catch {
          // see _recordDrop's identical guard above
        }
      }
    }
  }

  _pathFor(dateStr, category) {
    return path.join(this.root, 'events', dateStr, `${category}.${this.runId}.jsonl`);
  }
}

// ── prune interlock (design §1.4 / fact 0.14) ───────────────────────────
// pruneOldLogs() in logger.js unlinks entries directly inside
// config.paths.logs_dir whose name satisfies
// `startsWith('aigentik-') && endsWith('.log')`. The interlock here is a
// SEPARATE, independent check (never trusts the filename convention alone
// — see design's "relying on that silently would be fragile"): it refuses
// to initialize the store at all if its root is equal to, or nested
// inside, logs_dir, regardless of what the store's own filenames look
// like.
export const DEFAULT_METRICS_ROOT = path.join(os.homedir(), '.codeyOS', 'metrics');

function isRootInsidePrunableLogsDir(metricsRoot) {
  const logsDir = config?.paths?.logs_dir;
  if (!logsDir) return false; // nothing configured to collide with
  const rel = path.relative(path.resolve(logsDir), path.resolve(metricsRoot));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function emitWriterDisabledRecord(root, runId) {
  // Best-effort, synchronous, and written exactly once — this is the one
  // narrow exception to "never fs.*Sync on the hot path": it happens at
  // most once per process, before the store (and its async writer) has
  // been allowed to come up at all, and design §1.4 explicitly specifies
  // this single diagnostic record ("emits a single meta record ... and
  // thereafter no-ops").
  try {
    const record = buildEnvelope({
      category: 'meta',
      eventType: 'writer_disabled',
      emitter: 'aigentik',
      pid: process.pid,
      runId,
      body: { reason: 'metrics_root_inside_prunable_logs_dir' },
      nulls: {}
    });
    const dateStr = dateForRecord(record);
    const filePath = path.join(root, 'events', dateStr, `meta.${runId}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // If even this single diagnostic write fails, the writer stays
    // silently disabled rather than throwing into whatever call site
    // triggered the first record() call — telemetry is never allowed to
    // break the extraction pipeline it's observing.
  }
}

let _singletonStore = null;
let _writerDisabledEmitted = false;

function getStore(rootOverride) {
  if (!TELEMETRY_ENABLED) return null;
  const root = rootOverride || DEFAULT_METRICS_ROOT;

  if (_singletonStore !== null) return _singletonStore;
  if (_writerDisabledEmitted) return null; // already refused; stay disabled

  if (isRootInsidePrunableLogsDir(root)) {
    _writerDisabledEmitted = true;
    emitWriterDisabledRecord(root, getRunId());
    return null;
  }

  try {
    _singletonStore = new Store(root, getRunId());
  } catch (exc) {
    try {
      log.warn('telemetry', `failed to initialize store: ${exc}`);
    } catch {
      // see Store._recordDrop's identical guard
    }
    return null;
  }
  return _singletonStore;
}

export function resetForTests() {
  if (_singletonStore !== null) {
    // Fire-and-forget shutdown — tests that need the flush to have
    // completed should await store internals directly via
    // getStoreForTests().shutdown() instead.
    _singletonStore.shutdown().catch(() => {});
  }
  _singletonStore = null;
  _writerDisabledEmitted = false;
}

export function getStoreForTests(rootOverride) {
  return getStore(rootOverride);
}

// ── generic emit ───────────────────────────────────────────────────────

function emit({ category, eventType, emitter, pid, runId, body, correlationId = null, nulls = null }) {
  if (!TELEMETRY_ENABLED) return;
  try {
    const prunedBody = pruneBody(body, nulls);
    const resolvedRunId = runId || getRunId();
    const record = buildEnvelope({
      category,
      eventType,
      emitter,
      pid,
      runId: resolvedRunId,
      body: prunedBody,
      correlationId,
      nulls
    });
    const store = getStore();
    if (store) store.enqueue(record);
  } catch {
    // The absolute last line of defense: nothing above this point should
    // ever throw (buildEnvelope/pruneBody are pure, getStore/enqueue are
    // already internally guarded), but a telemetry call must NEVER be
    // able to raise into an extraction call site no matter what changes
    // underneath it later.
  }
}

// ── F. Extraction / grounding (Aigentik's priority category) ───────────

export function recordExtractionAttempt({
  emitter,
  pid,
  extractor,
  requestedFields,
  returnedFields,
  nullFields,
  droppedSchemaEchoFields,
  parseOk,
  sourceChars,
  modelBackend,
  parseErrorClass = null,
  correlationId = null,
  runId = null,
  nulls = null
}) {
  const body = {
    extractor,
    requested_fields: requestedFields,
    returned_fields: returnedFields,
    null_fields: nullFields,
    dropped_schema_echo_fields: droppedSchemaEchoFields,
    parse_ok: parseOk,
    parse_error_class: parseErrorClass,
    source_chars: sourceChars,
    model_backend: modelBackend
  };
  emit({
    category: 'extraction',
    eventType: 'extraction_attempt',
    emitter,
    pid,
    runId,
    body,
    correlationId,
    nulls
  });
}

export function recordGroundingCheck({
  emitter,
  pid,
  field,
  outcome,
  numericTokensInValue,
  numericTokensMatched,
  valueChars,
  sourceChars,
  actionTaken,
  valueSha256 = null,
  correlationId = null,
  runId = null,
  nulls = null
}) {
  const body = {
    field,
    outcome,
    numeric_tokens_in_value: numericTokensInValue,
    numeric_tokens_matched: numericTokensMatched,
    value_sha256: valueSha256,
    value_chars: valueChars,
    source_chars: sourceChars,
    action_taken: actionTaken
  };
  emit({
    category: 'extraction',
    eventType: 'grounding_check',
    emitter,
    pid,
    runId,
    body,
    correlationId,
    nulls
  });
}

// Exported for parity with the schema/recorders.py, and for any future
// call site — NOT called from anywhere in T1. The deterministic-rule
// dispatch points the design doc points at (subcontractor-form.js's
// parseApplication, email-rules.js/sms-rules.js's checkRules,
// do-not-contact.js) all live outside llama.js and are out of this
// sub-task's file scope (see the T1 handoff for the explicit flag).
export function recordDeterministicBypass({
  emitter,
  pid,
  ruleId,
  ruleSource,
  wouldHaveCalledModel,
  correlationId = null,
  runId = null,
  nulls = null
}) {
  const body = {
    rule_id: ruleId,
    rule_source: ruleSource,
    would_have_called_model: wouldHaveCalledModel
  };
  emit({
    category: 'extraction',
    eventType: 'deterministic_bypass',
    emitter,
    pid,
    runId,
    body,
    correlationId,
    nulls
  });
}
