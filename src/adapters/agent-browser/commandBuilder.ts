import {
  openPath,
  type BatchSubStep,
  type ClickStep,
  type DownloadStep,
  type FillStep,
  type HoverStep,
  type Locator,
  type OpenStep,
  type PressStep,
  type ScrollStep,
  type SnapshotStep,
  type Step,
  type TypeStep,
  type UploadStep,
  type WaitCondition,
  type WaitStep,
} from "../../core/schema/spec.v1";

/**
 * Pure functions mapping a behavioral Step → agent-browser argv.
 * No I/O; all side effects live in AgentBrowserAdapter.
 *
 * NOTE: for interactive steps (click/hover/fill/upload) with semantic
 * locators, AgentBrowserAdapter no longer dispatches through the `find`
 * family — it resolves the locator against the interactive snapshot first
 * (strict matching, scroll-into-view, resolved-element evidence) and acts on
 * the `@ref`. agent-browser's `find` reported success on zero matches, which
 * produced silent no-op clicks (dogfood P0 #1). The find path below remains
 * for selector locators, `batch`, and as a documented fallback.
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
      if (loc.exact) argv.push("--exact");
      return argv;
    }
    case "label": {
      const argv = ["find", "label", loc.name, action];
      if (value !== undefined) argv.push(value);
      if (loc.exact) argv.push("--exact");
      return argv;
    }
    case "text": {
      const argv = ["find", "text", loc.text, action];
      if (value !== undefined) argv.push(value);
      if (loc.exact) argv.push("--exact");
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
  // The object form's waitUntil is issued as a follow-up `wait --load` by the
  // adapter (two commands), so only the navigation is built here.
  return ["navigate", openPath(step)];
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

/**
 * `type` — character-by-character keyboard input via CDP.
 * Maps to agent-browser's `type <sel> <text>` command.
 * Real keyboard events trigger SPA framework reactivity (Vue/React) that a
 * bulk `fill` may miss, leaving submit buttons disabled.
 *
 * NOTE: agent-browser's `type` does not support `--delay`; the schema's
 * `delayMs` is reserved for future backends (e.g. Playwright) and is
 * stripped by the adapter before dispatch.
 */
export function typeStepToArgv(step: TypeStep): string[] {
  const { value, delayMs: _delayMs, ...locator } = step.type;
  return locatorToArgv(locator as Locator, "type", value);
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
  if (locator.by === "selector") return ["download", locator.selector, saveAs];
  throw new Error(
    "semantic download locators must be resolved by AgentBrowserAdapter",
  );
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
  } else if ("selector" in w) {
    argv.push(w.selector);
    if (w.state !== undefined) argv.push("--state", w.state);
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

export function pressStepToArgv(step: PressStep): string[] {
  return ["press", step.press];
}

export function scrollStepToArgv(step: ScrollStep): string[] {
  if ("direction" in step.scroll) {
    const argv = ["scroll", step.scroll.direction];
    if (step.scroll.px !== undefined) argv.push(String(step.scroll.px));
    return argv;
  }
  if (step.scroll.to.by === "selector") {
    return ["scrollintoview", step.scroll.to.selector];
  }
  throw new Error(
    "semantic scroll.to locators must be resolved by AgentBrowserAdapter",
  );
}

/**
 * Map one `batch` sub-step to agent-browser argv (without global flags).
 * Sub-steps are selector-only by schema, so every one maps to a single command
 * with no snapshot resolution — that's what keeps the whole batch a single
 * invocation. Used by AgentBrowserAdapter.batch().
 */
export function batchSubStepToArgv(sub: BatchSubStep): string[] {
  if ("click" in sub) return ["click", sub.click.selector];
  if ("hover" in sub) return ["hover", sub.hover.selector];
  if ("type" in sub) return ["type", sub.type.selector, sub.type.value];
  if ("fill" in sub) return ["fill", sub.fill.selector, sub.fill.value];
  if ("upload" in sub) return ["upload", sub.upload.selector, sub.upload.path];
  if ("press" in sub) return ["press", sub.press];
  if ("scroll" in sub) {
    if ("to" in sub.scroll) return ["scrollintoview", sub.scroll.to.selector];
    const argv = ["scroll", sub.scroll.direction];
    if (sub.scroll.px !== undefined) argv.push(String(sub.scroll.px));
    return argv;
  }
  return waitConditionToArgv(sub.wait);
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
  if ("type" in step) return typeStepToArgv(step);
  if ("upload" in step) return uploadStepToArgv(step);
  if ("download" in step) return downloadStepToArgv(step);
  if ("wait" in step) return waitStepToArgv(step);
  if ("press" in step) return pressStepToArgv(step);
  if ("scroll" in step) return scrollStepToArgv(step);
  if ("snapshot" in step) return snapshotStepToArgv(step);
  if ("transform" in step) {
    throw new Error(
      "transform steps are handled by the runner before adapter dispatch",
    );
  }
  if ("request" in step) {
    throw new Error(
      "request steps are handled by the runner before adapter dispatch",
    );
  }
  if ("batch" in step) {
    throw new Error(
      "batch steps are handled by AgentBrowserAdapter.batch before adapter dispatch",
    );
  }
  if ("use" in step) {
    throw new Error(
      `'use: ${step.use}' must be expanded to inline steps by the runner before adapter dispatch`,
    );
  }
  if ("eval" in step) {
    throw new Error(
      "eval steps are handled by the runner via backend.evaluate before adapter dispatch",
    );
  }
  if ("monitor" in step) {
    throw new Error(
      "monitor steps are handled by the runner via the monitor CLI before adapter dispatch",
    );
  }
  const exhaustive: never = step;
  throw new Error(
    `unhandled step shape: ${JSON.stringify(exhaustive satisfies never)}`,
  );
}
