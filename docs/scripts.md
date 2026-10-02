---
title: Script Verifiers and the Verifier SDK
description: Write typed Node verifiers for Cairntrace outcomes with defineVerifier — schema-checked fixtures, polling with evidence, datasources, network lookups and workbook reads.
---

# Script verifiers and the verifier SDK

`script` is the escape hatch for checks the typed verifiers do not cover. A `runtime: node` script runs in its own Node process and returns a verdict; Cairntrace writes the evidence next to every other outcome (`outcomes/<id>.md` plus an `outcomes/<id>.raw.json` sidecar), streams its progress and keeps its output in `logs/outcome-<id>.log`.

Plain scripts (`export default async function verify(ctx)`) keep working. New node verifiers should use the **verifier SDK**: the fixtures contract lives in code, the context is typed, and polling, datasource access and failure evidence come built in.

## A typed verifier

```ts
// verifiers/order-shipped.ts
import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";

export default defineVerifier({
  description: "The order saved in the UI reaches shipped in the database",
  fixtures: z.object({
    orderId: z.string().describe("Order created by the spec"),
    owners: z.array(z.string()).default([]),
    within: z.number().default(30_000),
  }),
  async run(ctx) {
    const save = ctx.network.findOne({
      method: "PATCH",
      path: "/api/orders/" + ctx.fixtures.orderId,
    });
    const doc = await ctx.poll(
      () => ctx.datasources.app.findOne("orders", { orderId: ctx.fixtures.orderId }),
      {
        until: (d) => d?.status === "shipped",
        failWhen: (d) => d?.status === "cancelled" && "order was cancelled",
        within: ctx.fixtures.within,
        every: 2_000,
        describe: (d) => "status=" + (d?.status ?? "missing"),
        want: "shipped",
      },
    );
    return ctx.result.ok({ status: doc.status, saveStatus: save.status });
  },
});
```

The outcome that uses it:

```yaml
outcomes:
  - id: order_shipped
    description: The saved order is shipped
    verify:
      script:
        runtime: node
        file: ./verifiers/order-shipped.ts
        timeoutMs: 60000
        fixtures:
          orderId: ${requests.order.body.id}
          owners: [ops, billing]
```

The runner gives the child process its own copy of the SDK, so the import resolves with nothing installed next to the verifier and always matches the running `cairn` — in the verifier file or in a shared support module it imports (`import { make } from "./support/orders.ts"`). Add `@thelacanians/cairntrace` as a dev dependency only if you want editor types.

## Fixtures

`fixtures` is a [zod](https://zod.dev) schema built with the `z` the SDK re-exports (zod 3): a `z.object({ … })`, or an intersection of objects (`a.and(b)`). A zod 4 schema (`zod/v4`, or a project's own zod 4 imported as `zod`) is refused when the module loads, because the coercion and unknown-key checks below would silently switch off. Before `run(ctx)` starts, the spec's fixtures are parsed:

- defaults are applied and `ctx.fixtures` is typed from the schema;
- strings (YAML scalars and `${vars.X}` interpolations arrive as strings) are coerced to the declared `number`, `boolean` (`true`/`false`), `date` (ISO) or array/object (JSON text);
- an empty string for an optional non-string key counts as absent, so its default applies;
- **unknown keys are rejected** — a misspelled fixture is an error, not a silently ignored key. Use `.passthrough()` on the schema to accept extra keys.

A mismatch fails the outcome before `run` is called. The observed value lists every issue (`owners: Expected array, received string; unknown fixture key(s): ordrId`) and the raw sidecar holds them as data. The SDK's messages name keys and expected types, never the values passed (a message you write in `.refine()` is yours to keep clean).

Fixtures can be **structured**: a YAML list or map reaches the verifier as JSON with its nested types kept. Top-level scalars stay strings for plain scripts, which have always received strings.

```yaml
fixtures:
  owners: [ops, billing]
  expected: { status: shipped, lines: 2 }
  retries: 3          # "3" for a plain script; 3 for z.number()
```

## The context

| member | what it is |
|---|---|
| `ctx.fixtures` | parsed fixtures (typed, defaults applied) |
| `ctx.vars` | resolved config / CLI vars of the active environment |
| `ctx.run` | `{ id, token, startedAt, labels, failedStep, lastSuccessfulStep, dir }`: `token` is `${run.token}`, `labels` the run's `--label key=value` pairs |
| `ctx.network` | the run's captured requests: `entries`, `find(filter)`, `findOne(filter)`, `json(entry)` |
| `ctx.evals` / `ctx.requests` | values assigned by `eval` and `request` steps |
| `ctx.captures` / `ctx.runs` / `ctx.fixturesOutputs` | values recorded by `capture` steps (and verifier `assign`s), outputs of `run` steps, outputs of the spec's fixtures |
| `ctx.artifacts` | named artifacts (downloads, transforms) with their paths |
| `ctx.datasources` | the config `datasources:` of the environment, by name |
| `ctx.poll(fn, options)` | poll until a condition holds, with evidence on failure |
| `ctx.deadline` / `ctx.remainingMs()` | when `run` must be done (a margin before `script.timeoutMs`) |
| `ctx.signal` | aborted at the deadline and when the run is cancelled |
| `ctx.progress(message)` | a live progress line (`outcome.progress` event) |
| `ctx.xlsx(path)` | read a workbook: `sheets`, `sheet(name).rows`, `.cell("B2")`, `.records()` |
| `ctx.log(...)` | a line in the outcome log |
| `ctx.result.ok(details)` / `ctx.result.fail(message, details)` | the verdict |
| `ctx.fail(message, details)` | fail right now (throws) |

### Results

Return `ctx.result.ok(details)` or `ctx.result.fail(message, details)`; `ctx.fail(...)` throws the same failure from anywhere — inside a `ctx.poll` attempt too, where it ends the poll at once. The message becomes the outcome's observed line, so a reader of `outcomes/<id>.md` sees *why*, and `details` lands in `outcomes/<id>.raw.json`. Any other exception is reported as a crashed script with its stack.

### Network

`find` and `findOne` take `{ method, url, urlContains, path, status, resourceType, since, where }` or a predicate. `url` is a substring or a RegExp; `path` is the exact pathname; `status` is a number, a list, or `{ atLeast, below }`. `findOne` passes only on exactly one match — otherwise the outcome fails with the candidates as evidence, which catches both a missing request and a double submit. `json(entry)` parses the captured request body.

### Polling

```ts
const rows = await ctx.poll(() => ctx.datasources.app.find("events", { orderId }), {
  until: (r) => r.length === 1,
  within: 60_000,     // never past ctx.deadline
  every: 2_000,
  stableFor: 5_000,   // the condition must keep holding this long
  describe: (r) => "count=" + r.length,
  want: "1",
});
```

Each attempt writes a progress line (`poll attempt 3/31: count=0 (want 1)`) that Studio and `cairn logs --follow` show live. An attempt that throws an ordinary error (a refused connection, `d.status` on a document that is not there yet) counts as "not yet"; `retryOnError: false` makes it fatal. A deliberate failure is final: `ctx.fail()`, a `ctx.network.findOne()` miss or a nested poll's timeout inside an attempt ends the poll with that failure. `failWhen` ends the wait at once on a terminal state. On timeout the outcome fails with the last observation (bounded to 20 rows of at most 4KB each), the first 5 and last 15 attempts, and the time spent; the outcome events carry `attempts` and `polledMs`. Without `until`, a truthy value or a non-empty array passes.

Attempts are bounded too. An attempt still running when `within` runs out is abandoned — its `signal` (the `signal` in `fn({ attempt, signal })`) aborts and the poll fails with the last completed observation — but every attempt gets at least `every` or one second, whichever is longer, so the attempt at the very edge of `within` can still answer. The deadline and a cancel abandon an attempt the same way. Pass the attempt's `signal` to `fetch` and child processes so abandoned work stops. `every` is at least 50ms.

### Datasources

`ctx.datasources.<name>` calls the datasource the configuration defines for the run's environment:

| kind | methods |
|---|---|
| `mongo` | `find(collection, filter?, { projection, sort, limit, database })`, `findOne(...)`, `count(collection, filter?)`, `query(request)`, `write(request)`, `ping()` |
| `temporal` | `describe(workflowId, runId?)`, `list(query, { pageSize }?)`, `count(query)`, `history(workflowId, runId)` |
| `http` | `request({ path, method, headers, body })`, `get(path)`, `post(path, body)`, `put`, `patch`, `delete` |

The calls run inside the runner, reached over a loopback channel that exists only while the outcome is evaluated: the datasource's connection string and credentials stay in the runner, `mode: read-only` and `guard:` rules apply, and every call is logged (`[datasource] app.find ok 12ms (1 rows)`) in the outcome log. An `http` path is relative to the datasource's `baseUrl`; an absolute URL is refused unless it stays on that origin, so a link taken from an app response cannot carry the datasource's credentials to another host. Arguments and results are JSON; Mongo values use relaxed extended JSON (`{ "$oid": … }`, `{ "$date": … }`), and a `Date` argument is sent as `{ "$date": … }`.

The SDK types each kind (`MongoDatasource`, `TemporalDatasource`, `HttpDatasource`). Declare your environment's datasources once to get them by name — and to keep `ctx.datasources.app` defined under `noUncheckedIndexedAccess`:

```ts
import type { MongoDatasource, TemporalDatasource } from "@thelacanians/cairntrace/verifier";

declare module "@thelacanians/cairntrace/verifier" {
  interface Datasources {
    app: MongoDatasource;
    workflows: TemporalDatasource;
  }
}
```

Undeclared names still work, with every kind's methods and untyped results.

### Deadline and cancellation

`script.timeoutMs` is the hard budget: the child is killed when it runs out. The SDK sets `ctx.deadline` a little earlier and aborts `ctx.signal` there, so a poll turns its last observation into a failure with evidence instead of being killed silently. A `run(ctx)` that has not settled shortly after the deadline (stuck on a call that ignores the signal) fails with `run(ctx) was still running at the verifier deadline`. Once an SDK verifier has its result, the process exits, so abandoned work cannot hold it until the hard kill. When the run is cancelled, the verifier receives SIGTERM, `ctx.signal` aborts, and its whole process tree is killed one second later. Pass `ctx.signal` to `fetch` and child processes so they stop too.

## The fixtures contract

```bash
cairn verifier schema verifiers/order-shipped.ts --json
```

prints the contract — keys, types, required, defaults, `.describe()` text, enum values and whether unknown keys are rejected. It reads the file as text and never runs it. A schema built inline (`z.object({ … })`, through one `const`, `.extend`, `.partial`, `.pick`/`.omit`, `.strict`/`.passthrough`, `.and(z.object({ … }))`) is read completely (`mode: static`). A key whose own schema is imported or built by a helper (`within`, `tag: optionalTag()`) is listed without `required`: the reader does not guess. A schema imported from another module, or reshaped by a method it does not know (`.or(…)`), is reported `mode: dynamic` with what could be read.

`--load` imports the module in a Node child (killed after `--timeout-ms`, default 10000) and reads the schema `defineVerifier` attached to the export (`mode: loaded`). That runs the module's top-level code with your permissions: use it only on files you trust, never on unreviewed code in CI.

Plain scripts are read the way `cairn catalog` always read them: a `Fixtures:` block in the header comment, an exported `fixtures` object, or the keys the code reads (`mode: legacy`).

`cairn spec lint`, `cairn spec finish` (which lints) and `cairn catalog` use the same contract. With an SDK schema, an unknown fixture key or a missing required one is an **error** (the verifier would reject it at runtime); with a header comment they stay warnings. A key listed without `required` is never reported missing.

## Plain scripts

```ts
import { stat } from "node:fs/promises";

export default async function verify(ctx) {
  const file = await stat(ctx.fixtures.templatePath);
  return {
    ok: file.isFile(),
    evidence: { templatePath: ctx.fixtures.templatePath, size: file.size },
  };
}
```

A plain node script receives `ctx` with `fixtures` (scalars as strings, lists and maps as JSON), `artifacts`, `vars`, `runDir`, `specDir`, `run` (`failedStep`, `lastSuccessfulStep`, `id`, `token`, `startedAt`, `labels`), `evals`, `requests`, `captures`, `runs`, `fixturesOutputs`, `deadline` (epoch ms or `null`) and `progress(message)`, and returns `{ ok: boolean, evidence }`. Browser scripts (`runtime: browser`, the default) get `fixtures`, `artifacts`, `vars` and `run` as globals.

Node runs TypeScript verifiers with type stripping, so relative imports need their extension: `import { helper } from "./lib.ts"`.
