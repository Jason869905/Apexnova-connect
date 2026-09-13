import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenCodeIntegration, detectOpenCode, inspectOpenCode, openCodeIntegration } from "../src/index.js";

const testRoots: string[] = [];

async function createTestRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apexnova-opencode-discovery-"));
  testRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of testRoots.splice(0)) {
    const resolvedTemp = await realpath(tmpdir());
    if (
      (await realpath(dirname(root))) !== resolvedTemp ||
      !basename(root).startsWith("apexnova-opencode-discovery-")
    ) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("OpenCode discovery", () => {
  it("detects an executable and a project JSONC configuration", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, "{ // valid\n}\n", "utf8");

    const result = await detectOpenCode(
      {
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: {},
        platform: "linux",
      },
      async () => ({ found: true, stdout: "opencode 2.4.1\n" })
    );

    expect(result).toMatchObject({
      status: "installed",
      productVersion: "2.4.1",
      configPath,
      configExists: true,
      configScope: "project",
    });
  });

  it("warns when the only OpenCode on PATH belongs to another operating system", async () => {
    const root = await createTestRoot();
    // A WSL session: $PATH carries the Windows entries, so `opencode` resolves
    // to the Windows install while the configuration goes to the Linux $HOME.
    // Reporting a version read from one beside a config path belonging to the
    // other is how `connect` came to write a file the Agent never reads.
    const windowsBin = "/mnt/c/Users/other/AppData/Roaming/npm";

    const result = await detectOpenCode(
      {
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: { PATH: windowsBin },
        platform: "linux",
      },
      async () => ({ found: true, stdout: "opencode 1.18.29\n" }),
      (path) => path === `${windowsBin}/opencode`,
    );

    expect(result.warnings.join(" ")).toContain("Windows installation");
    expect(result.warnings.join(" ")).toContain("configure one installation and launch another");
  });

  it("says nothing when a native OpenCode is also on PATH", async () => {
    const root = await createTestRoot();
    const windowsBin = "/mnt/c/Users/other/AppData/Roaming/npm";
    const nativeBin = "/usr/local/bin";

    const result = await detectOpenCode(
      {
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: { PATH: `${windowsBin}:${nativeBin}` },
        platform: "linux",
      },
      async () => ({ found: true, stdout: "opencode 1.18.29\n" }),
      (path) => path === `${windowsBin}/opencode` || path === `${nativeBin}/opencode`,
    );

    // A native entry means the installation that reads this configuration is
    // present; the Windows one beside it is not a problem to report.
    expect(result.warnings).toEqual([]);
  });

  it("reports config-only without guessing that the executable exists", async () => {
    const root = await createTestRoot();
    const configRoot = join(root, "xdg", "opencode");
    await mkdir(configRoot, { recursive: true });
    await writeFile(join(configRoot, "opencode.json"), "{}\n", "utf8");

    const result = await detectOpenCode(
      {
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: { XDG_CONFIG_HOME: join(root, "xdg") },
        platform: "linux",
      },
      async () => ({ found: false })
    );

    expect(result.status).toBe("config-only");
    expect(result.configScope).toBe("global");
    expect(result.configExists).toBe(true);
  });

  it("uses an explicit absent path as the preferred future configuration", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "custom", "opencode.jsonc");
    const result = await detectOpenCode(
      {
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: {},
        platform: "linux",
        configPath,
      },
      async () => ({ found: true, stdout: "2.0.0" }),
    );

    expect(result.configPath).toBe(configPath);
    expect(result.configExists).toBe(false);
    expect(result.configScope).toBe("explicit");
  });
});

describe("OpenCode inspection", () => {
  it("returns only managed provider metadata and never the whole config", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.jsonc");
    await writeFile(
      configPath,
      `{
  // unrelated user setting
  "theme": "system",
  "model": "apexnova/nova-coder",
  "provider": {
    "apexnova": {
      "name": "Apexnova AI Hub",
      "env": ["APEXNOVA_API_KEY"],
      "npm": "@ai-sdk/openai",
      "options": { "apiKey": "{env:APEXNOVA_API_KEY}", "baseURL": "https://api.example.test/v1" },
      "models": { "nova-coder": { "name": "Nova Coder" } }
    }
  }
}
`,
      "utf8",
    );
    const detection = await detectOpenCode(
      {
        workingDirectory: root,
        homeDirectory: join(root, "home"),
        environment: {},
        platform: "linux",
        configPath,
      },
      async () => ({ found: true, stdout: "2.1.0" }),
    );

    const result = await inspectOpenCode(detection);

    expect(result).toEqual({
      agentId: "opencode",
      configPath,
      status: "configured",
      managed: true,
      connection: {
        providerId: "apexnova",
        displayName: "Apexnova AI Hub",
        packageName: "@ai-sdk/openai",
        protocol: "openai-responses",
        baseUrl: "https://api.example.test/v1",
        environmentVariables: ["APEXNOVA_API_KEY"],
        modelIds: ["nova-coder"],
        defaultModelId: "nova-coder",
      },
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain("theme");
  });

  it("reports legacy and invalid configurations without returning their content", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.json");
    const baseDetection = { configPath, configExists: true };

    await writeFile(configPath, '{ "providers": {} }\n', "utf8");
    expect((await inspectOpenCode(baseDetection)).status).toBe("legacy");

    await writeFile(configPath, '{ "secret": "must-not-leak",', "utf8");
    const invalid = await inspectOpenCode(baseDetection);
    expect(invalid.status).toBe("invalid");
    expect(JSON.stringify(invalid)).not.toContain("must-not-leak");
  });

  it("removes credentials and query tokens from a displayed base URL", async () => {
    const root = await createTestRoot();
    const configPath = join(root, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          apexnova: {
            options: { baseURL: "https://user:secret@example.test/v1?api_key=hidden#token" },
            models: {},
          },
        },
      }),
      "utf8",
    );
    const result = await inspectOpenCode({ configPath, configExists: true });

    expect(result.connection?.baseUrl).toBe("https://example.test/v1");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(result.warnings).toHaveLength(1);
  });
});

describe("the model set a plan writes", () => {
  const planContext = {
    platform: "linux" as const,
    workingDirectory: tmpdir(),
    homeDirectory: tmpdir(),
    environment: {} as Record<string, string | undefined>,
  };
  const detection = {
    agentId: "opencode",
    displayName: "OpenCode",
    status: "installed" as const,
    productVersion: "1.18.29",
    configPath: "/tmp/opencode/opencode.jsonc",
    configExists: false,
    configScope: "global" as const,
    evidence: ["test"],
    warnings: [] as string[],
  };
  const inspection = {
    agentId: "opencode",
    configPath: detection.configPath,
    status: "not-configured" as const,
    managed: false,
    warnings: [] as string[],
  };
  const intent = {
    planId: "plan.models",
    createdAt: "2026-09-13T12:00:00.000Z",
    deploymentId: "deployment.nova",
    inferenceAlias: "nova",
    modelName: "Nova Coder",
    protocol: "openai-responses" as const,
    baseUrl: "https://api.example.test/v1/responses",
    apiKeyEnvironmentVariable: "APEXNOVA_API_KEY",
    limits: { context: 128000, output: 8192 },
  };

  function written(plan: { operations: readonly { content: string }[] }) {
    return JSON.parse(plan.operations[0]!.content) as {
      model: string;
      provider: { apexnova: { models: Record<string, { name: string; limit?: unknown }> } };
    };
  }

  it("writes every model the intent carries, and starts on the first", async () => {
    // The whole point of the set: OpenCode's own picker switches between these,
    // so all of them have to be in the provider it was given.
    const plan = await openCodeIntegration.plan(
      planContext,
      detection,
      inspection,
      {
        ...intent,
        models: [
          { deploymentId: "deployment.nova", inferenceAlias: "nova", modelName: "Nova Coder", limits: { context: 128000, output: 8192 } },
          { deploymentId: "deployment.aux", inferenceAlias: "aux", modelName: "Aux Reasoner" },
        ],
      },
    );

    const config = written(plan);
    expect(Object.keys(config.provider.apexnova.models)).toEqual(["nova", "aux"]);
    expect(config.provider.apexnova.models.aux?.name).toBe("Aux Reasoner");
    expect(config.provider.apexnova.models.aux?.limit).toBeUndefined();
    expect(config.model).toBe("apexnova/nova");
  });

  it("configures the single model an intent without a set names", async () => {
    // A caller that knows nothing about model sets still gets what it asked for.
    const plan = await openCodeIntegration.plan(planContext, detection, inspection, intent);

    const config = written(plan);
    expect(Object.keys(config.provider.apexnova.models)).toEqual(["nova"]);
    expect(config.model).toBe("apexnova/nova");
  });
});

describe("planLaunch and the configuration it was given", () => {
  // Paths are built with the host's own `path`, never written with a literal
  // separator. CI caught the difference: a Windows runner resolved the
  // hardcoded `/somewhere/config.yaml` to `D:\\somewhere\\config.yaml`, because
  // `configPath` names a file on the machine Connect is running on and is
  // resolved with the host's semantics -- which is correct, and what the test
  // had assumed away.
  const configDir = resolve(tmpdir(), "apexnova-launch-fixture", "opencode");
  const configFile = join(configDir, "opencode.jsonc");

  const context = (configPath?: string) => ({
    platform: "linux" as const,
    workingDirectory: tmpdir(),
    homeDirectory: tmpdir(),
    environment: {} as Record<string, string | undefined>,
    ...(configPath === undefined ? {} : { configPath }),
  });

  it("points OpenCode at an XDG-shaped path through XDG_CONFIG_HOME", async () => {
    // ADR 0029 first recorded that OpenCode honours no override at all. That was
    // wrong: it had been probed with an invented variable name rather than the
    // mechanism the product documents. `XDG_CONFIG_HOME` works, and this
    // integration's own discovery already searched that shape.
    const plan = await openCodeIntegration.planLaunch({
      context: context(configFile), credentialEnvironment: {}, args: [],
    });

    expect(plan.environment.XDG_CONFIG_HOME).toBe(dirname(configDir));
  });

  it("refuses a path XDG_CONFIG_HOME cannot express", async () => {
    // The variable names a directory, not a file, so only the layout OpenCode
    // looks for can be reached. Launching anyway would start it on its own
    // configuration while Connect had written ours somewhere else.
    await expect(openCodeIntegration.planLaunch({
      context: context(join(tmpdir(), "elsewhere", "my-config.jsonc")),
      credentialEnvironment: {},
      args: [],
    })).rejects.toMatchObject({ code: "LAUNCH_CONFIG_UNREACHABLE" });
  });

  it("leaves the environment alone when no configuration was named", async () => {
    const plan = await openCodeIntegration.planLaunch({
      context: context(), credentialEnvironment: {}, args: [],
    });

    expect(plan.environment.XDG_CONFIG_HOME).toBeUndefined();
  });
});
