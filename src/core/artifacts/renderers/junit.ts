import type { RunResult } from "../../schema/run.v1";

export function renderJUnit(results: RunResult[]): string {
  const totals = results.reduce(
    (acc, r) => {
      const cases = testCasesForRun(r);
      acc.tests += cases.length;
      acc.failures += cases.filter((c) => c.status === "failed").length;
      acc.errors += cases.filter((c) => c.status === "errored").length;
      acc.skipped += cases.filter((c) => c.status === "skipped").length;
      acc.time += r.durationMs / 1000;
      return acc;
    },
    { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 },
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}" time="${seconds(totals.time)}">`,
    ...results.map(renderSuite),
    "</testsuites>",
    "",
  ].join("\n");
}

interface JUnitCase {
  name: string;
  status: "passed" | "failed" | "errored" | "skipped";
  message?: string;
}

function renderSuite(r: RunResult): string {
  const cases = testCasesForRun(r);
  const failures = cases.filter((c) => c.status === "failed").length;
  const errors = cases.filter((c) => c.status === "errored").length;
  const skipped = cases.filter((c) => c.status === "skipped").length;
  const lines = [
    `  <testsuite name="${xml(r.spec.name)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(r.durationMs / 1000)}">`,
    `    <properties><property name="runDir" value="${xml(r.runDir)}"/></properties>`,
  ];
  for (const c of cases) {
    lines.push(renderCase(r, c));
  }
  lines.push("  </testsuite>");
  return lines.join("\n");
}

function renderCase(r: RunResult, c: JUnitCase): string {
  const base = `    <testcase classname="${xml(r.spec.name)}" name="${xml(c.name)}" time="0"`;
  if (c.status === "passed") return `${base}/>`;
  const message = xml(c.message ?? c.status);
  if (c.status === "failed") {
    return `${base}><failure message="${message}">${message}</failure></testcase>`;
  }
  if (c.status === "errored") {
    return `${base}><error message="${message}">${message}</error></testcase>`;
  }
  return `${base}><skipped message="${message}"/></testcase>`;
}

function testCasesForRun(r: RunResult): JUnitCase[] {
  if (r.outcomes.length > 0) {
    return r.outcomes.map((o) => ({
      name: o.id,
      status: o.status === "passed" ? "passed" : o.status,
      ...(o.status !== "passed"
        ? { message: `${o.status}: ${o.evidence ?? "no evidence"}` }
        : {}),
    }));
  }
  const failedStep = r.steps.find((s) => s.status === "failed");
  return [
    {
      name: "run",
      status: r.status === "passed" ? "passed" : "errored",
      ...(r.status !== "passed"
        ? { message: failedStep?.error ?? `run ${r.status}` }
        : {}),
    },
  ];
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function seconds(value: number): string {
  return value.toFixed(3);
}
