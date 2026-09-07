import { describe, expect, it } from "vitest";

import type { AgentIntegration, IntegrationManifest, Platform } from "@apexnova-connect/integration-sdk";

import { contractEnvironment, contractPlatform } from "../src/index.js";

function integrationOn(platforms: readonly Platform[]): AgentIntegration {
  return {
    manifest: { compatibility: { platforms } } as unknown as IntegrationManifest,
  } as AgentIntegration;
}

describe("contractPlatform", () => {
  it("uses the current platform when the manifest supports it", () => {
    const everywhere = integrationOn(["windows", "macos", "linux"]);

    expect(contractPlatform(everywhere, "windows")).toBe("windows");
    expect(contractPlatform(everywhere, "linux")).toBe("linux");
  });

  it("falls back to a supported platform rather than testing a refusal", () => {
    // Hermes has no Windows build. Exercising it on a Windows runner would only
    // ever prove that it says so, which is not the contract under test.
    const unixOnly = integrationOn(["macos", "linux"]);

    expect(contractPlatform(unixOnly, "windows")).toBe("macos");
  });

  it("falls back when the host platform is one the project does not model", () => {
    expect(contractPlatform(integrationOn(["linux"]), undefined)).toBe("linux");
  });

  it("refuses an integration that declares no platform at all", () => {
    expect(() => contractPlatform(integrationOn([]), "linux")).toThrowError(TypeError);
  });
});

describe("contractEnvironment", () => {
  it("gives Windows a PATH to resolve executables from", () => {
    // Executable resolution walks PATH.split(";"); an empty PATH makes that
    // loop run zero times, which no pathExists fixture can compensate for.
    const environment = contractEnvironment("windows");

    expect(environment.PATH).toBeDefined();
    expect(environment.PATH?.length).toBeGreaterThan(0);
  });

  it("leaves other platforms with a bare environment", () => {
    expect(contractEnvironment("linux")).toEqual({});
    expect(contractEnvironment("macos")).toEqual({});
  });
});
