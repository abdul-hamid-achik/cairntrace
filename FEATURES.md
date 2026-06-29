# FEATURES — cairntrace × codemap (implementation backlog)

> **Status:** planned / to-build · authored 2026-06-29 from a codemap-side ecosystem survey.
> **One line:** turn the existing push-only `cairn annotate → codemap` seam into a bidirectional
> **verify → locate → select** loop, so browser evidence and the code graph reinforce each other.
> Companion design doc: [`CODEMAP-INTEGRATION.md`](./CODEMAP-INTEGRATION.md) (seams A–G). This file is the
> forward-looking checklist Abdul works through; tick items as they ship.

cairntrace answers **"what happened in the browser"**; codemap answers **"what code is responsible."**
The features below close that loop. Each lists the codemap capability it leans on, the cairntrace surface
(CLI + MCP) it adds, an acceptance check, and an effort · priority tag matching the existing roadmap.

---

## The keystone codemap gives us: `codemap review` (diff-scoped intelligence)

Most of these features want the same answer: *"given a git diff, what symbols changed, what is the blast
radius, and which tests/specs cover it?"* codemap now **ships** a first-class command for exactly this
(as of 2026-06-29; plus `read-order` and `file-impact`) —

```
codemap review [--since <ref> | --staged | --working] --json
# → { changed_symbols[], blast_radius[], covering_tests[], untested[], hotspots[], stale, resolution }
```

cairntrace consumes that JSON instead of re-deriving structure by hand. Where a feature below says
"uses `codemap review`", it means: shell `codemap review --json`, read `changed_symbols` / `covering_tests`,
done — no diff parsing, no symbol resolution, no graph walk on the cairntrace side.

---

## Features to implement

### [ ] 1 — `cairn run --since-codemap <ref>`: impact-driven spec selection · M · **high**
Run only the browser specs a change can actually hit. Pipe `codemap review --since <ref> --json` →
intersect `blast_radius` file paths against each spec's `coversPaths` / code-match provenance → run that
minimal set. Mirrors glyphrun's `affected-specs` and codemap's `review`.
- **codemap:** `review` (preferred) or `impact` per changed symbol.
- **cairntrace:** new `--since-codemap` flag on `cairn run`; MCP `cairn_run` gains an optional `since` arg.
- **Accept:** a one-line CSS edit selects ~0 specs; a handler edit selects exactly the specs whose
  `coversPaths` intersect its blast radius. Degrades to "run all" if codemap is absent (best-effort).

### [x] 2 — generalize `maybeAutoAnnotate` to pass **and** fail per spec · S · **high**
Today cairntrace annotates codemap **only on failure**. Emit a node-or-path annotation for **every** run:
`source:'cairntrace', data:{specName, contractHash, runId, status, outcomes, failedVerifier}`. The
`contractHash` lets codemap invalidate stale green badges when a spec's contract changes. This is the link
everything downstream references (it is what makes feature 1's `coversPaths` exist).
- **codemap:** `codemap_annotate` (already wrapped).
- **cairntrace:** extend `maybeAutoAnnotateRun` in `src/cli/commands/annotate.ts`; config
  `annotate.autoAnnotate: on-run` already exists.
- **Accept:** a passing run leaves a green annotation; re-stamping the spec's `contractHash` drops it.

### [x] 3 — codemap structural ranking inside `cairn investigate` · M · **high**
When investigate surfaces N code candidates, re-rank them by the graph instead of by raw search score.
Feed failing-outcome text + failing network URLs to `codemap_semantic` + `codemap_find`; re-rank
`codeMatches` by `codemap_hotspots` centrality + `codemap_callers` depth. `investigate.json` gains
`{symbol, callers, blastRadius, codemapScore}` so "50 file:line matches" collapses to "the 5 on the
critical path."
- **codemap:** `semantic`, `find`, `hotspots`, `callers` (all exist).
- **cairntrace:** enrich the investigate pipeline in `src/cli/commands/investigate.ts`.
- **Accept:** investigate output is sorted by `codemapScore`; the top hit is on the failing call path.

### [x] 4 — call-path annotations for entry→failure traces · S · medium
A failing trace (`handleSubmit → validateEmail → api.post`) becomes a first-class annotated **call path**:
`codemap annotate <fromSymbol> <toSymbol> --source cairntrace`. codemap already supports path annotations
and nothing currently feeds them — cairntrace is the natural producer.
- **codemap:** `codemap_annotate` with `from`/`to` (path mode).
- **cairntrace:** when investigate reconstructs a failure trace, emit one path annotation per edge.
- **Accept:** `codemap annotations --from handleSubmit --to api.post` returns the cairntrace note.

### [x] 5 — fcheap as the run-artifact substrate · S · medium
Annotation `data` carries a `stashId` pointer instead of inline evidence; a codemap consumer hydrates the
full bundle via `fcheap restore`. Reverse direction: `cairn stash search` seeded from codemap symbol names.
Keeps the code graph light while evidence stays addressable.
- **codemap:** annotation `data` is opaque JSON (already supports a pointer).
- **cairntrace:** store `stashId` in annotation `data`; add `cairn stash search <symbol>`.
- **Accept:** a 2 KB annotation resolves to a full evidence bundle via one `fcheap restore`.

### [x] 6 — semantic spec scaffolding from untested entrypoints · M · medium
`cairn spec scaffold` consults `codemap_semantic` + `codemap_orphans` for untested entrypoints and pre-fills
the `coversSymbol:` binding from the symbol's signature/docstring — so agents discover *what to test next*
from the code graph, not from guessing.
- **codemap:** `semantic`, `orphans`, `read-order` (the new entrypoint-ranking command, once it lands).
- **cairntrace:** seed scaffold templates from codemap symbol metadata.
- **Accept:** scaffolding an uncovered handler produces a spec stub already bound to `coversSymbol`.

> **Implemented (2026-06-29) from `codemap semantic` + `codemap orphans` only.** `codemap read-order`
> (entrypoint ranking) is NOT used here yet — noted as a future enhancement (feature 9 builds on it).
> The scaffolded `coversSymbol` field also needs a matching `coversSymbol` entry on `SpecSchema`
> (`src/core/schema/spec.v1.ts`, currently `.strict()`) for `cairn spec verify`/`run` to accept it; the
> scaffolded stub is a TODO template (placeholder outcome, no contractHash) consistent with that gap.

### [x] 7 — resolve the target codebase from codemap's registry · S · low
`cairn doctor` + config resolve the codebase from `codemap_projects` (the XDG registry) instead of a
hardcoded `codemap.path`; `doctor` reports `codemap_status` ("codebase indexed: yes/no, N symbols, stale?").
- **codemap:** `codemap_projects`, `codemap_status`.
- **cairntrace:** read the registry in `cairn doctor` / config resolution.
- **Accept:** `cairn doctor` prints "codebase indexed: yes (4 522 symbols, fresh)" with no manual path.

> **Implemented (2026-06-29) from `codemap projects` only.** `codemap status` (per-project freshness) is
> NOT shipped in codemap yet, so `cairn doctor` reports "codebase indexed: yes (N symbols)" without a
> freshness verdict — a TODO in `src/cli/commands/doctor.ts` adds freshness once `codemap_status` lands.

### [ ] 8 — risk-ranked investigate (uses the new `codemap risk`) · S · **high**
`cairn investigate` already surfaces N code candidates for a failing run; now rank them by **change-risk**,
not just search score. For each candidate symbol call `codemap_risk` and sort by its `score` — so the
load-bearing, untested, widely-called code that a failure most likely flows through floats to the top.
`investigate.json` gains `{riskScore, riskLevel, riskFactors}` per match. Complements feature 3's centrality
ranking with a single "how dangerous is this code" number.
- **codemap:** `codemap_risk` (shipped 2026-06-29) — `{score, level, factors, callers, covering_tests}`.
- **cairntrace:** enrich the investigate pipeline; show `⚠ high` next to risky matches in `agent_context.md`.
- **Accept:** a failure touching an untested hub ranks that hub first, tagged `high (0.93)`.

### [ ] 9 — cover-the-riskiest scaffolding (uses `read-order` + `risk`) · M · medium
Turn feature 6's "scaffold from untested entrypoints" into "scaffold from the **riskiest** untested
entrypoints first": `codemap read-order` ranks the entrypoints, `codemap risk` flags which are untested +
load-bearing, and `cairn spec scaffold` targets those — so the first browser specs an agent writes cover the
code most likely to break and least covered today.
- **codemap:** `codemap_read_order` + `codemap_risk` (both shipped).
- **cairntrace:** `cairn spec scaffold --from-risk` consumes the ranked, risk-tagged entrypoint list.
- **Accept:** `cairn spec scaffold --from-risk --top 3` emits stubs bound to the 3 highest-risk untested
  entrypoints.

---

## Build order
**2** (generalize the annotate seam — smallest, unblocks 1) → **1** (spec selection) → **3** (investigate
ranking) → **8** (risk-ranked investigate — small, builds on 3) → **4** (path annotations) → **5** (stash
substrate) → **6** (scaffolding) → **9** (cover-the-riskiest scaffolding — builds on 6) → **7**
(doctor/registry). Deepen the already-shipping `cairn annotate → codemap` link first, then close the
structure↔behavior loop. **8 and 9 are newly unblocked** by codemap's `risk` + `read-order` (shipped
2026-06-29) and need no further codemap work.

## What cairntrace needs from codemap (tracking)
- [x] `codemap_annotate` node + path modes, opaque `data` payload, survives reindex.
- [x] `codemap_impact` / `semantic` / `find` / `hotspots` / `callers` / `symbol_at` (all shipped).
- [x] **`codemap review`** (diff-scoped impact + test selection) — **SHIPPED** 2026-06-29. Feature 1 is
  unblocked: `codemap review --since <ref> --json` → `{changed_symbols, blast_radius, covering_tests, …}`.
- [x] **`codemap read-order`** (entrypoint ranking) — **SHIPPED**. `codemap read-order [query] --json`; feeds
  feature 6 (scaffold from the top-ranked untested entrypoints).
- [x] **`codemap file-impact`** (file-level blast radius + `safe_to_delete`/`breaking_change`) — **SHIPPED**.
  Use it in feature 3 to rank `investigate` code-matches by which file is load-bearing.
- [x] **`codemap risk`** (change-risk score: untested + fan-in + cross-package + ambiguity) — **SHIPPED**.
  Powers feature 8 (risk-ranked investigate) and feature 9 (cover-the-riskiest scaffolding).
- [x] **`codemap context-batch`** (`codemap context <s1> <s2>…` / `codemap_context_batch`) — **SHIPPED**.
  Fetch context for several candidate symbols from one `investigate` run in a single call (+ `common_callers`).
- [ ] `codemap_status` exposing per-project freshness for feature 7's doctor line.

## Why this matters
Browser acceptance tests are invisible to unit-test-only impact scoring. Pinning every cairntrace run to the
symbol it exercises turns end-to-end behavior into a **durable, queryable fact** on the code graph — so an
agent can ask codemap "what covers this change?" and get *both* unit tests and real browser evidence back,
keyed by `contractHash` so stale badges never lie.
