/**
 * The run-event vocabulary, in one place.
 *
 * `cairn run` appends one JSON object per line to `events.ndjson` (and, for
 * batch-level work, to `_invocations/<id>/events.ndjson`). Studio reads those
 * lines in three places — the Live view, the run-detail Events tab, and the
 * main process's run-detail summary — and every one of them goes through this
 * module: `describeEvent` for a single human line, `applyEvent` /
 * `reduceEvents` for the rolled-up state (steps, outcomes, preconditions,
 * hooks, services, phase, heartbeat, announced logs, stash, retention).
 *
 * The vocabulary is the runner's, not ours: `step.failed` (never
 * `step.finished{status:failed}`), `step.finished{skipped:true}` for a `when:`
 * skip, `outcome.passed|failed|skipped`, `run.passed|failed|errored`. Newer
 * runners add `phase.changed`, `run.heartbeat`, `outcome.started/progress`,
 * `log.opened`, `hook.*`, and `invocation.*`; every one of those is optional,
 * so an older run directory still reduces to today's view. An event type this
 * file does not know is never rendered as a bare muted label: it falls back to
 * `type · key=value …` built from its compact scalar fields.
 *
 * Loaded twice on purpose, like format.js: `require()` in the main process and
 * node:test, and a classic `<script>` in the sandboxed renderer, where the
 * same functions land on `window.CairnEvents`.
 */

const CairnEvents = (() => {
  /** @type {any} */
  const fmt =
    typeof require === "function"
      ? require("./format")
      : /** @type {any} */ (globalThis).CairnFormat;

  /** A heartbeat younger than this means the run is alive. */
  const HEARTBEAT_FRESH_MS = 45_000;
  /** Bounded per-run buffers: the model is rebuilt from a stream, not stored. */
  const MAX_SERVICES = 400;
  const MAX_PROGRESS = 30;
  const MAX_REFUSALS = 500;
  const OUTPUT_TAIL_CHARS = 4000;
  /** Wave-4 rows: readiness gates, teardown items, expect steps, fixtures. */
  const MAX_GATES = 100;
  const MAX_GATE_ATTEMPTS = 40;
  const MAX_TEARDOWN = 200;
  const MAX_EXPECTS = 500;
  const MAX_FIXTURES = 200;
  const MAX_OUTPUTS = 30;
  /** Step execution rows kept per run (F14 loops multiply them). */
  const MAX_STEP_ROWS = 5000;
  const MAX_POLICY_ROWS = 100;
  const MAX_METRIC_SAMPLES = 400;
  /** widget.field entries kept per step execution. */
  const MAX_WIDGET_FIELDS = 100;
  /** artifact.request entries kept per step execution. */
  const MAX_STEP_REQUESTS = 50;

  /** Display names for `phase.changed.phase` values. */
  const PHASE_LABELS = {
    services: "services",
    "before-hooks": "before hook",
    preconditions: "precondition",
    fixtures: "fixture",
    steps: "step",
    outcomes: "outcome",
    "after-hooks": "after hook",
    teardown: "teardown",
    stash: "stash",
    retention: "retention",
  };

  /**
   * Where a gate was waited on (`gate.*` `scope`). Free-form in the runner,
   * so an unknown scope reads as itself.
   */
  const GATE_SCOPES = {
    precondition: "precondition",
    "services.docker": "docker",
    "services.tmux": "tmux",
    webServer: "web server",
    wait: "cairn wait",
  };

  /**
   * A key whose value Studio never shows, whatever the runner wrote
   * (fixture outputs, captures, evidence cells). The runner already keeps
   * secrets out of these; this is the second lock.
   */
  const SECRET_KEY =
    /(pass(word|wd|phrase)?$|^pwd$|secret|token|api[-_]?key|apikey|authorization|^auth$|credential|cookie|private[-_]?key|bearer|jwt|signature)/i;

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  function str(value) {
    return typeof value === "string" && value.length ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /**
   * @param {unknown} value
   * @param {number} [max]
   * @returns {string}
   */
  function short(value, max = 240) {
    return fmt.truncate(fmt.oneLine(String(value ?? "")), max);
  }

  /**
   * A step's `when:` predicate as text. The schema allows a string
   * (`text:Accept cookies`) or an object (`{ selector: ".banner", hasText:
   * "Accept" }`); the object form becomes `selector: .banner, hasText: Accept`.
   * @param {unknown} value
   * @returns {string | null}
   */
  function whenText(value) {
    if (typeof value === "string") return value.length ? value : null;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const parts = Object.entries(value)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(
        ([key, entry]) =>
          `${key}: ${
            typeof entry === "object" ? JSON.stringify(entry) : String(entry)
          }`,
      );
    return parts.length ? parts.join(", ") : null;
  }

  /**
   * The last word of a key that only describes a credential (`tokenCount`,
   * `cookieConsent`, `signatureStatus`, `accessTokenExpiresAt`): such a key
   * holds metadata, not the credential, and stays visible.
   */
  const METADATA_SUFFIX = new Set([
    "count",
    "consent",
    "status",
    "state",
    "type",
    "kind",
    "expires",
    "expiry",
    "expired",
    "at",
    "ttl",
    "length",
    "size",
    "enabled",
    "required",
    "policy",
    "url",
    "endpoint",
    "name",
  ]);

  /**
   * Does this key name a credential (a value Studio masks)? A key whose
   * last word is metadata (`tokenCount`, `token_type`) does not.
   * @param {unknown} key
   * @returns {boolean}
   */
  function isSecretKey(key) {
    if (typeof key !== "string" || !SECRET_KEY.test(key)) return false;
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_.-]+/)
      .filter(Boolean);
    return !(
      words.length > 1 &&
      METADATA_SUFFIX.has(words[words.length - 1].toLowerCase())
    );
  }

  /**
   * Credential-shaped text masked: URI userinfo, `Basic …` / `Bearer …`
   * values, JWTs.
   * @param {string} text
   * @returns {string}
   */
  function maskText(text) {
    return text
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, "$1***@")
      .replace(/\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ••••••")
      .replace(
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
        "••••••",
      );
  }

  /**
   * Deep copy with every secret-looking key's value replaced and every
   * string masked (previews, cells, outputs holding objects).
   * @param {unknown} value
   * @param {number} [depth]
   * @returns {unknown}
   */
  function maskDeep(value, depth = 0) {
    if (depth > 12) return "…";
    if (typeof value === "string") return maskValue(null, value, 100_000);
    if (Array.isArray(value))
      return value.map((item) => maskDeep(item, depth + 1));
    if (value !== null && typeof value === "object") {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [key, item] of Object.entries(value))
        out[key] = isSecretKey(key) ? "••••••" : maskDeep(item, depth + 1);
      return out;
    }
    return value;
  }

  /**
   * A value as one masked display line: credential-shaped text (URI
   * userinfo, `Basic …` / `Bearer …`, a JWT) never shows, and a secret key
   * hides its value whole, at any depth of an object value.
   * @param {unknown} key
   * @param {unknown} value
   * @param {number} [max]
   * @returns {string}
   */
  function maskValue(key, value, max = 200) {
    if (isSecretKey(key)) return "••••••";
    if (value === null || value === undefined) return String(value);
    let text;
    if (typeof value === "string") text = value;
    else {
      try {
        text = JSON.stringify(maskDeep(value));
      } catch {
        text = String(value);
      }
    }
    return short(maskText(String(text ?? "")), max);
  }

  /**
   * `{key: value}` outputs as masked `[key, display]` pairs (bounded).
   * @param {unknown} outputs
   * @returns {Array<[string, string]> | null}
   */
  function safeOutputs(outputs) {
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs))
      return null;
    /** @type {Array<[string, string]>} */
    const out = [];
    for (const [key, value] of Object.entries(outputs)) {
      if (out.length >= MAX_OUTPUTS) break;
      out.push([key, maskValue(key, value)]);
    }
    return out;
  }

  /**
   * Display name of a gate's scope.
   * @param {unknown} scope
   * @returns {string | null}
   */
  function gateScopeLabel(scope) {
    const value = str(scope);
    return value ? (GATE_SCOPES[value] ?? value) : null;
  }

  /**
   * The poll position in an `outcome.progress` line: `attempt 3/~31: …`
   * (typed verifiers) or `<label> attempt 3/31: …` (SDK `ctx.poll`).
   * @param {unknown} message
   * @returns {{ attempt: number, of: string | null, text: string } | null}
   */
  function parseAttemptProgress(message) {
    const match = /\battempt\s+(\d+)(?:\s*\/\s*(~?\d+))?\s*:?\s*(.*)$/i.exec(
      String(message ?? ""),
    );
    if (!match) return null;
    return {
      attempt: Number(match[1]),
      of: match[2] ?? null,
      text: match[3] ?? "",
    };
  }

  /**
   * ` · 3 attempts in 4.2s` for a polled outcome or expect; "" otherwise.
   * @param {unknown} attempts
   * @param {unknown} [polledMs]
   * @returns {string}
   */
  function attemptsText(attempts, polledMs) {
    const count = num(attempts);
    if (count === null) return "";
    const polled = num(polledMs);
    return ` · ${count} attempt${count === 1 ? "" : "s"}${
      polled === null ? "" : ` in ${fmt.formatDuration(polled)}`
    }`;
  }

  /**
   * Tone of a fixture verb's status (`ok` / `failed` / `skipped` /
   * `dry-run`).
   * @param {unknown} status
   * @returns {"ok" | "bad" | "muted" | "info"}
   */
  function fixtureTone(status) {
    if (status === "ok") return "ok";
    if (status === "failed") return "bad";
    if (status === "dry-run") return "info";
    return "muted";
  }

  /**
   * The run.refused entry (model.refusals) for one planned spec of an
   * invocation journal: by plan index when both carry one, else by path.
   * @param {Array<Record<string, any>> | null | undefined} refusals
   * @param {{ index?: number | null, spec?: string | null } | null | undefined} entry
   * @returns {Record<string, any> | null}
   */
  function plannedRefusal(refusals, entry) {
    const index = num(entry?.index);
    const spec = str(entry?.spec);
    for (const refusal of refusals ?? []) {
      const at = num(refusal?.index);
      if (at !== null && index !== null) {
        if (at === index) return refusal;
        continue;
      }
      const where = str(refusal?.path);
      if (
        where &&
        spec &&
        (where === spec ||
          where.endsWith(`/${spec}`) ||
          spec.endsWith(`/${where}`))
      )
        return refusal;
    }
    return null;
  }

  /**
   * How many specs of a finished invocation the environment policy refused.
   * A refused spec gets no run entry in the journal, so this reads, in
   * order: `summary.refused` when the journal carries it; what the summary
   * leaves unaccounted for (a result is passed, failed, errored or refused,
   * so `total - passed - failed - errored`); and the journal's own
   * `run.refused` events (`refusals`, the reduced model's list) for planned
   * specs without a run. The largest wins: they never disagree upward.
   * Specs `--bail` skipped (`summary.skipped`) are not results either, so
   * they are subtracted before the remainder is read as refused.
   * @param {Record<string, any> | null | undefined} journal invocation.json
   * @param {Array<Record<string, any>> | null | undefined} [refusals]
   * @returns {number}
   */
  function invocationRefusedCount(journal, refusals) {
    const withRun = new Set(
      (Array.isArray(journal?.runs) ? journal.runs : []).map(
        (/** @type {any} */ entry) => entry?.index,
      ),
    );
    const fromEvents = (
      Array.isArray(journal?.planned) ? journal.planned : []
    ).filter(
      (/** @type {any} */ entry) =>
        !withRun.has(entry?.index) && plannedRefusal(refusals, entry),
    ).length;
    const summary =
      journal?.summary && typeof journal.summary === "object"
        ? journal.summary
        : null;
    let fromSummary = 0;
    if (summary && journal?.status !== "running") {
      const own = num(summary.refused);
      const total = num(summary.total);
      fromSummary =
        own ??
        (total === null
          ? 0
          : Math.max(
              0,
              total -
                (num(summary.passed) ?? 0) -
                (num(summary.failed) ?? 0) -
                (num(summary.errored) ?? 0) -
                (num(summary.skipped) ?? 0),
            ));
    }
    return Math.max(fromEvents, fromSummary);
  }

  /**
   * The status to show for an invocation journal: its own, except that a
   * finished one is "refused" when the policy refused every planned spec
   * (the runner journals `passed` for an all-refused batch, `failed` for a
   * refused single spec) or it exited 7 (refusals were its only problem:
   * exit 7 ranks below failed and errored).
   * @param {Record<string, any> | null | undefined} journal
   * @param {Array<Record<string, any>> | null | undefined} [refusals]
   * @returns {string | null}
   */
  function invocationStatus(journal, refusals) {
    const status = str(journal?.status);
    if (status !== "passed" && status !== "failed") return status;
    if (num(journal?.summary?.exitCode) === 7) return "refused";
    const refused = invocationRefusedCount(journal, refusals);
    const total =
      num(journal?.summary?.total) ??
      (Array.isArray(journal?.planned) ? journal.planned.length : 0);
    return refused > 0 && refused >= total ? "refused" : status;
  }

  /**
   * An `artifact.stash` / `artifact.publish` event about another run: the
   * retention pass writes the archive or publication of each run it pruned
   * onto the current run's stream, with the pruned run's `runId`. A run's
   * own stash/publish events carry no `runId` (or its own).
   * @param {Record<string, any>} model
   * @param {Record<string, any>} event
   * @returns {boolean}
   */
  function foreignRun(model, event) {
    const runId = str(event?.runId);
    return runId !== null && runId !== model.runId;
  }

  /**
   * What a stash failure `reason` code means (artifact.stash, status
   * "error"). Any other reason string is shown as-is.
   */
  const STASH_REASONS = {
    "fcheap-missing": "fcheap is not installed or not on PATH",
    "save-failed": "fcheap could not save the run",
    auth: "file.cheap credentials are missing or expired (fcheap auth login)",
    "too-large": "the run is larger than the stash allows",
    timeout: "fcheap did not finish in time",
    "secrets-blocked":
      "secrets were found in the run, so the stash was blocked",
    unknown: "the stash failed for an unknown reason",
  };

  /** What an `artifact.publish` failure `reason` code means. */
  const PUBLISH_REASONS = {
    "fcheap-missing": "fcheap is not installed or not on PATH",
    "save-failed": "fcheap could not upload the package",
    auth: "file.cheap credentials are missing or expired (fcheap auth login)",
    "too-large": "the package is larger than file.cheap accepts",
    timeout: "fcheap did not finish in time",
    "secrets-blocked": "the package holds secret-bearing members",
    unknown: "the publish failed for an unknown reason",
  };

  /**
   * Why `cairn publish` sent no RunIndexV1 sidecar (`runIndexSkipped` on the
   * receipt): the private console does not list the run.
   */
  const RUN_INDEX_SKIPPED = {
    unsupported:
      "this fcheap has no publish --run-index (cairn doctor names the version)",
    "too-large": "the run metadata did not fit the 12 KiB run index",
    "build-failed": "the run index could not be built from this run",
  };

  /**
   * What each `artifact-manifest.json` `sensitivity` means for what leaves
   * the machine (the CLI's evidence gate decides; Studio only explains it).
   * @type {Record<string, { tone: "ok" | "muted" | "info" | "warn", meaning: string }>}
   */
  const SENSITIVITY = {
    redacted: {
      tone: "ok",
      meaning:
        "written by cairn through the run redactor — leaves with every stash and publication",
    },
    safe: {
      tone: "muted",
      meaning:
        "browser-produced media or files with no credential structure (they can still show personal data) — leaves when stash.include / --include lists its category",
    },
    sanitized: {
      tone: "info",
      meaning:
        "a trace the best-effort sanitizer rewrote — stashed only when stash.include lists traces, never published",
    },
    "secret-bearing": {
      tone: "warn",
      meaning:
        "raw bytes that may carry credentials (an unsanitized trace, a raw monitor profile, text cairn did not write) — stashed only with stash.unsafeIncludeRawTraces, never published",
    },
  };

  /** What an `artifact.trace` failure `reason` code means. */
  const TRACE_REASONS = {
    empty: "the backend wrote an empty trace",
    "stop-failed": "the backend could not stop and save the trace",
    "too-large": "the trace was over artifacts.capture.traceMaxBytes",
    "sanitize-failed":
      "the sanitizer could not rewrite it, so it stays local as secret-bearing",
  };

  /**
   * Count the manifest's files by `sensitivity` and name the ones that never
   * leave by default (sanitized, secret-bearing). Manifests written before
   * sensitivities existed count as `unlabeled`.
   * @param {unknown} manifest artifact-manifest.json
   * @returns {{ counts: Record<string, number>, sanitized: string[], secretBearing: string[], lines: string[] } | null}
   */
  function sensitivitySummary(manifest) {
    const entries =
      manifest && typeof manifest === "object"
        ? /** @type {any} */ (manifest).artifacts
        : null;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    /** @type {Record<string, number>} */
    const counts = {
      redacted: 0,
      safe: 0,
      sanitized: 0,
      "secret-bearing": 0,
      unlabeled: 0,
    };
    /** @type {string[]} */
    const sanitized = [];
    /** @type {string[]} */
    const secretBearing = [];
    for (const entry of entries) {
      const value = str(entry?.sensitivity);
      const key = value && Object.hasOwn(SENSITIVITY, value) ? value : null;
      counts[key ?? "unlabeled"] += 1;
      const at = str(entry?.path);
      if (key === "sanitized" && at) sanitized.push(at);
      if (key === "secret-bearing" && at) secretBearing.push(at);
    }
    const lines = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([key, count]) =>
        key === "unlabeled"
          ? `${count} unlabeled (written before sensitivities existed)`
          : `${count} ${key} — ${SENSITIVITY[key].meaning}`,
      );
    return { counts, sanitized, secretBearing, lines };
  }

  /**
   * @param {unknown} value
   * @returns {string[] | null} non-empty strings, or null when absent
   */
  function strList(value) {
    if (!Array.isArray(value)) return null;
    const list = value
      .filter((entry) => typeof entry === "string" && entry.length)
      .slice(0, 50)
      .map((entry) => short(entry, 120));
    return list;
  }

  /**
   * The optional stash fields of an `artifact.stash` event or a
   * `stash-receipt.json` (contract 2b), only the ones present: an older
   * runner's model keeps exactly the keys it always had.
   * @param {Record<string, any> | null | undefined} source
   * @returns {Record<string, any>}
   */
  function stashExtras(source) {
    /** @type {Record<string, any>} */
    const out = {};
    if (!source || typeof source !== "object") return out;
    const message = str(source.message);
    if (message) out.message = short(message, 300);
    const excluded = strList(source.excluded);
    if (excluded) out.excluded = excluded;
    const secrets = num(source.secretsFound);
    if (secrets !== null) out.secretsFound = secrets;
    const ttl = str(source.ttl);
    if (ttl) out.ttl = short(ttl, 40);
    const expiresAt = str(source.expiresAt);
    if (expiresAt) out.expiresAt = expiresAt;
    const tags = strList(source.tags);
    if (tags) out.tags = tags;
    const contentHash = str(source.contentHash);
    if (contentHash) out.contentHash = short(contentHash, 100);
    const fileCount = num(source.fileCount);
    if (fileCount !== null) out.fileCount = fileCount;
    const sizeBytes = num(source.sizeBytes);
    if (sizeBytes !== null) out.sizeBytes = sizeBytes;
    return out;
  }

  /**
   * A stash event that did not save: the 2b contract says `status: "error"`,
   * older runners said `action: "error"` or carried `error`.
   * @param {Record<string, any> | null | undefined} event
   * @returns {boolean}
   */
  function stashFailed(event) {
    return Boolean(
      event &&
        (event.status === "error" || event.action === "error" || event.error),
    );
  }

  /**
   * `reason — what it means` for a stash or publish failure code.
   * @param {string | null} reason
   * @param {Record<string, string>} table
   * @returns {string | null}
   */
  function reasonLine(reason, table) {
    if (!reason) return null;
    const meaning = table[reason];
    return meaning ? `${reason} — ${meaning}` : reason;
  }

  /**
   * Every fact about a run's stash, one per line: the badge tooltip and the
   * Run detail evidence panel read the same lines.
   * @param {Record<string, any> | null | undefined} stash
   * @param {number} [nowMs]
   * @returns {string[]}
   */
  function stashLines(stash, nowMs = Date.now()) {
    if (!stash || typeof stash !== "object") return [];
    const lines = [];
    const id = str(stash.stashId);
    lines.push(
      stash.ok === false
        ? `not stashed${id ? ` (${id})` : ""}`
        : `file.cheap stash ${id ?? "?"}`,
    );
    const status = str(stash.status);
    if (status && status !== "saved") lines.push(`status: ${status}`);
    const action = str(stash.action);
    if (action) lines.push(`action: ${action}`);
    if (stash.ok === false) {
      const reason = reasonLine(str(stash.reason), STASH_REASONS);
      if (reason) lines.push(`reason: ${reason}`);
    }
    if (str(stash.message)) lines.push(`message: ${stash.message}`);
    const failures = num(stash.postSaveFailureCount) ?? 0;
    if (failures) lines.push(`post-save failures: ${failures}`);
    const excluded = strList(stash.excluded) ?? [];
    if (excluded.length)
      lines.push(
        `left out: ${excluded.join(", ")} — opt in with stash.include`,
      );
    const secrets = num(stash.secretsFound) ?? 0;
    if (secrets > 0)
      lines.push(
        `secrets found: ${secrets} — fcheap flagged secret-looking content; review before sharing`,
      );
    if (str(stash.ttl)) lines.push(`ttl: ${stash.ttl}`);
    if (str(stash.expiresAt))
      lines.push(
        `expires: ${fmt.formatTimestamp(stash.expiresAt)} (${fmt.relativeTime(
          stash.expiresAt,
          new Date(nowMs),
        )})`,
      );
    else if (stash.ok !== false && !str(stash.ttl) && id)
      lines.push("expires: never");
    const tags = strList(stash.tags) ?? [];
    if (tags.length) lines.push(`tags: ${tags.join(", ")}`);
    const files = num(stash.fileCount);
    const size = num(stash.sizeBytes);
    if (files !== null || size !== null)
      lines.push(
        `contents: ${files === null ? "?" : files} file(s)${
          size === null ? "" : ` · ${fmt.formatBytes(size)}`
        }`,
      );
    if (str(stash.contentHash))
      lines.push(`content hash: ${stash.contentHash}`);
    if (id && stash.ok !== false)
      lines.push(`restore: cairn stash restore ${id}`);
    return lines;
  }

  /**
   * Badge for a run's stash state, from the `artifact.stash` model entry or
   * `stash-receipt.json`. A save with post-save failures
   * (`status: saved_with_failures` / `postSaveFailureCount > 0`) or with
   * secret findings is a warning, not a green "stashed"; a failed stash names
   * its reason code. `lines` holds every fact (the tooltip is their join).
   * @param {Record<string, any> | null | undefined} stash
   * @returns {{ tone: "ok" | "warn", text: string, title: string, lines: string[] } | null}
   */
  function stashBadge(stash) {
    if (!stash || typeof stash !== "object") return null;
    const id = str(stash.stashId) ?? "";
    const lines = stashLines(stash);
    if (stash.ok === false) {
      const reason = str(stash.reason);
      return {
        tone: "warn",
        text:
          reason && Object.hasOwn(STASH_REASONS, reason)
            ? `not stashed · ${reason}`
            : "not stashed",
        title:
          lines.length > 1
            ? lines.join("\n")
            : (reason ?? "the stash did not complete"),
        lines,
      };
    }
    const failures = num(stash.postSaveFailureCount) ?? 0;
    const status = str(stash.status);
    const secrets = num(stash.secretsFound) ?? 0;
    const partial = failures > 0 || (status !== null && status !== "saved");
    const secretNote = secrets > 0 ? ` · ${secrets} secret finding(s)` : "";
    if (partial)
      return {
        tone: "warn",
        text: `stashed with failures ${id}${secretNote}`.trim(),
        title: lines.join("\n"),
        lines,
      };
    return {
      tone: secrets > 0 ? "warn" : "ok",
      text: `stashed ${id}${secretNote}`.trim(),
      title: lines.join("\n"),
      lines,
    };
  }

  /**
   * The display text of an `artifactRef`: a string as-is, or the URI / id
   * of an `artifact-ref:v1` object.
   * @param {unknown} ref
   * @returns {string | null}
   */
  function artifactRefText(ref) {
    if (typeof ref === "string") return ref.length ? short(ref, 200) : null;
    if (!ref || typeof ref !== "object") return null;
    const record = /** @type {Record<string, any>} */ (ref);
    const value =
      str(record.uri) ?? str(record.artifact_id) ?? str(record.id) ?? null;
    return value ? short(value, 200) : null;
  }

  /**
   * Badge for a run's publish state (model `publish` or a normalized
   * `publish-receipt.json`).
   * @param {Record<string, any> | null | undefined} publish
   * @returns {{ tone: "ok" | "warn", text: string, title: string, lines: string[] } | null}
   */
  function publishBadge(publish, nowMs = Date.now()) {
    if (!publish || typeof publish !== "object") return null;
    const lines = [];
    if (publish.ok === false) {
      const reason = str(publish.reason);
      lines.push("not published");
      const meaning = reasonLine(reason, PUBLISH_REASONS);
      if (meaning) lines.push(`reason: ${meaning}`);
      if (str(publish.message)) lines.push(`message: ${publish.message}`);
      return {
        tone: "warn",
        text:
          reason && Object.hasOwn(PUBLISH_REASONS, reason)
            ? `publish failed · ${reason}`
            : "publish failed",
        title: lines.join("\n"),
        lines,
      };
    }
    const ref = artifactRefText(publish.artifactRef);
    lines.push(`published to file.cheap${ref ? `: ${ref}` : ""}`);
    if (str(publish.publishedAt))
      lines.push(`published: ${fmt.formatTimestamp(publish.publishedAt)}`);
    if (str(publish.expiresAt))
      lines.push(
        `expires: ${fmt.formatTimestamp(publish.expiresAt)} (${fmt.relativeTime(
          publish.expiresAt,
        )})`,
      );
    const size = num(publish.sizeBytes);
    if (size !== null) lines.push(`package: ${fmt.formatBytes(size)}`);
    const excluded = strList(publish.excluded) ?? [];
    if (excluded.length)
      lines.push(
        `left out: ${excluded.join(", ")} — opt in with retention.publish.include`,
      );
    const skipped = str(publish.runIndexSkipped);
    if (skipped)
      lines.push(
        `not listed in the console: ${
          reasonLine(skipped, RUN_INDEX_SKIPPED) ?? skipped
        }`,
      );
    if (str(publish.sha256)) lines.push(`sha256: ${publish.sha256}`);
    // file.cheap no longer keeps an expired package: not a green "published"
    if (publishExpired(publish, nowMs)) {
      lines.unshift("expired: file.cheap no longer keeps this package");
      return {
        tone: "warn",
        text: "publish expired",
        title: lines.join("\n"),
        lines,
      };
    }
    return { tone: "ok", text: "published", title: lines.join("\n"), lines };
  }

  /**
   * Is a published package past its `expiresAt`?
   * @param {Record<string, any> | null | undefined} publish
   * @param {number} [nowMs]
   * @returns {boolean}
   */
  function publishExpired(publish, nowMs = Date.now()) {
    const at = Date.parse(str(publish?.expiresAt) ?? "");
    return Number.isFinite(at) && at <= nowMs;
  }

  /**
   * The run's publish state: `publish-receipt.json` (the durable record),
   * unless the last `artifact.publish` event is a failure newer than the
   * receipt — a failed re-publish must not keep showing the old green.
   * @param {Record<string, any> | null | undefined} receipt normalized receipt
   * @param {Record<string, any> | null | undefined} event model `publish`
   * @returns {Record<string, any> | null}
   */
  function publishState(receipt, event) {
    if (!receipt) return event ?? null;
    if (event?.ok === false) {
      const failedAt = Date.parse(str(event.ts) ?? "");
      const publishedAt = Date.parse(str(receipt.publishedAt) ?? "");
      if (
        Number.isFinite(failedAt) &&
        (!Number.isFinite(publishedAt) || failedAt > publishedAt)
      )
        return event;
    }
    return receipt;
  }

  /**
   * The last non-empty line of a multi-line output blob.
   * @param {unknown} value
   * @returns {string}
   */
  function lastLine(value) {
    const lines = String(value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.at(-1) ?? "";
  }

  /**
   * `type · key=value …` from the compact scalar fields of an event the
   * describer does not know — never a bare label.
   * @param {Record<string, any>} event
   * @returns {string}
   */
  function compactFields(event) {
    const parts = [];
    for (const [key, value] of Object.entries(event ?? {})) {
      if (key === "ts" || key === "type") continue;
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      parts.push(`${key}=${short(value, 60)}`);
      if (parts.length >= 5) break;
    }
    return parts.join(" ");
  }

  /**
   * Phase display name.
   * @param {string | null | undefined} phase
   * @returns {string}
   */
  function phaseLabel(phase) {
    return PHASE_LABELS[String(phase ?? "")] ?? String(phase ?? "phase");
  }

  /**
   * `3/12` when the runner stamped an index (and total), else null.
   * @param {Record<string, any>} event
   * @returns {string | null}
   */
  function positionOf(event) {
    const index = num(event?.index);
    if (index === null) return null;
    const total = num(event?.total);
    return total === null ? `${index}` : `${index}/${total}`;
  }

  /**
   * `kind label` without stuttering: the runner's label usually starts with
   * the kind already (`click role=button "Save"`).
   * @param {string | null} kind
   * @param {string | null} label
   * @returns {string}
   */
  function stepWhat(kind, label) {
    if (label && kind && !label.startsWith(kind)) return `${kind} ${label}`;
    return label ?? kind ?? "";
  }

  /**
   * F14: where a nested step ran, from the additive `parentId` /
   * `iteration` / `branch` fields of its step.* event or run.json result:
   * `in visit_rows #2`, `in maybe_nav then`. Null for a top-level step.
   * @param {Record<string, any> | null | undefined} source
   * @returns {string | null}
   */
  function placeText(source) {
    const parentId = str(source?.parentId);
    if (!parentId) return null;
    const iteration = num(source?.iteration);
    const branch = str(source?.branch);
    return `in ${parentId}${iteration === null ? "" : ` #${iteration}`}${
      branch ? ` ${branch}` : ""
    }`;
  }

  /**
   * What a finished block did, in run-report shorthand: `×3` iterations (a
   * repeat) or attempts (a retried use), `→ then` (an if), `not matched`
   * (an optional or grouped wait). Empty for every other step.
   * @param {Record<string, any> | null | undefined} source
   * @returns {string}
   */
  function blockText(source) {
    const parts = [];
    const iterations = num(source?.iterations);
    if (iterations !== null) parts.push(`×${iterations}`);
    const taken = str(source?.taken);
    if (taken) parts.push(taken === "none" ? "→ no branch" : `→ ${taken}`);
    if (source?.matched === false) parts.push("not matched");
    return parts.join(" · ");
  }

  /**
   * The label of one group of a block's nested steps: `then` / `else` for an
   * if branch, `attempt N` for a retried use, `iteration N` for a repeat.
   * @param {{ iteration?: number | null, branch?: string | null }} place
   * @param {string | null | undefined} parentKind the block's step kind
   * @returns {string}
   */
  function groupLabel(place, parentKind) {
    if (place.branch) return String(place.branch);
    if (place.iteration === null || place.iteration === undefined)
      return "steps";
    return `${
      parentKind === "use" ? "attempt" : "iteration"
    } ${place.iteration}`;
  }

  /**
   * A run-lock owner (`run.lock.refused` / `run.lock.reclaimed`) in one line:
   * `pid 4242 (cli, env "local") · 5m 3s old`.
   * @param {Record<string, any> | null | undefined} owner
   * @returns {string | null}
   */
  function lockOwnerText(owner) {
    if (!owner || typeof owner !== "object") return null;
    const pid = num(owner.pid);
    const bits = [
      str(owner.origin),
      str(owner.invocationId) ? `invocation ${owner.invocationId}` : null,
      str(owner.env) ? `env "${owner.env}"` : null,
    ].filter(Boolean);
    const age = num(owner.ageSeconds);
    return [
      pid === null ? "unknown owner" : `pid ${pid}`,
      bits.length ? `(${bits.join(", ")})` : null,
      owner.alive === false ? "· not running" : null,
      age === null ? null : `· ${fmt.formatDuration(age * 1000)} old`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  /**
   * The CLI's exit-code meaning, for a suite's verdict line.
   * @param {number} code
   * @returns {string}
   */
  function describeSuiteExit(code) {
    switch (code) {
      case 0:
        return "passed";
      case 1:
        return "outcome failure";
      case 2:
        return "errored";
      case 4:
        return "refused before start";
      case 7:
        return "refused by environment policy";
      case 8:
        return "critical teardown failed";
      case 9:
        return "dirty state after the run";
      default:
        return "failed";
    }
  }

  /**
   * Run-policy and suite events (config `run:` block, `--bail`, `--suite`,
   * `metrics:` probes). Null for anything else.
   * @param {string} type
   * @param {Record<string, any>} event
   * @param {string} took ` · 1.2s` or empty
   * @returns {{ label: string, tone: "ok" | "bad" | "warn" | "info" | "muted" | "refused", detail: string | null } | null}
   */
  function describePolicyEvent(type, event, took) {
    const kind = str(event?.kind);
    const name = str(event?.name);
    switch (type) {
      case "run.lock.acquired":
        return event?.reclaimed
          ? {
              label: "run lock acquired (a dead owner's lock was reclaimed)",
              tone: "warn",
              detail: str(event?.path),
            }
          : {
              label: "run lock acquired",
              tone: "ok",
              detail: str(event?.path),
            };
      case "run.lock.reclaimed":
        return {
          label: "run lock reclaimed from a dead owner",
          tone: "warn",
          detail:
            [lockOwnerText(event?.previousOwner), str(event?.path)]
              .filter(Boolean)
              .join(" — ") || null,
        };
      case "run.lock.refused":
        return {
          label: `run lock refused · ${str(event?.reason) ?? "held"}${
            event?.owner ? ` by ${lockOwnerText(event.owner)}` : ""
          }`,
          tone: "bad",
          detail: str(event?.message) ? short(event.message, 400) : null,
        };
      case "run.lock.released": {
        const held = num(event?.heldMs);
        return {
          label: `run lock released${
            held === null ? "" : ` · held ${fmt.formatDuration(held)}`
          }`,
          tone: "muted",
          detail: str(event?.path),
        };
      }
      case "preflight.started":
        return {
          label: `preflight started · ${num(event?.total) ?? "?"} check(s)`,
          tone: "info",
          detail: null,
        };
      case "preflight.passed":
        return {
          label: `preflight ${event?.index ?? "?"} · ${event?.check ?? "?"}${
            name ? ` ${name}` : ""
          } passed${took}`,
          tone: "ok",
          detail: null,
        };
      case "preflight.failed":
        return {
          label: `preflight ${event?.index ?? "?"} · ${event?.check ?? "?"}${
            name ? ` ${name}` : ""
          } FAILED${took}`,
          tone: "bad",
          detail: str(event?.reason) ? short(event.reason, 400) : null,
        };
      case "cleanliness.clean":
        return {
          label: `${event?.phase ?? "?"}-run cleanliness · ${kind ?? "?"}${
            name ? ` ${name}` : ""
          } clean`,
          tone: "ok",
          detail: null,
        };
      case "cleanliness.dirty": {
        const survivors = Array.isArray(event?.survivors)
          ? event.survivors.map(String)
          : [];
        const where = `${kind ?? "?"}${name ? ` ${name}` : ""} · ${
          survivors.length
        } left`;
        return {
          label:
            event?.phase === "after"
              ? `dirty after the run (exit 9) · ${where}`
              : `dirty before the run (run refused) · ${where}`,
          tone: event?.phase === "after" ? "warn" : "bad",
          detail: survivors.length ? short(survivors.join(" · "), 400) : null,
        };
      }
      case "finally.started":
        return {
          label: `finally ${event?.index ?? "?"}/${event?.total ?? "?"} started`,
          tone: "info",
          detail: null,
        };
      case "finally.finished": {
        const ok = event?.exitCode === 0 && !event?.timedOut;
        const tail = lastLine(event?.outputTail);
        const how = event?.timedOut
          ? "timed out"
          : event?.exitCode === undefined || event?.exitCode === null
            ? "did not exit cleanly"
            : `exit ${event.exitCode}`;
        return {
          label: `finally ${event?.index ?? "?"} ${how}${took}${
            ok ? "" : " (non-fatal)"
          }`,
          tone: ok ? "ok" : "warn",
          detail: tail ? short(tail, 300) : null,
        };
      }
      case "invocation.bailed":
        return {
          label: `bailed after ${event?.spec ?? "a spec"} (exit ${
            event?.exitCode ?? "?"
          }) · ${num(event?.skipped) ?? 0} spec(s) skipped`,
          tone: "warn",
          detail: null,
        };
      case "suite.started":
        return {
          label: `suite ${name ?? "?"} started · ${num(event?.specs) ?? "?"} spec(s)${
            str(event?.env) ? ` · env ${event.env}` : ""
          }${num(event?.parallel) ? ` · parallel ${event.parallel}` : ""}${
            event?.bail ? " · bail" : ""
          }`,
          tone: "info",
          detail: null,
        };
      case "suite.hook.started":
        return {
          label: `suite ${name ?? "?"} ${event?.hook ?? "?"} hook ${
            event?.index ?? "?"
          }/${event?.total ?? "?"} started`,
          tone: "info",
          detail: str(event?.command) ? short(event.command, 300) : null,
        };
      case "suite.hook.finished": {
        const tail = lastLine(event?.outputTail);
        const how = event?.timedOut
          ? "timed out"
          : event?.ok
            ? "ok"
            : `failed${
                event?.exitCode === undefined || event?.exitCode === null
                  ? ""
                  : ` (exit ${event.exitCode})`
              }`;
        return {
          label: `suite ${name ?? "?"} ${event?.hook ?? "?"} hook ${
            event?.index ?? "?"
          } ${how}${took}`,
          tone: event?.ok ? "ok" : event?.hook === "after" ? "warn" : "bad",
          detail: tail ? short(tail, 300) : null,
        };
      }
      case "suite.finished": {
        const code = num(event?.exitCode);
        const failedHooks = num(event?.hooksFailed);
        return {
          label: `suite ${name ?? "?"} finished · exit ${code ?? "?"}${
            code === null ? "" : ` (${describeSuiteExit(code)})`
          }`,
          tone: code === 0 ? "ok" : code === 7 ? "refused" : "bad",
          detail: failedHooks ? `${failedHooks} suite hook(s) failed` : null,
        };
      }
      case "metric.sampled": {
        const value = num(event?.value);
        const mark = `${
          event?.scope === "invocation" ? "invocation " : ""
        }metric ${name ?? "?"} ${event?.phase ?? "sample"}`;
        return value === null
          ? {
              label: `${mark} failed`,
              tone: "warn",
              detail: str(event?.error) ? short(event.error, 300) : null,
            }
          : { label: `${mark} = ${value}`, tone: "muted", detail: null };
      }
      default:
        return null;
    }
  }

  /**
   * `services.restart|tunnel|provisioner|files|seed.phase|seed.commit|
   * teardown` events, with the names their `data` carries. Null for any
   * other services event (the generic `services <phase> <event>` line).
   * @param {string} type
   * @param {Record<string, any>} event
   * @returns {{ label: string, tone: "ok" | "bad" | "warn" | "info" | "muted" | "refused", detail: string | null } | null}
   */
  function describeServicesOps(type, event) {
    const rest = type.startsWith("services.")
      ? type.slice("services.".length)
      : "";
    const data =
      event?.data && typeof event.data === "object" ? event.data : {};
    const message = str(event?.message);
    const detail = message ? short(message, 300) : null;
    const win = str(data.window);
    const tunnel = str(data.tunnel);
    const phase = str(data.phase);
    const exit = num(data.exitCode);
    const tookMs = num(data.durationMs);
    const took = tookMs === null ? "" : ` · ${fmt.formatDuration(tookMs)}`;
    // An event without the name it is about (an older or future cairn) reads
    // as the generic `services <phase> <event> · message` line instead.
    if (
      (rest.startsWith("restart.") && !win) ||
      (rest.startsWith("tunnel.") && !tunnel) ||
      (rest.startsWith("seed.phase.") && !phase)
    )
      return null;
    switch (rest) {
      case "restart.start":
        return {
          label: `service restart · ${win ?? "?"}${
            str(data.reason) ? ` (${data.reason})` : ""
          }`,
          tone: "info",
          detail,
        };
      case "restart.stop":
        return {
          label: `service ${win ?? "?"} stopped${
            data.graceful === false ? " (not gracefully)" : ""
          }${took}`,
          tone: data.graceful === false ? "warn" : "muted",
          detail,
        };
      case "restart.ready":
        return {
          label: `service ${win ?? "?"} restarted${took}`,
          tone: "ok",
          detail,
        };
      case "restart.fail":
        return {
          label: `service ${win ?? "?"} restart FAILED`,
          tone: "bad",
          detail,
        };
      case "restart.giveup":
        return {
          label: `service ${win ?? "?"} gave up after ${
            num(data.restarts) ?? "?"
          } restart(s)`,
          tone: "bad",
          detail,
        };
      case "tunnel.start":
        return {
          label: `tunnel ${tunnel ?? "?"} starting`,
          tone: "info",
          detail,
        };
      case "tunnel.ready":
        return { label: `tunnel ${tunnel ?? "?"} ready`, tone: "ok", detail };
      case "tunnel.exit":
        return {
          label: `tunnel ${tunnel ?? "?"} exited`,
          tone: "warn",
          detail,
        };
      case "tunnel.restart":
        return {
          label: `tunnel ${tunnel ?? "?"} restarting`,
          tone: "warn",
          detail,
        };
      case "tunnel.giveup":
        return {
          label: `tunnel ${tunnel ?? "?"} gave up after ${
            num(data.restarts) ?? "?"
          } restart(s)`,
          tone: "bad",
          detail,
        };
      case "tunnel.stop":
        return {
          label: `tunnel ${tunnel ?? "?"} stopped`,
          tone: "muted",
          detail,
        };
      case "tunnel.fail":
        return {
          label: `tunnel ${tunnel ?? "?"} FAILED to start`,
          tone: "bad",
          detail,
        };
      case "provisioner.start":
        return { label: "provisioner up started", tone: "info", detail };
      case "provisioner.ready":
        return { label: "provisioner up finished", tone: "ok", detail };
      case "provisioner.exports": {
        const names = Array.isArray(data.exports)
          ? data.exports.map(String)
          : Array.isArray(data.names)
            ? data.names.map(String)
            : [];
        return {
          label: `provisioner exports · ${names.length} name(s)`,
          tone: "ok",
          detail: names.length ? names.join(", ") : detail,
        };
      }
      case "provisioner.fail":
        return { label: "provisioner up FAILED", tone: "bad", detail };
      case "files.write":
      case "files.unchanged":
      case "files.fail": {
        const file = str(data.path);
        const what = file ? ` · ${short(file, 120)}` : "";
        return rest === "files.write"
          ? { label: `services file written${what}`, tone: "ok", detail }
          : rest === "files.unchanged"
            ? { label: `services file unchanged${what}`, tone: "muted", detail }
            : {
                label: `services file write FAILED${what}`,
                tone: "bad",
                detail,
              };
      }
      case "seed.postcommand.skip":
        return {
          label: `seed post-command skipped${
            str(data.postCommand) ? ` · ${short(data.postCommand, 80)}` : ""
          }`,
          tone: "muted",
          detail: str(data.reason) ? short(data.reason, 200) : detail,
        };
      case "seed.phase.start":
        return {
          label: `seed phase ${phase ?? "?"} started`,
          tone: "info",
          detail,
        };
      case "seed.phase.skip":
        return {
          label: `seed phase ${phase ?? "?"} skipped`,
          tone: "muted",
          detail,
        };
      case "seed.phase.complete":
        return {
          label: `seed phase ${phase ?? "?"} done`,
          tone: "ok",
          detail,
        };
      case "seed.phase.fail":
        return {
          label: `seed phase ${phase ?? "?"} FAILED${
            exit === null ? "" : ` (exit ${exit})`
          }`,
          tone: "bad",
          detail,
        };
      case "seed.commit":
        return { label: "seed committed", tone: "ok", detail };
      case "teardown.fail":
        if (data.critical || data.provisioner)
          return {
            label: `${
              data.provisioner ? "provisioner down" : "critical teardown"
            } FAILED${exit === null ? "" : ` (exit ${exit})`} — exit 8`,
            tone: "bad",
            detail,
          };
        return null;
      default:
        return null;
    }
  }

  /**
   * @typedef {"ok" | "bad" | "warn" | "info" | "muted" | "refused"} Tone
   * @typedef {{
   *   ts: string | null,
   *   type: string,
   *   category: string,
   *   stepId: string | null,
   *   outcomeId: string | null,
   *   label: string,
   *   detail: string | null,
   *   tone: Tone,
   * }} EventDescription
   */

  /**
   * One human line (plus optional detail) for one event.
   * @param {Record<string, any>} event
   * @returns {EventDescription}
   */
  function describeEvent(event) {
    const type = str(event?.type) ?? "unknown";
    const ts = str(event?.ts);
    const stepId = str(event?.stepId);
    const outcomeId = str(event?.outcomeId);
    const category = type.includes(".") ? type.split(".")[0] : "other";
    /** @type {EventDescription} */
    const out = {
      ts,
      type,
      category,
      stepId,
      outcomeId,
      label: type,
      detail: null,
      tone: "muted",
    };
    const set = (
      /** @type {string} */ label,
      /** @type {Tone} */ tone,
      /** @type {string | null} */ detail = null,
    ) => {
      out.label = label;
      out.tone = tone;
      out.detail = detail ? detail : null;
      return out;
    };
    const duration = num(event?.durationMs);
    const took = duration === null ? "" : ` · ${fmt.formatDuration(duration)}`;

    switch (type) {
      // ── run ──────────────────────────────────────────────────────────────
      case "run.started": {
        const inv = event?.invocation;
        const position =
          inv && num(inv.index) !== null
            ? ` (spec ${inv.index}${
                num(inv.total) !== null ? `/${inv.total}` : ""
              })`
            : "";
        return set(
          `run started · ${event?.spec ?? "?"}${position}`,
          "info",
          str(event?.runId),
        );
      }
      case "run.passed":
        return set(`run passed${took}`, "ok");
      case "run.refused": {
        const position = positionOf(event);
        return set(
          `${position ? `[${position}] ` : ""}run refused${
            event?.spec ? ` · ${event.spec}` : ""
          }${event?.env ? ` · env ${event.env}` : ""}`,
          "refused",
          [
            str(event?.code),
            str(event?.reason) ? short(event.reason, 400) : null,
          ]
            .filter(Boolean)
            .join(" — ") || null,
        );
      }
      case "run.failed":
        return set(`run failed${took}`, "bad");
      case "run.errored": {
        const where = [str(event?.phase), str(event?.name)]
          .filter(Boolean)
          .join(" ");
        return set(
          `run errored${where ? ` in ${where}` : ""}${
            event?.timedOut ? " (timed out)" : ""
          }${took}`,
          "bad",
          str(event?.error) ? short(event.error, 400) : null,
        );
      }
      case "run.heartbeat": {
        const elapsed = num(event?.elapsedMs);
        const budget = num(event?.budgetMs);
        return set(
          `heartbeat · ${phaseLabel(event?.phase)}${
            event?.item ? ` ${event.item}` : ""
          }${elapsed === null ? "" : ` · ${fmt.formatDuration(elapsed)}`}${
            budget === null ? "" : ` of ${fmt.formatDuration(budget)}`
          }`,
          "muted",
        );
      }
      case "phase.changed": {
        const budget = num(event?.budgetMs);
        return set(
          `phase → ${phaseLabel(event?.phase)}${
            event?.item ? ` · ${event.item}` : ""
          }${budget === null ? "" : ` (budget ${fmt.formatDuration(budget)})`}`,
          "info",
        );
      }

      // ── steps ────────────────────────────────────────────────────────────
      case "step.started": {
        const position = positionOf(event);
        const what = stepWhat(str(event?.kind), str(event?.label));
        const place = placeText(event);
        return set(
          `${position ? `[${position}] ` : ""}step ${stepId ?? "?"} started${
            what ? ` · ${short(what, 160)}` : ""
          }${place ? ` (${short(place, 120)})` : ""}`,
          "info",
        );
      }
      case "step.finished": {
        const place = placeText(event);
        const where = place ? ` (${short(place, 120)})` : "";
        if (event?.skipped) {
          const when = whenText(event?.when);
          const reason = str(event?.skipReason);
          return set(
            `step ${stepId ?? "?"} skipped${
              reason
                ? ` (${short(reason, 80)})`
                : when
                  ? ` (when: ${short(when, 80)})`
                  : " (when:)"
            }${where}`,
            "muted",
          );
        }
        const block = blockText(event);
        return set(
          `step ${stepId ?? "?"} passed${took}${block ? ` · ${block}` : ""}${
            event?.via === "dispatch" || event?.via === "dataTransfer"
              ? ` · via ${event.via}`
              : ""
          }${where}`,
          event?.matched === false ? "muted" : "ok",
          str(event?.detail) ? short(event.detail, 300) : str(event?.url),
        );
      }
      // ── widget fields (F15) ──────────────────────────────────────────────
      case "widget.field": {
        const status = String(event?.status ?? "?");
        return set(
          `field ${short(String(event?.field ?? "?"), 80)} ${status}${
            event?.driver ? ` · ${event.driver}` : ""
          }${took}`,
          status === "failed" ? "bad" : status === "skipped" ? "muted" : "ok",
          str(event?.path),
        );
      }
      case "step.failed": {
        const place = placeText(event);
        const block = blockText(event);
        return set(
          `step ${stepId ?? "?"} failed${took}${block ? ` · ${block}` : ""}${
            place ? ` (${short(place, 120)})` : ""
          }`,
          "bad",
          str(event?.error) ? short(event.error, 400) : null,
        );
      }

      // ── outcomes ─────────────────────────────────────────────────────────
      case "outcome.started": {
        const timeout = num(event?.timeoutMs);
        return set(
          `outcome ${outcomeId ?? "?"} verifying…${
            event?.kind ? ` (${event.kind}` : ""
          }${
            event?.kind && timeout !== null
              ? `, timeout ${fmt.formatDuration(timeout)})`
              : event?.kind
                ? ")"
                : ""
          }`,
          "info",
        );
      }
      case "outcome.progress":
        return set(
          `outcome ${outcomeId ?? "?"} · ${short(event?.message ?? "", 200)}`,
          "info",
        );
      case "outcome.passed":
      case "outcome.failed":
      case "outcome.skipped": {
        const status = type.slice("outcome.".length);
        return set(
          `outcome ${outcomeId ?? "?"} ${status}${took}${attemptsText(
            event?.attempts,
            event?.polledMs,
          )}`,
          status === "passed" ? "ok" : status === "failed" ? "bad" : "muted",
        );
      }

      // ── expect steps (F16) ───────────────────────────────────────────────
      case "expect.passed":
      case "expect.failed": {
        const passed = type === "expect.passed";
        const attempts = num(event?.attempts);
        return set(
          `expect ${str(event?.expectId) ?? stepId ?? "?"} ${
            passed ? "passed" : "failed"
          }${event?.kind ? ` (${event.kind})` : ""}${
            attempts !== null && attempts > 1 ? ` · ${attempts} attempts` : ""
          }${took}`,
          passed ? "ok" : "bad",
          passed
            ? str(event?.actual)
              ? short(event.actual, 300)
              : null
            : `expected ${short(event?.expected ?? "?", 200)}; got ${short(
                event?.actual ?? "?",
                200,
              )}`,
        );
      }

      // ── readiness gates (F2) ─────────────────────────────────────────────
      case "gate.started": {
        const budget = num(event?.budgetMs);
        const every = num(event?.everyMs);
        const stable = num(event?.stable);
        const scope = gateScopeLabel(event?.scope);
        const policy = [
          budget ? `budget ${fmt.formatDuration(budget)}` : "no deadline",
          every ? `every ${fmt.formatDuration(every)}` : null,
          stable ? `stable ×${stable}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return set(
          `gate ${event?.name ?? "?"} waiting${
            scope ? ` · ${scope}` : ""
          } (${policy})`,
          "info",
        );
      }
      case "gate.attempt":
        return set(
          `gate ${event?.name ?? "?"} attempt ${event?.attempt ?? "?"} · ${
            event?.ok ? "ready" : "not ready"
          }`,
          event?.ok ? "ok" : "muted",
          str(event?.detail) ? short(event.detail, 300) : null,
        );
      case "gate.passed": {
        const attempts = num(event?.attempts);
        return set(
          `gate ${event?.name ?? "?"} ready${
            attempts === null
              ? ""
              : ` after ${attempts} attempt${attempts === 1 ? "" : "s"}`
          }${took}`,
          "ok",
          str(event?.lastDetail) ? short(event.lastDetail, 300) : null,
        );
      }
      case "gate.failed": {
        const attempts = num(event?.attempts);
        const why = event?.cancelled
          ? "cancelled"
          : event?.timedOut
            ? "timed out"
            : "not ready";
        return set(
          `gate ${event?.name ?? "?"} ${why}${
            attempts === null
              ? ""
              : ` after ${attempts} attempt${attempts === 1 ? "" : "s"}`
          }${took}`,
          event?.cancelled ? "warn" : "bad",
          str(event?.lastDetail) ? short(event.lastDetail, 300) : null,
        );
      }

      // ── spec teardown (F3a) ──────────────────────────────────────────────
      case "teardown.started": {
        const position = positionOf(event);
        const what = stepWhat(str(event?.kind), str(event?.label));
        return set(
          `teardown${position ? ` ${position}` : ""} · ${
            what ? `${short(what, 120)} · ` : ""
          }${str(event?.stepId) ?? "?"} started${
            event?.runStatus ? ` (run ${event.runStatus})` : ""
          }${event?.signal ? ` on ${event.signal}` : ""}`,
          "info",
        );
      }
      case "teardown.finished": {
        const status = String(event?.status ?? "?");
        return set(
          `teardown ${event?.index ?? "?"} · ${str(event?.stepId) ?? "?"} ${status}${
            event?.timedOut ? " (timed out)" : ""
          }${took}`,
          status === "passed" ? "ok" : status === "failed" ? "bad" : "muted",
          str(event?.error) ? short(event.error, 400) : null,
        );
      }

      // ── preconditions + hooks ────────────────────────────────────────────
      case "precondition.started": {
        const timeout = num(event?.timeoutMs);
        return set(
          `precondition ${event?.name ?? "?"} started${
            timeout === null ? "" : ` (timeout ${fmt.formatDuration(timeout)})`
          }`,
          "info",
          str(event?.logPath),
        );
      }
      case "precondition.progress":
        return set(
          `precondition ${event?.name ?? "?"} · ${short(event?.message ?? "", 200)}`,
          "info",
        );
      case "precondition.run": {
        const ok = event?.exitCode === 0 && !event?.timedOut;
        const exit = event?.timedOut
          ? "timed out"
          : `exit ${event?.exitCode ?? "?"}${
              event?.signal ? ` (${event.signal})` : ""
            }`;
        const tail = lastLine(event?.output);
        return set(
          `precondition ${event?.name ?? "?"} ${exit}${took}`,
          ok ? "ok" : "bad",
          tail ? short(tail, 300) : null,
        );
      }
      case "hook.started":
        return set(
          `${event?.hook ?? "?"} hook #${event?.index ?? "?"} started`,
          "info",
          str(event?.command) ? short(event.command, 300) : null,
        );
      case "hook.finished": {
        const ok = event?.exitCode === 0 && !event?.timedOut;
        const tail = lastLine(event?.outputTail);
        return set(
          `${event?.hook ?? "?"} hook #${event?.index ?? "?"} ${
            event?.timedOut ? "timed out" : `exit ${event?.exitCode ?? "?"}`
          }${took}`,
          ok ? "ok" : "bad",
          tail ? short(tail, 300) : null,
        );
      }

      // ── logs + invocation ────────────────────────────────────────────────
      case "log.opened":
        return set(
          `log · ${event?.kind ?? "?"}${event?.name ? ` ${event.name}` : ""}`,
          "muted",
          str(event?.path),
        );
      case "invocation.started": {
        const planned = num(event?.planned);
        return set(
          `invocation started${
            planned === null ? "" : ` · ${planned} planned`
          }`,
          "info",
          str(event?.invocationId),
        );
      }
      case "invocation.finished": {
        const status = String(event?.status ?? "unknown");
        return set(
          `invocation ${status}`,
          /** @type {Tone} */ (toneForStatus(status)),
          str(event?.invocationId),
        );
      }

      // ── artifacts ────────────────────────────────────────────────────────
      case "artifact.screenshot":
        if (event?.action === "failed")
          return set(
            `screenshot failed · ${event?.path ?? "?"}`,
            "warn",
            str(event?.error) ? short(event.error, 300) : null,
          );
        return set(`screenshot ${event?.path ?? "?"}`, "muted");
      case "artifact.snapshot":
        return set(`snapshot ${event?.path ?? "?"}`, "muted");
      case "artifact.diagnostics":
        return set(
          `diagnostics ${event?.path ?? "?"}${
            event?.wedged ? " (backend wedged)" : ""
          }`,
          event?.wedged ? "warn" : "muted",
        );
      case "artifact.request": {
        // F18: a matrix reports its mismatches, a retry / until its attempts.
        const matrix =
          typeof event?.combinations === "number"
            ? ` · ${event.combinations} combination(s)${
                event?.mismatches ? `, ${event.mismatches} mismatched` : ""
              }`
            : "";
        const attempts =
          typeof event?.attempts === "number"
            ? ` · ${event.attempts} attempts`
            : "";
        return set(
          `request${
            event?.assign ? ` ${event.assign}` : ""
          } → ${event?.status ?? "?"}${attempts}${matrix} · ${event?.path ?? "?"}`,
          event?.mismatches ? "warn" : "muted",
        );
      }
      case "artifact.download":
      case "artifact.transform":
      case "artifact.eval":
        return set(
          `${type.slice("artifact.".length)} ${
            event?.assign ? `${event.assign} → ` : ""
          }${event?.path ?? "?"}`,
          "muted",
        );
      case "artifact.monitor":
        return set(
          `monitor ${event?.action ?? ""}${
            event?.path ? ` · ${event.path}` : ""
          }`.trim(),
          "muted",
        );
      case "artifact.clip":
        return set(`clip ${event?.path ?? compactFields(event)}`, "muted");
      case "artifact.video": {
        const action = String(event?.action ?? "");
        if (action === "warning")
          return set("video warning", "warn", short(event?.warning ?? "", 300));
        if (action === "start")
          return set(
            `video recording started${
              event?.policy ? ` (${event.policy})` : ""
            }`,
            "muted",
          );
        if (action === "stop")
          return set(
            event?.path ? `video saved · ${event.path}` : "video stopped",
            "muted",
          );
        if (action === "clip")
          return event?.error
            ? set("video clips failed", "warn", short(event.error, 300))
            : set(
                `video clips · ${Object.keys(event?.clips ?? {}).length}`,
                "muted",
              );
        return set(`video ${compactFields(event)}`.trim(), "muted");
      }
      case "artifact.services":
        if (event?.action === "error")
          return set(
            "services evidence failed",
            "warn",
            short(event?.error ?? "", 300),
          );
        return set(
          `services evidence captured · ${event?.sources ?? 0} sources${
            event?.errors ? ` · ${event.errors} errors` : ""
          }`,
          "muted",
          str(event?.path),
        );
      case "artifact.stash": {
        if (stashFailed(event)) {
          const reason = str(event?.reason);
          const code = reason && Object.hasOwn(STASH_REASONS, reason);
          return set(
            code ? `not stashed · ${reason}` : "not stashed",
            "warn",
            short(
              [
                code ? reasonLine(reason, STASH_REASONS) : reason,
                str(event?.message) ?? str(event?.error),
              ]
                .filter(Boolean)
                .join(" — "),
              300,
            ) || null,
          );
        }
        const failures = num(event?.postSaveFailureCount) ?? 0;
        const secrets = num(event?.secretsFound) ?? 0;
        const partial =
          failures > 0 ||
          secrets > 0 ||
          Boolean(event?.status && event.status !== "saved");
        const excluded = strList(event?.excluded) ?? [];
        const notes = [
          excluded.length
            ? `left out ${excluded.join(", ")} (opt in with stash.include)`
            : null,
          str(event?.ttl) ? `ttl ${event.ttl}` : null,
          str(event?.expiresAt) ? `expires ${event.expiresAt}` : null,
        ].filter(Boolean);
        return set(
          `stashed · ${event?.stashId ?? "?"}${
            event?.status && event.status !== "saved"
              ? ` (${event.status})`
              : ""
          }${failures ? ` · ${failures} post-save failure(s)` : ""}${
            secrets ? ` · ${secrets} secret finding(s)` : ""
          }`,
          partial ? "warn" : "ok",
          notes.length ? notes.join(" · ") : null,
        );
      }
      case "artifact.publish": {
        if (event?.status === "error") {
          const reason = str(event?.reason);
          return set(
            reason ? `publish failed · ${reason}` : "publish failed",
            "warn",
            [reasonLine(reason, PUBLISH_REASONS), str(event?.message)]
              .filter(Boolean)
              .join(" — ") || null,
          );
        }
        return set(
          `published to file.cheap${
            artifactRefText(event?.artifactRef)
              ? ` · ${artifactRefText(event?.artifactRef)}`
              : ""
          }`,
          "ok",
          str(event?.webUrl),
        );
      }
      case "artifact.trace": {
        const action = str(event?.action);
        const reason = str(event?.reason);
        const sensitivity = str(event?.sensitivity);
        const format = str(event?.format);
        const formatText =
          format === "chrome-trace-json"
            ? "Chrome trace JSON (Perfetto)"
            : format === "playwright-zip"
              ? "Playwright trace (show-trace)"
              : null;
        const bytes = num(event?.bytes);
        const maxBytes = num(event?.maxBytes);
        if (action === "saved")
          return set(
            `trace saved${sensitivity ? ` · ${sensitivity}` : ""}`,
            sensitivity === "secret-bearing" ? "warn" : "muted",
            [
              str(event?.path),
              formatText,
              sensitivity && Object.hasOwn(SENSITIVITY, sensitivity)
                ? SENSITIVITY[sensitivity].meaning
                : null,
              str(event?.warning),
            ]
              .filter(Boolean)
              .join(" — ") || null,
          );
        if (action === "dropped")
          return set(
            "trace dropped · too large",
            "warn",
            [
              bytes !== null && maxBytes !== null
                ? `${fmt.formatBytes(bytes)} over the ${fmt.formatBytes(maxBytes)} limit (artifacts.capture.traceMaxBytes)`
                : reasonLine(reason, TRACE_REASONS),
              str(event?.warning),
            ]
              .filter(Boolean)
              .join(" — ") || null,
          );
        if (action === "error")
          return set(
            reason ? `trace failed · ${reason}` : "trace failed",
            "warn",
            [reasonLine(reason, TRACE_REASONS), str(event?.warning)]
              .filter(Boolean)
              .join(" — ") || null,
          );
        return set(`trace ${compactFields(event)}`.trim(), "muted");
      }
      case "artifact.retention":
        if (event?.action === "warning" || event?.warning)
          return set(
            "retention warning",
            "warn",
            short(event?.warning ?? "", 300),
          );
        return set(`retention ${compactFields(event)}`.trim(), "muted");
      case "viewport.set":
        return set(
          `viewport ${event?.width ?? "?"}×${event?.height ?? "?"}${
            event?.ok === false ? " failed" : ""
          }`,
          event?.ok === false ? "warn" : "muted",
          str(event?.error),
        );
      default:
        break;
    }

    // ── run policy, suites, metrics (wave 6) ─────────────────────────────
    const policy = describePolicyEvent(type, event, took);
    if (policy) return set(policy.label, policy.tone, policy.detail);

    // ── services.<phase>.<event> ─────────────────────────────────────────
    if (type.startsWith("services.")) {
      const ops = describeServicesOps(type, event);
      if (ops) return set(ops.label, ops.tone, ops.detail);
      const [, phase = "?", name = "?"] = type.split(".");
      const message = str(event?.message);
      const exit = num(event?.data?.exitCode);
      /** @type {Tone} */
      let tone = "info";
      if (name === "fail" || name === "failure-cleanup") tone = "bad";
      else if (
        name === "ready" ||
        name === "complete" ||
        (name === "healthcheck" &&
          /healthy/.test(message ?? "") &&
          !/unhealthy/.test(message ?? ""))
      )
        tone = "ok";
      else if (name === "healthcheck" && /unhealthy/.test(message ?? ""))
        tone = "warn";
      else if (name === "skip" || name === "reuse") tone = "muted";
      return set(
        `services ${phase} ${name}${
          message ? ` · ${short(message, 200)}` : ""
        }${
          exit === null || (message ?? "").includes(`exit ${exit}`)
            ? ""
            : ` (exit ${exit})`
        }`,
        tone,
      );
    }

    // ── fixture.<verb> (F3b): ensure / reset / verify / teardown ─────────
    if (type.startsWith("fixture.")) {
      const verb = type.slice("fixture.".length) || "?";
      const status = str(event?.status) ?? "?";
      const outputs = safeOutputs(event?.outputs);
      return set(
        `fixture ${event?.name ?? "?"} ${verb} ${status}${
          event?.adapter ? ` (${event.adapter})` : ""
        }${event?.timedOut ? " (timed out)" : ""}${
          event?.signal ? ` on ${event.signal}` : ""
        }${took}`,
        fixtureTone(status),
        str(event?.error)
          ? short(event.error, 400)
          : str(event?.reason)
            ? short(event.reason, 300)
            : outputs?.length
              ? `outputs: ${outputs.map(([key]) => key).join(", ")}`
              : null,
      );
    }

    // Unknown type: never a bare muted label.
    const fields = compactFields(event);
    return set(fields ? `${type} · ${fields}` : type, "muted");
  }

  /**
   * @param {string} status
   * @returns {Tone}
   */
  function toneForStatus(status) {
    const tone = fmt.statusTone(status);
    return /** @type {Tone} */ (tone === "warn" ? "warn" : tone);
  }

  // ── the reducer ──────────────────────────────────────────────────────────

  /**
   * @typedef {{
   *   stepId: string, index: number, total: number | null, kind: string | null,
   *   label: string | null, status: "running" | "passed" | "failed" | "skipped",
   *   startedAt: string | null, durationMs: number | null, error: string | null,
   *   url: string | null, screenshot: string | null, diagnostics: string | null,
   *   when: string | null, artifacts: string[], expect: ExpectRow | null,
   *   key: string, started: boolean,
   *   parentId: string | null, parentKey: string | null,
   *   iteration: number | null, branch: string | null, depth: number,
   *   iterations: number | null, taken: string | null, matched: boolean | null,
   *   via: string | null, driver: string | null, detail: string | null,
   *   skipReason: string | null, superseded: boolean,
   *   widgets: WidgetFieldRow[], widgetsDropped: number,
   *   requests: RequestRow[],
   * }} StepRow
   * @typedef {{
   *   field: string, status: string, driver: string | null,
   *   via: string | null, durationMs: number | null, path: string | null,
   * }} WidgetFieldRow
   * @typedef {{
   *   assign: string | null, status: number | null, attempts: number | null,
   *   combinations: number | null, mismatches: number | null,
   *   path: string | null,
   * }} RequestRow
   * @typedef {{
   *   outcomeId: string, kind: string | null, timeoutMs: number | null,
   *   status: "verifying" | "passed" | "failed" | "skipped",
   *   startedAt: string | null, endedAt: string | null, durationMs: number | null,
   *   progress: string[], attempts: number | null, polledMs: number | null,
   * }} OutcomeRow
   * @typedef {{
   *   name: string, scope: string | null, budgetMs: number | null,
   *   everyMs: number | null, stable: number | null,
   *   status: "waiting" | "passed" | "failed" | "interrupted",
   *   startedAt: string | null, endedAt: string | null,
   *   durationMs: number | null, attempts: number, lastOk: boolean | null,
   *   lastDetail: string | null, timedOut: boolean, cancelled: boolean,
   *   attemptLog: Array<{ attempt: number, ok: boolean, detail: string | null, ts: string | null }>,
   *   attemptsDropped: number,
   * }} GateRow
   * @typedef {{
   *   index: number, total: number | null, kind: string | null,
   *   stepId: string | null, label: string | null, runStatus: string | null,
   *   signal: string | null, status: "running" | "passed" | "failed" | "skipped",
   *   startedAt: string | null, durationMs: number | null,
   *   error: string | null, timedOut: boolean,
   * }} TeardownRow
   * @typedef {{
   *   stepId: string | null, expectId: string, kind: string | null,
   *   status: "passed" | "failed", path: string | null,
   *   attempts: number | null, durationMs: number | null,
   *   expected: string | null, actual: string | null, ts: string | null,
   * }} ExpectRow
   * @typedef {{
   *   name: string, adapter: string | null, scope: string | null,
   *   verbs: Record<string, { status: string, durationMs: number | null, error: string | null, reason: string | null, timedOut: boolean, signal: string | null, ts: string | null }>,
   *   order: string[], outputs: Array<[string, string]> | null,
   *   lastVerb: string | null, lastStatus: string | null,
   * }} FixtureRow
   */

  /** @returns {Record<string, any>} a fresh, empty run model */
  function createRunModel() {
    return {
      runId: null,
      spec: null,
      invocation: null,
      invocationId: null,
      planned: null,
      status: "running",
      terminal: null,
      startedAt: null,
      lastEventAt: null,
      phase: null,
      heartbeat: null,
      stepTotal: null,
      /** @type {StepRow[]} */
      steps: [],
      /** @type {Record<string, number>} stepId → its newest execution row */
      stepIndex: {},
      /** @type {Record<string, number>} stepId → executions seen (F14 loops) */
      stepRuns: {},
      /** executions past MAX_STEP_ROWS (folded into their id's newest row) */
      stepsDropped: 0,
      currentStepId: null,
      /** @type {OutcomeRow[]} */
      outcomes: [],
      /** @type {Record<string, number>} */
      outcomeIndex: {},
      preconditions: [],
      hooks: [],
      services: [],
      /** @type {GateRow[]} readiness gates waited on (gate.*) */
      gates: [],
      /** @type {TeardownRow[]} spec teardown items (teardown.*) */
      teardown: [],
      /** @type {ExpectRow[]} expect-step verdicts (expect.*) */
      expects: [],
      /** @type {FixtureRow[]} fixtures touched by the run (fixture.*) */
      fixtures: [],
      logs: [],
      latestScreenshot: null,
      stash: null,
      publish: null,
      refusal: null,
      /** run.refused entries (journal: one per refused planned spec) */
      refusals: [],
      retention: null,
      video: null,
      viewport: null,
      /** run lock, preflight, cleanliness, finally, bail, suite, metrics */
      policy: createPolicyState(),
      eventCount: 0,
    };
  }

  /**
   * @returns {{
   *   lock: { state: string, path: string | null, scope: string | null, reason: string | null, owner: Record<string, any> | null, message: string | null, heldMs: number | null, reclaimed: boolean } | null,
   *   preflight: { total: number | null, checks: Array<{ index: number, check: string, name: string | null, status: "passed" | "failed", durationMs: number | null, reason: string | null }> },
   *   cleanliness: Array<{ phase: string, kind: string, name: string | null, status: "clean" | "dirty", survivors: string[] }>,
   *   finally: Array<{ index: number, total: number | null, status: "running" | "passed" | "failed" | "timed out", exitCode: number | null, durationMs: number | null, outputTail: string | null }>,
   *   bailed: { spec: string | null, exitCode: number | null, skipped: number } | null,
   *   suite: { name: string, env: string | null, specs: number | null, parallel: number | null, bail: boolean, status: "running" | "passed" | "failed" | "refused", exitCode: number | null, hooksFailed: number | null } | null,
   *   suiteHooks: Array<{ hook: string, index: number, total: number | null, command: string | null, logPath: string | null, status: "running" | "passed" | "failed" | "timed out", exitCode: number | null, durationMs: number | null, outputTail: string | null }>,
   *   metrics: Array<{ name: string, scope: string | null, phase: string | null, value: number | null, error: string | null, runId: string | null, iteration: number | null, ts: string | null }>,
   * }}
   */
  function createPolicyState() {
    return {
      lock: null,
      preflight: { total: null, checks: [] },
      cleanliness: [],
      finally: [],
      bailed: null,
      suite: null,
      suiteHooks: [],
      metrics: [],
    };
  }

  /**
   * Fold one run-policy / suite / metric event into `model.policy`.
   * @param {Record<string, any>} model
   * @param {string} type
   * @param {Record<string, any>} event
   * @param {string | null} ts
   * @returns {string[] | null} touched sections, or null when not a policy event
   */
  function applyPolicyEvent(model, type, event, ts) {
    const policy = model.policy ?? (model.policy = createPolicyState());
    switch (type) {
      case "run.lock.acquired":
        policy.lock = {
          state: event.reclaimed ? "reclaimed" : "held",
          path: str(event.path),
          scope: str(event.scope),
          reason: null,
          owner: null,
          message: null,
          heldMs: null,
          reclaimed: Boolean(event.reclaimed),
        };
        return ["policy"];
      case "run.lock.reclaimed":
        policy.lock = {
          state: "reclaimed",
          path: str(event.path),
          scope: str(event.scope),
          reason: null,
          owner:
            event.previousOwner && typeof event.previousOwner === "object"
              ? event.previousOwner
              : null,
          message: null,
          heldMs: null,
          reclaimed: true,
        };
        return ["policy"];
      case "run.lock.refused":
        policy.lock = {
          state: "refused",
          path: str(event.path),
          scope: str(event.scope),
          reason: str(event.reason),
          owner:
            event.owner && typeof event.owner === "object" ? event.owner : null,
          message: str(event.message) ? short(event.message, 600) : null,
          heldMs: null,
          reclaimed: false,
        };
        return ["policy"];
      case "run.lock.released":
        if (policy.lock) {
          policy.lock.state = "released";
          policy.lock.heldMs = num(event.heldMs);
        } else
          policy.lock = {
            state: "released",
            path: str(event.path),
            scope: str(event.scope),
            reason: null,
            owner: null,
            message: null,
            heldMs: num(event.heldMs),
            reclaimed: false,
          };
        return ["policy"];
      case "preflight.started":
        policy.preflight.total = num(event.total);
        return ["policy"];
      case "preflight.passed":
      case "preflight.failed": {
        const index = num(event.index) ?? policy.preflight.checks.length + 1;
        const row = {
          index,
          check: str(event.check) ?? "check",
          name: str(event.name),
          status: /** @type {"passed" | "failed"} */ (
            type === "preflight.passed" ? "passed" : "failed"
          ),
          durationMs: num(event.durationMs),
          reason: str(event.reason) ? short(event.reason, 600) : null,
        };
        const at = policy.preflight.checks.findIndex(
          (entry) => entry.index === index,
        );
        if (at >= 0) policy.preflight.checks[at] = row;
        else policy.preflight.checks.push(row);
        bound(policy.preflight.checks, MAX_POLICY_ROWS);
        return ["policy"];
      }
      case "cleanliness.clean":
      case "cleanliness.dirty": {
        const phase = str(event.phase) ?? "?";
        const kind = str(event.kind) ?? "?";
        const name = str(event.name);
        const row = {
          phase,
          kind,
          name,
          status: /** @type {"clean" | "dirty"} */ (
            type === "cleanliness.clean" ? "clean" : "dirty"
          ),
          survivors: Array.isArray(event.survivors)
            ? event.survivors.slice(0, 50).map((line) => short(line, 300))
            : [],
        };
        const at = policy.cleanliness.findIndex(
          (entry) =>
            entry.phase === phase && entry.kind === kind && entry.name === name,
        );
        if (at >= 0) policy.cleanliness[at] = row;
        else policy.cleanliness.push(row);
        bound(policy.cleanliness, MAX_POLICY_ROWS);
        return ["policy"];
      }
      case "finally.started":
      case "finally.finished": {
        const index = num(event.index) ?? policy.finally.length + 1;
        let row = policy.finally.find((entry) => entry.index === index);
        if (!row) {
          row = {
            index,
            total: null,
            status: "running",
            exitCode: null,
            durationMs: null,
            outputTail: null,
          };
          policy.finally.push(row);
          bound(policy.finally, MAX_POLICY_ROWS);
        }
        row.total = num(event.total) ?? row.total;
        if (type === "finally.finished") {
          row.exitCode = num(event.exitCode);
          row.durationMs = num(event.durationMs);
          row.outputTail = str(event.outputTail)
            ? short(event.outputTail, OUTPUT_TAIL_CHARS)
            : null;
          row.status = event.timedOut
            ? "timed out"
            : row.exitCode === 0
              ? "passed"
              : "failed";
        }
        return ["policy"];
      }
      case "invocation.bailed":
        policy.bailed = {
          spec: str(event.spec),
          exitCode: num(event.exitCode),
          skipped: num(event.skipped) ?? 0,
        };
        return ["policy", "status"];
      case "suite.started":
        policy.suite = {
          name: str(event.name) ?? "?",
          env: str(event.env),
          specs: num(event.specs),
          parallel: num(event.parallel),
          bail: Boolean(event.bail),
          status: "running",
          exitCode: null,
          hooksFailed: null,
        };
        return ["policy"];
      case "suite.hook.started":
      case "suite.hook.finished": {
        const hook = str(event.hook) ?? "?";
        const index = num(event.index) ?? 1;
        let row = policy.suiteHooks.find(
          (entry) => entry.hook === hook && entry.index === index,
        );
        if (!row) {
          row = {
            hook,
            index,
            total: null,
            command: null,
            logPath: null,
            status: "running",
            exitCode: null,
            durationMs: null,
            outputTail: null,
          };
          policy.suiteHooks.push(row);
          bound(policy.suiteHooks, MAX_POLICY_ROWS);
        }
        row.total = num(event.total) ?? row.total;
        if (type === "suite.hook.started") {
          row.command = str(event.command) ? short(event.command, 400) : null;
          row.logPath = str(event.logPath);
        } else {
          row.exitCode = num(event.exitCode);
          row.durationMs = num(event.durationMs);
          row.outputTail = str(event.outputTail)
            ? short(event.outputTail, OUTPUT_TAIL_CHARS)
            : null;
          row.status = event.timedOut
            ? "timed out"
            : event.ok
              ? "passed"
              : "failed";
        }
        return ["policy"];
      }
      case "suite.finished": {
        const suite =
          policy.suite ??
          (policy.suite = {
            name: str(event.name) ?? "?",
            env: null,
            specs: null,
            parallel: null,
            bail: false,
            status: "running",
            exitCode: null,
            hooksFailed: null,
          });
        suite.exitCode = num(event.exitCode);
        suite.hooksFailed = num(event.hooksFailed);
        suite.status =
          suite.exitCode === 0
            ? "passed"
            : suite.exitCode === 7
              ? "refused"
              : "failed";
        return ["policy", "status"];
      }
      case "metric.sampled":
        policy.metrics.push({
          name: str(event.name) ?? "?",
          scope: str(event.scope),
          phase: str(event.phase),
          value: num(event.value),
          error: str(event.error) ? short(event.error, 300) : null,
          runId: str(event.runId),
          iteration: num(event.iteration),
          ts,
        });
        bound(policy.metrics, MAX_METRIC_SAMPLES);
        return ["policy"];
      default:
        return null;
    }
  }

  /**
   * @param {Record<string, any>} model
   * @param {string} stepId
   * @param {Record<string, any>} event
   * @returns {StepRow}
   */
  function stepRow(model, stepId, event) {
    const existing = model.stepIndex[stepId];
    if (existing !== undefined) return model.steps[existing];
    return addStepRow(model, stepId, event, stepId);
  }

  /**
   * Append a step row. `stepIndex` points at the newest execution of an id,
   * so artifact / widget / request events (which carry only the stepId) land
   * on the execution that is running.
   * @param {Record<string, any>} model
   * @param {string} stepId
   * @param {Record<string, any>} event
   * @param {string} key unique per execution (the stepId for the first)
   * @returns {StepRow}
   */
  function addStepRow(model, stepId, event, key) {
    /** @type {StepRow} */
    const row = {
      stepId,
      key,
      index: num(event?.index) ?? model.steps.length + 1,
      total: num(event?.total),
      kind: str(event?.kind),
      label: str(event?.label),
      status: "running",
      startedAt: str(event?.ts),
      durationMs: null,
      error: null,
      url: null,
      screenshot: null,
      diagnostics: null,
      when: null,
      artifacts: [],
      expect: null,
      started: false,
      parentId: null,
      parentKey: null,
      iteration: null,
      branch: null,
      depth: 0,
      iterations: null,
      taken: null,
      matched: null,
      via: null,
      driver: null,
      detail: null,
      skipReason: null,
      superseded: false,
      widgets: [],
      widgetsDropped: 0,
      requests: [],
    };
    model.stepIndex[stepId] = model.steps.length;
    model.steps.push(row);
    return row;
  }

  /**
   * The row a `step.started` opens. A step that already ran and finished
   * (a repeat iteration, a retried attempt, an if inside a loop) gets a new
   * execution row; anything else reuses the id's row (a flat spec never
   * starts a step twice). Past MAX_STEP_ROWS, executions share their id's
   * newest row and `stepsDropped` counts them.
   * @param {Record<string, any>} model
   * @param {string} stepId
   * @param {Record<string, any>} event
   * @returns {StepRow}
   */
  function startStepRow(model, stepId, event) {
    const existing = model.stepIndex[stepId];
    const previous = existing === undefined ? null : model.steps[existing];
    if (!previous || !previous.started || previous.status === "running")
      return stepRow(model, stepId, event);
    if (model.steps.length >= MAX_STEP_ROWS) {
      model.stepsDropped += 1;
      return previous;
    }
    const count = (model.stepRuns[stepId] ?? 1) + 1;
    model.stepRuns[stepId] = count;
    return addStepRow(model, stepId, event, `${stepId}#${count}`);
  }

  /**
   * F14: the rows of a retried use's earlier attempts (and everything nested
   * under them) are superseded once a later attempt starts: their failure
   * stays in the stream but no longer fails the run.
   * @param {Record<string, any>} model
   * @param {StepRow} parent the use block's row
   * @param {number} attempt the attempt that just started
   */
  function supersedeAttempts(model, parent, attempt) {
    const marked = new Set();
    const from = model.steps.indexOf(parent);
    for (let i = from + 1; i < model.steps.length; i += 1) {
      const row = model.steps[i];
      if (
        (row.parentKey === parent.key &&
          row.iteration !== null &&
          row.iteration < attempt) ||
        (row.parentKey !== null && marked.has(row.parentKey))
      ) {
        row.superseded = true;
        marked.add(row.key);
      }
    }
  }

  // ── F14 step trees ───────────────────────────────────────────────────────

  /**
   * @typedef {{
   *   item: Record<string, any>,
   *   kind: string | null,
   *   groups: StepGroup[],
   * }} StepNode
   * @typedef {{
   *   key: string, label: string,
   *   iteration: number | null, branch: string | null,
   *   status: "running" | "passed" | "failed" | "skipped" | "retried",
   *   superseded: boolean, error: string | null,
   *   nodes: StepNode[],
   * }} StepGroup
   */

  /**
   * Put a nested execution into its block's group for that iteration /
   * branch (created in the order the groups first ran).
   * @param {StepNode} parent
   * @param {StepNode} child
   * @param {{ iteration: number | null, branch: string | null }} place
   */
  function addToGroup(parent, child, place) {
    const key = `${place.iteration ?? ""}|${place.branch ?? ""}`;
    let group = parent.groups.find((entry) => entry.key === key);
    if (!group) {
      group = {
        key,
        label: groupLabel(place, parent.kind),
        iteration: place.iteration,
        branch: place.branch,
        status: "passed",
        superseded: false,
        error: null,
        nodes: [],
      };
      parent.groups.push(group);
    }
    group.nodes.push(child);
  }

  /**
   * A group's verdict from its direct steps: running while one runs, failed
   * when one failed, skipped when every step was, and `retried` for an
   * attempt a later one superseded.
   * @param {StepGroup} group
   */
  function settleGroup(group) {
    const items = group.nodes.map((node) => node.item);
    if (items.length && items.every((item) => item.superseded === true)) {
      group.superseded = true;
      group.status = "retried";
    } else if (items.some((item) => item.status === "running"))
      group.status = "running";
    else if (items.some((item) => item.status === "failed"))
      group.status = "failed";
    else if (items.length && items.every((item) => item.status === "skipped"))
      group.status = "skipped";
    else group.status = "passed";
    for (const node of group.nodes)
      for (const inner of node.groups) settleGroup(inner);
  }

  /**
   * The live model's step executions as a tree: top-level rows, and under a
   * block (repeat / if / retried use) its nested executions grouped by
   * iteration, attempt or branch, in the order they ran. A nested row whose
   * block never started in this stream stays at the top level.
   * @param {Record<string, any> | null | undefined} model
   * @returns {StepNode[]}
   */
  function modelStepTree(model) {
    /** @type {Map<string, StepNode>} */
    const nodes = new Map();
    /** @type {StepNode[]} */
    const roots = [];
    for (const row of model?.steps ?? []) {
      /** @type {StepNode} */
      const node = { item: row, kind: row.kind ?? null, groups: [] };
      nodes.set(row.key ?? row.stepId, node);
      const parent = row.parentKey ? nodes.get(row.parentKey) : undefined;
      if (parent)
        addToGroup(parent, node, {
          iteration: row.iteration ?? null,
          branch: row.branch ?? null,
        });
      else roots.push(node);
    }
    for (const node of nodes.values())
      if (!node.item.parentKey)
        for (const group of node.groups) settleGroup(group);
    return roots;
  }

  /**
   * run.json `steps` (F14 post-order: a block's nested results come before
   * the block's own) as a tree, like `modelStepTree`. A retried use's
   * dropped attempts come back as `retried` groups from its `retries`
   * (their step results are gone; the events still have them). Nested
   * results whose block recorded no result stay at the top level.
   * @param {Array<Record<string, any>> | null | undefined} steps
   * @param {(stepId: string) => string | null} [kindOf] a step's kind
   *   (from the events model), for group labels
   * @returns {StepNode[]}
   */
  function resultStepTree(steps, kindOf = () => null) {
    /** @type {Map<string, StepNode[]>} */
    const pending = new Map();
    /** @type {StepNode[]} */
    const roots = [];
    (Array.isArray(steps) ? steps : []).forEach((step, index) => {
      if (!step || typeof step !== "object") return;
      const id = str(step.id) ?? `step_${index + 1}`;
      const retries = Array.isArray(step.retries) ? step.retries : [];
      /** @type {StepNode} */
      const node = {
        item: step,
        kind: kindOf(id) ?? (retries.length ? "use" : null),
        groups: [],
      };
      for (const retry of retries) {
        const attempt = num(retry?.attempt);
        if (attempt === null) continue;
        node.groups.push({
          key: `retry|${attempt}`,
          label: groupLabel({ iteration: attempt, branch: null }, "use"),
          iteration: attempt,
          branch: null,
          status: "retried",
          superseded: true,
          error: str(retry?.error) ? short(retry.error, 600) : null,
          nodes: [],
        });
      }
      const children = pending.get(id);
      if (children) {
        pending.delete(id);
        for (const child of children)
          addToGroup(node, child, {
            iteration: num(child.item.iteration),
            branch: str(child.item.branch),
          });
        for (const group of node.groups)
          if (!group.superseded) settleGroup(group);
      }
      const parentId = str(step.parentId);
      if (parentId) {
        const list = pending.get(parentId) ?? [];
        list.push(node);
        pending.set(parentId, list);
      } else roots.push(node);
    });
    // a block that recorded no result (an older or interrupted runner)
    for (const orphans of pending.values()) roots.push(...orphans);
    return roots;
  }

  /**
   * @param {Record<string, any>} model
   * @param {string} outcomeId
   * @returns {OutcomeRow}
   */
  function outcomeRow(model, outcomeId) {
    const existing = model.outcomeIndex[outcomeId];
    if (existing !== undefined) return model.outcomes[existing];
    /** @type {OutcomeRow} */
    const row = {
      outcomeId,
      kind: null,
      timeoutMs: null,
      status: "verifying",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      progress: [],
      attempts: null,
      polledMs: null,
    };
    model.outcomeIndex[outcomeId] = model.outcomes.length;
    model.outcomes.push(row);
    return row;
  }

  /**
   * Drop the oldest entries of a bounded list.
   * @param {unknown[]} list
   * @param {number} max
   */
  function bound(list, max) {
    if (list.length > max) list.splice(0, list.length - max);
  }

  /**
   * The gate row a `gate.attempt` / `gate.passed` / `gate.failed` settles:
   * the newest still-waiting wait of that name (and scope), else a new row
   * (a stream that starts mid-wait).
   * @param {Record<string, any>} model
   * @param {Record<string, any>} event
   * @returns {GateRow}
   */
  function gateRow(model, event) {
    const name = str(event?.name) ?? "?";
    const scope = str(event?.scope);
    const open = findLast(
      model.gates,
      (row) =>
        row.name === name &&
        row.status === "waiting" &&
        (scope === null || row.scope === null || row.scope === scope),
    );
    if (open) return open;
    /** @type {GateRow} */
    const row = {
      name,
      scope,
      budgetMs: null,
      everyMs: null,
      stable: null,
      status: "waiting",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      attempts: 0,
      lastOk: null,
      lastDetail: null,
      timedOut: false,
      cancelled: false,
      attemptLog: [],
      attemptsDropped: 0,
    };
    model.gates.push(row);
    bound(model.gates, MAX_GATES);
    return row;
  }

  /**
   * The teardown row for a 1-based teardown index.
   * @param {Record<string, any>} model
   * @param {Record<string, any>} event
   * @returns {TeardownRow}
   */
  function teardownRow(model, event) {
    const index = num(event?.index) ?? model.teardown.length + 1;
    const existing = findLast(model.teardown, (row) => row.index === index);
    if (existing) return existing;
    /** @type {TeardownRow} */
    const row = {
      index,
      total: null,
      kind: null,
      stepId: null,
      label: null,
      runStatus: null,
      signal: null,
      status: "running",
      startedAt: null,
      durationMs: null,
      error: null,
      timedOut: false,
    };
    model.teardown.push(row);
    bound(model.teardown, MAX_TEARDOWN);
    return row;
  }

  /**
   * Last entry in `list` matching `predicate`.
   * @template T
   * @param {T[]} list
   * @param {(entry: T) => boolean} predicate
   * @returns {T | undefined}
   */
  function findLast(list, predicate) {
    for (let index = list.length - 1; index >= 0; index -= 1)
      if (predicate(list[index])) return list[index];
    return undefined;
  }

  /**
   * @param {string[]} list
   * @param {string | null} value
   */
  function pushUnique(list, value) {
    if (value && !list.includes(value)) list.push(value);
  }

  /**
   * Fold one event into the model. Returns the sections it touched so a view
   * can repaint only those ("status", "phase", "steps", "outcomes",
   * "preconditions", "hooks", "services", "logs", "screenshot", "badges").
   * @param {Record<string, any>} model
   * @param {Record<string, any>} event
   * @returns {string[]}
   */
  function applyEvent(model, event) {
    if (!event || typeof event !== "object") return [];
    const type = String(event.type ?? "");
    const ts = str(event.ts);
    model.eventCount += 1;
    if (ts) model.lastEventAt = ts;
    const stepId = str(event.stepId);

    switch (type) {
      case "run.started":
        model.runId = str(event.runId) ?? model.runId;
        model.spec = str(event.spec) ?? model.spec;
        model.startedAt = ts ?? model.startedAt;
        if (event.invocation && typeof event.invocation === "object") {
          model.invocation = event.invocation;
          model.invocationId = str(event.invocation.id) ?? model.invocationId;
        }
        return ["status"];
      case "run.passed":
      case "run.failed":
      case "run.errored": {
        const status = type.slice("run.".length);
        model.status = status;
        model.terminal = {
          status,
          ts,
          durationMs: num(event.durationMs),
          phase: str(event.phase),
          name: str(event.name),
          timedOut: Boolean(event.timedOut),
        };
        // A step still "running" when the run ended never finished.
        for (const row of model.steps)
          if (row.status === "running") row.status = "failed";
        for (const row of model.outcomes)
          if (row.status === "verifying") row.status = "skipped";
        // Teardown items may still run after the verdict (the SIGINT/SIGTERM
        // path): only a wait that never settled is closed here.
        const gates = closeOpenGates(model, ts);
        return ["status", "steps", "outcomes", "phase", ...gates];
      }
      case "run.refused": {
        // The runner writes run.refused to the invocation journal: a refused
        // spec gets no run directory. In a journal it is one planned spec,
        // never the end of the stream; only a run's own stream (it saw
        // run.started) ends refused.
        const refusal = {
          reason: str(event.reason),
          env: str(event.env),
          code: str(event.code),
          spec: str(event.spec),
          index: num(event.index),
          path: str(event.path),
          requires:
            event.requires && typeof event.requires === "object"
              ? event.requires
              : null,
        };
        model.refusals.push(refusal);
        if (model.refusals.length > MAX_REFUSALS)
          model.refusals.splice(0, model.refusals.length - MAX_REFUSALS);
        if (!model.runId) return ["refusals", "status"];
        model.status = "refused";
        model.refusal = refusal;
        model.terminal = {
          status: "refused",
          ts,
          durationMs: num(event.durationMs),
          phase: null,
          name: null,
          timedOut: false,
        };
        // Nothing ran: no step or outcome can still be open.
        for (const row of model.steps)
          if (row.status === "running") row.status = "skipped";
        for (const row of model.outcomes)
          if (row.status === "verifying") row.status = "skipped";
        return ["status", "steps", "outcomes", "phase", "badges", "refusals"];
      }
      case "phase.changed":
        model.phase = {
          phase: str(event.phase),
          item: str(event.item),
          budgetMs: num(event.budgetMs),
          deadline: str(event.deadline),
          since: ts,
        };
        return ["phase"];
      case "run.heartbeat":
        model.heartbeat = {
          ts,
          phase: str(event.phase),
          item: str(event.item),
          elapsedMs: num(event.elapsedMs),
          budgetMs: num(event.budgetMs),
          pid: num(event.pid),
        };
        return ["phase"];

      case "step.started": {
        if (!stepId) return [];
        const row = startStepRow(model, stepId, event);
        row.started = true;
        row.status = "running";
        row.startedAt = ts ?? row.startedAt;
        row.index = num(event.index) ?? row.index;
        row.total = num(event.total) ?? row.total;
        row.kind = str(event.kind) ?? row.kind;
        row.label = str(event.label) ?? row.label;
        // F14: a nested execution names its block, loop and branch; it hangs
        // under the block's open row (its newest execution).
        const parentId = str(event.parentId);
        if (parentId) {
          const at = model.stepIndex[parentId];
          const parent = at === undefined ? null : model.steps[at];
          row.parentId = parentId;
          row.parentKey = parent?.key ?? null;
          row.depth = parent ? parent.depth + 1 : 1;
          row.iteration = num(event.iteration);
          row.branch = str(event.branch);
          if (
            parent?.kind === "use" &&
            row.iteration !== null &&
            row.iteration > 1
          )
            supersedeAttempts(model, parent, row.iteration);
        } else if (row.total !== null) model.stepTotal = row.total;
        model.currentStepId = stepId;
        return ["steps", "phase"];
      }
      case "step.finished":
      case "step.failed": {
        if (!stepId) return [];
        const row = stepRow(model, stepId, event);
        row.status =
          type === "step.failed"
            ? "failed"
            : event.skipped
              ? "skipped"
              : "passed";
        row.durationMs = num(event.durationMs) ?? row.durationMs;
        row.error = str(event.error) ?? row.error;
        row.url = str(event.url) ?? row.url;
        row.when = whenText(event.when) ?? row.when;
        // F14 block results and F15 interaction paths (all optional)
        row.iterations = num(event.iterations) ?? row.iterations;
        row.taken = str(event.taken) ?? row.taken;
        if (typeof event.matched === "boolean") row.matched = event.matched;
        row.via = str(event.via) ?? row.via;
        row.driver = str(event.driver) ?? row.driver;
        row.detail = str(event.detail) ? short(event.detail, 600) : row.detail;
        row.skipReason = str(event.skipReason) ?? row.skipReason;
        const sections = ["steps"];
        const screenshot = str(event.screenshot);
        if (screenshot) {
          row.screenshot = screenshot;
          pushUnique(row.artifacts, screenshot);
          model.latestScreenshot = { path: screenshot, stepId, ts };
          sections.push("screenshot");
        }
        if (model.currentStepId === stepId) {
          // back to the enclosing block while it still runs
          const at = row.parentId ? model.stepIndex[row.parentId] : undefined;
          const parent = at === undefined ? null : model.steps[at];
          model.currentStepId =
            parent && parent.status === "running" ? parent.stepId : null;
        }
        return sections;
      }

      // ── F15 widget fields: one per field a set/check/choose/form handled ──
      case "widget.field": {
        if (!stepId) return [];
        const row = stepRow(model, stepId, event);
        if (row.widgets.length >= MAX_WIDGET_FIELDS) {
          row.widgetsDropped += 1;
          return ["steps"];
        }
        row.widgets.push({
          // a field key or a locator description, never the value
          field: short(String(event.field ?? "?"), 200),
          status: str(event.status) ?? "unknown",
          driver: str(event.driver),
          via: str(event.via),
          durationMs: num(event.durationMs),
          path: str(event.path),
        });
        const path = str(event.path);
        if (path) pushUnique(row.artifacts, path);
        return ["steps"];
      }

      case "outcome.started": {
        const id = str(event.outcomeId);
        if (!id) return [];
        const row = outcomeRow(model, id);
        row.status = "verifying";
        row.kind = str(event.kind) ?? row.kind;
        row.timeoutMs = num(event.timeoutMs) ?? row.timeoutMs;
        row.startedAt = ts ?? row.startedAt;
        return ["outcomes"];
      }
      case "outcome.progress": {
        const id = str(event.outcomeId);
        if (!id) return [];
        const row = outcomeRow(model, id);
        const message = str(event.message);
        if (message) {
          row.progress.push(message);
          if (row.progress.length > MAX_PROGRESS)
            row.progress.splice(0, row.progress.length - MAX_PROGRESS);
        }
        return ["outcomes"];
      }
      case "outcome.passed":
      case "outcome.failed":
      case "outcome.skipped": {
        const id = str(event.outcomeId);
        if (!id) return [];
        const row = outcomeRow(model, id);
        row.status = /** @type {OutcomeRow["status"]} */ (
          type.slice("outcome.".length)
        );
        row.endedAt = ts;
        row.durationMs = num(event.durationMs) ?? row.durationMs;
        row.attempts = num(event.attempts) ?? row.attempts;
        row.polledMs = num(event.polledMs) ?? row.polledMs;
        return ["outcomes"];
      }

      case "expect.passed":
      case "expect.failed": {
        /** @type {ExpectRow} */
        const entry = {
          stepId,
          expectId: str(event.expectId) ?? stepId ?? "expect",
          kind: str(event.kind),
          status: type === "expect.passed" ? "passed" : "failed",
          path: str(event.path),
          attempts: num(event.attempts),
          durationMs: num(event.durationMs),
          expected: typeof event.expected === "string" ? event.expected : null,
          actual: typeof event.actual === "string" ? event.actual : null,
          ts,
        };
        model.expects.push(entry);
        bound(model.expects, MAX_EXPECTS);
        if (!stepId) return ["expects"];
        // (the event's `kind` names assertions, not the step kind)
        const row = stepRow(model, stepId, { ts });
        row.expect = entry;
        // Runners before the expect/capture step labels say kind "step".
        if (!row.kind || row.kind === "step") row.kind = "expect";
        if (!row.label || row.label === "step")
          row.label = `expect ${entry.expectId}${
            entry.kind ? ` ${entry.kind}` : ""
          }`;
        pushUnique(row.artifacts, entry.path);
        return ["expects", "steps"];
      }

      case "gate.started": {
        /** @type {GateRow} */
        const row = {
          name: str(event.name) ?? "?",
          scope: str(event.scope),
          budgetMs: num(event.budgetMs),
          everyMs: num(event.everyMs),
          stable: num(event.stable),
          status: "waiting",
          startedAt: ts,
          endedAt: null,
          durationMs: null,
          attempts: 0,
          lastOk: null,
          lastDetail: null,
          timedOut: false,
          cancelled: false,
          attemptLog: [],
          attemptsDropped: 0,
        };
        model.gates.push(row);
        bound(model.gates, MAX_GATES);
        return ["gates", "phase"];
      }
      case "gate.attempt": {
        const row = gateRow(model, event);
        const attempt = num(event.attempt) ?? row.attempts + 1;
        row.attempts = Math.max(row.attempts, attempt);
        row.lastOk = Boolean(event.ok);
        row.lastDetail = str(event.detail) ?? row.lastDetail;
        row.attemptLog.push({
          attempt,
          ok: Boolean(event.ok),
          detail: str(event.detail),
          ts,
        });
        if (row.attemptLog.length > MAX_GATE_ATTEMPTS) {
          // keep the first attempts and the newest ones
          row.attemptLog.splice(5, 1);
          row.attemptsDropped += 1;
        }
        return ["gates", "phase"];
      }
      case "gate.passed":
      case "gate.failed": {
        const row = gateRow(model, event);
        row.status = type === "gate.passed" ? "passed" : "failed";
        row.attempts = num(event.attempts) ?? row.attempts;
        row.durationMs = num(event.durationMs) ?? row.durationMs;
        row.lastDetail = str(event.lastDetail) ?? row.lastDetail;
        row.lastOk = type === "gate.passed";
        row.timedOut = Boolean(event.timedOut);
        row.cancelled = Boolean(event.cancelled);
        row.endedAt = ts;
        return ["gates", "phase"];
      }

      case "teardown.started": {
        const row = teardownRow(model, event);
        row.status = "running";
        row.total = num(event.total) ?? row.total;
        row.kind = str(event.kind) ?? row.kind;
        row.stepId = str(event.stepId) ?? row.stepId;
        row.label = str(event.label) ?? row.label;
        row.runStatus = str(event.runStatus) ?? row.runStatus;
        row.signal = str(event.signal) ?? row.signal;
        row.startedAt = ts ?? row.startedAt;
        return ["teardown", "phase"];
      }
      case "teardown.finished": {
        const row = teardownRow(model, event);
        const status = str(event.status);
        row.status = /** @type {TeardownRow["status"]} */ (
          status === "passed" || status === "skipped" ? status : "failed"
        );
        row.kind = str(event.kind) ?? row.kind;
        row.stepId = str(event.stepId) ?? row.stepId;
        row.durationMs = num(event.durationMs) ?? row.durationMs;
        row.error = str(event.error) ?? row.error;
        row.timedOut = Boolean(event.timedOut);
        return ["teardown", "phase"];
      }

      case "precondition.started":
        model.preconditions.push({
          name:
            str(event.name) ?? `precondition[${model.preconditions.length}]`,
          status: "running",
          startedAt: ts,
          timeoutMs: num(event.timeoutMs),
          logPath: str(event.logPath),
          exitCode: null,
          durationMs: null,
          timedOut: false,
          signal: null,
          outputTail: null,
          progress: [],
        });
        return ["preconditions", "phase"];
      case "precondition.progress": {
        const entry = findLast(
          model.preconditions,
          (row) => row.name === str(event.name) || !str(event.name),
        );
        const message = str(event.message);
        if (entry && message) {
          entry.progress.push(message);
          if (entry.progress.length > MAX_PROGRESS)
            entry.progress.splice(0, entry.progress.length - MAX_PROGRESS);
        }
        return entry ? ["preconditions"] : [];
      }
      case "precondition.run": {
        const name = str(event.name) ?? "precondition";
        let entry = findLast(
          model.preconditions,
          (row) => row.name === name && row.status === "running",
        );
        if (!entry) {
          entry = {
            name,
            status: "running",
            startedAt: null,
            timeoutMs: null,
            logPath: null,
            exitCode: null,
            durationMs: null,
            timedOut: false,
            signal: null,
            outputTail: null,
            progress: [],
          };
          model.preconditions.push(entry);
        }
        entry.exitCode = num(event.exitCode);
        entry.durationMs = num(event.durationMs);
        entry.timedOut = Boolean(event.timedOut);
        entry.signal = str(event.signal);
        entry.logPath = str(event.logPath) ?? entry.logPath;
        const output = str(event.output);
        entry.outputTail = output ? output.slice(-OUTPUT_TAIL_CHARS) : null;
        entry.status =
          entry.exitCode === 0 && !entry.timedOut ? "passed" : "failed";
        return ["preconditions"];
      }

      case "hook.started":
        model.hooks.push({
          hook: str(event.hook) ?? "?",
          index: num(event.index),
          runId: str(event.runId),
          iteration: num(event.iteration),
          command: str(event.command),
          logPath: str(event.logPath),
          status: "running",
          startedAt: ts,
          exitCode: null,
          durationMs: null,
          outputTail: null,
        });
        return ["hooks", "phase"];
      case "hook.finished": {
        const hook = str(event.hook) ?? "?";
        const index = num(event.index);
        const runId = str(event.runId);
        const iteration = num(event.iteration);
        // Parallel --after hooks share hook + index; the run tells them apart.
        let entry = findLast(
          model.hooks,
          (row) =>
            row.hook === hook &&
            row.index === index &&
            (row.runId ?? null) === runId &&
            (row.iteration ?? null) === iteration,
        );
        if (!entry) {
          entry = {
            hook,
            index,
            runId,
            iteration,
            command: null,
            logPath: null,
            status: "running",
            startedAt: null,
            exitCode: null,
            durationMs: null,
            outputTail: null,
          };
          model.hooks.push(entry);
        }
        entry.exitCode = num(event.exitCode);
        entry.durationMs = num(event.durationMs);
        entry.outputTail = str(event.outputTail) ?? entry.outputTail;
        entry.timedOut = Boolean(event.timedOut);
        entry.status =
          entry.exitCode === 0 && !entry.timedOut ? "passed" : "failed";
        return ["hooks"];
      }

      case "log.opened": {
        const logPath = str(event.path);
        if (!logPath) return [];
        if (!model.logs.some((entry) => entry.path === logPath))
          model.logs.push({
            kind: str(event.kind) ?? "log",
            name: str(event.name),
            path: logPath,
            openedAt: ts,
          });
        // Precondition/hook rows learn their log from the announcement too.
        const name = str(event.name);
        if (event.kind === "precondition" && name) {
          const entry = findLast(
            model.preconditions,
            (row) => row.name === name,
          );
          if (entry && !entry.logPath) entry.logPath = logPath;
        }
        return ["logs"];
      }

      case "invocation.started":
        model.invocationId = str(event.invocationId) ?? model.invocationId;
        model.planned = num(event.planned);
        model.startedAt = ts ?? model.startedAt;
        return ["status"];
      case "invocation.finished":
        model.invocationId = str(event.invocationId) ?? model.invocationId;
        model.status = str(event.status) ?? "unknown";
        model.terminal = {
          status: model.status,
          ts,
          durationMs: num(event.durationMs),
          phase: null,
          name: null,
          timedOut: false,
        };
        return ["status", "phase", ...closeOpenGates(model, ts)];

      case "artifact.screenshot": {
        const shotPath = str(event.path);
        if (!shotPath || event.action === "failed") return [];
        if (stepId) {
          const row = stepRow(model, stepId, event);
          pushUnique(row.artifacts, shotPath);
          row.screenshot = row.screenshot ?? shotPath;
        }
        model.latestScreenshot = { path: shotPath, stepId, ts };
        return ["screenshot", "steps"];
      }
      case "artifact.snapshot":
      case "artifact.diagnostics":
      case "artifact.download":
      case "artifact.request":
      case "artifact.eval":
      case "artifact.transform":
      case "artifact.monitor": {
        const artifactPath = str(event.path);
        if (!stepId || !artifactPath) return [];
        const row = stepRow(model, stepId, event);
        pushUnique(row.artifacts, artifactPath);
        if (type === "artifact.diagnostics") row.diagnostics = artifactPath;
        // F18: what each request did (status, retries / polls, matrix)
        if (
          type === "artifact.request" &&
          row.requests.length < MAX_STEP_REQUESTS
        )
          row.requests.push({
            assign: str(event.assign),
            status: num(event.status),
            attempts: num(event.attempts),
            combinations: num(event.combinations),
            mismatches: num(event.mismatches),
            path: artifactPath,
          });
        return ["steps"];
      }
      case "artifact.video":
        if (event.action === "stop" && str(event.path))
          model.video = str(event.path);
        return [];
      case "artifact.stash":
        // The retention pass records archives of the runs it pruned on this
        // run's stream, with their runId: not this run's stash.
        if (foreignRun(model, event)) return [];
        model.stash = {
          ...(stashFailed(event)
            ? {
                ok: false,
                action: str(event.action),
                stashId: str(event.stashId),
                status: str(event.status),
                reason:
                  str(event.reason) ?? str(event.error) ?? str(event.status),
              }
            : {
                ok: true,
                action: str(event.action),
                stashId: str(event.stashId),
                status: str(event.status),
                postSaveFailureCount: num(event.postSaveFailureCount),
                reason: null,
              }),
          ...stashExtras(event),
        };
        return ["badges"];
      case "artifact.publish":
        // ditto: a pruned run's publication is not this run's
        if (foreignRun(model, event)) return [];
        model.publish =
          event.status === "error"
            ? {
                ok: false,
                status: "error",
                reason: str(event.reason) ?? "unknown",
                message: str(event.message) ? short(event.message, 300) : null,
                artifactRef: null,
                webUrl: null,
                ts,
              }
            : {
                ok: true,
                status: str(event.status) ?? "published",
                reason: null,
                message: null,
                ts,
                artifactRef: artifactRefText(event.artifactRef),
                webUrl: str(event.webUrl),
                ...(strList(event.excluded)?.length
                  ? { excluded: strList(event.excluded) }
                  : {}),
              };
        return ["badges"];
      case "artifact.retention":
        model.retention = {
          action: str(event.action),
          warning: str(event.warning),
          summary: compactFields(event),
        };
        return ["badges"];
      case "run.lock.acquired":
      case "run.lock.reclaimed":
      case "run.lock.refused":
      case "run.lock.released":
      case "preflight.started":
      case "preflight.passed":
      case "preflight.failed":
      case "cleanliness.clean":
      case "cleanliness.dirty":
      case "finally.started":
      case "finally.finished":
      case "invocation.bailed":
      case "suite.started":
      case "suite.hook.started":
      case "suite.hook.finished":
      case "suite.finished":
      case "metric.sampled":
        return applyPolicyEvent(model, type, event, ts) ?? [];
      case "viewport.set":
        model.viewport = {
          width: num(event.width),
          height: num(event.height),
          ok: event.ok !== false,
        };
        return [];
      default:
        break;
    }

    if (type.startsWith("services.")) {
      const [, phase = null, name = null] = type.split(".");
      model.services.push({
        ts,
        phase,
        event: name,
        message: str(event.message),
        data: event.data && typeof event.data === "object" ? event.data : null,
      });
      if (model.services.length > MAX_SERVICES)
        model.services.splice(0, model.services.length - MAX_SERVICES);
      return ["services"];
    }

    if (type.startsWith("fixture.")) {
      const name = str(event.name);
      const verb = type.slice("fixture.".length);
      if (!name || !verb) return [];
      let row = findLast(model.fixtures, (entry) => entry.name === name);
      if (!row) {
        row = {
          name,
          adapter: null,
          scope: null,
          verbs: {},
          order: [],
          outputs: null,
          lastVerb: null,
          lastStatus: null,
        };
        model.fixtures.push(row);
        bound(model.fixtures, MAX_FIXTURES);
      }
      row.adapter = str(event.adapter) ?? row.adapter;
      row.scope = str(event.scope) ?? row.scope;
      const status = str(event.status) ?? "unknown";
      row.verbs[verb] = {
        status,
        durationMs: num(event.durationMs),
        error: str(event.error) ? short(event.error, 600) : null,
        // why it was skipped or dry-run (`fresh: ensured …`, `shared environment`)
        reason: str(event.reason) ? short(event.reason, 300) : null,
        timedOut: Boolean(event.timedOut),
        signal: str(event.signal),
        ts,
      };
      if (!row.order.includes(verb)) row.order.push(verb);
      // Outputs are non-secret by contract; masked again on the way in.
      const outputs = safeOutputs(event.outputs);
      if (outputs?.length) row.outputs = outputs;
      row.lastVerb = verb;
      row.lastStatus = status;
      return ["fixtures"];
    }
    return [];
  }

  /**
   * A run (or invocation) that ended while a gate was still waiting: that
   * wait was cut off, not passed or failed.
   * @param {Record<string, any>} model
   * @param {string | null} ts
   * @returns {string[]}
   */
  function closeOpenGates(model, ts) {
    let touched = false;
    for (const row of model.gates)
      if (row.status === "waiting") {
        row.status = "interrupted";
        row.endedAt = ts;
        touched = true;
      }
    return touched ? ["gates"] : [];
  }

  /**
   * Reduce a whole event list into a fresh model.
   * @param {Array<Record<string, any>>} events
   * @param {Record<string, any>} [model]
   * @returns {Record<string, any>}
   */
  function reduceEvents(events, model = createRunModel()) {
    for (const event of events ?? []) applyEvent(model, event);
    return model;
  }

  /**
   * Epoch millis of an ISO timestamp, or null.
   * @param {string | null | undefined} iso
   * @returns {number | null}
   */
  function parseTs(iso) {
    if (!iso) return null;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * The open row of a phase (running step, verifying outcome, running
   * precondition/hook), for banners whose phase event named no item.
   * @param {Record<string, any>} model
   * @param {string} phase
   * @returns {string | null}
   */
  function openItem(model, phase) {
    if (phase === "steps" && model.currentStepId) {
      const row = model.steps[model.stepIndex[model.currentStepId]];
      const place = row ? placeText(row) : null;
      return row
        ? `${row.index}${
            row.total ? `/${row.total}` : ""
          } ${stepWhat(row.kind, row.label) || row.stepId}${
            place ? ` (${place})` : ""
          }`
        : model.currentStepId;
    }
    if (phase === "outcomes")
      return (
        findLast(model.outcomes, (row) => row.status === "verifying")
          ?.outcomeId ?? null
      );
    // A readiness gate is waited on before the precondition commands (and
    // while services boot): the open wait names the item.
    if (phase === "preconditions" || phase === "services") {
      const gate = findLast(model.gates, (row) => row.status === "waiting");
      if (gate) return gate.name;
    }
    if (phase === "preconditions")
      return (
        findLast(model.preconditions, (row) => row.status === "running")
          ?.name ?? null
      );
    if (phase === "teardown") {
      const row = findLast(
        model.teardown,
        (entry) => entry.status === "running",
      );
      return row?.stepId ?? null;
    }
    if (phase === "before-hooks" || phase === "after-hooks") {
      const hook = findLast(model.hooks, (row) => row.status === "running");
      return hook ? `#${hook.index ?? "?"}` : null;
    }
    return null;
  }

  /**
   * The phase the run is in right now and how long it has been there.
   * The heartbeat is the fresher signal when both exist.
   * @param {Record<string, any>} model
   * @param {number} [nowMs]
   * `text` is the whole line; `head` (phase + item) and `detail` (elapsed
   * against the budget, then the missing-heartbeat warning) are its two
   * parts, so a narrow banner can shorten the head and keep the detail.
   * @returns {{ phase: string, item: string | null, elapsedMs: number | null, budgetMs: number | null, stale: boolean, head: string, detail: string, text: string, gate: { name: string, scope: string | null, attempts: number, lastDetail: string | null } | null } | null}
   */
  function currentPhase(model, nowMs = Date.now()) {
    if (!model || model.terminal) return null;
    const changed = model.phase;
    const beat = model.heartbeat;
    const changedAt = parseTs(changed?.since);
    const beatAt = parseTs(beat?.ts);
    /** @type {{ phase: string | null, item: string | null, elapsedMs: number | null, budgetMs: number | null }} */
    let pick;
    if (beat && beat.phase && (beatAt ?? 0) >= (changedAt ?? 0)) {
      pick = {
        phase: beat.phase,
        item: beat.item,
        budgetMs:
          beat.budgetMs ??
          (changed?.phase === beat.phase ? changed.budgetMs : null),
        elapsedMs:
          beat.elapsedMs === null
            ? null
            : beat.elapsedMs + Math.max(0, nowMs - (beatAt ?? nowMs)),
      };
    } else if (changed?.phase) {
      pick = {
        phase: changed.phase,
        item: changed.item,
        budgetMs: changed.budgetMs,
        elapsedMs: changedAt === null ? null : Math.max(0, nowMs - changedAt),
      };
    } else {
      // Older runners: derive "where are we" from the newest open row.
      const pre = findLast(
        model.preconditions,
        (row) => row.status === "running",
      );
      const step =
        model.currentStepId !== null
          ? model.steps[model.stepIndex[model.currentStepId]]
          : undefined;
      const outcome = findLast(
        model.outcomes,
        (row) => row.status === "verifying",
      );
      const waiting = findLast(model.gates, (row) => row.status === "waiting");
      const cleaning = findLast(
        model.teardown,
        (row) => row.status === "running",
      );
      const open = cleaning
        ? {
            phase: "teardown",
            item: cleaning.stepId,
            since: cleaning.startedAt,
            budget: null,
          }
        : waiting
          ? {
              phase:
                waiting.scope && waiting.scope.startsWith("services")
                  ? "services"
                  : "preconditions",
              item: waiting.name,
              since: waiting.startedAt,
              budget: waiting.budgetMs || null,
            }
          : outcome
            ? {
                phase: "outcomes",
                item: outcome.outcomeId,
                since: outcome.startedAt,
                budget: outcome.timeoutMs,
              }
            : step
              ? {
                  phase: "steps",
                  item: step.stepId,
                  since: step.startedAt,
                  budget: null,
                }
              : pre
                ? {
                    phase: "preconditions",
                    item: pre.name,
                    since: pre.startedAt,
                    budget: pre.timeoutMs,
                  }
                : null;
      if (!open) return null;
      const since = parseTs(open.since);
      pick = {
        phase: open.phase,
        item: open.item,
        budgetMs: open.budget ?? null,
        elapsedMs: since === null ? null : Math.max(0, nowMs - since),
      };
    }
    if (!pick.phase) return null;
    // `phase.changed` without an item: name the open row of that phase.
    if (!pick.item) pick.item = openItem(model, pick.phase);
    // A heartbeat that stopped arriving says the phase may be stale.
    const beatAge =
      beat && beatAt !== null && pick.phase === beat.phase
        ? Math.max(0, nowMs - beatAt)
        : null;
    const stale = beatAge !== null && beatAge > HEARTBEAT_FRESH_MS;
    let head = `${phaseLabel(pick.phase)}${pick.item ? ` ${pick.item}` : ""}`;
    // While a readiness gate waits, the banner names the gate, its last
    // probe answer and the attempt count (the phase item is the gate name).
    const gate = findLast(
      model.gates,
      (row) =>
        row.status === "waiting" && (!pick.item || row.name === pick.item),
    );
    let attemptNote = "";
    if (gate) {
      if (
        (pick.budgetMs === null || pick.budgetMs === undefined) &&
        gate.budgetMs
      )
        pick.budgetMs = gate.budgetMs;
      const scope = gateScopeLabel(gate.scope);
      head = `gate ${gate.name}${scope ? ` (${scope})` : ""}${
        gate.lastDetail && gate.lastOk === false
          ? ` — ${short(gate.lastDetail, 160)}`
          : ""
      }`;
      if (gate.attempts) attemptNote = ` · attempt ${gate.attempts}`;
    } else if (pick.phase === "teardown") {
      const row = findLast(
        model.teardown,
        (entry) =>
          entry.status === "running" &&
          (!pick.item || entry.stepId === pick.item),
      );
      if (row)
        head = `teardown ${row.index}${
          row.total ? `/${row.total}` : ""
        } ${teardownWhat(row)}`;
    }
    const tail =
      pick.elapsedMs === null
        ? ""
        : ` · ${fmt.formatDuration(pick.elapsedMs)}${
            pick.budgetMs === null || pick.budgetMs === undefined
              ? ""
              : ` of ${fmt.formatDuration(pick.budgetMs)}`
          }`;
    const detail = `${tail}${attemptNote}${
      stale ? ` · no heartbeat for ${fmt.formatDuration(beatAge)}` : ""
    }`;
    return {
      phase: pick.phase,
      item: pick.item,
      elapsedMs: pick.elapsedMs,
      budgetMs: pick.budgetMs ?? null,
      stale,
      head,
      detail,
      text: `${head}${detail}`,
      gate: gate
        ? {
            name: gate.name,
            scope: gate.scope,
            attempts: gate.attempts,
            lastDetail: gate.lastDetail,
          }
        : null,
    };
  }

  /**
   * `<stepId> · <kind label>` of a teardown item.
   * @param {TeardownRow} row
   * @returns {string}
   */
  function teardownWhat(row) {
    const what = stepWhat(row.kind, row.label);
    if (!row.stepId) return what || "?";
    return what && what !== row.stepId ? `${row.stepId} · ${what}` : row.stepId;
  }

  /**
   * Classify whether a run without `run.json` is alive.
   *
   * Signals, strongest first: a fresh `run.heartbeat`; the owning process
   * (heartbeat or invocation pid) checked by the caller; and only when
   * neither exists, today's mtime heuristic.
   *
   * @param {{
   *   hasRunJson?: boolean,
   *   heartbeatTs?: string | number | null,
   *   pid?: number | null,
   *   pidAlive?: boolean | null,
   *   lastActivityMs?: number | null,
   *   now?: number,
   *   freshMs?: number,
   *   runningWindowMs?: number,
   *   staleMs?: number,
   * }} input
   * @returns {{ state: "finished" | "running" | "quiet" | "dead" | "interrupted" | "stale", reason: string, heartbeatAgeMs: number | null }}
   */
  function classifyLiveness(input) {
    const now = input.now ?? Date.now();
    const beatMs =
      typeof input.heartbeatTs === "number"
        ? input.heartbeatTs
        : parseTs(/** @type {string | null | undefined} */ (input.heartbeatTs));
    const heartbeatAgeMs = beatMs === null ? null : Math.max(0, now - beatMs);
    if (input.hasRunJson)
      return { state: "finished", reason: "run.json written", heartbeatAgeMs };
    if (
      heartbeatAgeMs !== null &&
      heartbeatAgeMs < (input.freshMs ?? HEARTBEAT_FRESH_MS)
    )
      return { state: "running", reason: "heartbeat", heartbeatAgeMs };
    if (input.pid && input.pidAlive === true)
      return {
        state: heartbeatAgeMs === null ? "running" : "quiet",
        reason:
          heartbeatAgeMs === null
            ? `process ${input.pid} alive`
            : `process ${input.pid} alive, heartbeat ${fmt.formatDuration(heartbeatAgeMs)} old`,
        heartbeatAgeMs,
      };
    if (input.pid && input.pidAlive === false)
      return {
        state: "dead",
        reason: `process ${input.pid} exited without writing run.json`,
        heartbeatAgeMs,
      };
    if (heartbeatAgeMs !== null)
      return {
        state: "dead",
        reason: `heartbeat stopped ${fmt.formatDuration(heartbeatAgeMs)} ago`,
        heartbeatAgeMs,
      };
    const activity = input.lastActivityMs ?? null;
    if (activity === null)
      return {
        state: "interrupted",
        reason: "no activity recorded",
        heartbeatAgeMs,
      };
    const age = Math.max(0, now - activity);
    if (age <= (input.runningWindowMs ?? 5 * 60_000))
      return { state: "running", reason: "recent writes", heartbeatAgeMs };
    if (age <= (input.staleMs ?? 30 * 60_000))
      return {
        state: "interrupted",
        reason: `quiet for ${fmt.formatDuration(age)}`,
        heartbeatAgeMs,
      };
    return {
      state: "stale",
      reason: `quiet for ${fmt.formatDuration(age)}`,
      heartbeatAgeMs,
    };
  }

  /**
   * @typedef {{ key: string, label: string, tone: "bad" | "warn" | "info", glyph: string, title: string }} PolicyBadge
   */

  /**
   * The exit codes the run policy added, as an accessible badge: a glyph and
   * words as well as a tone, so the meaning never rides on colour alone.
   * 8 (a critical teardown failed) is a hard stop and reads in the failure
   * tone with a stop sign; 9 (dirty state after the run) is a warning with a
   * warning sign. Null for every other code.
   * @param {number | null | undefined} code
   * @returns {PolicyBadge | null}
   */
  function exitBadge(code) {
    if (code === 8)
      return {
        key: "critical-teardown",
        label: "critical teardown failed · exit 8",
        tone: "bad",
        glyph: "⛔",
        title:
          "A services.teardown entry marked critical (or the provisioner's down) failed or timed out. It outranks every verdict: whatever it guarded may still be running.",
      };
    if (code === 9)
      return {
        key: "dirty-after",
        label: "dirty state after the run · exit 9",
        tone: "warn",
        glyph: "⚠",
        title:
          "run.verifyClean found browsers, tmux sessions or docker projects this run left behind. cairn kills nothing; the survivors are listed.",
      };
    return null;
  }

  /**
   * The invocation-level failure of a finished `cairn run`: exit 8 (a
   * critical teardown failed) or 9 (dirty state after the run), from the
   * process exit code or else the printed document's
   * `invocationOutcome.exitCode`. Null for every other code. Such a run is
   * errored whatever its specs did — its events still read passed.
   * @param {number | null | undefined} exitCode
   * @param {unknown} [document] the `--format json` run or batch document
   * @returns {8 | 9 | null}
   */
  function invocationFailureCode(exitCode, document) {
    if (exitCode === 8 || exitCode === 9) return exitCode;
    const outcome =
      document && typeof document === "object"
        ? /** @type {Record<string, any>} */ (document).invocationOutcome
        : null;
    const code =
      outcome && typeof outcome === "object" ? outcome.exitCode : null;
    return code === 8 || code === 9 ? code : null;
  }

  /**
   * Badges for what the run policy did to one invocation: critical teardown
   * (exit 8), dirty state (exit 9), a failed preflight check, a refused run
   * lock, failed `finally` / suite hooks, and specs skipped by `--bail`.
   * Reads the events model (`model.policy`, `model.services`) and, when the
   * journal has settled, its `summary` (`runPolicy`, `skipped`, `exitCode`).
   * @param {Record<string, any> | null | undefined} model
   * @param {Record<string, any> | null | undefined} [summary] invocation.json summary
   * @returns {PolicyBadge[]}
   */
  function policyBadges(model, summary) {
    /** @type {PolicyBadge[]} */
    const out = [];
    const policy = model?.policy ?? null;
    const run = summary?.runPolicy ?? null;
    const seen = new Set();
    const add = (/** @type {PolicyBadge | null} */ badge) => {
      if (!badge || seen.has(badge.key)) return;
      seen.add(badge.key);
      out.push(badge);
    };
    const criticalEvents = (model?.services ?? []).filter(
      (/** @type {Record<string, any>} */ row) =>
        row.phase === "teardown" &&
        row.event === "fail" &&
        (row.data?.critical || row.data?.provisioner),
    );
    if (
      (Array.isArray(run?.criticalTeardown) && run.criticalTeardown.length) ||
      criticalEvents.length ||
      summary?.exitCode === 8
    )
      add(exitBadge(8));
    const dirty = [
      ...(Array.isArray(run?.dirty) ? run.dirty : []),
      ...(policy?.cleanliness ?? []).filter(
        (/** @type {Record<string, any>} */ row) => row.status === "dirty",
      ),
    ];
    if (
      dirty.some(
        (/** @type {Record<string, any>} */ row) => row.phase === "after",
      ) ||
      summary?.exitCode === 9
    )
      add(exitBadge(9));
    if (
      dirty.some(
        (/** @type {Record<string, any>} */ row) => row.phase === "before",
      )
    )
      add({
        key: "dirty-before",
        label: "dirty before the run · refused",
        tone: "bad",
        glyph: "⛔",
        title:
          "run.verifyClean found leftovers before the run started, so cairn refused it (exit 4).",
      });
    if (
      (policy?.preflight?.checks ?? []).some(
        (/** @type {Record<string, any>} */ row) => row.status === "failed",
      )
    )
      add({
        key: "preflight-failed",
        label: "preflight failed · refused",
        tone: "bad",
        glyph: "⛔",
        title:
          "A run.preflight check failed before anything started; cairn refused the run (exit 4).",
      });
    if (policy?.lock?.state === "refused")
      add({
        key: "lock-refused",
        label: "run lock refused",
        tone: "bad",
        glyph: "⛔",
        title:
          policy.lock.message ??
          "Another cairn run holds this config's run lock; cairn refused this one (exit 4).",
      });
    const finallyFailed =
      num(run?.finallyFailed) ??
      (policy?.finally ?? []).filter(
        (/** @type {Record<string, any>} */ row) =>
          row.status === "failed" || row.status === "timed out",
      ).length;
    if (finallyFailed)
      add({
        key: "finally-failed",
        label: `${finallyFailed} finally hook(s) failed`,
        tone: "warn",
        glyph: "⚠",
        title:
          "run.finally commands are non-fatal: the run's exit code is unchanged.",
      });
    const hooksFailed = (policy?.suiteHooks ?? []).filter(
      (/** @type {Record<string, any>} */ row) =>
        row.status === "failed" || row.status === "timed out",
    ).length;
    if (hooksFailed)
      add({
        key: "suite-hooks-failed",
        label: `${hooksFailed} suite hook(s) failed`,
        tone: "warn",
        glyph: "⚠",
        title:
          "A failed suite before hook stops the run (exit 2); a failed after hook never changes the exit code.",
      });
    const skipped = num(summary?.skipped) ?? policy?.bailed?.skipped ?? null;
    if (skipped || policy?.bailed)
      add({
        key: "bailed",
        label: `bailed · ${skipped ?? 0} skipped`,
        tone: "warn",
        glyph: "↷",
        title: policy?.bailed?.spec
          ? `--bail: ${policy.bailed.spec} failed (exit ${policy.bailed.exitCode ?? "?"}), so the remaining specs never started.`
          : "--bail: the first failed spec stopped the scheduling of the rest.",
      });
    return out;
  }

  return {
    HEARTBEAT_FRESH_MS,
    createPolicyState,
    policyBadges,
    exitBadge,
    invocationFailureCode,
    lockOwnerText,
    PHASE_LABELS,
    describeEvent,
    placeText,
    blockText,
    groupLabel,
    modelStepTree,
    resultStepTree,
    createRunModel,
    applyEvent,
    reduceEvents,
    currentPhase,
    classifyLiveness,
    phaseLabel,
    stepWhat,
    lastLine,
    whenText,
    isSecretKey,
    maskValue,
    maskDeep,
    safeOutputs,
    gateScopeLabel,
    parseAttemptProgress,
    attemptsText,
    fixtureTone,
    teardownWhat,
    stashBadge,
    plannedRefusal,
    invocationRefusedCount,
    invocationStatus,
    stashLines,
    stashExtras,
    publishBadge,
    publishExpired,
    publishState,
    artifactRefText,
    sensitivitySummary,
    STASH_REASONS,
    PUBLISH_REASONS,
    RUN_INDEX_SKIPPED,
    SENSITIVITY,
    TRACE_REASONS,
  };
})();

if (typeof module === "object" && module.exports) module.exports = CairnEvents;
if (typeof globalThis === "object" && globalThis)
  /** @type {any} */ (globalThis).CairnEvents = CairnEvents;
