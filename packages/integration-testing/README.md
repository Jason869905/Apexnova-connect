# Integration Testing

`describeIntegrationContract` is the suite every Agent Integration must pass before it can move past `research`. It exercises the shared lifecycle against a real temporary directory: manifest validity and drift, detection on a machine where the product was never installed, refusal of configuration formats the integration does not understand, plan determinism and idempotence, the absence of secrets in a serialized plan, and an apply → verify → rollback round trip that must restore the original bytes.

Call it from the integration's own `tests/` directory:

```ts
describeIntegrationContract({
  integration: createOpenCodeIntegration({ runVersionCommand: async () => ({ found: true, stdout: "1.18.29" }) }),
  manifestJson: JSON.parse(await readFile(manifestPath, "utf8")),
  configFileName: "opencode.jsonc",
  intent,
  unsupportedConfigs: [...],
});
```

The suite deliberately does not reach the network, a credential store, or the user's real configuration. Anything a product-specific test needs beyond this contract belongs in that integration's own tests.
