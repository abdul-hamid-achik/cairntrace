# Quickstart

Install Cairntrace, write your first browser spec, and run it.

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
bun install
./bin/cairn --help
```

Create `examples/specs/hello.yml`:

```yaml
intent: Visit the homepage and confirm the heading exists
outcomes:
  - id: heading-visible
    text: { contains: "Welcome" }
steps:
  - open: { path: "/" }
```

Then run it:

```bash
./bin/cairn run examples/specs/hello.yml --format md
```

You should see a successful outcome report and a run dir under `~/.cairntrace/runs/`.
