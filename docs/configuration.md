# Configuration

Every cairntrace surface reads from a single hierarchical config source: `cairntrace.config.yml`. The file is optional — every setting has a default that works out of the box — but anything project-specific (services, viewport, environment, MCP ports) lives there.

## File location resolution

The CLI walks the file system upward from the spec file looking for the first `cairntrace.config.yml`. If your specs live in `specs/flows/login.yml` and the project root has the config, that's used. Specs outside the project tree work fine — `--config <path>` overrides the lookup.

## Schema

```yaml
# cairntrace.config.yml
project: project-name               # used in artifacts, breadcrumbs, MCP resource names
version: 1                          # config schema version
extends: ./base.yml                 # merge-instead-of-replace from a base file

run:
  out: ./run                        # artifact output dir (default ./run)
  dryRun: false                     # print what would happen; never change state
  coldStart: auto                   # auto | always | never
  timeoutMs: 30000                  # global ceiling; per-step overrides via timeoutMs on the step
  continueOnFailure: false          # whether to keep going after the first failed outcome

browser:
  backend: agent-browser            # agent-browser | playwright | mock
  viewport:
    width: 1280
    height: 800
  headless: true                    # always true in CI; default true everywhere
  userDataDir: ./.cairntrace/profile
  ignoreHTTPSErrors: false
  recordVideo: false
  artifacts:
    snapshots: on-failure           # always | on-failure | never
    screenshots: on-failure
    console: on-failure
    network: on-failure

services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
    readinessCheck: "curl -sf http://localhost:27017"
    healthcheck:
      command: "curl -sf http://localhost:9200/_cluster/health | grep -q green"
      intervalSeconds: 15
      retries: 5
  seed:
    command: "yarn demo-import"
    ttlSeconds: 21600
    freshnessCheck: "mongosh --quiet --eval 'db.count()' mydb"

environment:
  defaults:                         # ${env.X} values default to these
    API_URL: http://localhost:3000
  vars:                             # ${vars.X} values are spec-scoped overrides
    allowed_countries: [US, MX]

redaction:
  patterns:
    - "authorization: .*"
    - "set-cookie: .*"
    - "x-api-key: .*"
    - "bearer [A-Za-z0-9\\-\\._~+/=]+"

report:
  theme: nord                       # nord | solarized | plain
  colors: { primary: "rgb(94, 129, 172)" }
  includeTimingGraph: true

mcp:
  transport: stdio                  # stdio | http
  port: 4173                        # http only
  resources:
    expose: [specs, run]
  redactSecrets: true
  perToolConfirm:
    - rotate_key                    # confirm-and-go for these mutating tools

telemetry:
  events:
    onOutcomes: true
    onErrors: true
    onRepairs: true
```

## Hierarchical merge

When `extends` points at another file, the overlay merges field-by-field with that base rather than replacing it. Per-field replacement is the rule; per-array replacement is the rule. If you want per-element merge of an array, replace with a structured object first.

```yaml
# base.yml
environment:
  defaults:
    API_URL: http://localhost:3000

# overlay.yml — extends: ./base.yml
environment:
  defaults:
    LOG_LEVEL: debug               # LOG_LEVEL is added; API_URL is preserved
```

## Environment resolution order

For every `${baseUrl}`, `${env.X}`, or `${vars.X}` substitution in a spec, the resolver walks, in order:

1. Inline `env:` block in the spec (highest).
2. `vars:` block in the spec.
3. `environment.vars` in the merged config.
4. `environment.defaults` in the merged config.
5. Process environment variables of the runner (`process.env`).
6. Reserved env vars injected by services the runner owns.

If a placeholder is unresolved, the run fails at parse-time with a typed error pointing at the spec line.

## Backend choice

`browser.backend: agent-browser` is the default and the right choice for almost everything. It runs the spec inside the agent's existing browser session, which is what makes agent-in-session specs possible at all. Pick `playwright` only when you need native Playwright traces or full-frame video. Pick `mock` for test-only runs of headless specs.

## Cold-start and the auto default

`run.coldStart: auto` means **run with --cold-start when in CI, with whatever cookies exist otherwise**. That is the right default for a local development loop. The cold-start contract is enforced via `--cold-start` checks in CI. Local iterations can skip the cold restart to keep the inner loop fast.

## Setting `timeoutMs`

`run.timeoutMs` is the global ceiling. A step that needs 60 seconds (slow SPA hydration) should override per-step:

```yaml
steps:
  - wait: { selector: "[data-testid='hydrated']", state: visible, timeoutMs: 60000 }
```

A blanket `run.timeoutMs: 600000` is a code smell — fix the slow step instead.

## Redaction patterns

The default patterns cover the obvious credential/cookie header cases. Add project-specific patterns when you have fields the defaults miss. Patterns are compiled to `RegExp` once on runner construction; a misbehaving pattern causes the run to fail at parse time, not at the first match.

## See also

- [Troubleshooting](/troubleshooting) — common configuration mistakes and what they break
- [MCP](/mcp) — server-side config for the MCP server
- [Distribution](/distribution) — distributing `cairn` to teammates
- [Overview](/overview) — what cairntrace is
