import { describe, expect, it } from "vitest";
import {
  fcheapPublisherEnv,
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
