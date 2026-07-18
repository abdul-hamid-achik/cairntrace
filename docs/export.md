---
title: Export & import (Playwright)
description: Hand off Cairntrace specs to Playwright JS/TS, or import Playwright tests into reviewable YAML.
---

# Export & import (Playwright bridge)

Cairntrace stays the **agent source of truth**. Use Playwright export when CI or
a human-only suite needs a plain `@playwright/test` file.

## Export

```bash
# TypeScript (default) + markdown coverage report
cairn export playwright flows/login.yml

# JavaScript
cairn export playwright flows/login.yml --lang js --out tests/login.spec.js

# Batch a directory
cairn export playwright flows/ --lang ts --out-dir playwright/tests --format json

# Source only (pipe)
cairn export playwright flows/login.yml --stdout > tests/login.spec.ts
```

MCP: `cairn_export_playwright` with `path`, optional `out` / `outDir`, `lang`, `stdout`.

Coverage reports list **skips** (e.g. `eval.file`, node `script` verifiers,
`monitor`) so agents know the handoff is partial.

## What maps well

| Cairntrace | Playwright |
|------------|------------|
| open / click / fill / hover / select | page.goto / locators |
| wait text/notText/selector/load | waitForFunction / waitForSelector / waitForLoadState |
| request | page.request.fetch (cookies) |
| eval (inline js) | page.evaluate |
| batch | sequential steps (no hover atomicity) |
| when: url\*/text\* | real `if` wrappers |
| text / url / count / network / console | expect(...) |

## Import

```bash
cairn import playwright tests/login.spec.ts --format md
```

Review TODO comments, satisfy cold-start, then `cairn run --cold-start`.

## Authoring path

1. `cairn docs authoring` / discovery (`cairn_discover_*`)
2. Export YAML → `cairn run` → heal
3. Only then `cairn export playwright` if needed

See also: [Discover](/discover), [Authoring](/authoring) (if present), `cairn docs export --json`.
