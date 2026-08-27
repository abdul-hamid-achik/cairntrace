# Examples

A two-part example suite: the original static smoke pages and a real
demo platform backed by Postgres. Used both as documentation and as
Cairntrace's end-to-end integration check against a real
[`agent-browser`](https://agent-browser.dev) install.

## One-command run

```bash
./bin/cairn run examples/flows
```

That is the whole story. `examples/cairntrace.config.yml` owns the
lifecycle: it starts Postgres via `docker compose up -d`
(`examples/docker-compose.yaml`, port **5433** so it never collides with a
local 5432), runs migrations + the deterministic seed when the data is stale
(`services.seed` with a data-level freshness check), and boots the demo app
(`webServer`). Docker (or colima) is the only prerequisite.

The seed operator is `casey@cairntrace.dev` / `cairn-demo-2026`.

## Layout

```
examples/
├── README.md                          (this file)
├── cairntrace.config.yml              baseUrl + vars + webServer + services lifecycle
├── docker-compose.yaml                demo Postgres on :5433
├── fixtures/
│   ├── sample-invoice.pdf             public sample PDF (upload fixture)
│   ├── sample-report.pdf              public sample PDF (seeded document)
│   ├── product-notebook.jpg           generated product photo (image upload)
│   └── product-desk-lamp.jpg          generated product photo
├── demo-app/
│   ├── server.ts                      bun server on :8787: static smoke pages,
│   │                                  DB-backed platform pages, JSON APIs, exports
│   ├── xlsx.ts                        dependency-free OOXML workbook writer
│   ├── db/
│   │   ├── schema.ts                  Drizzle schema (users, products, documents)
│   │   ├── client.ts                  lazy Postgres connection (DATABASE_URL,
│   │   │                              defaults to the compose service)
│   │   ├── migrate.ts                 journal-driven migration runner
│   │   └── seed.ts                    deterministic demo-import (12 products,
│   │                                  1 operator, 2 starter documents)
│   ├── drizzle/                       0000_init.sql + journal
│   ├── index.html                     home (smoke + platform links)
│   ├── dashboard.html                 static inventory table (smoke specs)
│   ├── api.html / api-broken.html     pages that fetch /api/inventory, /api/broken
│   ├── import.html                    workbook download/upload demo
│   ├── table-actions.html             hover-reveal row actions (batch step demo)
│   ├── login.html                     sign-in form (session cookie)
│   └── form-controls.html             focus-reveal combobox, Enter-committed search
├── actions/
│   ├── open_dashboard.yml             INTENTIONALLY drifted (heal demo)
│   ├── login_demo_app.yml             sign in as the seeded operator
│   └── create_product.yml             parameterized product form action
├── transforms/
│   └── make-invalid-template.ts       Node transform that creates an invalid upload fixture
├── verifiers/
│   ├── check-template-xlsx.ts         Node verifier that reads a downloaded workbook
│   └── check-pdf-magic.ts             Node verifier for %PDF- magic bytes
└── flows/
    ├── 01-dashboard-nav.yml           open → click → URL + text + console outcomes
    ├── 02-row-count.yml               open → count + no-failed-requests outcomes
    ├── 03-network.yml                 network verifier (GET /api/inventory → 200)
    ├── 04-script.yml                  script escape hatch (counts DOM items via JS)
    ├── 07-config-driven.yml           config baseUrl + ${vars.expectedRows}
    ├── 08-conditional-step.yml        when: urlContains step skipping
    ├── 10-artifact-xlsx.yml           download → verifier → xlsx → transform → upload
    ├── 11-batch-hover-click.yml       batch step: hover → click a popover in one invocation
    ├── 12-focus-value.yml             focus + exact live-value wait without eval
    ├── platform/                      DB-backed suite (below)
    └── demos/                         INTENTIONALLY failing specs, `_`-prefixed so a
                                       directory run stays green (run by explicit path)
```

### The platform suite (`flows/platform/`)

| Spec | Exercises |
| --- | --- |
| `20-login-journey.yml` | imported login action, cold-start contract, URL/text/count outcomes |
| `21-product-catalog.yml` | seeded catalog, category filter counts, `httpJson` on `/api/stats` |
| `22-product-create.yml` | chained actions with call-site vars, per-run `${run.token}` SKU, flash |
| `23-product-duplicate-sku.yml` | server-side validation error rendered in the form |
| `24-documents-pdf.yml` | multipart PDF upload, spec-relative fixture path, download + `%PDF-` Node verifier |
| `25-documents-image.yml` | image upload, inline `<img>` preview, no failed preview requests |
| `26-exports.yml` | CSV download + `file` verifier on `${artifacts.*.path}`, live XLSX + `xlsx` verifier |
| `27-api-session.yml` | `request` step login (cookie bridge), `expectStatus` incl. 401 probe, `httpJson` session |
| `28-form-controls.yml` | `focus`-revealed combobox, `fill` + `press` with target, client-side filter |
| `29-guest-redirect.yml` | auth wall redirect, `wait.url`, URL outcome on the redirect target |

Data policy for the platform: fixed, realistic operating data for a fictional
office-supplies warehouse. No real people; the product names and prices are
ordinary catalog facts, not random strings. Documents uploaded by specs
accumulate across runs (assertions use `atLeast`), and the seed re-runs
whenever the products table is empty.

## Heal demo (`cairn spec heal`)

`demos/_06-drifted-link.yml` ships with a locator that doesn't match the page
(it asks for `link "Dashboard link"` when the real page has
`link "Open dashboard"`).

```bash
# 1. Confirm the spec fails as-shipped
./bin/cairn run examples/flows/demos/_06-drifted-link.yml

# 2. Ask Cairntrace to propose a fix from the snapshot
./bin/cairn spec heal examples/flows/demos/_06-drifted-link.yml

# 3. Apply the proposed fix in place
./bin/cairn spec heal examples/flows/demos/_06-drifted-link.yml --apply

# 4. Re-run — the spec now passes
./bin/cairn run examples/flows/demos/_06-drifted-link.yml
```

`demos/_05-detects-broken-api.yml` proves `noFailedRequests` surfaces 5xx,
and `demos/_09-imported-drift.yml` shows heal patching the imported action
file (`actions/open_dashboard.yml`) rather than the spec. All three are
`_`-prefixed so `cairn run examples/flows` (directory expansion skips
`_*.yml` and `actions/`) stays green.

v0 scope: only the `by: role` locator's `name` field is healed; multi-step
drift, role swaps, and wait insertions aren't yet attempted. Comments and
formatting in the YAML are preserved by `--apply`.

## Prerequisites

- `bun` (1.3+)
- Docker (or colima) for the demo Postgres — that is the only container
- `agent-browser` on `$PATH` (`cairn doctor` will tell you if it's missing)
- This repo installed: `bun install`

## Run it

1. **Run a spec or the whole suite** — the lifecycle starts itself:

   ```bash
   ./bin/cairn run examples/flows/01-dashboard-nav.yml
   ./bin/cairn run examples/flows            # everything, green
   ./bin/cairn run examples/flows --cold-start   # fresh browser state
   ```

   This drives a real headless Chrome via `agent-browser`. Add `--headed` to
   see the browser, or `--backend playwright` to switch backends. To manage
   the platform yourself instead: `docker compose -f examples/docker-compose.yaml up -d`,
   `bun examples/demo-app/db/seed.ts`, `bun examples/demo-app/server.ts`, then
   `cairn run <spec> --no-services --no-web-server`.

2. **Inspect the artifacts**:

   ```bash
   ./bin/cairn context latest        # agent_context.md printed to stdout
   ./bin/cairn context latest --path # absolute path only
   ```

The full run directory is at `~/.cairntrace/runs/<run-id>/`:
`run.{json,yaml,md}`, `report.{html,json}`, `agent_context.md`,
`events.ndjson`, `outcomes/`, `snapshots/`, `screenshots/`, `console/`,
`network/`, `downloads/`, `transforms/`, `evals/`, `services/manifest.json`,
`spec.resolved.yml`.

## Try a failing run

Edit `01-dashboard-nav.yml`'s `url_is_dashboard` outcome to expect something
the page doesn't satisfy (e.g. `endsWith: /never`). Re-run. The run exits with
code 1, the markdown summary shows `FAILED`, and
`outcomes/url_is_dashboard.md` contains the Expected/Actual evidence.

## What this exercises

- **Backend integration** — real `agent-browser` CLI invocations through
  `AgentBrowserAdapter`, including semantic locator resolution, `wait --text`,
  uploads/downloads, and the `{success, data, error}` JSON envelope from
  `network requests --json` / `console --json`.
- **Services lifecycle** — docker compose, conditional seed with a data-level
  freshness check, and webServer reuse, all through the config block cairn
  ships for real projects (the same one graphite uses).
- **Outcome vocabulary v0** — `text`, `notText` (implicitly via wait), `url`,
  `count`, `console.errorsMax`, `network`, `noFailedRequests`, browser and
  Node `script`, `file`, `httpJson`, and `xlsx` across the two suites.
- **Artifact pack** — every artifact category gets written (JSON+YAML+MD trio,
  evidence files, events, snapshots, console, network, downloads, transforms,
  evals, verifier `.raw.json` sidecars).
- **Exit codes** — passing runs return 0; the `_`-prefixed demos return 1 by
  design to confirm failure detection.

The platform specs are intentionally small so you can read them in one
sitting. The real Cairntrace value shows up when an agent authors a spec
against your actual app from a one-line intent.
