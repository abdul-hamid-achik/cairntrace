import { stringify as yamlStringify } from "yaml";

/**
 * YAML mirror of the canonical JSON value. Mirrors the same in-memory object,
 * never re-parsed from JSON (so the two formats can't drift).
 */
export function renderYaml(value: unknown): string {
  return yamlStringify(value, {
    indent: 2,
    lineWidth: 100,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}
