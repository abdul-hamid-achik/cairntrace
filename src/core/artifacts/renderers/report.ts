import type {
  ReportColorOverrides,
  ReportConfig,
  ReportThemeName,
} from "../../schema/config.v1";
import type {
  OutcomeResult,
  RunArtifacts,
  RunResult,
  StepResult,
} from "../../schema/run.v1";
import { renderJson } from "./json";

export interface ReportThemeTokens {
  background: string;
  surface: string;
  surfaceAlt: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  accentText: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  codeBg: string;
}

export interface ReportThemeDefinition {
  name: ReportThemeName;
  label: string;
  colors: ReportThemeTokens;
}

export interface ReportBuildOptions {
  config?: ReportConfig;
  generatedAt?: string;
}

export interface ReportStatusCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export type ReportStepCounts = ReportStatusCounts;

export interface ReportArtifactLink {
  label: string;
  path: string;
  kind: string;
}

export interface ReportModel {
  $schema: "urn:cairntrace.dev:report:v1";
  version: "1";
  generatedAt: string;
  run: {
    runId: string;
    runDir: string;
    specName: string;
    specPath: string;
    environment: string;
    backend: string;
    coldStart: boolean;
    status: RunResult["status"];
    startedAt: string;
    endedAt: string;
    durationMs: number;
    durationLabel: string;
    exitCode: RunResult["exitCode"];
  };
  summary: {
    outcomes: ReportStatusCounts;
    steps: ReportStepCounts;
  };
  outcomes: OutcomeResult[];
  steps: StepResult[];
  artifacts: RunArtifacts;
  artifactLinks: ReportArtifactLink[];
  theme: {
    selected: ReportThemeName;
    label: string;
    tokens: ReportThemeTokens;
    overrides: ReportColorOverrides;
    available: Record<ReportThemeName, ReportThemeDefinition>;
  };
  reproduce: string;
}

export const REPORT_THEMES: Record<ReportThemeName, ReportThemeDefinition> = {
  cairn: {
    name: "cairn",
    label: "Cairn",
    colors: {
      background: "#e7f0ec",
      surface: "#fbfdf9",
      surfaceAlt: "#edf7f4",
      ink: "#10201f",
      muted: "#5d6c70",
      line: "#bfd4ce",
      accent: "#0f766e",
      accentText: "#ecfeff",
      success: "#16823a",
      warning: "#a45f12",
      danger: "#b42318",
      info: "#4f46e5",
      codeBg: "#dfeae6",
    },
  },
  graphite: {
    name: "graphite",
    label: "Graphite",
    colors: {
      background: "#1d2224",
      surface: "#f3f5f2",
      surfaceAlt: "#e4ebe7",
      ink: "#161c1f",
      muted: "#59666b",
      line: "#bac7c2",
      accent: "#256f7d",
      accentText: "#f7fcfd",
      success: "#217a4a",
      warning: "#b7791f",
      danger: "#b83d36",
      info: "#5964d8",
      codeBg: "#dce4df",
    },
  },
  midnight: {
    name: "midnight",
    label: "Midnight",
    colors: {
      background: "#17151f",
      surface: "#252331",
      surfaceAlt: "#302d3f",
      ink: "#f2f4f8",
      muted: "#b9c2cf",
      line: "#4a435d",
      accent: "#43b8a7",
      accentText: "#071412",
      success: "#55c97b",
      warning: "#e0a33a",
      danger: "#ff6b5f",
      info: "#a49bff",
      codeBg: "#14131b",
    },
  },
  contrast: {
    name: "contrast",
    label: "Contrast",
    colors: {
      background: "#000000",
      surface: "#ffffff",
      surfaceAlt: "#f1f1f1",
      ink: "#000000",
      muted: "#343434",
      line: "#000000",
      accent: "#005fcc",
      accentText: "#ffffff",
      success: "#007a2f",
      warning: "#8a4b00",
      danger: "#c60000",
      info: "#3b2fc9",
      codeBg: "#eeeeee",
    },
  },
};

export function buildReportModel(
  result: RunResult,
  opts: ReportBuildOptions = {},
): ReportModel {
  const selected = opts.config?.theme ?? "cairn";
  const baseTheme = REPORT_THEMES[selected];
  const overrides = sanitizeColorOverrides(opts.config?.colors ?? {});
  const tokens = { ...baseTheme.colors, ...overrides };

  return {
    $schema: "urn:cairntrace.dev:report:v1",
    version: "1",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    run: {
      runId: result.runId,
      runDir: result.runDir,
      specName: result.spec.name,
      specPath: result.spec.path,
      environment: result.environment,
      backend: result.backend,
      coldStart: result.coldStart,
      status: result.status,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      durationMs: result.durationMs,
      durationLabel: formatDuration(result.durationMs),
      exitCode: result.exitCode,
    },
    summary: {
      outcomes: countStatuses(result.outcomes),
      steps: countStatuses(result.steps),
    },
    outcomes: result.outcomes,
    steps: result.steps,
    artifacts: result.artifacts,
    artifactLinks: buildArtifactLinks(result),
    theme: {
      selected,
      label: baseTheme.label,
      tokens,
      overrides,
      available: REPORT_THEMES,
    },
    reproduce: `cairn run ${result.spec.path} --env ${result.environment}`,
  };
}

export function renderReportJson(model: ReportModel): string {
  return renderJson(model);
}

export function renderReportHtml(model: ReportModel): string {
  const outcomeTotals = model.summary.outcomes;
  const stepTotals = model.summary.steps;
  const title = `Cairntrace Report - ${model.run.specName}`;
  const outcomeRows =
    model.outcomes.length > 0
      ? model.outcomes.map(renderOutcomeRow).join("\n")
      : `<tr><td colspan="4" class="empty">No outcomes recorded.</td></tr>`;
  const stepRows =
    model.steps.length > 0
      ? model.steps.map(renderStepRow).join("\n")
      : `<tr><td colspan="5" class="empty">No steps recorded.</td></tr>`;
  const artifactItems =
    model.artifactLinks.length > 0
      ? model.artifactLinks.map(renderArtifactItem).join("\n")
      : `<li class="empty">No artifact links recorded.</li>`;

  return `<!doctype html>
<html lang="en" data-theme="${escapeAttr(model.theme.selected)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
${renderThemeCss(model)}
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 24%, transparent), transparent 36rem),
        linear-gradient(135deg, var(--background), color-mix(in srgb, var(--surface-alt) 64%, var(--background)));
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    a { color: var(--accent); }
    .shell { max-width: 1120px; margin: 0 auto; padding: 28px; }
    .toolbar {
      align-items: center;
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-bottom: 18px;
    }
    .toolbar label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    select,
    button {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--ink);
      font: inherit;
      min-height: 36px;
      padding: 7px 10px;
    }
    button {
      background: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 78%, #000);
      color: var(--accent-text);
      cursor: pointer;
      font-weight: 700;
    }
    .hero {
      background: linear-gradient(135deg, var(--surface), var(--surface-alt));
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 20px 50px color-mix(in srgb, var(--ink) 14%, transparent);
      overflow: hidden;
      padding: 30px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.14em;
      margin: 0 0 8px;
      text-transform: uppercase;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 4.4rem);
      line-height: 0.95;
      margin: 0;
      max-width: 900px;
    }
    .meta-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-top: 24px;
    }
    .meta {
      background: color-mix(in srgb, var(--surface) 72%, transparent);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .meta span,
    .stat span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .meta strong,
    .stat strong {
      display: block;
      font-size: 18px;
      margin-top: 5px;
      overflow-wrap: anywhere;
    }
    .section { margin-top: 26px; }
    .section-head {
      align-items: end;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    h2 { font-size: 24px; margin: 0; }
    .section-head p {
      color: var(--muted);
      margin: 0;
      max-width: 650px;
    }
    .summary-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .stat,
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 8%, transparent);
    }
    .stat { padding: 16px; }
    .status {
      border-radius: 999px;
      display: inline-flex;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      padding: 5px 9px;
      text-transform: uppercase;
    }
    .status-passed { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
    .status-failed,
    .status-errored { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
    .status-skipped { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
    .bar {
      background: var(--surface-alt);
      border: 1px solid var(--line);
      border-radius: 999px;
      display: flex;
      height: 18px;
      overflow: hidden;
    }
    .bar span { min-width: 0; }
    .bar .passed { background: var(--success); }
    .bar .failed { background: var(--danger); }
    .bar .skipped { background: var(--warning); }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    .panel { overflow: hidden; }
    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--surface-alt);
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    code {
      background: var(--code-bg);
      border-radius: 6px;
      color: var(--ink);
      padding: 2px 5px;
    }
    .path,
    .error {
      max-width: 420px;
      overflow-wrap: anywhere;
    }
    .error { color: var(--danger); }
    .artifact-list {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .artifact-list li {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .artifact-list span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 4px;
      text-transform: uppercase;
    }
    .empty { color: var(--muted); font-style: italic; }
    .reproduce {
      background: var(--code-bg);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow-x: auto;
      padding: 14px;
      white-space: pre;
    }
    @media (max-width: 850px) {
      .shell { padding: 16px; }
      .toolbar,
      .section-head { align-items: stretch; flex-direction: column; }
      .meta-grid,
      .summary-grid,
      .artifact-list { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
    @media print {
      body {
        background: #fff;
        color: #111;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }
      .shell { max-width: none; padding: 0; }
      .toolbar { display: none; }
      .hero,
      .panel,
      .stat,
      .artifact-list li {
        box-shadow: none;
        break-inside: avoid;
      }
      a { color: inherit; text-decoration: none; }
      .section { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="toolbar" aria-label="Report tools">
      <label for="theme-select">Theme</label>
      <select id="theme-select" aria-label="Theme">
${renderThemeOptions(model.theme.selected)}
      </select>
      <button type="button" id="print-report">Print / Save PDF</button>
    </div>

    <header class="hero">
      <p class="eyebrow">Cairntrace Report</p>
      <h1>${escapeHtml(model.run.specName)}</h1>
      <div class="meta-grid">
        ${renderMeta("Status", statusBadge(model.run.status))}
        ${renderMeta("Run ID", `<code>${escapeHtml(model.run.runId)}</code>`)}
        ${renderMeta("Environment", escapeHtml(model.run.environment))}
        ${renderMeta("Duration", escapeHtml(model.run.durationLabel))}
      </div>
    </header>

    <section class="section">
      <div class="section-head">
        <h2>Summary</h2>
        <p>Outcome and step totals are generated from the same redacted run result used by <code>run.json</code>.</p>
      </div>
      <div class="summary-grid">
        ${renderStat("Outcomes Passed", outcomeTotals.passed, outcomeTotals.total)}
        ${renderStat("Outcomes Failed", outcomeTotals.failed, outcomeTotals.total)}
        ${renderStat("Steps Passed", stepTotals.passed, stepTotals.total)}
        ${renderStat("Steps Failed", stepTotals.failed, stepTotals.total)}
      </div>
      <div class="section panel" aria-label="Outcome status distribution">
        <div class="bar" role="img" aria-label="${escapeAttr(statusSummary(outcomeTotals))}">
          ${renderBarSegment("passed", outcomeTotals.passed, outcomeTotals.total)}
          ${renderBarSegment("failed", outcomeTotals.failed, outcomeTotals.total)}
          ${renderBarSegment("skipped", outcomeTotals.skipped, outcomeTotals.total)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Outcomes</h2>
        <p>Evidence links point to the markdown and raw sidecar files in this run directory.</p>
      </div>
      <div class="panel">
        <table>
          <thead><tr><th>ID</th><th>Status</th><th>Evidence</th><th>Raw</th></tr></thead>
          <tbody>
${outcomeRows}
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Steps</h2>
        <p>Step artifacts include screenshots, snapshots, downloads, transforms, diagnostics, and resolved semantic locators when present.</p>
      </div>
      <div class="panel">
        <table>
          <thead><tr><th>ID</th><th>Status</th><th>Duration</th><th>Resolved</th><th>Error</th></tr></thead>
          <tbody>
${stepRows}
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Artifacts</h2>
        <p>These links are relative to <code>${escapeHtml(model.run.runDir)}</code>.</p>
      </div>
      <ul class="artifact-list">
${artifactItems}
      </ul>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Reproduce</h2>
      </div>
      <pre class="reproduce"><code>${escapeHtml(model.reproduce)}</code></pre>
    </section>
  </main>
  <script>
    const themeSelect = document.getElementById("theme-select");
    const printButton = document.getElementById("print-report");
    themeSelect?.addEventListener("change", (event) => {
      const value = event.target.value;
      document.documentElement.dataset.theme = value;
      try { localStorage.setItem("cairntrace.report.theme", value); } catch {}
    });
    try {
      const saved = localStorage.getItem("cairntrace.report.theme");
      if (saved && themeSelect?.querySelector(\`option[value="\${saved}"]\`)) {
        themeSelect.value = saved;
        document.documentElement.dataset.theme = saved;
      }
    } catch {}
    printButton?.addEventListener("click", () => window.print());
  </script>
</body>
</html>
`;
}

function countStatuses<T extends { status: "passed" | "failed" | "skipped" }>(
  entries: T[],
): ReportStatusCounts {
  const counts: ReportStatusCounts = {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: entries.length,
  };
  for (const entry of entries) {
    counts[entry.status] += 1;
  }
  return counts;
}

function buildArtifactLinks(result: RunResult): ReportArtifactLink[] {
  const artifacts = result.artifacts;
  const links: ReportArtifactLink[] = [
    {
      label: "Run report",
      path: artifacts.report ?? "report.html",
      kind: "report",
    },
    {
      label: "Report data",
      path: artifacts.reportJson ?? "report.json",
      kind: "report-json",
    },
    { label: "Agent context", path: artifacts.agentContext, kind: "context" },
    { label: "Events", path: artifacts.events, kind: "events" },
  ];

  for (const outcome of result.outcomes) {
    addOptional(links, `${outcome.id} evidence`, outcome.evidence, "outcome");
    addOptional(links, `${outcome.id} raw`, outcome.evidenceRaw, "outcome-raw");
  }
  addOptional(links, "Console errors", artifacts.console, "console");
  addOptional(links, "Network failures", artifacts.network, "network");
  addOptional(links, "Trace", artifacts.trace, "trace");
  addOptional(links, "Video", artifacts.video, "video");
  for (const path of artifacts.screenshots ?? []) {
    links.push({ label: basenameLabel(path), path, kind: "screenshot" });
  }
  for (const path of artifacts.snapshots ?? []) {
    links.push({ label: basenameLabel(path), path, kind: "snapshot" });
  }
  for (const path of artifacts.diagnostics ?? []) {
    links.push({ label: basenameLabel(path), path, kind: "diagnostic" });
  }
  for (const [name, path] of Object.entries(artifacts.downloads ?? {})) {
    links.push({ label: name, path, kind: "download" });
  }
  for (const [name, path] of Object.entries(artifacts.transforms ?? {})) {
    links.push({ label: name, path, kind: "transform" });
  }
  for (const [name, path] of Object.entries(artifacts.requests ?? {})) {
    links.push({ label: name, path, kind: "request" });
  }
  for (const [name, path] of Object.entries(artifacts.evals ?? {})) {
    links.push({ label: name, path, kind: "eval" });
  }
  return links;
}

function addOptional(
  links: ReportArtifactLink[],
  label: string,
  path: string | undefined,
  kind: string,
): void {
  if (path) links.push({ label, path, kind });
}

function renderThemeCss(model: ReportModel): string {
  const themeRules = Object.values(REPORT_THEMES)
    .map((theme) => {
      const selector =
        theme.name === "cairn"
          ? `    :root,\n    html[data-theme="${theme.name}"]`
          : `    html[data-theme="${theme.name}"]`;
      return `${selector} {\n${renderCssVars(theme.colors)}\n    }`;
    })
    .join("\n");
  const custom =
    Object.keys(model.theme.overrides).length > 0
      ? `\n    html[data-theme="${model.theme.selected}"] {\n${renderCssVars(model.theme.tokens)}\n    }`
      : "";
  return `${themeRules}${custom}`;
}

function renderCssVars(tokens: ReportThemeTokens): string {
  return Object.entries(tokens)
    .map(([key, value]) => `      --${cssTokenName(key)}: ${value};`)
    .join("\n");
}

function sanitizeColorOverrides(
  input: ReportColorOverrides,
): ReportColorOverrides {
  const output: ReportColorOverrides = {};
  for (const [key, value] of Object.entries(input) as [
    keyof ReportColorOverrides,
    string | undefined,
  ][]) {
    if (value && isSafeCssColor(value)) output[key] = value;
  }
  return output;
}

function isSafeCssColor(value: string): boolean {
  return value.length > 0 && value.length <= 80 && !/[;{}<>]/.test(value);
}

function cssTokenName(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function renderThemeOptions(selected: ReportThemeName): string {
  return Object.values(REPORT_THEMES)
    .map((theme) => {
      const isSelected = theme.name === selected ? " selected" : "";
      return `        <option value="${escapeAttr(theme.name)}"${isSelected}>${escapeHtml(theme.label)}</option>`;
    })
    .join("\n");
}

function renderMeta(label: string, value: string): string {
  return `<div class="meta"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function renderStat(label: string, value: number, total: number): string {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${value}<small> / ${total}</small></strong></div>`;
}

function renderOutcomeRow(outcome: OutcomeResult): string {
  return `            <tr>
              <td><code>${escapeHtml(outcome.id)}</code></td>
              <td>${statusBadge(outcome.status)}</td>
              <td>${
                outcome.evidence ? link(outcome.evidence, outcome.evidence) : ""
              }</td>
              <td>${
                outcome.evidenceRaw ? link(outcome.evidenceRaw, "raw json") : ""
              }</td>
            </tr>`;
}

function renderStepRow(step: StepResult): string {
  const resolved = step.resolved
    ? `${step.resolved.role}${
        step.resolved.name ? `: ${step.resolved.name}` : ""
      }${step.resolved.ref ? ` (${step.resolved.ref})` : ""}`
    : "";
  return `            <tr>
              <td><code>${escapeHtml(step.id)}</code></td>
              <td>${statusBadge(step.status)}</td>
              <td>${escapeHtml(formatDuration(step.durationMs))}</td>
              <td class="path">${escapeHtml(resolved)}</td>
              <td class="error">${escapeHtml(step.error ?? "")}</td>
            </tr>`;
}

function renderArtifactItem(item: ReportArtifactLink): string {
  return `        <li><span>${escapeHtml(item.kind)}</span>${link(item.path, item.label)}</li>`;
}

function renderBarSegment(
  status: "passed" | "failed" | "skipped",
  count: number,
  total: number,
): string {
  if (count === 0 || total === 0) return "";
  return `<span class="${status}" style="width: ${((count / total) * 100).toFixed(2)}%"></span>`;
}

function statusSummary(counts: ReportStatusCounts): string {
  return `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`;
}

function statusBadge(
  status: RunResult["status"] | OutcomeResult["status"],
): string {
  return `<span class="status status-${escapeAttr(status)}">${escapeHtml(status)}</span>`;
}

function link(path: string, label: string): string {
  return `<a href="${escapeAttr(path)}">${escapeHtml(label)}</a>`;
}

function basenameLabel(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}m ${remaining}s`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
