import type { Locator, Step } from "../schema/spec.v1";

/**
 * Swap the locator on an interactive step while keeping authored values
 * (fill/type text, upload path, download saveAs, click.until).
 */
export function replaceStepLocator(step: Step, locator: Locator): Step {
  if ("click" in step) {
    const { until } = step.click;
    return {
      ...step,
      click: until ? { ...locator, until } : locator,
    } as Step;
  }
  if ("hover" in step) return { ...step, hover: locator };
  if ("focus" in step) return { ...step, focus: locator };
  if ("fill" in step) {
    return {
      ...step,
      fill: { ...locator, value: step.fill.value },
    } as Step;
  }
  if ("type" in step) {
    return {
      ...step,
      type: {
        ...locator,
        value: step.type.value,
        ...(step.type.delayMs !== undefined
          ? { delayMs: step.type.delayMs }
          : {}),
      },
    } as Step;
  }
  if ("select" in step) {
    return {
      ...step,
      select: {
        ...locator,
        ...(step.select.value !== undefined
          ? { value: step.select.value }
          : {}),
        ...(step.select.label !== undefined
          ? { label: step.select.label }
          : {}),
      },
    } as Step;
  }
  if ("upload" in step) {
    return {
      ...step,
      upload: { ...locator, path: step.upload.path },
    } as Step;
  }
  if ("download" in step) {
    return {
      ...step,
      download: {
        ...locator,
        saveAs: step.download.saveAs,
        ...(step.download.assign ? { assign: step.download.assign } : {}),
        ...(step.download.timeoutMs !== undefined
          ? { timeoutMs: step.download.timeoutMs }
          : {}),
      },
    } as Step;
  }
  if ("press" in step) {
    return { ...step, target: locator };
  }
  if ("scroll" in step && "to" in step.scroll) {
    return { ...step, scroll: { to: locator } };
  }
  return step;
}

/** True when the backend failed to resolve a target, not after a delivered action. */
export function isLocatorMissError(message: string): boolean {
  if (/click\.until|press\.until|verifyFill|flipped back/i.test(message)) {
    return false;
  }
  if (
    /0(?:\s+visible)?\s+match|not found|no matching|unresolved|ambiguous|strict mode|multiple .*match|zero matches|mock step failure/i.test(
      message,
    )
  ) {
    return true;
  }
  // Playwright: locator.click: Timeout 10000ms exceeded + waiting for getByRole(...)
  return (
    /Timeout \d+ms exceeded/i.test(message) &&
    /waiting for (?:getBy(?:Role|Label|Text|TestId|Placeholder|Title|AltText)|locator\b)/i.test(
      message,
    )
  );
}

export function isInteractiveLocatorStep(step: Step): boolean {
  return (
    "click" in step ||
    "hover" in step ||
    "focus" in step ||
    "fill" in step ||
    "type" in step ||
    "select" in step ||
    "upload" in step ||
    "download" in step ||
    "press" in step ||
    ("scroll" in step && "to" in step.scroll)
  );
}
