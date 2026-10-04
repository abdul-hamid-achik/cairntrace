---
title: Project Catalog for Agents
description: List the reusable actions, config vars, script verifiers, environments, flows and checkpoints a Cairntrace project already has, ranked by keyword, so agents reuse them.
---

# Project catalog

`cairn catalog` answers "what does this project already have?" in one call: reusable actions with their inputs, config vars per environment, script verifiers with their fixtures contract, environments with their policy, flows with their last run, checkpoints with their scope, and config suites with the specs each resolves to per environment. An agent that is about to author a spec asks the catalog first and reuses `use: <action>` and `${vars.X}` instead of re-recording literals.

The catalog only reads files. It never runs a spec, a script verifier, a hook or a service.

```bash
cairn catalog --json                                  # everything
cairn catalog --query "edit website field" --json     # ranked, top 10 per kind
cairn catalog --env staging --kind vars,checkpoints   # one environment
```

MCP: the `cairn_catalog` tool takes the same inputs (`config`, `env`, `query`, `kind`, `limit`, `artifactRoot`) and returns the same document as `structuredContent`, with a short text summary (rows per kind, the first names, how to narrow) as its text content. Without `query` or `limit` it returns at most 20 rows per kind; `totals` keeps the full counts. Pass the task's keywords as `query` before authoring a spec. The `cairn://catalog` resource holds the whole catalog of the project the server runs in, as compact JSON scoped to the config `defaultEnvironment` when one is set; on a large project prefer the tool with a `query`.

## Flags

| Flag | Effect |
|---|---|
| `--config <path>` | explicit `cairntrace.config.yml` (default: discovered upward from the current directory) |
| `--env <name>` | vars of that environment only; last runs in that environment; checkpoint origin checked against its `baseUrl`. An environment the config does not define, or `--env` with no config found, is an error (exit 4) |
| `--query <text>` | rank rows by keyword and keep the ones that match |
| `--kind <kinds>` | `actions`, `vars`, `verifiers`, `envs`, `flows`, `checkpoints`; repeatable or comma-separated (default: all) |
| `--limit <n>` | rows per kind (default 10 with `--query`, otherwise all); `totals` keeps the full count |
| `--artifact-root <path>` | artifact root scanned for last runs (default: config `artifactRoot`, else `~/.cairntrace/runs`) |
| `--format json\|yaml\|md` | output shape (`--json`, `--yaml`, `--md` shorthands) |

Exit codes: `0` success, `2` usage error (`--kind`, `--limit`) or an unexpected failure, `4` config error (invalid config, unknown `--env`, `--env` without a config). A malformed project file never fails the catalog: a file that cannot be read, or a row the schema rejects (an empty name, outcome id or run status), is left out and named in `warnings`.

## What it lists

The JSON document is `urn:cairntrace.dev:catalog:v1`. Every `file` is relative to `root`, the config directory.

- **actions**: `name`, `file`, `description` (the action's `description:` field, else its leading YAML comment block; `descriptionSource` says which), `inputs`, `steps`, `usedBy` (specs and actions that import or `use:` it) and `lastGreenRun` (the newest passed run of a spec that uses it). Each input carries `declared` (listed under `inputs:`), `referenced` (read as `${vars.X}` in the action), its `default`, `required` (declared, or no action default and no config var: the importing spec's `vars:`, a config environment var or `--var` must supply it) and `configEnvs` (environments whose config vars set it). `problems` lists `inputs:` that disagree with `vars:`.
- **vars**: one row per environment and var: `value` as authored (placeholders like `${env.X}` stay as written), the YAML comment above the key, `definedIn` (`environment`, also for a var in a file the environment lists under `include:`, where `file` names that file; `inherited` through a `<<:` merge key or a `vars: *anchor` alias, with `inheritedFrom`; `top-level` for the config's top-level `vars:` or an included file; `extends` for an environment this one extends, named in `inheritedFrom`), `file` (`file:line` of a definition the environment does not write itself), and `usedBy`. `cairn config vars` adds the effective value per environment, every definition and override, and uses beyond specs and actions (see [Configuration](/configuration#listing-vars-cairn-config-vars)).
- **verifiers**: every `script.file` the specs reference, with its header doc comment, its fixtures contract and, per use, the fixture keys the outcome passes. `unknownKeys` are passed keys the contract does not list; `missingKeys` are contract keys marked required that the outcome does not pass.
- **envs**: `baseUrl`, `policy` (`trait`, `mutations`, `description`), `services` (enabled and its phases) and the secrets provider with key names (never values).
- **flows**: `name`, `intent`, `tags`, `requires`, `environment`, the actions it uses, its `session.resume` checkpoint, `draft` for `_`-prefixed files or folders, and `lastRun` (status and duration).
- **checkpoints**: the checkpoints specs resume, and saved ones captured for an origin one of the configured environments uses, with `health` (`ok`, `expired`, `unscoped`, `missing`), `scope` (env, baseUrl, ttl, expiresAt) and, with `--env`, a `problem` when the checkpoint was captured for another origin. The checkpoint store is shared by every project, so the others are only counted (`scan.otherCheckpoints`); `cairn checkpoint list` shows them.

Last runs are matched by the spec's own path. When no run in the scanned window recorded that path (a moved checkout), the newest run recorded under the spec's name is used and marked `matchedBy: "name"`: with the shared default artifact root it can come from a same-named spec of another project.

Values that look like credentials are masked as `[redacted]`: vars whose name says password, secret, token, credential, cookie, assertion, code verifier or API key (also in plurals and run-together names such as `DBPASSWORD` or `accessTokens`), literals that look like tokens (also as the fallback of `${env.X:-…}`), and URL userinfo.

## Ranking

`--query` splits names, descriptions and comments into words (camelCase, `snake_case` and `kebab-case` too) and scores each row. Phrasal verbs count as one word whichever way they are written, and a few spellings fold together: "log in", "logged in", `sign_in` and `login` all match `login_as_admin`. A word in the name counts most, then the description, intent or tags, then inputs, then comments and other text. Rows with no match are dropped. Each row carries a `score` and `matched`: the query words that hit and the field they hit.

```json
{
  "name": "edit_and_save_text_field",
  "file": "actions/edit_and_save_text_field.yml",
  "description": "Reveal, edit and save a profile text field such as the company website.",
  "score": 9,
  "matched": [
    { "token": "edit", "field": "name" },
    { "token": "websit", "field": "description" },
    { "token": "field", "field": "name" }
  ]
}
```

## Documenting actions

Actions may carry a `description:` and `inputs:` so the catalog (and a reader) knows what to pass:

```yaml
version: 1
name: edit_and_save_text_field
description: Reveal, edit and save a profile text field.
vars:
  textFieldValue: hello
inputs:
  textFieldSelector:
    description: CSS selector of the input
    required: true
  textFieldValue:
    description: Value to type before saving
    default: hello
steps:
  - fill: { by: selector, selector: "${vars.textFieldSelector}", value: "${vars.textFieldValue}" }
```

`inputs` document; `vars` still hold the values a run uses. An input `default` must equal `vars.<name>`, and a `required` input cannot have a default; the spec parser rejects either mismatch.

A `required` input has to reach the action when the spec imports it: imports are resolved once, before any `use:` expands, so set it in the importing spec's `vars:`, a config environment var or `--var`. A call site's `use: { action, vars }` can then override it for that call, but a value passed only there is not enough:

```yaml
vars:
  textFieldSelector: '[data-field="website"] input'   # satisfies the required input
imports: [../actions/edit_and_save_text_field.yml]
steps:
  - use:
      action: edit_and_save_text_field
      vars: { textFieldValue: https://example.test }   # per-call override
```

An input every call site sets differently is better given a neutral `vars:` default (and no `required`). Without `description:`, the leading comment block of the file is used. Name inputs in plain words inside `description:`: like every value of an action, it is substituted at run time, so a `${vars.X}` there must resolve.

## Documenting script verifiers

The catalog reads a verifier's fixtures contract without running it, from the first of:

1. a `Fixtures:` block in the header comment, one key per line, or `@fixture name description` tags:

   ```ts
   // Checks that the saved value survived a reload.
   //
   // Fixtures:
   //   expectedValue: the value to find (required)
   //   inputSelector: where to look (optional)
   ```

2. an exported object literal: `export const fixtures = { expectedValue: "the value to find" }` or `export const contract = { fixtures: { … } }`;
3. otherwise the keys the code reads (`fixtures.x`, `fixtures["x"]`, `const { x } = ctx.fixtures`).

A script that reads fixtures dynamically (`Object.keys(fixtures)`, a spread, a computed key, or the whole object passed to an imported helper or a builtin such as `JSON.stringify`) is marked `dynamic` and its unknown keys are not flagged. The whole object passed to a local function is followed into that function's parameter.

## Performance

Parsed files are cached by path and modification time within the process, so repeated `cairn_catalog` calls on a long-lived MCP server only re-read files that changed. The file walk is bounded, skips hidden, dependency and build folders and the artifact root, and the run scan reads at most 500 `run.json` files, newest first.
