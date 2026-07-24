# Secrets

`cairn secrets` checks the [TinyVault](https://github.com/abdul-hamid-achik/tinyvault) secrets provider and lists the secret keys a project exposes. It is the diagnostic for the `secrets.provider: tvault` config block — the command never prints secret *values*, only metadata.

## `cairn secrets`

```bash
cairn secrets --project my-app                      # direct mode
cairn secrets --group payments --env prod           # inheritance mode
cairn secrets --config ./cairntrace.config.yml
```

TinyVault supports two modes, mirrored from the config `tvault:` block:

- **Direct** — `--project <name>` reads keys from a single TinyVault project.
- **Inheritance** — `--group <name> --env <name>` resolves missing keys from the base environment via TinyVault's env-group feature.

`--group` requires `--env` and vice versa; using neither falls back to the `tvault:` block in `cairntrace.config.yml`.

## Config

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
secrets:
  provider: tvault
  required: [API_KEY]
  tvault:
    project: my-app          # direct mode
    # OR use inheritance mode instead:
    # group: payments
    # env: prod
```

When `secrets.provider: tvault` is set, `cairn run` resolves the selected vault
before parsing the spec, registers every returned value with the artifact
redactor, and injects missing keys into the run environment. The services
lifecycle also makes those values available to seed commands. Existing shell
environment variables take precedence. `cairn secrets` lets you verify the
wiring and see *which* keys are available before a run depends on them.

## What it does not do

- The status command never prints secret values — only key names and counts.
  Runtime resolution injects values into the seed/run environment and
  registers them with Cairntrace's text/JSON redactor.
- `cairn secrets` is only the read-only status check; secret injection happens
  inside `cairn run` and the services lifecycle.

The text/JSON redactor does not inspect producer-owned binary files. A
screenshot or video can show a secret rendered by the app; a download,
transform, or trace can retain sensitive bytes. Keep run directories private
and review binary captures before sharing or stashing them.

## Availability

`tvault` must be on `$PATH`. `cairn doctor` flags it. If a run selects
`secrets.provider: tvault` and the vault cannot be resolved, the run fails
before browser execution instead of continuing with missing secrets.

## See also

- [Services](/services) — where `secrets.provider: tvault` is consumed (the seed step)
- [Configuration](/configuration) — the `secrets:` and `tvault:` config blocks
- [Doctor & clean](/doctor) — the `tvault` availability check
