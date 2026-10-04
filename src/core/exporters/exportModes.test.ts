import { describe, expect, it } from "vitest";
import {
  parseGateEnv,
  parsePreconditionsMode,
  parseVerifiersMode,
  preconditionsPlan,
} from "./exportModes";

describe("export modes (E10)", () => {
  it("parses --preconditions and --verifiers, rejecting anything else", () => {
    expect(parsePreconditionsMode(undefined)).toBeUndefined();
    for (const mode of ["inline", "global", "skip", "manifest"]) {
      expect(parsePreconditionsMode(mode)).toBe(mode);
    }
    expect(() => parsePreconditionsMode("maybe")).toThrow(
      /--preconditions must be inline\|global\|skip\|manifest/,
    );
    expect(parseVerifiersMode(undefined)).toBeUndefined();
    for (const mode of ["keep", "gate", "drop"]) {
      expect(parseVerifiersMode(mode)).toBe(mode);
    }
    expect(() => parseVerifiersMode("hide")).toThrow(
      /--verifiers must be keep\|gate\|drop/,
    );
  });

  it("normalizes --gate-env (repeatable or comma separated) and rejects non-names", () => {
    expect(parseGateEnv(undefined)).toEqual([]);
    expect(parseGateEnv(["MONGO_URI,TEMPORAL_API_BASE", "MONGO_URI"])).toEqual([
      "MONGO_URI",
      "TEMPORAL_API_BASE",
    ]);
    expect(() => parseGateEnv(["not a name"])).toThrow(/environment variable/);
    expect(() => parseGateEnv(["1BAD"])).toThrow(/environment variable/);
  });

  it("plans what each mode emits for a standalone file and a project", () => {
    // Today's behavior without the flag: only --project / --into run a hook.
    expect(preconditionsPlan(undefined, false)).toEqual({
      inline: false,
      global: false,
      manifest: false,
      hostCommands: false,
    });
    expect(preconditionsPlan(undefined, true)).toEqual({
      inline: true,
      global: false,
      manifest: false,
      hostCommands: false,
    });
    // run: steps and teardown export only with an explicit inline|global.
    expect(preconditionsPlan("inline", false).hostCommands).toBe(true);
    expect(preconditionsPlan("global", true)).toMatchObject({
      global: true,
      inline: false,
      hostCommands: true,
    });
    expect(preconditionsPlan("skip", true)).toEqual({
      inline: false,
      global: false,
      manifest: false,
      hostCommands: false,
    });
    expect(preconditionsPlan("manifest", true)).toMatchObject({
      manifest: true,
      inline: false,
      hostCommands: false,
    });
  });
});
