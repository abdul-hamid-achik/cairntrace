import { renderRunMarkdown } from "../../core/artifacts/renderers/markdown";
import { runSpec } from "../../core/runner/Runner";
import { type BackendChoice, createBackend } from "../backendFactory";
import { emit, resolveFormat } from "../format";
import { isInteractive, makeInteractiveListener } from "../progress";

export interface RunCommandOptions {
  env?: string;
  coldStart?: boolean;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  artifactRoot?: string;
  config?: string;
  /** Commander sets this to false when `--no-color` is passed. */
  color?: boolean;
}

export async function runCommand(
  specPath: string,
  opts: RunCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const backend = createBackend({
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
  });

  // Interactive progress only when emitting markdown to a real TTY. JSON/YAML
  // callers (agents, CI) get a clean structured payload with no progress noise.
  const interactive = format === "md" && isInteractive();
  const colorEnabled =
    opts.color !== false &&
    !process.env.NO_COLOR &&
    process.env.TERM !== "dumb";
  const listener = interactive
    ? makeInteractiveListener({ color: colorEnabled })
    : undefined;

  let exitCode = 2;
  try {
    const result = await runSpec({
      specPath,
      backend,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(listener ? { listener } : {}),
    });
    exitCode = result.exitCode;

    if (!interactive) {
      // Non-TTY md mode (piped output, CI) gets the full markdown summary.
      // Interactive mode already streamed everything via the listener.
      process.stdout.write(emit(format, result, renderRunMarkdown));
      if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    }
  } catch (e) {
    const err = e as Error;
    if (format === "json") {
      process.stdout.write(
        JSON.stringify({
          $schema: "https://cairntrace.dev/schemas/run.v1.json",
          version: "1",
          status: "errored",
          error: { name: err.name, message: err.message },
          exitCode: 2,
        }),
      );
    } else {
      process.stderr.write(`cairn run: ${err.message}\n`);
    }
  } finally {
    await backend.close().catch(() => undefined);
  }

  process.exit(exitCode);
}
