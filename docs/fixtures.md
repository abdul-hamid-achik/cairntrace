---
title: Cairntrace Fixtures Registry
description: Declare test data once in cairntrace.config.yml — exec, mongo and http fixtures with ensure, reset, verify and teardown — and let cairn run ensure, share and clean it up.
---

# Fixtures

A fixture is named test data a spec needs before its first step: a cloned
document, an entity created through the API, a row table emptied, a worker
started. Instead of a `mongosh … ensure-x.js` precondition or an outcome with
side effects, declare it once under `fixtures:` in `cairntrace.config.yml`
and list it in the spec:

```yaml
# spec
fixtures:
  - kit_rows.reset                               # ensure its needs, then reset it
  - { use: buyer, with: { name: Demo Buyer } }   # parameters override with:
steps:
  - open: /kits/${fixtures.demo_kit.kitId}?buyer=${fixtures.buyer.id}
```

`cairn run` ensures the fixtures (needs first) after the preconditions and
before the browser starts, splices their outputs as
`${fixtures.<name>.<key>}` into steps, `teardown:` and verifiers, and tears
run-scoped fixtures down after the spec teardown — after a pass, a failure, a
cancel, and (exec fixtures) a SIGINT/SIGTERM.

## The registry

```yaml
fixtures:
  <name>:
    kind: exec | mongo | http
    scope: run | suite | seed     # default run
    description: …
    with: { … }                   # default parameters: ${with.X}
    needs: [other]                # ensured first; must live at least as long
    ensure: …                     # make it exist (idempotent)
    reset: …                      # put it back to its initial state
    verify: …                     # read-only presence check (never writes)
    teardown: …                   # remove it
    outputs: { key: $.path }      # or a template, or { from: $.path, secret: true }
    owner: { exactlyOne: true, marker: { field: value } }
    ttl: 6h                       # freshness of a recorded ensure (seed/suite)
    timeoutMs: 120000             # default budget of each verb
```

A fixture needs `ensure` or `reset`. A spec reference is `name` (ensure; a
fixture with only `reset` is reset instead), `name.reset` (ensure, then reset)
or `{use, with, write}`. Unknown fixtures, `needs` cycles and a `needs` on a
shorter-lived fixture (a seed fixture needing a run fixture) are config
errors. A spec that splices `${fixtures.x…}` without listing `x` (or a
fixture that needs it), lists no fixtures at all, or uses `${fixtures.…}` in
its preconditions (they run before the fixtures) errors before anything runs.
After the fixtures are set up, every `${fixtures.<name>.<key>}` the steps,
`teardown:` and outcomes splice must have a value — a dry-run that found
none errors the run in phase `fixture` instead of sending a literal
placeholder to the browser.

`verify` is the check that also runs where writes are off (a dry-run, a
freshness check, `cairn fixtures status --verify`), so it may only read: mongo
`findOne` / `count`, http `find` and GET/HEAD requests (no `create`; the
`login` helper still runs), a mongosh `script` only while writes are
allowed, and an exec verify must keep to reads itself (it gets
`CAIRN_FIXTURE_READ_ONLY=1`). A verify with a write operation is a config
error, and the adapters refuse one at run time too.

Strings in a fixture may use `${with.X}`, `${fixtures.<name>.<key>}` (a need's
outputs, or the fixture's own in reset/verify/teardown), `${vars.X}`,
`${secrets.X}` / `${env.X}`, `${baseUrl}`, `${run.token}` and `${now}`. A
string that is exactly one placeholder keeps the value's type; an unresolved
placeholder fails the verb instead of writing an empty id.

## Scopes

| Scope | Ensured | Torn down |
|---|---|---|
| `run` | by every run that lists it | after that run's spec teardown, newest first |
| `suite` | once per `cairn run` invocation (parallel runs wait on the same ensure) | when the invocation ends, before the webServer and services stop |
| `seed` | once per services seed: a recorded ensure is reused while it is fresh | never by a run (`cairn fixtures teardown` / `sweep`) |

Freshness: a seed or suite fixture with `ttl` reuses the ensure the ledger
recorded within the ttl, for the same definition and parameters, when its
`verify` (if any) passes. A seed fixture without `ttl` is fresh until the
services seed runs again, its definition changes or its `verify` fails.
`cairn run` knows whether its own services seed ran or was skipped as fresh
(and remembers a seed run for later invocations); a seed run elsewhere —
`cairn services up`, by hand — is caught by the services seed state, or
reliably by a `verify` verb.

## Adapters

### `exec`

```yaml
workspace:
  kind: exec
  scope: suite
  ensure: { node: tools/create-workspace.mjs, args: ["${vars.tenant}"] }
  teardown: { shell: 'tools/delete-workspace.sh "$1"', args: ["${fixtures.workspace.id}"] }
  outputs: { id: $.id }
```

A verb is a shell string or `{shell | node, args, cwd, env, timeoutMs}`; node
scripts and `cwd` resolve against the config directory. `args` reach a shell
command as `$1…$n` — the string form has none, so use the object form when the
command needs a value (`$1` would be empty). The child sees the
run context (`CAIRN_ENV`, `CAIRN_BASE_URL`, `CAIRN_RUN_ID`, …,
`CAIRN_RUN_STATUS` in teardown) plus `CAIRN_FIXTURE_NAME`, `_VERB`, `_SCOPE`,
`_WITH` (JSON parameters), `_OUTPUTS` (JSON outputs so far) and `_MARKER`;
a `verify` child also gets `CAIRN_FIXTURE_READ_ONLY=1`.
Its last stdout line, when it is JSON, is the verb result; without `outputs:`
that object becomes the outputs. A non-zero exit fails the verb. The verb runs
in its own process group: the verb settles when its command exits (a
background process it started cannot hold it open), and the group is killed
past the deadline, on cancel, and when `cairn` exits.

### `mongo`

```yaml
demo_kit:
  kind: mongo
  datasource: appdb                 # a datasources: entry of kind mongo
  scope: seed
  with: { kitId: 6a0000000000000000000001 }
  owner: { exactlyOne: true, marker: { cairnFixture: demo_kit } }
  ensure:
    - cloneDoc:
        collection: kits
        from: [{ _id: { $oid: 6a0000000000000000000099 } }, { kind: deliverable, cairnFixture: { $exists: false } }]
        to: { _id: { $oid: "${with.kitId}" } }
        set: { label: Demo kit 2026 }
        unset: [taskCounts]
      as: clone
  verify:
    - findOne: { collection: kits, filter: { _id: { $oid: "${with.kitId}" } } }
      expect: { found: true }
  outputs: { kitId: $.clone.id }
```

Operations: `insertOne`, `insertMany`, `updateOne`, `updateMany`,
`replaceOne`, `deleteOne`, `deleteMany`, `cloneDoc`, `findOne` and `count`,
each with an optional `expect` (`matched`, `modified`, `upserted`, `deleted`,
`inserted`, `count`, `found`, `fields`; a number means equals) and `as`.
`cloneDoc` reads the first document matching `from` (fallback filters tried in
order), applies `set` / `unset` (dotted paths), and writes it onto `to` with a
`replaceOne` upsert that keeps `to._id`. Values are extended JSON (`{$oid}`,
`{$date: "${now}"}`); results reach `outputs` in plain form (ObjectIds as hex
strings). Every transport of the datasource works (the optional `mongodb`
driver, `mongosh`, `docker exec` into the compose service), and a
`mode: read-only` datasource refuses every write and every script.

The escape hatch is a mongosh script:

```yaml
ensure: { script: tools/ensure-kit.mongosh.js, args: { kitId: { $oid: "${with.kitId}" } } }
```

The script runs with `db` bound to the datasource's database and `args`
decoded from EJSON; its last stdout line, when it is JSON, is the result. The
connection string and the arguments travel in the environment, never on the
command line. A script cannot be proven read-only: as `verify` it only runs
while writes are allowed (a dry-run skips it and falls back to the ledger).

### `http`

```yaml
buyer:
  kind: http                        # base URL: datasource, baseUrl, else the env's
  with: { name: Demo Buyer }
  owner: { exactlyOne: true, marker: { cairnFixture: buyer } }   # stamped on what it creates
  login:
    path: /api/login
    body: { email: fixtures@demo.test, password: "${secrets.FIXTURE_PASSWORD}" }
    token: $.token                  # sent as Authorization: Bearer …
  ensure:
    find: { path: /api/entities, items: $.entities, where: { name: "${with.name}" } }
    create: { path: /api/entities, body: { name: "${with.name}" }, item: $.entity }
  verify:
    find: { path: /api/entities, items: $.entities, where: { id: "${fixtures.buyer.id}" } }
  teardown:
    - { method: DELETE, path: "/api/entities/${fixtures.buyer.id}", status: [204, 404] }
  outputs: { id: $.item.id }
```

`find` reads the candidate list (`items`, default the body when it is a list)
and keeps those matching `where` (the natural key), the ones carrying the
owner marker first; when none match, `create` runs (the marker merged into its
body) and `item` picks the created record (`refind: true` repeats the find).
cairn tears down only what the fixture owns: a record it created, or a found
one that carries its marker. A record `find` adopted — matched by the natural
key, no marker on it (someone else's data) — is used, never deleted: its
teardown is `skipped` and the ledger releases it. Without `owner.marker` a
found record is always adopted, so declare one whenever `teardown` deletes.
A verb can also be a list of requests (`{method, path, headers, body, status,
expect, as}`); statuses default to 2xx. The login token, like every resolved
secret, is scrubbed from errors and evidence.

## Outputs and ownership

`outputs` map a key to a JSONPath into the verb result or to a template:

| Adapter | Result |
|---|---|
| exec | the JSON of the last stdout line |
| mongo | `$.ops[i]`, `$.<as>`, `$.last` — counts (`matched`, `modified`, `upserted`, `deleted`, `inserted`), `upsertedId`, `insertedId`, a found document, cloneDoc's `id` / `sourceId`, count's `count` |
| http | `$.item`, `$.created`, `$.owned` (created, or found carrying the marker), `$.found`, `$.<as>`, `$.last` |

`{from, secret: true}` makes an output usable as `${fixtures.x.key}` but keeps
it out of events, `fixtures.json`, the ledger, `cairn fixtures` output and the
run's evidence (a step that splices it shows `[redacted]`). An output under a
sensitive key (`token`, `apiToken`, `password`, `secret`, …, at any depth —
an exec result without `outputs:` included) is treated the same way. A
redacted output cannot be reused from the ledger: a seed or suite fixture
that has one is re-ensured instead of reused.

`owner.exactlyOne` fails a verb when its natural key matches more than one
record (an http `find`, a mongo update/replace/delete/clone target).
`owner.marker` is stamped on everything the fixture creates — mongo inserts,
clones, replacements and `$setOnInsert` on upserts; an http create body;
`CAIRN_FIXTURE_MARKER` for exec — and mongo deletes, plus every mongo write of
`teardown`, only touch documents that carry it. Put `${run.token}` in a
run-scoped marker to keep parallel runs apart.

## Environment policy

`ensure`, `reset` and `teardown` are dry-run — the event says `dry-run`,
nothing is written — on an environment whose `policy.trait` is `shared` or
`protected`, and on any environment with `policy.mutations: deny`. Allow
writes on a shared or protected environment for one invocation with
`cairn run --allow-fixture-writes` (`cairn fixtures … --allow-writes`, MCP
`allowFixtureWrites: true` / `allowWrites: true`), or for one reference with
`{use: name, write: true}` (it covers the fixture's needs). Nothing overrides
`mutations: deny`.

A dry-run ensure still runs the read-only `verify` to prove the data is there
and reads its outputs from the result; without a usable `verify` it reuses
the outputs the ledger recorded for the same definition and parameters (never
another instance's: a spec asking for `name: Beta` does not get the ids of
`name: Alpha`). A failing verify errors the run, and so does a spliced output
that is still missing afterwards.

## Evidence

- Events `fixture.ensure`, `fixture.reset`, `fixture.verify` and
  `fixture.teardown`: `{name, adapter, status: ok | failed | skipped | dry-run,
  durationMs, scope, outputs?, error?, reason?, timedOut?, signal?}`. Suite and
  seed fixtures also go to the invocation journal
  (`_invocations/<id>/events.ndjson`). While a verb runs, `phase.changed`
  shows `fixture <verb> <name>`.
- `<runDir>/fixtures.json`: `{version: 1, entries: [{name, adapter, scope,
  ensuredAt, outputs, status, reason?, reset?, teardown?}]}`.
- `~/.cairntrace/fixtures/<project>.ledger.jsonl`: one line per verb, with the
  environment, outputs and parameters (redacted, sensitive keys included),
  ttl, the seed it belongs to, the run or invocation and the process that
  recorded it. A run-scoped fixture is folded per instance (each run owns
  its own), so parallel runs never hide each other's leftovers. States:
  `live`, `failed`, `torn-down`, and `released` (cairn owes no teardown:
  an adopted record, or a failed ensure a sweep released).
- A failed ensure or reset errors the run in phase `fixture`; whatever was
  ensured before it is still torn down. A failed teardown is reported and
  never changes the run status — `cairn fixtures sweep` retries it. A
  teardown that needs an output its failed ensure never recorded is
  `skipped`, not failed. Teardown has finally semantics: a run that throws
  after its fixtures were set up (an I/O error writing evidence) still runs
  the spec teardown and the fixture teardowns before the error propagates.

## `cairn fixtures`

```bash
cairn fixtures list                               # the registry
cairn fixtures status --verify                    # ledger state, verify against recorded outputs
cairn fixtures ensure buyer --with name=Demo\ Buyer --env local
cairn fixtures reset kit_rows
cairn fixtures teardown buyer                     # every open instance, with its recorded outputs
cairn fixtures sweep --older-than 2h              # report leftovers
cairn fixtures sweep --older-than 2h --apply      # tear them down
```

Every subcommand takes `--config`, `--env` and `--format json|yaml|md`
(`urn:cairntrace.dev:fixtures:v1`); `ensure`, `reset`, `teardown` and `sweep`
take `--allow-writes` for a shared or protected environment (`writes` and
`writesReason` say what applies). Exit 0 ok (a dry-run included), 1 a verb
failed, 2 error, 4 invalid input. The document goes through the same
key-aware redaction as run evidence. `status` shows a run-scoped fixture's
newest open instance, with `instances` when several runs left one open.
`sweep` lists one row per leftover (per run instance) and never touches a
fixture whose recording process still runs on this host, one without a
teardown verb or no longer in the config, a record the ensure adopted
(`skipped-adopted`), one younger than `--older-than` (default 1h; a ttl
that expired always qualifies), or a seed fixture unless `--include-seed`.
A failed ensure whose teardown needs outputs it never recorded is
`skipped-no-outputs` (exit 0); `--apply` releases it from the ledger. MCP:
`cairn_fixtures_list`, `cairn_fixtures_status`, `cairn_fixtures_ensure`,
`cairn_fixtures_reset`, `cairn_fixtures_teardown`, `cairn_fixtures_sweep`.
`cairn catalog --kind fixtures` lists the registry with the specs that use
each fixture.

## See also

- [Configuration](/configuration#fixtures) — where the registry lives
- [Verifiers](/verifiers#datasources) — the `datasources:` mongo and http fixtures use
- [Services](/services) — the seed a seed-scoped fixture follows
- [Steps](/steps) — the spec `teardown:` and `run:` step that run before fixture teardown
