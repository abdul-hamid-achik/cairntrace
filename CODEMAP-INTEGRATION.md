# cairntrace ⇄ codemap integration

> **Status:** design / proposed (2026-06-24). Authored from a codemap-side ecosystem survey.
> **One line:** deepen the existing push-only `cairn annotate → codemap` seam into a bidirectional
> verify / locate / select loop.

## Existing seam
`cairn annotate` already shells `codemap annotate <symbol> --source --note --data --json` — but it is
**failure-only, push-only**, and unaware of codemap's impact/semantic/path queries. The work is making it
bidirectional and generalizing it.

## Integrations

### A — `cairn run --since-codemap <symbol>`: impact-driven spec selection  ·  M · **high**
`codemap_impact` blast-radius file paths intersected against each spec's `coversPaths` / code-match
provenance → run only affected specs. Mirrors codemap's `affected-specs` (EI.5) on the cairntrace side.

### B — generalize `maybeAutoAnnotate` to pass + fail per spec  ·  S · **high**
Today it annotates on failure only. Emit a node OR path annotation for every run:
`source:'cairntrace', data:{specName, contractHash, runId, status, outcomes, failedVerifier}`. `contractHash`
invalidates stale green badges. Closes the loop with A. *(codemap EI.7.)*

### C — codemap structural ranking inside `cairn investigate`  ·  M · **high**
Feed failing-outcome text + failing network URLs to `codemap_semantic` + `codemap_find`; re-rank the
fcheap/vecgrep `codeMatches` by `codemap_hotspots` centrality + `codemap_callers` depth. `investigate.json`
gains `{symbol, callers, blastRadius, codemapScore}`. *(codemap EI.9.)*

### D — semantic spec scaffolding  ·  M · medium
`cairn spec scaffold` consults `codemap_semantic` + `codemap_orphans` for untested entrypoints and pre-fills
the `coversSymbol:` binding. *(codemap EI.17.)*

### E — fcheap as the run-artifact substrate  ·  S · medium
Annotation `data` carries a `stashId` pointer, not inline evidence; a codemap consumer hydrates via
`fcheap restore`. Reverse: `cairn stash search` seeded from codemap symbol names.

### F — call-path annotations for entry→failure traces  ·  S · medium
`codemap annotate <fromSymbol> <toSymbol> --source cairntrace` — codemap's **path-annotation** feature that
nothing currently feeds. A failing trace becomes a first-class annotated call path.

### G — resolve the target codebase from codemap's registry  ·  S · low
`cairn doctor` + config resolve the codebase from `codemap_projects` (the XDG registry) instead of a
hardcoded `codemap.path`; `doctor` reports `codemap_status` ("codebase indexed: yes/no, N symbols").

## Build order
B (generalize the existing annotate seam — smallest, unblocks A) → A (spec selection) → C (investigate
ranking) → F (path annotations) → E (stash substrate) → D (scaffolding) → G (doctor/registry). This deepens
the already-shipping `cairn annotate → codemap` link first, then closes the structure↔behavior loop.
