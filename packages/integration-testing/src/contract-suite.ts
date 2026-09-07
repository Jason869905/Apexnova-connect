import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileConfigExecutor } from "@apexnova-connect/config-engine";
import { runIntegrationChange } from "@apexnova-connect/core";
import {
  AgentIntegrationError,
  isDetectionAvailable,
  toDetectionDocument,
  toInspectionDocument,
  validateDetectionDocument,
  validateInspectionDocument,
  toPlatform,
  validateIntegrationManifest,
  type AgentIntegration,
  type AvailableDetection,
  type ConnectionIntent,
  type IntegrationContext,
  type InspectionStatus,
  type Platform,
} from "@apexnova-connect/integration-sdk";

/** A configuration the integration must refuse instead of rewriting. */
export interface UnsupportedConfigFixture {
  readonly label: string;
  readonly content: string;
  readonly status: Extract<InspectionStatus, "legacy" | "invalid">;
}

export interface IntegrationContractFixtures {
  readonly integration: AgentIntegration;
  /** The parsed `manifest.json` shipped beside the integration. */
  readonly manifestJson: unknown;
  /** File name the product configuration takes inside the temporary root. */
  readonly configFileName: string;
  /** A connection the integration is expected to accept. */
  readonly intent: ConnectionIntent;
  readonly unsupportedConfigs: readonly UnsupportedConfigFixture[];
  /**
   * An existing configuration with a user setting in it, plus the fragments
   * that must still be present after planning.
   */
  readonly preservedConfig?: {
    readonly content: string;
    readonly mustContain: readonly string[];
  };
  /** A protocol the integration must refuse, when it does not accept all of them. */
  readonly unsupportedProtocol?: ConnectionIntent["protocol"];
  /**
   * A detection-only integration: it discovers and inspects but never changes
   * or launches anything. The suite then requires that every mutating entry
   * point refuses rather than half-implementing the lifecycle.
   */
  readonly readOnly?: boolean;
}

const SECRET = "contract-suite-secret-value";

/**
 * The platform to exercise an integration on. Running it where its manifest
 * excludes the platform tests the refusal, not the integration: Hermes has no
 * Windows build, so on a Windows runner it would only ever prove that it says
 * so.
 */
export function contractPlatform(
  integration: AgentIntegration,
  currentPlatform: Platform | undefined = toPlatform(process.platform),
): Platform {
  const supported = integration.manifest.compatibility.platforms;
  if (currentPlatform && supported.includes(currentPlatform)) return currentPlatform;
  const fallback = supported[0];
  if (!fallback) {
    throw new TypeError(`${integration.manifest.id} declares no supported platforms.`);
  }
  return fallback;
}

/**
 * Windows executable resolution walks `PATH`, so an environment without one is
 * not a machine any integration has to cope with -- and an empty `PATH` makes
 * that loop run zero times, which no `pathExists` fixture can compensate for.
 */
export function contractEnvironment(platform: Platform): Record<string, string | undefined> {
  return platform === "windows" ? { PATH: "C:\\apexnova-contract-bin" } : {};
}

async function removeRoot(root: string): Promise<void> {
  const resolvedTemp = await realpath(tmpdir());
  if (
    (await realpath(dirname(root))) !== resolvedTemp ||
    !basename(root).startsWith("apexnova-contract-")
  ) {
    throw new Error(`Refusing to remove unexpected test directory: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
}

/**
 * The contract every Agent Integration has to satisfy. It runs against real
 * files in a temporary directory and never touches the network, a credential
 * store, or the user's own configuration.
 */
export function describeIntegrationContract(
  fixtures: IntegrationContractFixtures,
): void {
  const { integration } = fixtures;
  const agentId = integration.manifest.id;

  describe(`${agentId} integration contract`, () => {
    let root: string;
    let configPath: string;
    let context: IntegrationContext;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "apexnova-contract-"));
      configPath = join(root, "config", fixtures.configFileName);
      await mkdir(dirname(configPath), { recursive: true });
      const platform = contractPlatform(integration);
      context = {
        platform,
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: contractEnvironment(platform),
        configPath,
      };
    });

    afterEach(async () => {
      await removeRoot(root);
    });

    async function availableDetection(): Promise<AvailableDetection> {
      const detection = await integration.detect(context);
      if (!isDetectionAvailable(detection)) {
        throw new TypeError(
          `Expected ${agentId} to be available in the contract fixture, got ${detection.status}.`,
        );
      }
      return detection;
    }

    it("ships a manifest that validates and matches its JSON copy", () => {
      const result = validateIntegrationManifest(integration.manifest);
      expect(result.valid, JSON.stringify(result.valid ? [] : result.errors)).toBe(true);
      expect(integration.manifest).toEqual(fixtures.manifestJson);
    });

    it("declares only protocols its manifest also declares", () => {
      if (!fixtures.readOnly) {
        expect(integration.supportedProtocols.length).toBeGreaterThan(0);
      }
      const declared = integration.manifest.protocols.map((protocol) => protocol.id);
      for (const protocol of integration.supportedProtocols) {
        expect(declared).toContain(protocol);
      }
    });

    it("names an uppercase credential environment variable, never a secret", () => {
      expect(integration.credentialEnvironmentVariable).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    });

    it("reports absolute configuration roots", () => {
      const roots = integration.configRoots(context);
      expect(roots.length).toBeGreaterThan(0);
      for (const candidate of roots) {
        expect(isAbsolute(candidate)).toBe(true);
      }
    });

    it("detects a machine where the product was never installed without throwing", async () => {
      const bare: IntegrationContext = {
        platform: context.platform,
        workingDirectory: join(root, "empty"),
        homeDirectory: join(root, "empty-home"),
        environment: contractEnvironment(context.platform),
      };
      await mkdir(bare.workingDirectory, { recursive: true });
      const detection = await integration.detect(bare);
      expect(["not-found", "installed", "config-only"]).toContain(detection.status);
      expect(detection.agentId).toBe(agentId);
      expect(detection.configExists).toBe(false);

      const document = validateDetectionDocument(toDetectionDocument(detection));
      expect(document.valid, JSON.stringify(document.valid ? [] : document.errors)).toBe(true);
    });

    it("reports a missing configuration as not-configured", async () => {
      const detection = await availableDetection();
      const inspection = await integration.inspect(context, detection);
      expect(inspection.status).toBe("not-configured");
      expect(inspection.managed).toBe(false);

      const document = validateInspectionDocument(toInspectionDocument(inspection));
      expect(document.valid, JSON.stringify(document.valid ? [] : document.errors)).toBe(true);
    });

    for (const fixture of fixtures.unsupportedConfigs) {
      it(`refuses to rewrite ${fixture.label}`, async () => {
        await writeFile(configPath, fixture.content, "utf8");
        const detection = await availableDetection();
        const inspection = await integration.inspect(context, detection);
        expect(inspection.status).toBe(fixture.status);
        expect(inspection.managed).toBe(false);
        expect(JSON.stringify(inspection)).not.toContain("must-not-leak");

        await expect(
          integration.plan(context, detection, inspection, fixtures.intent),
        ).rejects.toBeInstanceOf(AgentIntegrationError);
        expect(await readFile(configPath, "utf8")).toBe(fixture.content);
      });
    }

    it.skipIf(fixtures.readOnly)("plans one write that carries no secret", async () => {
      const detection = await availableDetection();
      const plan = await integration.plan(
        context,
        detection,
        await integration.inspect(context, detection),
        fixtures.intent,
      );

      expect(plan.integrationId).toBe(agentId);
      expect(plan.id).toBe(fixtures.intent.planId);
      expect(plan.operations).toHaveLength(1);
      const operation = plan.operations[0]!;
      expect(operation.path).toBe(configPath);
      expect(operation.mode).toBe("create");
      expect(operation.containsSecrets).toBe(false);
      expect(JSON.stringify(plan)).not.toContain(SECRET);
    });

    it.skipIf(fixtures.readOnly)("produces the same plan twice and no plan once applied", async () => {
      const detection = await availableDetection();
      const first = await integration.plan(
        context,
        detection,
        await integration.inspect(context, detection),
        fixtures.intent,
      );
      const repeat = await integration.plan(
        context,
        detection,
        await integration.inspect(context, detection),
        fixtures.intent,
      );
      expect(repeat.operations).toEqual(first.operations);

      await writeFile(configPath, first.operations[0]!.content, "utf8");
      const applied = await availableDetection();
      const third = await integration.plan(
        context,
        applied,
        await integration.inspect(context, applied),
        fixtures.intent,
      );
      expect(third.operations).toHaveLength(0);
    });

    if (fixtures.preservedConfig && !fixtures.readOnly) {
      const preserved = fixtures.preservedConfig;
      it("keeps unrelated user settings", async () => {
        await writeFile(configPath, preserved.content, "utf8");
        const detection = await availableDetection();
        const plan = await integration.plan(
          context,
          detection,
          await integration.inspect(context, detection),
          fixtures.intent,
        );
        const content = plan.operations[0]?.content ?? "";
        for (const fragment of preserved.mustContain) {
          expect(content).toContain(fragment);
        }
      });
    }

    if (fixtures.unsupportedProtocol && !fixtures.readOnly) {
      const protocol = fixtures.unsupportedProtocol;
      it(`refuses a ${protocol} deployment instead of guessing`, async () => {
        const detection = await availableDetection();
        await expect(
          integration.plan(context, detection, await integration.inspect(context, detection), {
            ...fixtures.intent,
            protocol,
          }),
        ).rejects.toBeInstanceOf(AgentIntegrationError);
      });
    }

    it.skipIf(fixtures.readOnly)("applies, verifies and rolls back to the original bytes", async () => {
      const original = fixtures.preservedConfig?.content ?? "";
      if (original) await writeFile(configPath, original, "utf8");

      const executor = new FileConfigExecutor({
        allowedRoots: [dirname(configPath)],
        backupRoot: join(root, "backups"),
      });
      const result = await runIntegrationChange({
        adapter: integration,
        executor,
        context,
        intent: fixtures.intent,
        approve: async () => true,
      });

      expect(result.status).toBe("applied");
      if (result.status !== "applied") throw new TypeError("Expected an applied change.");

      const inspection = await integration.inspect(context, await availableDetection());
      expect(inspection.status).toBe("configured");
      expect(inspection.managed).toBe(true);
      // However the product refers to its credential -- a placeholder in the
      // file or an injected variable -- inspection has to name the variable and
      // never the value.
      expect(inspection.connection?.environmentVariables).toContain(
        integration.credentialEnvironmentVariable,
      );
      expect(JSON.stringify(inspection)).not.toContain(SECRET);

      await executor.rollback(result.receipt);
      if (original) {
        expect(await readFile(configPath, "utf8")).toBe(original);
      }
    });

    it.skipIf(fixtures.readOnly)("plans a launch that injects the credential into the environment only", async () => {
      const launch = await integration.planLaunch({
        context,
        credentialEnvironment: { [integration.credentialEnvironmentVariable]: SECRET },
        args: ["--version"],
      });

      expect(launch.executable.length).toBeGreaterThan(0);
      expect(launch.args).toEqual(["--version"]);
      expect(launch.environment[integration.credentialEnvironmentVariable]).toBe(SECRET);
      expect(launch.args.join(" ")).not.toContain(SECRET);
      expect(launch.executable).not.toContain(SECRET);
    });

    it.runIf(fixtures.readOnly)("refuses to change or launch anything", async () => {
      const detection = await availableDetection();
      const inspection = await integration.inspect(context, detection);

      await expect(
        integration.plan(context, detection, inspection, fixtures.intent),
      ).rejects.toBeInstanceOf(AgentIntegrationError);
      await expect(
        integration.planLaunch({ context, credentialEnvironment: {}, args: [] }),
      ).rejects.toBeInstanceOf(AgentIntegrationError);
      expect(integration.manifest.capabilities).not.toContain("provider-config");
    });

    it("diagnoses without throwing and labels every check", async () => {
      const checks = await integration.diagnose(context);
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        expect(check.id.startsWith(agentId)).toBe(true);
        expect(["pass", "warning", "fail", "skipped", "unknown"]).toContain(check.status);
      }
    });
  });
}
