import { renderJson } from "../core/artifacts/renderers/json";
import { renderYaml } from "../core/artifacts/renderers/yaml";

export type OutputFormat = "json" | "yaml" | "md";

export function isFormat(v: string): v is OutputFormat {
  return v === "json" || v === "yaml" || v === "md";
}

export function emit<T>(
  format: OutputFormat,
  value: T,
  toMarkdown: (v: T) => string,
): string {
  switch (format) {
    case "json":
      return renderJson(value);
    case "yaml":
      return renderYaml(value);
    case "md":
      return toMarkdown(value);
  }
}

/** Resolve a `--format`/`--json`/`--yaml`/`--md` cluster, falling back to default. */
export function resolveFormat(
  opts: {
    format?: string;
    json?: boolean;
    yaml?: boolean;
    md?: boolean;
  },
  defaultFormat: OutputFormat,
): OutputFormat {
  if (opts.json) return "json";
  if (opts.yaml) return "yaml";
  if (opts.md) return "md";
  if (opts.format && isFormat(opts.format)) return opts.format;
  return defaultFormat;
}
