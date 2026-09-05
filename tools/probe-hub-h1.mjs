#!/usr/bin/env node

import { HubControlPlaneClient, HubOAuthClient } from "../packages/hub-client/dist/index.js";

const baseUrl = process.env.APEXNOVA_HUB_BASE_URL;
const clientId = process.env.APEXNOVA_OAUTH_CLIENT_ID;
if (!baseUrl || !clientId) {
  throw new Error("APEXNOVA_HUB_BASE_URL and APEXNOVA_OAUTH_CLIENT_ID are required.");
}

const url = new URL(baseUrl);
const allowInsecureLoopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const interactive = process.argv.includes("--interactive");
const includeInference = process.argv.includes("--include-inference");
const includeRuntimeCredential = process.argv.includes("--include-runtime-credential") || includeInference;
const inferenceModel = process.env.APEXNOVA_HUB_INFERENCE_MODEL?.trim();
const requestTimeoutMs = Number(process.env.APEXNOVA_HUB_REQUEST_TIMEOUT_MS ?? (interactive ? 60_000 : 15_000));
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
  throw new Error("APEXNOVA_HUB_REQUEST_TIMEOUT_MS must be a positive integer.");
}
const oauth = new HubOAuthClient({
  baseUrl,
  clientId,
  scope: "account:read catalog:read billing:read runtime-credentials:write",
  requestTimeoutMs,
  ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
});

async function revokeWithRetry(token) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await oauth.revoke(token);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (interactive) {
    process.stderr.write(`[warning] OAuth token revocation failed after retry: ${lastError?.message ?? "unknown error"}\n`);
  }
}

await oauth.discover();
const authorization = await oauth.startDeviceAuthorization();
if (interactive) {
  const verificationUrl = new URL(process.env.APEXNOVA_HUB_VERIFICATION_URL ?? authorization.verificationUri);
  verificationUrl.searchParams.set("user_code", authorization.userCode);
  process.stderr.write(`Open ${verificationUrl.toString()}\nEnter code: ${authorization.userCode}\nExpires: ${authorization.expiresAt}\n`);
}
const tokens = await oauth.waitForDeviceAuthorization(
  authorization,
  interactive ? {} : { sleep: async () => undefined },
);
if (interactive) process.stderr.write("[passed] OAuth device authorization and token exchange\n");

let created;
try {
  const control = new HubControlPlaneClient({
    baseUrl,
    accessToken: async () => tokens.accessToken,
    requestTimeoutMs,
    ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
  });

  const [account, balance, catalog] = await Promise.all([
    control.me(),
    control.balance(),
    control.catalog(),
  ]);
  if (interactive) process.stderr.write("[passed] Account, balance, and atomic catalog\n");

  let runtimeCredential;
  let inference;
  if (includeRuntimeCredential) {
    const normalizedInferenceModel = inferenceModel?.toLowerCase();
    const deployment = catalog.deployments.find((item) => {
      const isCompatible = item.availability.status === "available" &&
        (!includeInference || item.protocols.some((candidate) => candidate.protocol === "openai-chat"));
      if (!isCompatible || !normalizedInferenceModel) return isCompatible;
      return [item.id, item.modelId, item.displayName, item.inferenceAlias, ...(item.aliases ?? [])]
        .some((candidate) => candidate.toLowerCase() === normalizedInferenceModel);
    });
    const protocol = includeInference
      ? deployment?.protocols.find((candidate) => candidate.protocol === "openai-chat")
      : deployment?.protocols[0];
    if (!deployment || !protocol) {
      const target = inferenceModel ? ` matching ${JSON.stringify(inferenceModel)}` : "";
      throw new Error(`The catalog has no compatible available deployment${target} for the probe.`);
    }
    created = await control.createRuntimeCredential({
      name: "Apexnova-connect H1 probe",
      protocols: [protocol.protocol],
      publicDeploymentIds: [deployment.id],
      expiresIn: 300,
    });
    runtimeCredential = { credentialId: created.credentialId, expiresAt: created.expiresAt };
    if (interactive) process.stderr.write("[passed] Runtime credential issuance\n");

    if (includeInference) {
      const inferenceUrl = new URL(protocol.baseUrl);
      const loopbackHostAlias = process.env.APEXNOVA_HUB_LOOPBACK_HOST_ALIAS;
      if (loopbackHostAlias) {
        const allowedAlias = ["localhost", "127.0.0.1", "[::1]"].includes(loopbackHostAlias);
        if (!allowInsecureLoopback || !inferenceUrl.hostname.endsWith(".localhost") || !allowedAlias) {
          throw new Error("APEXNOVA_HUB_LOOPBACK_HOST_ALIAS is only valid for a .localhost inference URL in loopback mode.");
        }
        inferenceUrl.hostname = loopbackHostAlias;
      }
      const response = await fetch(inferenceUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${created.secret.reveal()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: deployment.inferenceAlias,
          messages: [{ role: "user", content: "Reply with exactly OK." }],
          max_tokens: 8,
          stream: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Inference probe failed with HTTP ${response.status}.`);
      await response.arrayBuffer();
      inference = {
        ok: true,
        status: response.status,
        protocol: protocol.protocol,
        deploymentId: deployment.id,
        requestId: response.headers.get("x-apexnova-request-id") ?? undefined,
      };
      if (interactive) process.stderr.write("[passed] Minimal live inference\n");
    }
  }

  if (created) {
    await control.revokeRuntimeCredential(created.credentialId);
    runtimeCredential = { ...runtimeCredential, revoked: true };
    created = undefined;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    accountId: account.accountId,
    userId: account.userId,
    currency: balance.currency,
    catalogVersion: catalog.catalogVersion,
    deployments: catalog.deployments.length,
    ...(runtimeCredential ? { runtimeCredential } : {}),
    ...(inference ? { inference } : {}),
  }, null, 2)}\n`);
} finally {
  if (created) {
    const cleanup = new HubControlPlaneClient({
      baseUrl,
      accessToken: async () => tokens.accessToken,
      requestTimeoutMs,
      ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    });
    await cleanup.revokeRuntimeCredential(created.credentialId).catch(() => {});
  }
  // A refresh-token revocation invalidates its complete rotation family, including
  // access tokens. Do it first so a transient failure between the two calls cannot
  // leave a long-lived refresh token active; the access-token call is an idempotent fallback.
  if (tokens.refreshToken) await revokeWithRetry(tokens.refreshToken);
  await revokeWithRetry(tokens.accessToken);
}
