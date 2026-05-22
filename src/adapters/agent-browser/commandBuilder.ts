import type {
  ClickStep,
  DownloadStep,
  FillStep,
  HoverStep,
  Locator,
  OpenStep,
  SnapshotStep,
  Step,
  UploadStep,
  WaitCondition,
  WaitStep,
} from "../../core/schema/spec.v1";

/**
 * Pure functions mapping a behavioral Step → agent-browser argv.
 * No I/O; all side effects live in AgentBrowserAdapter.
 *
 * Locators use agent-browser's semantic `find` family wherever possible
 * (find role / find label / find text), falling back to raw selectors only
 * for `by: "selector"` locators. This matches agent-browser's AI-ergonomic
 * model and keeps specs resilient to UI changes.
 */

/* ----- locator dispatch ----- */

/**
 * Build the argv prefix for invoking an action against a Locator.
 * agent-browser's `find` family takes the form: `find <kind> <key> <action> [value] [flags]`.
 * For `by: "selector"`, returns `[action, selector]` (e.g., `["click", "#submit"]`).
 */
export function locatorToArgv(
  loc: Locator,
  action: string,
  value?: string,
): string[] {
  switch (loc.by) {
    case "role": {
      const argv = ["find", "role", loc.role, action];
      if (value !== undefined) argv.push(value);
      if (loc.name !== undefined) argv.push("--name", loc.name);
      return argv;
    }
    case "label": {
      const argv = ["find", "label", loc.name, action];
      if (value !== undefined) argv.push(value);
      return argv;
    }
    case "text": {
      const argv = ["find", "text", loc.text, action];
      if (value !== undefined) argv.push(value);
      return argv;
    }
    case "selector": {
      const argv = [action, loc.selector];
      if (value !== undefined) argv.push(value);
      return argv;
    }
  }
}

/* ----- per-step builders (exported for unit testing) ----- */

export function openStepToArgv(step: OpenStep): string[] {
  // Use `navigate` (not `open`) — open is for browser launch; navigate handles
  // both initial nav and subsequent nav. agent-browser lazily starts the
  // browser on first command per session, so navigate is safe as the first step.
  return ["navigate", step.open];
}

export function clickStepToArgv(step: ClickStep): string[] {
  return locatorToArgv(step.click, "click");
}

export function hoverStepToArgv(step: HoverStep): string[] {
  return locatorToArgv(step.hover, "hover");
}

export function fillStepToArgv(step: FillStep): string[] {
  const { value, ...locator } = step.fill;
  return locatorToArgv(locator as Locator, "fill", value);
}

export function uploadStepToArgv(step: UploadStep): string[] {
  const { path, ...locator } = step.upload;
  return locatorToArgv(locator as Locator, "upload", path);
}

export function downloadStepToArgv(step: DownloadStep): string[] {
  const {
    saveAs,
    assign: _assign,
    timeoutMs: _timeoutMs,
    ...locator
  } = step.download;
  return locatorToArgv(locator as Locator, "download", saveAs);
}

export function waitStepToArgv(step: WaitStep): string[] {
  return waitConditionToArgv(step.wait);
}

export function waitConditionToArgv(w: WaitCondition): string[] {
  const argv = ["wait"];
  if ("text" in w) {
    argv.push("--text", w.text);
  } else if ("notText" in w) {
    // agent-browser has no native --notText. Use --fn with a JS predicate.
    // The function returns truthy when the text is absent from <body>.
    const escaped = JSON.stringify(w.notText);
    argv.push("--fn", `() => !document.body.innerText.includes(${escaped})`);
  } else {
    argv.push("--load", w.load);
  }
  if (w.timeoutMs !== undefined) {
    argv.push("--timeout", String(w.timeoutMs));
  }
  return argv;
}

export function snapshotStepToArgv(step: SnapshotStep): string[] {
  const argv = ["snapshot"];
  if (step.snapshot.interactive) argv.push("-i");
  return argv;
}

/* ----- top-level dispatch ----- */

/**
 * Convert a behavioral Step to agent-browser argv (without global flags).
 * `use:` steps must be expanded by the runner before reaching the adapter.
 */
export function stepToArgv(step: Step): string[] {
  if ("open" in step) return openStepToArgv(step);
  if ("click" in step) return clickStepToArgv(step);
  if ("hover" in step) return hoverStepToArgv(step);
  if ("fill" in step) return fillStepToArgv(step);
  if ("upload" in step) return uploadStepToArgv(step);
  if ("download" in step) return downloadStepToArgv(step);
  if ("wait" in step) return waitStepToArgv(step);
  if ("snapshot" in step) return snapshotStepToArgv(step);
  if ("use" in step) {
    throw new Error(
      `'use: ${step.use}' must be expanded to inline steps by the runner before adapter dispatch`,
    );
  }
  const exhaustive: never = step;
  throw new Error(
    `unhandled step shape: ${JSON.stringify(exhaustive satisfies never)}`,
  );
}
