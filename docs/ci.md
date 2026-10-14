---
title: "Run Cairntrace in CI"
description: Run Cairntrace behavioral specs in GitHub Actions or GitLab CI with Bun, Playwright Chromium, a JUnit report, run artifacts and exit-code gating.
---

# Run Cairntrace in CI

Cairntrace runs in CI the same way it runs locally: `cairn run` executes the specs against a real browser, writes a run directory per spec, and exits with a code your job can branch on. This page gives a working recipe for GitHub Actions and GitLab CI.

## Prerequisites

- **Bun** on the runner. The `cairn` binary is a Bun shebang launcher, so Bun must be on `PATH` even when you install the package with npm.
- **Chromium** for Playwright. Install it on the runner with `bunx playwright install --with-deps chromium` (`--with-deps` also installs the system libraries a fresh runner lacks; locally, [Quickstart](/quickstart) uses `bunx playwright install chromium`).
- **The package**, `@thelacanians/cairntrace`, installed globally (`npm install -g @thelacanians/cairntrace`, or `bun add -g @thelacanians/cairntrace`). See [Install](/distribution).
- **A config and specs** in the repo: a `cairntrace.config.yml` with an `environments:` block, and the `.yml` specs it runs. A `suites:` entry is optional but useful for CI (see [Tips](#tips)).
- **The app under test** started by the job, or by a `webServer` / `services` entry in the config. See [Services](/services).

Cairntrace reads `CI` from the environment. When `CI` is set to a truthy value (GitHub Actions and GitLab CI both set it), `--cold-start` is on by default, and Playwright Chromium launches with `--no-sandbox` and `--disable-dev-shm-usage`. Set `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` only to replace those flags.

## GitHub Actions

Save as `.github/workflows/cairntrace.yml`. The steps follow this repository's own `ci.yml`: `oven-sh/setup-bun` with Bun 1.4.2, then the Chromium install, then the run. Pin actions to commit SHAs if your policy requires it.

```yaml
name: Browser specs

on:
  push:
    branches: [main]
  pull_request:

jobs:
  cairntrace:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2

      - name: Install Cairntrace
        run: npm install -g @thelacanians/cairntrace

      - name: Install Playwright Chromium
        run: bunx playwright install --with-deps chromium

      # Start the app under test here (or declare it under webServer:/services:
      # in cairntrace.config.yml so cairn starts and stops it for you).
      # - run: bun install && bun run start &

      - name: Run specs
        run: |
          cairn run --suite smoke --cold-start --backend playwright \
            --artifact-root cairn-artifacts --junit cairn-junit.xml

      - name: Upload Cairntrace artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: cairntrace-artifacts
          path: cairn-artifacts/
          if-no-files-found: ignore
```

What each flag does:

| Flag | Effect |
| ---- | ------ |
| `--suite smoke` | Runs the config `suites:` entry `smoke` instead of listing spec paths. Replace `smoke` with your suite name. |
| `--cold-start` | Forces a fresh browser profile. On by default when `CI` is set; kept explicit here. |
| `--backend playwright` | Uses the Playwright backend (native traces, video, HAR). The default backend is `agent-browser`. |
| `--artifact-root <path>` | Writes run directories under `<path>`. The default is `~/.cairntrace/runs`, which is outside the workspace, so the upload step needs an explicit path. |
| `--junit <file>` | Writes a JUnit XML report to `<file>`. |

The job's exit code is the `cairn run` exit code. The upload step runs with `if: always()`, so artifacts are kept when specs fail. `if-no-files-found: ignore` keeps the upload from failing when the run stopped before it wrote `cairn-artifacts/`. A JUnit test reporter is optional: any action or viewer that reads `cairn-junit.xml` can run in a later step.

## GitLab CI

Save as `.gitlab-ci.yml`. It uses the Node image, installs Bun and the package, and keeps the same run flags.

```yaml
cairntrace:
  image: node:22
  timeout: 30 minutes
  before_script:
    - npm install -g bun@1.4.2 @thelacanians/cairntrace
    - bunx playwright install --with-deps chromium
  # Start the app under test here, or declare it in cairntrace.config.yml.
  script:
    - cairn run --suite smoke --cold-start --backend playwright --artifact-root cairn-artifacts --junit cairn-junit.xml
  artifacts:
    when: always
    paths:
      - cairn-artifacts/
    reports:
      junit: cairn-junit.xml
```

GitLab reads `reports: junit:` directly, so no separate reporter is needed. If the file is missing (the run failed before writing it), GitLab reports no tests for the job.

## Exit codes

`cairn run` exits with a stable code. The common ones for a CI gate:

| Code | Meaning in CI |
| ---- | ------------- |
| 0 | All specs passed. |
| 1 | An outcome failed (a spec ran and its assertions did not hold). |
| 2 | Errored, or a command-line usage error. |
| 3 | Cold-start gate failed. |
| 4 | Config or lint error, or the run was refused by the run policy. |
| 8 | A critical teardown failed. This outranks the other codes. |
| 9 | Dirty state after the run (`run.verifyClean` found a survivor). |

The full table, including the export and import codes, is on [Exit codes](/exit-codes). Your job fails on any non-zero code by default; branch on specific codes only if a step needs different handling.

## Tips

- **Suites.** Define the CI set once in `suites:` (`specs`, `tags`, `bail`, `vars`, and per-environment overrides under `env.<name>`) and run `cairn run --suite <name>` in the job. Check what a suite resolves to with `cairn suites list`. See [Configuration](/configuration) and [Services: suites](/services#suites-cairn-run-suite).
- **Bail early.** `--bail` stops scheduling the remaining specs after the first failure and reports them as skipped. `--no-bail` overrides a suite's `bail: true`. Use `--bail` on pull requests for faster feedback, and leave the full run on `main`.
- **Services.** Let Cairntrace start Docker, seed data and dev servers around the run with the config `services:` block, instead of shell steps. `--no-services` and `--no-web-server` skip those lifecycles when the job manages them itself. See [Services](/services).
- **Secrets.** Pass credentials as environment variables from your CI secret store (masked secrets in GitHub Actions or GitLab CI variables), and reference them from the config rather than committing values. If you use TinyVault, see [Secrets](/secrets).
- **Logs.** Use `--progress plain` when the output is piped, so the job log stays readable. `cairn logs latest --artifact-root cairn-artifacts` replays a run's files of record.
- **Environment.** Pick the environment with `--env <name>` if the suite spans several (`cairn run --suite smoke --env ci`).
- **Headed runs.** Do not use `--headed` on CI runners; they have no display.

## See also

- [Commands](/commands): every `cairn` subcommand and flag.
- [Exit codes](/exit-codes): the full code table.
- [Configuration](/configuration): `environments:`, `suites:` and artifact roots.
- [Services](/services): docker, seed, dev servers and run policy.
- [Secrets](/secrets): secrets providers and config references.
