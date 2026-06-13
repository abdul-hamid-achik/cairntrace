import type { BrowserBackend } from "../../adapters/browserBackend";
import { parseSnapshot } from "../healer/snapshotParser";
import type { Locator } from "../schema/spec.v1";

export interface RoleInventoryEntry {
  role: string;
  name?: string;
  count: number;
  refs: string[];
  locator: Extract<Locator, { by: "role" }>;
}

export interface TestIdInventoryEntry {
  testId: string;
  count: number;
  selector: string;
  tagNames: string[];
  textSamples: string[];
}

export interface LocatorInventory {
  roles?: RoleInventoryEntry[];
  testids?: TestIdInventoryEntry[];
}

export interface LocatorInventoryOptions {
  roles?: boolean;
  testids?: boolean;
}

export async function collectLocatorInventory(
  backend: BrowserBackend,
  opts: LocatorInventoryOptions,
): Promise<LocatorInventory> {
  const out: LocatorInventory = {};

  if (opts.roles) {
    const snapshot = await backend.snapshot({ interactive: true });
    if (!snapshot.ok) {
      throw new Error(`snapshot failed: ${snapshot.text}`);
    }
    out.roles = extractRoleInventory(snapshot.text);
  }

  if (opts.testids) {
    const evaluated = await backend.evaluate(TEST_ID_INVENTORY_SCRIPT);
    if (!evaluated.ok) {
      throw new Error(
        `testid inventory failed: ${evaluated.stderr || evaluated.stdout}`,
      );
    }
    out.testids = parseTestIdInventory(evaluated.stdout);
  }

  return out;
}

export function extractRoleInventory(text: string): RoleInventoryEntry[] {
  const groups = new Map<string, RoleInventoryEntry>();
  for (const el of parseSnapshot(text)) {
    if (!shouldIncludeRole(el.role, el.name)) continue;
    const key = `${el.role}\0${el.name ?? ""}`;
    const current =
      groups.get(key) ??
      ({
        role: el.role,
        ...(el.name ? { name: el.name } : {}),
        count: 0,
        refs: [],
        locator: {
          by: "role",
          role: el.role,
          ...(el.name ? { name: el.name } : {}),
        },
      } satisfies RoleInventoryEntry);
    current.count++;
    if (el.ref) current.refs.push(el.ref);
    groups.set(key, current);
  }

  return [...groups.values()].toSorted((a, b) => {
    const role = a.role.localeCompare(b.role);
    if (role !== 0) return role;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

export function parseTestIdInventory(stdout: string): TestIdInventoryEntry[] {
  const raw = JSON.parse(stdout) as unknown;
  if (!Array.isArray(raw)) return [];
  const groups = new Map<string, TestIdInventoryEntry>();

  for (const item of raw) {
    if (!isRawTestId(item)) continue;
    const current =
      groups.get(item.testId) ??
      ({
        testId: item.testId,
        count: 0,
        selector: item.selector,
        tagNames: [],
        textSamples: [],
      } satisfies TestIdInventoryEntry);
    current.count++;
    if (!current.tagNames.includes(item.tagName)) {
      current.tagNames.push(item.tagName);
    }
    if (item.text && !current.textSamples.includes(item.text)) {
      current.textSamples.push(item.text);
    }
    groups.set(item.testId, current);
  }

  return [...groups.values()].toSorted((a, b) =>
    a.testId.localeCompare(b.testId),
  );
}

export const TEST_ID_INVENTORY_SCRIPT = `(() => {
  const escapeAttr = (value) => String(value).replace(/[\\\\"]/g, "\\\\$&");
  return Array.from(document.querySelectorAll("[data-testid]"))
    .slice(0, 200)
    .map((el) => {
      const testId = el.getAttribute("data-testid") || "";
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120);
      return {
        testId,
        tagName: el.tagName.toLowerCase(),
        text,
        selector: '[data-testid="' + escapeAttr(testId) + '"]'
      };
    });
})()`;

function shouldIncludeRole(role: string, name: string | undefined): boolean {
  if (name && name.trim().length > 0) return true;
  return !IGNORED_UNNAMED_ROLES.has(role);
}

const IGNORED_UNNAMED_ROLES = new Set([
  "body",
  "document",
  "generic",
  "none",
  "presentation",
]);

function isRawTestId(value: unknown): value is {
  testId: string;
  tagName: string;
  text: string;
  selector: string;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.testId === "string" &&
    v.testId.length > 0 &&
    typeof v.tagName === "string" &&
    typeof v.text === "string" &&
    typeof v.selector === "string"
  );
}
