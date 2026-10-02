import {
  createDatasourceSession,
  ejsonToPlain,
  type MongoSourceDescriptor,
} from "../../datasources";
import type { MongoVerifier } from "../../schema/verifier.v1";
import { boundRows } from "./evidence";
import { matchPaths, matchValue, type MatchOutcome } from "./matchers";
import type { Attempt, PolledEvaluation } from "./poll";
import { resolveRefsDeep } from "./refs";
import type { VerifierContext, VerifierEvaluation } from "./types";

export type PollRunner = (attempt: Attempt) => Promise<PolledEvaluation>;

const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

/**
 * `mongo` verifier: one find (+ countDocuments) per attempt against a
 * configured datasource; the poll runner decides how often.
 */
export async function evaluateMongo(
  verifier: MongoVerifier,
  ctx: VerifierContext,
  run: PollRunner,
): Promise<VerifierEvaluation> {
  const spec = verifier.mongo;
  const query = resolveRefsDeep(
    {
      filter: spec.filter ?? {},
      ...(spec.projection ? { projection: spec.projection } : {}),
      ...(spec.sort ? { sort: spec.sort } : {}),
    },
    ctx,
  );
  // Matcher operands (`fields`, `count`) may splice runtime values too.
  const expectation = resolveRefsDeep(spec.expect, ctx);
  const judged: MongoVerifier["mongo"] =
    spec.expect !== undefined
      ? {
          ...spec,
          expect: expectation.value as NonNullable<
            MongoVerifier["mongo"]["expect"]
          >,
        }
      : spec;
  const request = {
    collection: spec.collection,
    ...(spec.database ? { database: spec.database } : {}),
    ...query.value,
    limit: spec.limit ?? 20,
  };
  if (query.missing.length > 0 || expectation.missing.length > 0) {
    return {
      passed: false,
      expected: `mongo ${spec.source}.${spec.collection} query with resolved references`,
      actual: `unresolved ${[...query.missing, ...expectation.missing].join(", ")}`,
      raw: { kind: "mongo", source: { name: spec.source }, request },
    };
  }

  const session = createDatasourceSession(ctx.datasources, {
    ...(ctx.childEnv ? { env: ctx.childEnv } : {}),
    ...(ctx.vars ? { vars: ctx.vars } : {}),
    ...(ctx.envName ? { envName: ctx.envName } : {}),
    ...(ctx.loadMongoDriver ? { loadMongoDriver: ctx.loadMongoDriver } : {}),
    // The optional `mongodb` driver lives in the user's project.
    ...(ctx.specDir ? { projectDirs: [ctx.specDir] } : {}),
  });
  let descriptor: MongoSourceDescriptor | undefined;
  let observed: { count: number; docs: unknown[] } | undefined;
  try {
    const polled = await run(async ({ deadline }) => {
      const source = await session.mongo(spec.source);
      descriptor = source.descriptor;
      const result = await source.find(
        {
          collection: spec.collection,
          ...(spec.database ? { database: spec.database } : {}),
          filter: query.value.filter,
          ...(query.value.projection
            ? { projection: query.value.projection }
            : {}),
          ...(query.value.sort ? { sort: query.value.sort } : {}),
          limit: spec.limit ?? 20,
          count: true,
        },
        {
          deadline: Math.min(
            deadline,
            Date.now() + (spec.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
          ),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      const docs = ejsonToPlain(result.docs) as unknown[];
      observed = { count: result.count ?? docs.length, docs };
      return judgeMongo(judged, observed);
    });
    if (spec.assign && observed) {
      ctx.captures ??= {};
      ctx.captures[spec.assign] = observed;
    }
    const bounded = observed ? boundRows(observed.docs) : undefined;
    return {
      ...polled,
      raw: {
        kind: "mongo",
        source: descriptor ?? { name: spec.source, kind: "mongo" },
        request,
        ...(observed && bounded
          ? {
              observed: {
                count: observed.count,
                docs: bounded.rows,
                truncated:
                  bounded.truncated || observed.count > bounded.rows.length,
              },
            }
          : {}),
        ...(polled.attemptLog ? { attempts: polled.attemptLog } : {}),
        ...(polled.polledMs !== undefined ? { polledMs: polled.polledMs } : {}),
      },
    };
  } finally {
    await session.close();
  }
}

function judgeMongo(
  spec: MongoVerifier["mongo"],
  observed: { count: number; docs: unknown[] },
): VerifierEvaluation {
  const where = `${spec.source}.${spec.collection}`;
  const expect = spec.expect ?? { exists: true };
  const checks: MatchOutcome[] = [];
  if (expect.exists !== undefined) {
    checks.push({
      passed: expect.exists ? observed.count >= 1 : observed.count === 0,
      expected: expect.exists
        ? `at least one matching document in ${where}`
        : `no matching document in ${where}`,
      actual: `count=${observed.count}`,
    });
  }
  if (expect.count !== undefined) {
    const result = matchValue(observed.count, true, expect.count, "count");
    checks.push({ ...result, actual: `count=${observed.count}` });
  }
  if (expect.fields !== undefined) {
    const first = observed.docs[0];
    if (first === undefined) {
      checks.push({
        passed: false,
        expected: `first document of ${where} with ${Object.keys(expect.fields).join(", ")}`,
        actual: "no document",
      });
    } else {
      const report = matchPaths(first, expect.fields);
      for (const result of report.results) {
        checks.push({
          passed: result.passed,
          expected: result.expected,
          actual: `${result.path}=${result.actual}`,
        });
      }
    }
  }
  const failing = checks.filter((check) => !check.passed);
  const actualParts = [
    `count=${observed.count}`,
    ...failing
      .map((check) => check.actual)
      .filter((part) => !part.startsWith("count=")),
  ];
  return {
    passed: failing.length === 0,
    expected: checks.map((check) => check.expected).join("; "),
    actual: actualParts.join("; "),
  };
}
