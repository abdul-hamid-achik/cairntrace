# FEATURE: codemap + cairntrace Integration

## What

cairntrace produces timestamped video evidence of browser interactions. codemap
provides structural code intelligence that can pre-filter where cairntrace's
evidence connects to the codebase — "this UI element maps to this component, which
is called by these handlers."

## How they connect

### codemap annotations from cairntrace runs

cairntrace runs produce evidence bundles (screenshots, OCR text, timeline). The
`codemap_annotate` MCP tool can pin a cairntrace finding to a specific code symbol:

```
codemap_annotate(symbol="HandleSubmit", source="cairntrace", note="fails on empty form", data=<JSON>)
```

### Structural pre-filtering

When cairntrace's `--connect` (fcheap connect / vecgrep) surfaces code candidates,
codemap's graph can narrow them:

1. cairntrace finds the UI element text in the evidence
2. vecgrep/codemap_semantic finds the matching component
3. codemap_callers shows what triggers that component
4. codemap_impact shows the blast radius of a fix

### Cache and cairntrace

The fcheap index cache is orthogonal to cairntrace — cairntrace stashes its own
evidence bundles in fcheap, and codemap stashes its index snapshots. Both use the
same fcheap vault with different tag prefixes (`codemap-cache` vs cairntrace's
tags). The two coexist without conflict.

### What cairntrace gets from codemap

- `codemap_symbol_at`: resolve a file:line (from a stack trace or error) to the
  enclosing symbol — the entry point for joining cairntrace evidence onto the
  code graph
- `codemap_callers` / `codemap_impact`: structural expansion from a symbol
- `codemap_annotate`: pin cairntrace evidence to a symbol (persistent across reindex)

## Why this matters

cairntrace answers "what happened in the browser" and codemap answers "what code
is responsible." Together they close the loop from observed behavior to root cause.