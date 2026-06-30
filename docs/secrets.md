# Secrets

`cairn secrets` checks the [TinyVault](https://github.com/abdul-hamid-achik/tinyvault) secrets provider and lists the secret keys a project exposes. It is the diagnostic for the `secrets.provider: tvault` config block — it never prints secret *values*, only metadata, so it is safe in CI logs.

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
secrets:
  provider: tvault
tvault:
  project: my-app            # direct mode
  # OR inheritance mode:
  # group: payments
  # env: prod
```

When `secrets.provider: tvault` is set, the run path injects vault secrets into the seed command's env the first time it needs them. `cairn secrets` lets you verify the wiring and see *which* keys are available before a run depends on them.

## What it does not do

- It never prints secret values — only key names and counts. Values flow directly into the seed/run environment via `tvault run`, never through cairntrace's stdout or artifacts.
- It is not the path that injects secrets at run time; that is `runWithTvault` (`tvault run --project <name> -- <command>`), called by the services lifecycle when seeding. `cairn secrets` is the read-only status check.

## Availability

`tvault` must be on `$PATH`. `cairn doctor` flags it — a missing `tvault` means `secrets.provider: tvault` will be unavailable and the seed command runs without vault secrets (or fails, depending on whether the seed needs them).

## See also

- [Services](/services) — where `secrets.provider: tvault` is consumed (the seed step)
- [Configuration](/configuration) — the `secrets:` and `tvault:` config blocks
- [Doctor & clean](/doctor) — the `tvault` availability check