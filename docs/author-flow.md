---
title: Author a Spec from a Request
description: How a coding agent goes from a three-sentence request to a promoted Cairntrace browser spec — catalog, discovery with setup, convention export, spec finish, review and promote.
---

# Author a spec from a request

You tell an agent:

> Sign in as the supplier, change the Website field on the profile, save, and
> check that it persisted. Write it as a spec.

This page is the path from those sentences to a spec in your suite that
replays from a cold browser, reuses the project's own actions and vars, keeps
secrets out of the file, and ran green against the app before anyone
promoted it. MCP clients
get the same recipe as the `author-flow` prompt (arguments `request`, `env`,
`targetDir`); shells get it from `cairn docs author-flow`.

## The six steps

### 1. Ask the catalog first

```text
cairn_catalog { query: "profile website", env: "local" }
```

```bash
cairn catalog --query "profile website" --env local --json
```

The [catalog](/catalog) lists what the project already has: the login action,
an edit-and-save helper, the config vars that hold the field selector and the
test value, script verifiers and their fixture contracts, similar flows. The
agent reuses them. It never re-records a login, and never hardcodes a value a
var already holds.

### 2. Open a discovery session where the journey starts

```text
cairn_discover_open {
  env: "local",
  setup: [{ use: "login_as_supplier" }],
  url: "/profile",
  snapshotMode: "diff"
}
```

The setup runs the project's own login action through the same engine as
`cairn run` (config, vars, `${secrets.X}` from the configured provider), so the
session starts signed in. Every session is journaled under
`<artifactRoot>/_sessions/<id>/` — screenshots, snapshots, the network it saw
and a draft spec regenerated after each step — and Cairntrace Studio shows it
while the agent works. See [discovery sessions](/discover).

### 3. Record the journey, one step per call

```text
cairn_discover_interact { sessionId, action: "fill",
  target: { by: "label", name: "Website" }, value: "https://acme.example.test" }
cairn_discover_interact { sessionId, action: "click",
  target: { by: "role", role: "button", name: "Save" } }
```

`snapshotMode: "diff"` keeps each answer small: only what changed since the
last snapshot. `result.network.mutations` shows the request the save sent
(`PATCH /api/profile/42 204`) — if it is not there, the save did not happen.
Credentials are typed as `${secrets.NAME}` or `${env.NAME}`; a value equal to a
known secret is recorded as its placeholder anyway. A wrong step is undone with
`cairn_discover_remove_step`.

### 4. Export with the project's conventions

```text
cairn_discover_export {
  sessionId,
  into: "flows/_drafts",
  intent: "A supplier can change the profile website and the change is saved",
  outcomes: [{ id: "website_saved", description: "…", verify: { … } }],
  requires: { env: ["local"] }
}
```

The outcomes are the contract: they assert what was asked for (the value
persisted, the confirmation shows, the request succeeded), not how the agent
clicked. The export then writes the spec the way the project would:

| Convention | What the draft gets |
| --- | --- |
| Reuse actions | Runs of steps an existing action performs become `use: { action, vars }`; the setup stays `imports:` + `use:` |
| Lift vars | A literal equal to a config var of the environment becomes `${vars.name}`: URLs, emails and long values always, short words only into a field the var is named after; locators and numbers never |
| Secrets | Known secret values become their placeholders; a literal typed into a field whose name sounds like a credential that matches no known secret refuses the export (`refuseSecrets: false` keeps it with a warning) |
| URLs | Absolute URLs under the environment `baseUrl` become relative |
| Waits | `open:` gets `waitUntil: networkidle`; a click that changed the page gets a `wait: { url }` the old URL does not satisfy (`includes` of the new path's stable part, or a `pattern` for the exact new path in CRUD flows like `/products/new` → `/products/42`) |
| Postconditions | A request the session saw a click or fill cause becomes `postcondition.network` |
| Ids | Every step gets a unique snake_case `id` |
| Template | `authoring.template` adds `requires`, `metadata.tags` and the action files to search |

The result's `report` lists what happened — `reusedActions` (with a
confidence), `liftedVars`, `secretsPlaceholdered`, `warnings`, each naming
the step as the written file has it (`steps[3]`) — so the agent can say it. Drafts land in the drafts directory, which `cairn run <dir>` skips.

### 5. Finish: lint, cold-start run, stamp

```text
cairn_spec_finish { path: "flows/_drafts/profile_website_saved.yml", env: "local" }
```

```bash
cairn spec finish flows/_drafts/profile_website_saved.yml --env local --json
```

`spec finish` lints the draft (an error stops it with `lint-failed` and a
fix-it per finding; `cairn spec lint --fix` applies the safe ones), runs it
from a fresh browser through the same engine as `cairn run`, and stamps the
contract hash when the run is green. It answers with `status`
(`green`, `red`, `lint-failed`, `errored`, `refused`), the run directory and
report, and a summary of the run's `agent_context.md`. On `red` the agent fixes
the steps — not the outcomes — and finishes again. With a dev server already
running, pass `--no-web-server` (MCP `noWebServer: true`); a cold start
otherwise boots the config `webServer` fresh. A finish with `mock: true` only
shows the spec replays: it never touches the app, and promotion does not
accept it.

### 6. Report, and let the human promote

The agent reports the draft path, the intent, each outcome, the run report and
what it reused, and asks for review. After the human approves:

```bash
cairn spec promote flows/_drafts/profile_website_saved.yml --json
```

Promotion moves the draft out of the drafts directory (to `flows/` by default,
or `--to`), rewrites its relative imports and file paths, stamps the contract
and returns `{from, to, intent, outcomes, contractHash}`. It only promotes the
exact content that finished green on a real backend, it rolls back when the
promoted copy would point at a missing file, and it never replaces an
existing spec.

## Project setup

Tell the project's agents about this path once:

```bash
cairn init agent-kit --write
```

writes a short section into the `AGENTS.md` next to the config — the config,
the environments, the drafts directory, the actions, the five commands and the
rules — between markers, so running it again updates it in place. Without
`--write` it only prints the section.

Project conventions live in `cairntrace.config.yml`:

```yaml
authoring:
  draftsDir: flows/_drafts          # default; the folder name must start with _
  template:
    requires: { env: [local] }      # where new specs may run
    metadata: { tags: [authored] }
    imports: [actions/login.yml]    # actions exports look in first
```

## Without MCP

Interactive recording needs the MCP session tools, but a one-shot discovery
leaves a journal that the CLI can export with the same conventions:

```bash
cairn discover /profile --use login_as_supplier --env local --json
cairn discover export --from-session <sessionId> --into flows/_drafts \
  --name profile_website_saved \
  --intent "A supplier can change the profile website" --outcomes outcomes.yml --json
cairn spec finish flows/_drafts/profile_website_saved.yml --env local --json
cairn spec promote flows/_drafts/profile_website_saved.yml --json
```

## Related

- [Discovery sessions](/discover) — setup, interactions, snapshot modes, the journal.
- [Project catalog](/catalog) — what to reuse.
- [Authoring contracts](/authoring) — outcomes, cold start, lint, finish, promote.
- [Agent workflow](/agents) — the run and repair loop once a spec exists.
