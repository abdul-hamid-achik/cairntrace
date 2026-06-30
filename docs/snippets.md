# Reusable snippets

The `imports:` block on a spec lets you split reusable parts across files and reference them by name. A snippet can be a single step, a sequence, or even an entire spec authored to be lifted into other specs.

## File layout

```text
specs/
├── checks/
│   ├── login-admin.yml
│   └── assert-login-page.yml
├── flows/
│   ├── checkout.yml
│   └── checkout-success.yml
├── snippets/
│   ├── actions/
│   │   ├── rotate-token.yml
│   │   └── create-entity.yml
│   └── conditional-steps/
│       ├── dismiss-banner.yml
│       └── env-conditional.yml
```

The directory structure is convention only — `cairn` walks the spec root recursively, finds every `*.yml` file, and indexes them by `name`. The `name` is the spec's first comment or its filename minus `.yml`.

## Imports block

```yaml
# specs/flows/checkout.yml
imports:
  - actions/login-admin        # refers to specs/snippets/actions/login-admin.yml
  - actions/rotate-token
  - conditional-steps/dismiss-banner

intent: Sign in, rotate an API token, and confirm the new token works.
outcomes:
  - id: token-rotated
    text: { contains: "Token rotated" }
steps:
  - use: login-admin            # uses the imported snippet
  - use: rotate-token
  - use: dismiss-banner
```

`use:` invokes the imported snippet by name within the spec's `steps:`. Snippets themselves can `import:` and `use:` other snippets — the import graph is a DAG, not a tree.

## What gets reused

The same logic that lives in one spec is the candidate for a snippet:

- **Login flows.** "Sign in as an admin" is reused everywhere a flow needs an authenticated session.
- **Token rotation, key rotation, secret reset.** Anything where the contract is "the system shows the success toast after I do the dance."
- **Conditional dismissals.** Banner dismissal, modal close, and feature-flag dismissals are the same shape in 30 specs. Make them snippets.
- **Form fills** with a fixed shape. "Fill name + email + submit" reused across several flows.

Do not lift things that are unique to one flow. The point of a snippet is to encode the contract across many flows, not to factor code.

## When you lift something to a snippet

1. The contract (`intent + outcomes`) should still read sensibly without steps.
2. The snippet's `intent` becomes "do the snippet's job" and `outcomes` becomes "snippet succeeded." The harness consuming the snippet measures success against its own outcomes, not the snippet's.
3. Refactor in two commits: the first introduces the snippet, the second swaps the inline steps for `use:`. This makes bisect readable.
4. If multiple snippets need a shared precondition (e.g. "be on `/settings`"), put that precondition in a top-level login snippet — don't repeat it.

## Snippet vs. action file

In early adoption, the term *action file* and *snippet* are interchangeable. There is no separate "action file" syntax — a snippet file is just a spec YAML with `intent + outcomes + steps`. The directory structure (`snippets/actions/`) is a convention so consumers can grep for them; the runner doesn't care.

## Conditional steps

Snippets frequently need conditional behavior. The `when:` predicate makes a step opt-in:

```yaml
- when: { env: FEATURE_BANNER, equals: "on" }
- click: { by: { role: button, name: "Dismiss banner" } }
```

Conditional steps are excellent snippet content because the snippet itself decides whether to run the step based on environment, harness capability, or run-time configuration. The harness consuming the snippet does not need to know.

## Iteration

When a snippet's contract changes — that's rare but it happens — the contract hash changes. Re-stamp:

```bash
cairn spec verify specs/snippets/actions/rotate-token.yml --stamp
```

Then run all specs that import that snippet to confirm the contract hash drift didn't break any consumer:

```bash
cairn run specs --cold-start --format json
```

Passing a directory (`cairn run specs/`) walks the spec tree recursively for `*.yml` in one shot — there is no separate `--recursive` flag.

## Cookbook: building a snippet library

A reasonable starting library for a SaaS-ish app:

- `actions/login.yml` — sign in flow.
- `actions/logout.yml` — sign out, defensively in case the test seeded a session.
- `actions/rotate-token.yml`, `actions/revoke-token.yml` — token lifecycle.
- `actions/seed-entity.yml`, `actions/delete-entity.yml` — entity lifecycle.
- `conditional/dismiss-banner.yml`, `conditional/dismiss-cookie-banner.yml` — first-paint nags.
- `conditional/env-prod-skip.yml` — short-circuit when running against prod.

That set covers 80% of the import statements in the rest of the spec tree.

## See also

- [Authoring](/authoring) — what makes a contract survive across months
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies
- [Configuration](/configuration) — config keys, including snippet resolution paths
