import { describe, expect, it } from "vitest";
import { buildSpecYaml, deriveSpecName } from "./specExporter";

describe("specExporter", () => {
  describe("deriveSpecName", () => {
    it("derives a name from a simple path", () => {
      expect(deriveSpecName("flows/login-flow.yml")).toBe("login_flow");
    });

    it("derives a name from a path with no extension", () => {
      expect(deriveSpecName("flows/login")).toBe("login");
    });

    it("handles Windows-style paths", () => {
      expect(deriveSpecName("flows\\login-flow.yml")).toBe("login_flow");
    });

    it("handles paths with spaces and special chars", () => {
      expect(deriveSpecName("flows/User Login Flow!.yml")).toBe(
        "user_login_flow",
      );
    });

    it("falls back to discovered_spec for empty stems", () => {
      expect(deriveSpecName("...")).toBe("discovered_spec");
    });

    it("handles a bare filename", () => {
      expect(deriveSpecName("dashboard.yml")).toBe("dashboard");
    });
  });

  describe("buildSpecYaml", () => {
    it("builds a valid spec YAML with steps and outcomes", () => {
      const { yaml, stepCount } = buildSpecYaml({
        name: "login_flow",
        intent: "User can log in",
        outcomes: [
          {
            id: "dashboard_visible",
            description: "Dashboard heading is shown",
            verify: { text: { contains: "Dashboard" } },
          },
        ],
        steps: [
          { open: "/login" },
          { click: { by: "role", role: "button", name: "Sign In" } },
        ],
      });

      expect(stepCount).toBe(2);
      expect(yaml).toContain("COLD START CONTRACT");
      expect(yaml).toContain("version: 1");
      expect(yaml).toContain("name: login_flow");
      expect(yaml).toContain("intent: User can log in");
      expect(yaml).toContain("open: /login");
      expect(yaml).toContain("Sign In");
      expect(yaml).toContain("dashboard_visible");
      expect(yaml).toContain("Dashboard");
    });

    it("builds a spec with no steps", () => {
      const { yaml, stepCount } = buildSpecYaml({
        name: "empty",
        intent: "Nothing happens",
        outcomes: [
          {
            id: "page-loads",
            description: "Page loads",
            verify: { text: { contains: "Welcome" } },
          },
        ],
        steps: [],
      });

      expect(stepCount).toBe(0);
      expect(yaml).toContain("steps: []");
    });

    it("builds a spec with multiple outcomes", () => {
      const { yaml } = buildSpecYaml({
        name: "multi",
        intent: "Multiple checks",
        outcomes: [
          {
            id: "text-check",
            description: "Text appears",
            verify: { text: { contains: "Hello" } },
          },
          {
            id: "url-check",
            description: "URL matches",
            verify: { url: { endsWith: "/dashboard" } },
          },
        ],
        steps: [{ open: "/home" }],
      });

      expect(yaml).toContain("text-check");
      expect(yaml).toContain("url-check");
      expect(yaml).toContain("Hello");
      expect(yaml).toContain("/dashboard");
    });
  });
});
