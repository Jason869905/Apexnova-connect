import { describe, expect, it } from "vitest";

import { nativeWindowsTarget, probeExecutableVersion, toPlatform } from "../src/index.js";

async function version(stdout: string): Promise<string | undefined> {
  const probe = await probeExecutableVersion({
    executable: "example",
    displayName: "Example",
    platform: "linux",
    run: async () => ({ found: true, stdout }),
  });
  return probe.version;
}

describe("probeExecutableVersion", () => {
  it("reads the version out of each product's real banner", async () => {
    expect(await version("opencode 1.18.29\n")).toBe("1.18.29");
    expect(await version("2.1.261 (Claude Code)\n")).toBe("2.1.261");
    expect(await version("codex-cli 0.52.0\n")).toBe("0.52.0");
    // A `v` prefix is part of the version, and the build date that follows must
    // not win: this banner is what Hermes Agent v0.21.0 actually prints.
    expect(await version("Hermes Agent v0.21.0 (2026.8.31) · upstream a7198a88\n")).toBe("0.21.0");
  });

  it("keeps a prerelease suffix", async () => {
    expect(await version("tool v2.0.0-rc.1\n")).toBe("2.0.0-rc.1");
  });

  it("records no version when the version command itself failed", async () => {
    const probe = await probeExecutableVersion({
      executable: "example",
      displayName: "Example",
      platform: "linux",
      // A broken npm install prints a Node crash banner rather than its version.
      run: async () => ({
        found: true,
        stderr: "Error: Missing optional dependency\n\nNode.js v22.23.1\n",
        error: "Command failed",
      }),
    });

    expect(probe.found).toBe(true);
    expect(probe.version).toBeUndefined();
    expect(probe.warnings[0]).toContain("did not complete successfully");
  });

  it("reports a missing executable as a normal result", async () => {
    const probe = await probeExecutableVersion({
      executable: "example",
      displayName: "Example",
      platform: "linux",
      run: async () => ({ found: false }),
    });

    expect(probe.found).toBe(false);
    expect(probe.version).toBeUndefined();
    expect(probe.evidence).toEqual([]);
  });

  it("warns when the executable answers without a recognizable version", async () => {
    const probe = await probeExecutableVersion({
      executable: "example",
      displayName: "Example",
      platform: "linux",
      run: async () => ({ found: true, stdout: "unknown build\n" }),
    });

    expect(probe.found).toBe(true);
    expect(probe.warnings[0]).toContain("recognizable semantic version");
  });

  it("refuses an unsafe executable name or argument", async () => {
    await expect(
      probeExecutableVersion({ executable: "rm -rf /", displayName: "x", platform: "linux" }),
    ).rejects.toThrowError(TypeError);
    await expect(
      probeExecutableVersion({
        executable: "example",
        displayName: "x",
        platform: "linux",
        args: ["--version; rm -rf /"],
      }),
    ).rejects.toThrowError(TypeError);
  });

  it("maps node platforms onto the manifest vocabulary", () => {
    expect(toPlatform("win32")).toBe("windows");
    expect(toPlatform("darwin")).toBe("macos");
    expect(toPlatform("linux")).toBe("linux");
    expect(toPlatform("freebsd")).toBeUndefined();
  });
});

describe("nativeWindowsTarget", () => {
  it("picks the .exe a launcher would start, not the shim beside it", () => {
    // Observed on 2026-09-13: one machine carried Claude Code twice -- npm's
    // shim at 2.1.233 and a native exe at 2.1.201 -- and the probe reported the
    // shim's version while the launcher started the exe. Every Windows launcher
    // in this repository resolves `<name>.exe`, because a `.cmd` cannot be
    // spawned with `shell:false`.
    const output = [
      "C:\\Users\\someone\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\someone\\.local\\bin\\claude.exe",
    ].join("\r\n");

    expect(nativeWindowsTarget(output)).toBe("C:\\Users\\someone\\.local\\bin\\claude.exe");
  });

  it("prefers the first .exe when PATH offers several", () => {
    const output = "C:\\first\\tool.exe\r\nC:\\second\\tool.exe\r\n";

    expect(nativeWindowsTarget(output)).toBe("C:\\first\\tool.exe");
  });

  it("finds nothing when only a shim is installed", () => {
    // The launcher will refuse in this case, and saying so honestly is better
    // than reporting a version for something that cannot be started.
    const output = "C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd\r\n";

    expect(nativeWindowsTarget(output)).toBeUndefined();
  });
});
