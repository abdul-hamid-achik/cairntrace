# FEATURE — Out-of-page, timeout-bounded `request` steps

**Target release:** v1.9.0
**Status:** implemented
**Implementation note:** v1.9.0 keeps request steps out of page and
timeout-bounded. It uses Playwright's `APIRequestContext` when safe, and a
Bun-safe context-cookie bridge under Bun because Bun exposes a relative
`IncomingMessage.url` that breaks Playwright's Set-Cookie parser.
**Area:** `request` step execution · `BrowserBackend` · Playwright adapter · Runner
**Motivating bug:** a `request` step (in-page `fetch`) hangs *indefinitely* when the
app under test stalls response delivery — the whole spec/suite hangs until an
external watchdog kills it.

---

## 1. Summary

Move `request`-step execution off the **in-page `page.evaluate(fetch)`** path and onto
Playwright's **out-of-page `APIRequestContext`** (`context.request`). This:

1. **Bounds every request with a real timeout** (Playwright's request API has a built-in
   30 s default; today an in-page fetch with no `timeoutMs` is *unbounded*).
2. **Preserves cookie/session sharing** — `context.request` uses the browser context's
   cookie jar (sends context cookies *and* persists `Set-Cookie`), so the
   `credentials: "include"` semantics that motivated the in-page approach are kept.
3. **Decouples requests from page state** — they no longer share the page's event loop,
   so a slow dev server, an in-flight HMR reload, or on-demand module transformation
   can't wedge a request.

Plus a **defense-in-depth** change: give `backend.evaluate(...)` a hard Node-side
timeout so *no* evaluate-based step (the request fallback, the `script` verifier, the
`evaluate` escape hatch) can hang forever on any backend.

No spec changes are required; contract hashes are unaffected.

---

## 2. Motivation — the concrete bug

Observed dogfooding Cairntrace against a Nuxt 4 app's e2e suite on GitHub Actions
(headless Chromium, `--backend playwright`, app served by `nuxt dev`):

- A `request` step — an in-page `POST /api/test/login-as` — **never completes**. The
  spec sits on that step until the harness's 12-minute watchdog kills the job.
- The **server side was proven healthy**: instrumenting the route showed it received the
  request and returned in **~99 ms** (`entry → DB query → session → return`).
- So the stall is **client-side**: `page.evaluate(async () => { const r = await fetch(...);
  const t = await r.text(); ... })` never resolves — the response body delivery stalls in
  this environment and nothing unsticks it.
- **Adding `timeoutMs` to the step did not help.** `timeoutMs` makes
  `buildRequestScript` inject `signal: AbortSignal.timeout(ms)` *into the in-page script*.
  The abort timer lives in the same page event loop that is stalled, so it never fires —
  the suite still hung past the timeout. This is the key evidence that the problem is at
  the **`page.evaluate` / page-context level, not the `fetch` promise level.**
- Reproduces **consistently in CI** and **intermittently locally** (cold Vite cache /
  loaded dev server).

The failure mode is generic: any app that, under load or in dev mode, is slow to flush a
response body can hang a Cairntrace run on a `request` step, with no per-step or
per-backend bound. A behavioral-spec runner should fail *fast and legibly*, never hang.

---

## 3. Where this lives today

```
Runner.runRequestStep (src/core/runner/Runner.ts ~820)
  → resolveRequestUrl()                 # relative → absolute via baseUrl
  → ensureRequestOrigin()               # navigate to origin first (about:blank can't fetch)
  → backend.evaluate(buildRequestScript(req))   # <-- in-page fetch, NO out-of-page timeout
  → JSON.parse(result.stdout) → RequestResponse
  → expectStatus check

buildRequestScript (Runner.ts ~937)
  (async () => {
    const res = await fetch(url, { method, credentials:"include", headers, body,
                                   [signal: AbortSignal.timeout(timeoutMs)] });  # only if timeoutMs set
    const text = await res.text();                                               # <-- can hang forever
    ... return { status, ok, headers, body };
  })()

PlaywrightAdapter.evaluate (src/adapters/playwright/PlaywrightAdapter.ts ~236)
  → page.evaluate(js)                   # NO timeout option; awaits the in-page promise forever

backendFactory (src/cli/backendFactory.ts ~35)
  → PlaywrightAdapter({ defaultTimeoutMs: 10_000 })   # used for step ops, NOT for evaluate
```

`AGENTS.md` originally documented the design intent: *"request: → fetch in page context
(runner-handled, not adapter)."* The in-page choice was deliberate — it lets authenticated
API calls reuse the browser's cookies (`credentials: "include"`) with no cookie glue. That
benefit is **fully retained** by `context.request` (see §5).

---

## 4. Root cause

1. **No Node-side timeout on `page.evaluate`.** Playwright's `page.evaluate` resolves only
   when the in-page promise resolves; there is no built-in deadline. A never-resolving
   in-page `fetch`/`res.text()` ⇒ a never-resolving step.
2. **In-page `AbortSignal.timeout` can't rescue a stalled page.** The abort timer runs in
   the same page context/event loop that is stuck, so the only "timeout" we have is
   ineffective exactly when it's needed.
3. **Coupling requests to page state is fragile.** Dev servers (Vite module serving,
   on-demand route compilation, HMR full-reloads) make the page a hostile place to run a
   blocking I/O await.

---

## 5. Proposed solution

### 5.1 Primary — execute `request` steps out-of-page via `APIRequestContext`

Add an optional `request()` method to `BrowserBackend` and implement it in the Playwright
adapter using `context.request` (a.k.a. `page.request` — same instance).

Why this is the right primitive (verified against Playwright docs):

- **Shared cookie jar.** `browserContext.request`/`page.request` "populate request cookies
  from the context and update context cookies from the response." So:
  - context cookies are sent automatically ⇒ same as `credentials: "include"`;
  - `Set-Cookie` on the response is persisted back into the context ⇒ a `login`-style
    request authenticates subsequent **page** navigations, exactly like today.
- **Built-in timeout.** Default **30 s**, per-request `timeout` option (`0` disables). We
  will always pass an explicit, bounded timeout (never `0` by default).
- **Out-of-process.** Runs in the Playwright driver, not the page — immune to the page
  event loop, reloads, and dev-server module serving.
- **Clean response API.** `APIResponse.status()`, `.headers()`, `.text()`, `.json()`.

### 5.2 Secondary — bound `backend.evaluate` itself (defense-in-depth)

Independently of `request`, wrap the adapter's `evaluate` in a Node-side deadline so a
hung in-page promise can't wedge the run. This protects:

- the `request` **fallback** path (backends without `request()`),
- the **`script`** outcome verifier,
- the **`evaluate`** escape-hatch step.

On timeout, return `InvocationResult { ok:false, stderr: "evaluate timed out after <N>ms", exitCode: 124 }`
rather than hanging. Source the deadline from `defaultTimeoutMs` (with a generous ceiling,
e.g. `max(defaultTimeoutMs, 30_000)` for `script`/`evaluate`, which can legitimately poll).

> Note: a Node-side `Promise.race` deadline lets the **runner** move on; the orphaned
> in-page promise is abandoned but harmless (the context is torn down at spec end). This is
> acceptable and standard. Prefer it over leaving any code path unbounded.

---

## 6. Detailed design

### 6.1 `BrowserBackend` interface (src/adapters/browserBackend.ts)

```ts
export interface BackendRequest {
  method: string;
  url: string;                       // absolute (runner resolves relative → absolute)
  headers?: Record<string, string>;
  body?: unknown;                    // object → JSON-encoded; string → sent as-is
  timeoutMs?: number;                // per-step override; runner supplies a default if unset
}

export interface BackendResponse {
  ok: boolean;                       // transport-level success (got a response)
  status: number;
  headers: Record<string, string>;
  body: unknown;                     // parsed JSON if possible, else text
  error?: string;                    // set when ok=false (timeout / network / abort)
}

export interface BrowserBackend {
  // ...existing...
  /**
   * Execute an HTTP request OUT OF PAGE, sharing the browser context's cookies
   * (send + persist Set-Cookie). Optional: backends that don't implement it fall
   * back to the in-page evaluate path in the Runner. Must be timeout-bounded.
   */
  request?(req: BackendRequest): Promise<BackendResponse>;
}
```

### 6.2 Playwright adapter (src/adapters/playwright/PlaywrightAdapter.ts)

```ts
async request(req: BackendRequest): Promise<BackendResponse> {
  await this.ensureBrowser();
  // context.request shares the browser context cookie jar (send + persist Set-Cookie).
  const ctx = this.context ?? (await this.newSharedContext());
  const timeout = req.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
  const isString = typeof req.body === "string";
  try {
    const res = await ctx.request.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      timeout,                                  // hard bound — fixes the hang
      ...(req.body !== undefined
        ? isString
          ? { data: req.body as string }
          : { data: req.body }                  // object → Playwright JSON-encodes + sets content-type
        : {}),
      failOnStatusCode: false,                  // cairn does its own expectStatus check
      maxRedirects: 20,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const headers = res.headers();
    // Mirror into the network log so `network` verifiers still see request-step calls (§6.5).
    this.recordSyntheticRequest(req, res.status());
    return { ok: true, status: res.status(), headers, body };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, body: null, error: (e as Error).message };
  }
}
```

`ensureBrowser()` already exists; ensure a context exists (reuse `ensurePage`/`loadState`
context). `context.request` and `page.request` are the same instance and share cookies.

### 6.3 Runner (src/core/runner/Runner.ts `runRequestStep`)

```ts
const resolved = await resolveRequestUrl(req.url, opts);          // unchanged
if (!resolved.ok) return resolved;
const request = { ...req, url: resolved.url };

if (typeof opts.backend.request === "function") {
  // Out-of-page path: NO ensureRequestOrigin needed (APIRequestContext doesn't need a
  // page origin), and it's timeout-bounded.
  const r = await opts.backend.request({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: request.body,
    timeoutMs: request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,   // e.g. 30_000
  });
  if (!r.ok) return { ok: false, error: `request failed: ${r.error} (${request.method} ${request.url})` };
  const response: RequestResponse = { url: request.url, method: request.method, status: r.status, ok: r.status >= 200 && r.status < 400, headers: r.headers, body: r.body };
  return applyExpectStatus(response, request);                    // unchanged check
}

// Fallback (agent-browser / mock without request()): existing in-page evaluate path,
// now bounded by the evaluate deadline (§5.2). Keep ensureRequestOrigin for this path.
```

Add `DEFAULT_REQUEST_TIMEOUT_MS` (recommend **30_000**). The behavior change: request steps
**without** an explicit `timeoutMs` are now bounded by this default instead of being
unbounded.

### 6.4 Other backends

- **AgentBrowserAdapter** — if the daemon exposes the session cookie jar, implement
  `request()` via an out-of-process HTTP client seeded with those cookies; otherwise leave
  `request` undefined and rely on the §5.2 bounded-evaluate fallback. Either way the hang
  is eliminated.
- **MockBrowserBackend** — implement `request()` to return the same canned response shape
  it returns today via `evaluate`, so mock-mode parity is preserved.

### 6.5 Network-log parity (important)

In-page fetches are observed by the page's `request`/`response` listeners and therefore
show up in `getNetworkRequests()`. Out-of-page `context.request` calls are **not** seen by
those page listeners. Specs that assert (via the `network` verifier) on an API call made
*by a `request` step* would silently stop matching.

**Requirement:** when the Playwright adapter services a `request` step out-of-page, push a
synthetic `NetworkEntry` (`url`, `method`, `status`, `startedAt`, a marker like
`resourceType: "fetch"`) into the same `networkLog` the page listeners feed. This keeps the
`network`/`noFailedRequests` verifiers behaving identically to the in-page era.

(Page-*initiated* requests — e.g. a real form submit hitting `/api/auth/login` — are
unaffected; they still flow through the page listeners as before.)

---

## 7. Backward compatibility

- **Specs:** no changes. `timeoutMs` keeps working (now also honored out-of-page). Contract
  hashes are step-independent, so nothing re-stamps.
- **Backends without `request()`** fall back to the current in-page path, now bounded by the
  evaluate deadline — strictly safer, same semantics.
- The "establish the origin first, *then* request" authoring guidance (needed because a
  credentialed `fetch` from `about:blank` fails) becomes **unnecessary** for the Playwright
  path. Keep `ensureRequestOrigin` for the fallback path; it's harmless if a page is already
  open. (Optional doc cleanup, not required.)
- Cookie behavior is preserved (see §5.1) — verify with the §8 auth test.

---

## 8. Testing / acceptance criteria

Add to cairntrace's own test suite (examples app + a controllable server):

1. **Regression (the bug):** a route that delays its response body past the timeout ⇒ the
   `request` step **fails fast** with a timeout error within ~`timeoutMs`, and the run
   completes (no hang). Assert wall-clock ≪ any watchdog.
2. **Default bound:** a request step with **no** `timeoutMs` against a hanging route fails
   within `DEFAULT_REQUEST_TIMEOUT_MS` (not unbounded).
3. **Cookie send:** a context cookie set beforehand is sent on the request-step call.
4. **`Set-Cookie` persist:** a `request` step whose response sets a session cookie ⇒ a
   subsequent page navigation is authenticated (this is the `login`-action use case).
5. **`expectStatus`** pass and fail paths unchanged.
6. **Network parity (§6.5):** a `network` verifier matches a call issued by a `request`
   step.
7. **Fallback:** a backend without `request()` still works and is bounded by the evaluate
   deadline.

**External acceptance:** the Termina e2e suite's in-page hook POSTs (`login_as_dev`,
`seed_game`, `force-end`, `advance`, `new-draft`, inline `login-as`, `register`) no longer
hang in CI — each either succeeds or fails fast within its timeout, and the suite runs to
completion.

---

## 9. Rollout

- Shipped in **v1.9.0** (SemVer minor: additive interface method + safer default; no breaking
  spec behavior).
- Suggested release-note line: *"`request` steps now execute out of page on the
  Playwright backend with browser-context cookie sharing, `Set-Cookie` persistence,
  and a real default 30 s timeout; evaluate-based fallbacks are also
  timeout-bounded. Fixes indefinite hangs when an app stalls response delivery
  (e.g. dev servers under CI load)."*

---

## 10. Open questions for the author

1. **Default request timeout** — 30 s (Playwright default) vs reuse `defaultTimeoutMs`
   (10 s)? API calls (seeding, builds) can be slower than UI ops; 30 s seems safer as the
   request default. A separate `requestTimeoutMs` config knob?
2. **agent-browser** — does the session expose its cookie jar to an out-of-process client?
   If yes, implement `request()` there too; if no, the bounded-evaluate fallback is the
   safety net.
3. **`evaluate` deadline ceiling** — `script`/`evaluate` steps may legitimately poll; pick a
   generous default (≥30 s) and allow a per-step override so we don't regress slow-but-valid
   scripts.
4. Should `timeoutMs: 0` be honored as "disable" (Playwright supports it), or should cairn
   always enforce a max to keep the runner hang-proof? (Recommend: enforce a max.)

---

### Appendix — reproduction notes (from the dogfood that surfaced this)

- App: Nuxt 4 (`nuxt dev`), `TERMINA_TEST_HOOKS=1`, dev test hooks under `/api/test/*`.
- Backend: `--backend playwright`, headless Chromium, GitHub Actions `ubuntu-latest`.
- Server instrumentation proved the handler returned in ~99 ms; the in-page
  `page.evaluate(fetch → res.text())` never resolved.
- Step-level `timeoutMs: 15000` (→ in-page `AbortSignal.timeout`) did **not** fire — the
  stall is above the fetch promise, confirming an out-of-page execution path + a Node-side
  evaluate bound are the correct fixes.
