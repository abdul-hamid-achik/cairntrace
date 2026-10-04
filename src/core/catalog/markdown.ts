import { CATALOG_KINDS, type CatalogResult } from "./catalog.v1";

const SUMMARY_ROWS = 5;

/**
 * A few lines for MCP `content`: rows per kind (shown of total), the first
 * row names of each kind, and how to narrow. The rows themselves travel in
 * `structuredContent`.
 */
export function renderCatalogSummary(c: CatalogResult): string {
  const head = [
    `Catalog${c.project ? ` ${c.project}` : ""} (${c.root})`,
    c.env ? `env ${c.env}` : "",
    c.query ? `query "${c.query}"` : "",
  ].filter(Boolean);
  const lines = [head.join(", ")];
  for (const kind of CATALOG_KINDS) {
    const rows = c[kind];
    if (!rows) continue;
    const total = c.totals[kind] ?? rows.length;
    const names = rows.slice(0, SUMMARY_ROWS).map((row) => {
      const r = row as { name?: string; file?: string; env?: string };
      const label = r.name ?? r.file ?? "?";
      return kind === "vars" && r.env ? `${label} [${r.env}]` : label;
    });
    lines.push(
      `${kind} ${rows.length}${total > rows.length ? ` of ${total}` : ""}${
        names.length > 0
          ? `: ${names.join(", ")}${rows.length > names.length ? ", …" : ""}`
          : ""
      }`,
    );
  }
  if (c.scan.otherCheckpoints) {
    lines.push(
      `${c.scan.otherCheckpoints} other checkpoint(s) in the store are not this project's (cairn checkpoint list)`,
    );
  }
  if (c.warnings.length > 0) lines.push(`warnings: ${c.warnings.length}`);
  const cut = CATALOG_KINDS.some(
    (k) => (c.totals[k] ?? 0) > (c[k]?.length ?? 0),
  );
  lines.push(
    `Rows are in structuredContent (urn:cairntrace.dev:catalog:v1).${
      cut
        ? " Some kinds were cut at the limit: pass query (the task's keywords) and/or kind to narrow, or a larger limit."
        : ""
    }`,
  );
  return lines.join("\n");
}

/** Markdown rendering of a catalog (`cairn catalog --format md`). */
export function renderCatalogMarkdown(c: CatalogResult): string {
  const lines: string[] = [
    `# Catalog${c.project ? `: ${c.project}` : ""}`,
    "",
    `- Root: \`${c.root}\``,
    ...(c.configPath
      ? [`- Config: \`${c.configPath}\``]
      : ["- Config: (none)"]),
    ...(c.env ? [`- Environment: ${c.env}`] : []),
    ...(c.query ? [`- Query: "${c.query}"`] : []),
    `- Scanned: ${c.scan.files} YAML file(s), ${c.scan.specs} spec(s), ${c.scan.actions} action(s), ${c.scan.runs} run(s)`,
    "",
  ];
  const heading = (
    title: string,
    kind: keyof CatalogResult["totals"],
    shown: number,
  ): void => {
    const total = c.totals[kind] ?? shown;
    lines.push(
      `## ${title} (${shown}${total > shown ? ` of ${total}` : ""})`,
      "",
    );
    if (shown === 0) lines.push(c.query ? "(no match)" : "(none)");
  };

  if (c.actions) {
    heading("Actions", "actions", c.actions.length);
    for (const a of c.actions) {
      lines.push(
        `- **${a.name}** — \`${a.file}\`, ${a.steps} step(s)${why(a)}`,
      );
      if (a.description) lines.push(`  ${oneLine(a.description)}`);
      if (a.inputs.length > 0) {
        lines.push(
          `  inputs: ${a.inputs
            .map(
              (i) =>
                `${i.name}${i.required ? "*" : ""}${
                  i.default !== undefined ? `=${String(i.default)}` : ""
                }`,
            )
            .join(", ")}`,
        );
      }
      if (a.usedBy.length > 0)
        lines.push(`  used by: ${a.usedBy.map((u) => u.name).join(", ")}`);
      if (a.lastGreenRun) {
        lines.push(
          `  last green: ${a.lastGreenRun.runId} (${a.lastGreenRun.spec}${
            a.lastGreenRun.matchedBy === "name" ? ", matched by name" : ""
          })`,
        );
      }
      for (const p of a.problems ?? []) lines.push(`  problem: ${p}`);
    }
    lines.push("");
  }
  if (c.vars) {
    heading("Vars", "vars", c.vars.length);
    for (const v of c.vars) {
      const value = v.value === undefined ? "" : ` = \`${String(v.value)}\``;
      const from = v.inheritedFrom
        ? ` (from ${v.inheritedFrom})`
        : v.definedIn === "top-level"
          ? ` (top-level${v.file ? `, ${v.file}` : ""})`
          : "";
      lines.push(`- **${v.name}** [${v.env}]${value}${from}${why(v)}`);
      if (v.comment) lines.push(`  ${oneLine(v.comment)}`);
      if (v.usedBy.length > 0)
        lines.push(`  used by: ${v.usedBy.map((u) => u.name).join(", ")}`);
    }
    lines.push("");
  }
  if (c.verifiers) {
    heading("Verifiers", "verifiers", c.verifiers.length);
    for (const v of c.verifiers) {
      lines.push(`- **${v.file}**${v.exists ? "" : " (missing)"}${why(v)}`);
      if (v.description) lines.push(`  ${oneLine(v.description)}`);
      if (v.fixtures.keys.length > 0) {
        lines.push(
          `  fixtures (${v.fixtures.source}${
            v.fixtures.dynamic ? ", dynamic" : ""
          }): ${v.fixtures.keys
            .map(
              (k) =>
                `${k.name}${k.required ? "*" : ""}${
                  k.type ? `: ${k.type}` : ""
                }`,
            )
            .join(", ")}`,
        );
      }
      for (const u of v.usedBy) {
        const flags = [
          u.unknownKeys?.length ? `unknown: ${u.unknownKeys.join(", ")}` : "",
          u.missingKeys?.length ? `missing: ${u.missingKeys.join(", ")}` : "",
        ].filter(Boolean);
        lines.push(
          `  used by ${u.spec} (${u.outcome})${
            flags.length > 0 ? ` — ${flags.join("; ")}` : ""
          }`,
        );
      }
    }
    lines.push("");
  }
  if (c.envs) {
    heading("Environments", "envs", c.envs.length);
    for (const e of c.envs) {
      const policy = e.policy
        ? ` — ${[e.policy.trait, e.policy.mutations ? `mutations ${e.policy.mutations}` : ""].filter(Boolean).join(", ")}`
        : "";
      lines.push(
        `- **${e.name}**${e.default ? " (default)" : ""}${
          e.baseUrl ? ` ${e.baseUrl}` : ""
        }${policy}${why(e)}`,
      );
      if (e.policy?.description)
        lines.push(`  ${oneLine(e.policy.description)}`);
      lines.push(
        `  services: ${
          e.services.enabled ? e.services.phases.join(", ") || "on" : "off"
        }; secrets: ${e.secrets?.provider ?? "none"}; vars: ${e.vars}`,
      );
    }
    lines.push("");
  }
  if (c.flows) {
    heading("Flows", "flows", c.flows.length);
    for (const f of c.flows) {
      const last = f.lastRun
        ? ` — last ${f.lastRun.status}${
            f.lastRun.durationMs !== undefined
              ? ` in ${f.lastRun.durationMs}ms`
              : ""
          }${f.lastRun.matchedBy === "name" ? " (matched by name)" : ""}`
        : "";
      lines.push(
        `- **${f.name}** — \`${f.file}\`${
          f.draft ? " (draft)" : ""
        }${last}${why(f)}`,
      );
      lines.push(`  ${oneLine(f.intent)}`);
      if (f.tags?.length) lines.push(`  tags: ${f.tags.join(", ")}`);
      if (f.actions?.length) lines.push(`  uses: ${f.actions.join(", ")}`);
    }
    lines.push("");
  }
  if (c.checkpoints) {
    heading("Checkpoints", "checkpoints", c.checkpoints.length);
    for (const k of c.checkpoints) {
      const scope = k.scope
        ? ` — ${[k.scope.env, k.scope.baseUrl, k.scope.expiresAt ? `expires ${k.scope.expiresAt}` : ""].filter(Boolean).join(", ")}`
        : "";
      lines.push(`- **${k.name}** — ${k.health}${scope}${why(k)}`);
      if (k.problem) lines.push(`  ${k.problem.message}`);
      if (k.usedBy.length > 0)
        lines.push(`  used by: ${k.usedBy.map((u) => u.name).join(", ")}`);
    }
    if (c.scan.otherCheckpoints) {
      lines.push(
        "",
        `${c.scan.otherCheckpoints} other checkpoint(s) in the store are not this project's (\`cairn checkpoint list\` shows them).`,
      );
    }
    lines.push("");
  }
  if (c.fixtures) {
    heading("Fixtures", "fixtures", c.fixtures.length);
    for (const f of c.fixtures) {
      lines.push(
        `- **${f.name}** — ${f.kind}, ${f.scope}${
          f.datasource ? ` (${f.datasource})` : ""
        }: ${f.verbs.join(", ")}${why(f)}`,
      );
      if (f.description) lines.push(`  ${oneLine(f.description)}`);
      if (f.needs.length > 0) lines.push(`  needs: ${f.needs.join(", ")}`);
      if (f.outputs.length > 0)
        lines.push(`  outputs: ${f.outputs.join(", ")}`);
      if (f.usedBy.length > 0)
        lines.push(`  used by: ${f.usedBy.map((u) => u.name).join(", ")}`);
    }
    lines.push("");
  }
  if (c.suites) {
    heading("Suites", "suites", c.suites.length);
    for (const suite of c.suites) {
      const knobs = [
        suite.parallel !== undefined ? `parallel ${suite.parallel}` : "",
        suite.bail ? "bail" : "",
        suite.tags ? `tags ${suite.tags.join("+")}` : "",
        suite.requires?.env ? `env ${suite.requires.env.join("|")}` : "",
      ].filter(Boolean);
      lines.push(
        `- **${suite.name}**${
          knobs.length > 0 ? ` — ${knobs.join(", ")}` : ""
        }${why(suite)}`,
      );
      if (suite.description) lines.push(`  ${oneLine(suite.description)}`);
      for (const e of suite.envs) {
        lines.push(
          e.problem
            ? `  ${e.env}: ${oneLine(e.problem)}`
            : `  ${e.env}: ${e.specs.length} spec(s)${
                e.before + e.after > 0
                  ? ` (hooks: ${e.before} before, ${e.after} after)`
                  : ""
              }: ${e.specs.join(", ")}`,
        );
      }
    }
    lines.push("");
  }
  if (c.warnings.length > 0) {
    lines.push("## Warnings", "", ...c.warnings.map((w) => `- ${w}`), "");
  }
  return lines.join("\n").trimEnd();
}

/** Why a row matched the query: ` _(score 9: edit→name, …)_`. */
function why(row: {
  score?: number;
  matched?: Array<{ token: string; field: string }>;
}): string {
  if (row.score === undefined) return "";
  const hits = (row.matched ?? []).map((m) => `${m.token}→${m.field}`);
  return ` _(score ${row.score}: ${hits.join(", ")})_`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}
