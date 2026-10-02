import { describe, expect, it } from "vitest";
import {
  cairnContextEnv,
  fcheapPublisherEnv,
  isWithheldFromTargetChildren,
  targetChildEnv,
  targetChildEnvWithSelectedTvaultKeys,
} from "./processEnv";

describe("protected child environments", () => {
  it("removes the ingest credential from ordinary target children", () => {
    expect(
      targetChildEnv({
        SAFE: "visible",
        FILECHEAP_INGEST_TOKEN: "publisher-only",
        CAIRN_TVAULT_ENV: "preview",
        TVAULT_PROJECT: "control",
      }),
    ).toEqual({ SAFE: "visible" });
  });

  it("preserves an explicitly selected TinyVault-prefixed target value", () => {
    expect(
      targetChildEnvWithSelectedTvaultKeys(
        {
          SAFE: "visible",
          TVAULT_PROJECT: "control",
          TVAULT_SELECTED: "explicit-secret",
        },
        ["TVAULT_SELECTED"],
      ),
    ).toEqual({ SAFE: "visible", TVAULT_SELECTED: "explicit-secret" });
  });

  it("uses a strict allowlist for the explicit publisher scope", () => {
    expect(
      fcheapPublisherEnv({
        PATH: "/opt/bin",
        SAFE: "visible",
        VERCEL_OIDC_TOKEN: "unrelated-vercel-credential",
        DATABASE_URL: "unrelated-database-credential",
        FILECHEAP_ARTIFACT_SERVICE_URL: "https://file.cheap",
        FILECHEAP_INGEST_TOKEN: "publisher-only",
      }),
    ).toEqual({
      PATH: "/opt/bin",
      FILECHEAP_ARTIFACT_SERVICE_URL: "https://file.cheap",
      FILECHEAP_INGEST_TOKEN: "publisher-only",
    });
  });
});

describe("cairnContextEnv", () => {
  it("exports the non-secret run context under CAIRN_*", () => {
    expect(
      cairnContextEnv({
        environment: "staging",
        baseUrl: "https://demo.example.test",
        runToken: "tok_1",
        runId: "demo-2026",
        runDir: "/runs/demo-2026",
        configDir: "/project",
      }),
    ).toEqual({
      CAIRN_ENV: "staging",
      CAIRN_BASE_URL: "https://demo.example.test",
      CAIRN_RUN_TOKEN: "tok_1",
      CAIRN_RUN_ID: "demo-2026",
      CAIRN_RUN_DIR: "/runs/demo-2026",
      CAIRN_CONFIG_DIR: "/project",
    });
  });

  it("omits values that are not known yet", () => {
    expect(cairnContextEnv({ environment: "local", baseUrl: "" })).toEqual({
      CAIRN_ENV: "local",
    });
  });

  it("still loses CAIRN_TVAULT_ENV when layered into a target child env", () => {
    const env = targetChildEnv({
      CAIRN_TVAULT_ENV: "preview",
      ...cairnContextEnv({ environment: "preview" }),
    });
    expect(env).toEqual({ CAIRN_ENV: "preview" });
  });
});

describe("isWithheldFromTargetChildren", () => {
  it("names the credentials targetChildEnv removes, not the env selector", () => {
    expect(isWithheldFromTargetChildren("FILECHEAP_INGEST_TOKEN")).toBe(true);
    expect(isWithheldFromTargetChildren("TVAULT_TOKEN")).toBe(true);
    expect(isWithheldFromTargetChildren("CAIRN_TVAULT_ENV")).toBe(false);
    expect(isWithheldFromTargetChildren("DEMO_API_TOKEN")).toBe(false);
  });
});
