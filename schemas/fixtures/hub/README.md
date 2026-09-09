# Hub response fixtures

Copied verbatim from the Apexnova AI Hub repository, `openapi/fixtures/`, at
Hub commit `6f07704`. They are the redacted responses Hub publishes alongside
`openapi/apexnova-hub-v1.json`.

They are here to be **fed through `@apexnova-connect/hub-client`'s parsers**
(`packages/hub-client/tests/hub-fixtures.test.ts`), not to be read by hand.
Twice now a whitelist parser has met a documented field and failed in a way that
looked like missing data rather than a parse error:

- a `null` in `promoCovered` threw, and reconciliation filed the exception under
  "Hub has not settled this yet";
- `capabilityStatements` was never parsed, so a field Hub always sends looked to
  us like a field Hub never sent.

Both are caught by running these files through the parsers. A fixture that is
richer than our parser is exactly the case unit tests written from our own
assumptions cannot produce: the test data has to come from the other side.

## Refreshing

```bash
cp <hub-repo>/openapi/fixtures/*.json schemas/fixtures/hub/
```

Then run `pnpm --filter @apexnova-connect/hub-client test`. A failure after a
refresh is the contract having moved, and it is read as a finding rather than a
snapshot to update -- the same rule agreed for the canonical evidence vectors.
Record the Hub commit above when refreshing.
