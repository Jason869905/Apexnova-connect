#!/usr/bin/env node

import { HubControlPlaneClient, HubOAuthClient } from "../packages/hub-client/dist/index.js";

const baseUrl = process.env.APEXNOVA_HUB_BASE_URL;
const clientId = process.env.APEXNOVA_OAUTH_CLIENT_ID;
if (!baseUrl || !clientId) {
  throw new Error("APEXNOVA_HUB_BASE_URL and APEXNOVA_OAUTH_CLIENT_ID are required.");
}

const url = new URL(baseUrl);
const allowInsecureLoopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const oauth = new HubOAuthClient({
  baseUrl,
  clientId,
  scope: "account:read catalog:read billing:read runtime-credentials:write",
  ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
});

await oauth.discover();
const authorization = await oauth.startDeviceAuthorization();
const tokens = await oauth.waitForDeviceAuthorization(authorization, { sleep: async () => undefined });
const control = new HubControlPlaneClient({
  baseUrl,
  accessToken: async () => tokens.accessToken,
  ...(allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
});

const [account, balance, catalog] = await Promise.all([
  control.me(),
  control.balance(),
  control.catalog(),
]);

let runtimeCredential;
if (process.argv.includes("--include-runtime-credential")) {
  const deployment = catalog.deployments.find((item) => item.availability.status === "available");
  const protocol = deployment?.protocols[0];
  if (!deployment || !protocol) throw new Error("The catalog has no available deployment for the probe.");
  const created = await control.createRuntimeCredential({
    name: "Apexnova-connect H1 probe",
    protocols: [protocol.protocol],
    publicDeploymentIds: [deployment.id],
    expiresIn: 300,
  });
  await control.revokeRuntimeCredential(created.credentialId);
  runtimeCredential = { credentialId: created.credentialId, expiresAt: created.expiresAt, revoked: true };
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  accountId: account.accountId,
  userId: account.userId,
  currency: balance.currency,
  catalogVersion: catalog.catalogVersion,
  deployments: catalog.deployments.length,
  ...(runtimeCredential ? { runtimeCredential } : {}),
}, null, 2)}\n`);
