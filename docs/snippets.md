---
title: "Reusable Browser Test Snippets and Actions"
---

# Reusable snippets

The `imports:` block on a spec lets you split reusable parts across files and call them by name. A snippet can be a single step or a sequence of steps, packaged as an action file.

## File layout

```text
specs/
├── checks/
│   └── assert-login-page.yml
├── flows/
│   ├── checkout.yml
│   └── checkout-success.yml
└── snippets/
    └── actions/
        ├── login-admin.yml
        ├── rotate-token.yml
        ├── create-entity.yml
        └── conditional/
            ├── dismiss-banner.yml
            └── env-conditional.yml
```

The layout is convention only. Two rules matter: `cairn run <dir>` skips folders named `actions/` (and names starting with `_`), so keep reusable files under `actions/`; and an import is a file path, not a lookup by name.

Each action file needs a snake_case `name:` (`^[a-z][a-z0-9_]*$`). `use:` calls the action by that name, not by its file name.

## Imports block

```yaml
# specs/flows/checkout.yml
version: 1
name: checkout_rotate_token
imports:
  - ../snippets/actions/login-admin.yml              # relative to this file; .yml required
  - ../snippets/actions/rotate-token.yml
  - ../snippets/actions/conditional/dismiss-banner.yml

intent: Sign in, rotate an API token, and confirm the new token works.
outcomes:
  - id: token_rotated
    description: the rotated token is confirmed
    verify:
      text: { contains: "Token rotated" }
steps:
  - use: login_admin            # uses the imported snippet
  - use: rotate_token
  - use: dismiss_banner
```

Each imported file declares its own name: `login-admin.yml` has `name: login_admin`, `rotate-token.yml` has `name: rotate_token`, and `dismiss-banner.yml` has `name: dismiss_banner`.

`use:` invokes the imported snippet by name within the spec's `steps:`. Import paths are resolved relative to the file that imports them, and cairn does not add `.yml` or look for files by name, so a bare `actions/login-admin` fails with `ENOENT`. An action file can declare its own `imports:` (also relative to the action file) and `use:` them, so `login_as_supplier` reuses `login_base` instead of copying its steps:

```yaml
# snippets/actions/roles/login_as_supplier.yml
version: 1
name: login_as_supplier
imports:
  - ../shared/login_base.yml
steps:
  - use: { action: login_base, vars: { user: supplier@demo.test } }
  - click: { by: role, role: button, name: Supplier view }
```

An action's `use:` resolves against its own imports first, then against its importer's. Vars reach a nested action in this order: the inner call's own `vars` win; then — only for names the nested action does not default — the values its caller saw; then the spec's vars; then the nested action's defaults. An enclosing call never silently overrides a nested action's own default: pass it on explicitly (`use: { action: fill_form, vars: { name: "${vars.name}" } }`) when that is what you want. The import graph must be a DAG: an import cycle, or a `use:` cycle reached through the importer's scope, is a parse error, and two files that declare the same action `name:` are refused. Expansion is recursive, so a run, `cairn spec heal` and the step-relative file paths all point at the innermost action file, and `cairn export playwright --project` turns a nested `use:` into a call to that action's module.

## What gets reused

The same logic that lives in one spec is the candidate for a snippet:

- **Login flows.** "Sign in as an admin" is reused everywhere a flow needs an authenticated session.
- **Token rotation, key rotation, secret reset.** Anything where the contract is "the system shows the success toast after I do the dance."
- **Conditional dismissals.** Banner dismissal, modal close, and feature-flag dismissals are the same shape in 30 specs. Make them snippets.
- **Form fills** with a fixed shape. "Fill name + email + submit" reused across several flows.

Do not lift things that are unique to one flow. The point of a snippet is to encode the contract across many flows, not to factor code.

## When you lift something to a snippet

1. Give the action a `description:` and declare what the caller must pass in `inputs:` (`required: true` when the action has no `vars:` default; an `inputs.<name>.default` must equal its `vars:` default), so its contract reads without opening the steps.
2. Action files have no `intent:` or `outcomes:`. The calling spec's `outcomes:` decide whether the run succeeded, so a snippet's job is to leave the page in the state the next step expects.
3. Refactor in two commits: the first introduces the snippet, the second swaps the inline steps for `use:`. This makes bisect readable.
4. If multiple snippets need a shared precondition (e.g. "be on `/settings`"), put that precondition in a top-level login snippet — don't repeat it.

## Snippet vs. top-level spec

A snippet file is an action file: `version`, `name`, `steps`, and optionally `description`, `vars`, `inputs` and `imports`. It is validated strictly, so `intent` and `outcomes` are rejected in an action file (`unknown key(s) "intent", "outcomes"`). Only a top-level spec carries `intent` and `outcomes`. The directory structure (`snippets/actions/`) is a convention so consumers can grep for them; the runner doesn't care.

## Conditional steps

Snippets frequently need conditional behavior. The `when:` predicate makes a step opt-in:

```yaml
vars:
  FEATURE_BANNER: "${env.FEATURE_BANNER:-off}"
steps:
  - click: { by: role, role: button, name: "Dismiss banner" }
    when: { var: FEATURE_BANNER, equals: "on" }
```

`when.var` reads a `vars:` value (the spec's, the config's or a `--var` override), not the process environment. Reach the environment through `${env.X}` in `vars:`, as above.

Conditional steps are excellent snippet content because the snippet itself decides whether to run the step based on its vars, harness capability, or run-time configuration. The harness consuming the snippet does not need to know.

## Iteration

When a snippet changes, every spec that imports it changes behavior. Lint the specs that import it, then run them:

```bash
cairn spec lint specs/flows/checkout.yml
cairn run specs --cold-start --format json
```

`cairn spec verify --stamp` writes a contract hash into top-level specs only; it rejects action files.

Passing a directory (`cairn run specs/`) walks the spec tree recursively for `*.yml` in one shot, skipping `actions/` folders and `_`-prefixed names — there is no separate `--recursive` flag.

## Cookbook: building a snippet library

A reasonable starting library for a SaaS-ish app, under `specs/snippets/`:

- `actions/login.yml` — sign in flow.
- `actions/logout.yml` — sign out, defensively in case the test seeded a session.
- `actions/rotate-token.yml`, `actions/revoke-token.yml` — token lifecycle.
- `actions/seed-entity.yml`, `actions/delete-entity.yml` — entity lifecycle.
- `actions/conditional/dismiss-banner.yml`, `actions/conditional/dismiss-cookie-banner.yml` — first-paint nags.
- `actions/conditional/env-prod-skip.yml` — short-circuit when running against prod.

That set covers 80% of the import statements in the rest of the spec tree.

## See also

- [Authoring](/authoring) — what makes a contract survive across months
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies
- [Configuration](/configuration) — config keys
