#!/usr/bin/env node
// Bundles the CLI into a single self-contained ESM file for release.
//
// The output needs only a Node runtime: no npm install, no pnpm, no workspace,
// no build step on the user's machine. `scripts/install.sh` and `install.ps1`
// download exactly this file from the GitHub release.
//
// Usage: pnpm bundle
//
// Env overrides:
//   APEXNOVA_DEFAULT_HUB_BASE_URL    baked-in Hub base URL   (default: production)
//   APEXNOVA_DEFAULT_OAUTH_CLIENT_ID baked-in OAuth client   (default: apexnova-connect)
//   APEXNOVA_BUNDLE_VERSION          override the version    (default: apps/cli/package.json)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliRoot = join(repoRoot, "apps", "cli");
const outDir = join(repoRoot, "dist");
const outFile = join(outDir, "apexnova.mjs");

const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
const version = process.env.APEXNOVA_BUNDLE_VERSION || manifest.version;
if (!version) throw new Error("apps/cli/package.json has no version.");

const defaultHubBaseUrl = process.env.APEXNOVA_DEFAULT_HUB_BASE_URL ?? "https://api.apexnova-consulting.com";
const defaultOauthClientId = process.env.APEXNOVA_DEFAULT_OAUTH_CLIENT_ID ?? "apexnova-connect";

const entryPoint = join(cliRoot, "dist", "run-cli.js");
try {
  readFileSync(entryPoint);
} catch {
  throw new Error(`Missing ${entryPoint}. Run \`pnpm --filter @apexnova-connect/cli... build\` first.`);
}

// A generated entry keeps the shebang out of the bundled source: esbuild puts the
// banner above everything, so an entry that already starts with `#!` would end up
// with a second shebang in the middle of the file.
const generatedEntry = join(outDir, ".bundle-entry.mjs");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  generatedEntry,
  [
    `import { runCli } from ${JSON.stringify(entryPoint)};`,
    "const result = await runCli(process.argv.slice(2));",
    "process.exitCode = result.exitCode;",
    "",
  ].join("\n"),
  "utf8",
);

try {
  await build({
    entryPoints: [generatedEntry],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    // jsonc-parser ships a UMD `main` that calls require() at load time, which an
    // ESM bundle cannot satisfy. Prefer its `module` build instead.
    mainFields: ["module", "main"],
    // Deliberately unminified: users paste stack traces into bug reports, and the
    // wire cost is dominated by gzip either way.
    minify: false,
    banner: {
      js: [
        "#!/usr/bin/env node",
        // Some transitive dependencies are CommonJS and call require() at runtime.
        'import { createRequire as __apexnovaCreateRequire } from "node:module";',
        "const require = __apexnovaCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    define: {
      __APEXNOVA_VERSION__: JSON.stringify(version),
      __APEXNOVA_DEFAULT_HUB_BASE_URL__: JSON.stringify(defaultHubBaseUrl),
      __APEXNOVA_DEFAULT_OAUTH_CLIENT_ID__: JSON.stringify(defaultOauthClientId),
    },
    logLevel: "warning",
  });
} finally {
  rmSync(generatedEntry, { force: true });
}

const bytes = readFileSync(outFile);
const digest = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${outFile}.sha256`, `${digest}  apexnova.mjs\n`, "utf8");

// Smoke-test the artifact we are about to publish, so a broken bundle fails the
// release instead of the user's first command.
const reported = execFileSync(process.execPath, [outFile, "--version"], { encoding: "utf8" }).trim();
if (reported !== `apexnova ${version}`) {
  throw new Error(`Bundle reported "${reported}" but the release version is ${version}.`);
}

process.stdout.write(
  [
    `bundle   ${outFile}`,
    `version  ${version}`,
    `hub      ${defaultHubBaseUrl} (client ${defaultOauthClientId})`,
    `size     ${(bytes.byteLength / 1024).toFixed(1)} KiB`,
    `sha256   ${digest}`,
    "",
  ].join("\n"),
);
