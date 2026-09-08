import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ApplyReceipt,
  ChangePlan,
  WriteFileOperation,
} from "@apexnova-connect/integration-sdk";

import { ConfigExecutionError, FileConfigExecutor } from "../src/index.js";

const temporaryRoots = new Set<string>();

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "apexnova-connect-config-engine-"));
  temporaryRoots.add(root);
  const configRoot = join(root, "config");
  const backupRoot = join(root, "backups");
  await mkdir(configRoot);

  return {
    root,
    configRoot,
    backupRoot,
    executor: new FileConfigExecutor({
      allowedRoots: [configRoot],
      backupRoot,
      now: () => new Date("2026-09-02T20:00:00.000Z"),
    }),
  };
}

function update(path: string, from: string, to: string): WriteFileOperation {
  return {
    type: "write-file",
    path,
    mode: "update",
    expectedContentHash: hash(from),
    content: to,
    containsSecrets: false,
  };
}

function transactionId(receipt: ApplyReceipt): string {
  return (receipt.rollbackToken as { transactionId: string }).transactionId;
}

/** Ordering comes from `appliedAt`, so transactions need a clock that moves. */
function advancingExecutor(configRoot: string, backupRoot: string): FileConfigExecutor {
  let elapsed = 0;
  return new FileConfigExecutor({
    allowedRoots: [configRoot],
    backupRoot,
    now: () => new Date(Date.parse("2026-09-02T20:00:00.000Z") + (elapsed += 1_000)),
  });
}

function plan(operation: WriteFileOperation): ChangePlan {
  return {
    id: "config-plan-1",
    integrationId: "test-agent",
    summary: "Update a test configuration.",
    createdAt: "2026-09-02T20:00:00.000Z",
    operations: [operation],
    requiresRestart: true,
    warnings: [],
  };
}

afterEach(async () => {
  for (const root of temporaryRoots) {
    const resolvedTemp = await realpath(tmpdir());
    if (
      (await realpath(dirname(root))) !== resolvedTemp ||
      !basename(root).startsWith("apexnova-connect-config-engine-")
    ) {
      throw new Error(`Refusing to remove unexpected test directory: ${root}`);
    }
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }
});

describe("FileConfigExecutor", () => {
  it("atomically updates a file and restores its backup", async () => {
    const { backupRoot, configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = "{\"provider\":\"original\"}\n";
    const updated = "{\"provider\":\"apexnova\"}\n";
    await writeFile(target, original, "utf8");

    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: target,
        mode: "update",
        expectedContentHash: hash(original),
        content: updated,
        containsSecrets: false,
      }),
    );

    expect(await readFile(target, "utf8")).toBe(updated);
    expect((await readdir(backupRoot)).length).toBe(1);

    await executor.rollback(receipt);

    expect(await readFile(target, "utf8")).toBe(original);
    expect(await readdir(backupRoot)).toEqual([]);
  });

  it("removes a newly created file during rollback", async () => {
    const { configRoot, executor } = await fixture();
    const target = join(configRoot, "new-config.json");

    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: target,
        mode: "create",
        expectedContentHash: null,
        content: "{}\n",
        containsSecrets: false,
      }),
    );
    expect(await readFile(target, "utf8")).toBe("{}\n");

    await executor.rollback(receipt);

    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects targets outside explicitly allowed roots", async () => {
    const { executor, root } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    const target = join(outside, "settings.json");

    await expect(
      executor.apply(
        plan({
          type: "write-file",
          path: target,
          mode: "create",
          expectedContentHash: null,
          content: "{}\n",
          containsSecrets: false,
        }),
      ),
    ).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOT",
    } satisfies Partial<ConfigExecutionError>);
  });

  it("detects concurrent changes before writing", async () => {
    const { configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = "{\"value\":1}\n";
    const concurrent = "{\"value\":2}\n";
    await writeFile(target, original, "utf8");
    const changePlan = plan({
      type: "write-file",
      path: target,
      mode: "update",
      expectedContentHash: hash(original),
      content: "{\"value\":3}\n",
      containsSecrets: false,
    });
    await writeFile(target, concurrent, "utf8");

    await expect(executor.apply(changePlan)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(target, "utf8")).toBe(concurrent);
  });

  it.skipIf(process.platform === "win32")(
    "refuses to follow a symbolic-link target",
    async () => {
      const { configRoot, executor, root } = await fixture();
      const actual = join(root, "actual.json");
      const target = join(configRoot, "settings.json");
      await writeFile(actual, "{}\n", "utf8");
      await symlink(actual, target);

      await expect(
        executor.apply(
          plan({
            type: "write-file",
            path: target,
            mode: "update",
            expectedContentHash: hash("{}\n"),
            content: "{\"changed\":true}\n",
            containsSecrets: false,
          }),
        ),
      ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
    },
  );

  it("does not overwrite edits made after apply when rolling back", async () => {
    const { configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = "{\"value\":1}\n";
    const applied = "{\"value\":2}\n";
    const userEdit = "{\"value\":3}\n";
    await writeFile(target, original, "utf8");

    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: target,
        mode: "update",
        expectedContentHash: hash(original),
        content: applied,
        containsSecrets: false,
      }),
    );
    await writeFile(target, userEdit, "utf8");

    await expect(executor.rollback(receipt)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(target, "utf8")).toBe(userEdit);
  });

  it("rejects duplicate targets before applying any operation", async () => {
    const { configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const changePlan: ChangePlan = {
      ...plan({
        type: "write-file",
        path: target,
        mode: "create",
        expectedContentHash: null,
        content: "{}\n",
        containsSecrets: false,
      }),
      operations: [
        {
          type: "write-file",
          path: target,
          mode: "create",
          expectedContentHash: null,
          content: "{}\n",
          containsSecrets: false,
        },
        {
          type: "write-file",
          path: target,
          mode: "create",
          expectedContentHash: null,
          content: "{\"again\":true}\n",
          containsSecrets: false,
        },
      ],
    };

    await expect(executor.apply(changePlan)).rejects.toMatchObject({
      code: "INVALID_PLAN",
    });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a forged rollback transaction", async () => {
    const { configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = "{}\n";
    await writeFile(target, original, "utf8");
    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: target,
        mode: "update",
        expectedContentHash: hash(original),
        content: "{\"changed\":true}\n",
        containsSecrets: false,
      }),
    );
    const forgedReceipt: ApplyReceipt = {
      ...receipt,
      rollbackToken: {
        version: 2,
        transactionId: "../forged",
      },
    };

    await expect(executor.rollback(forgedReceipt)).rejects.toMatchObject({
      code: "INVALID_RECEIPT",
    });

    await executor.rollback(receipt);
  });

  it("discovers and restores a transaction with a new executor instance", async () => {
    const { backupRoot, configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = "{\"provider\":\"original\"}\n";
    const updated = "{\"provider\":\"apexnova\"}\n";
    await writeFile(target, original, "utf8");

    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: target,
        mode: "update",
        expectedContentHash: hash(original),
        content: updated,
        containsSecrets: false,
      }),
    );

    const restartedExecutor = new FileConfigExecutor({
      allowedRoots: [configRoot],
      backupRoot,
    });
    const backups = await restartedExecutor.listBackups();
    expect(backups).toEqual([
      expect.objectContaining({
        transactionId: (receipt.rollbackToken as { transactionId: string })
          .transactionId,
        planId: receipt.planId,
        integrationId: "test-agent",
        state: "applied",
        operationCount: 1,
      }),
    ]);

    const recoveredReceipt = await restartedExecutor.getReceipt(
      backups[0]!.transactionId,
    );
    await restartedExecutor.rollback(recoveredReceipt);

    expect(await readFile(target, "utf8")).toBe(original);
    expect(await restartedExecutor.listBackups()).toEqual([]);
  });

  it("rejects corrupted persisted transaction metadata", async () => {
    const { backupRoot, configRoot, executor } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = "{}\n";
    const updated = "{\"changed\":true}\n";
    await writeFile(target, original, "utf8");

    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: target,
        mode: "update",
        expectedContentHash: hash(original),
        content: updated,
        containsSecrets: false,
      }),
    );
    const { transactionId } = receipt.rollbackToken as { transactionId: string };
    const metadataPath = join(backupRoot, transactionId, "transaction.json");
    const document = JSON.parse(await readFile(metadataPath, "utf8")) as {
      transaction: { planId: string };
    };
    document.transaction.planId = "tampered-plan";
    await writeFile(metadataPath, `${JSON.stringify(document)}\n`, "utf8");

    const restartedExecutor = new FileConfigExecutor({
      allowedRoots: [configRoot],
      backupRoot,
    });
    await expect(restartedExecutor.rollback(receipt)).rejects.toMatchObject({
      code: "INVALID_RECEIPT",
    });
    expect(await readFile(target, "utf8")).toBe(updated);
  });

  it("leaves a refused rollback marked applied, not rolling-back", async () => {
    const { configRoot, executor } = await fixture();
    const configPath = join(configRoot, "agent.json");

    const receipt = await executor.apply(
      plan({
        type: "write-file",
        path: configPath,
        mode: "create",
        expectedContentHash: null,
        content: '{"managed":true}\n',
        containsSecrets: false,
      }),
    );

    // Someone edits the file after it was applied, so removing it would discard
    // a change this transaction never made.
    await writeFile(configPath, '{"managed":true,"edited":true}\n', "utf8");

    await expect(executor.rollback(receipt)).rejects.toMatchObject({ code: "CONFLICT" });

    // Nothing was undone, so the transaction must still read as applied and the
    // file must be untouched -- otherwise a recovery scan sees a half-undone
    // transaction that never started.
    const summaries = await executor.listBackups();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.state).toBe("applied");
    expect(await readFile(configPath, "utf8")).toBe('{"managed":true,"edited":true}\n');

    // And it stays retryable: undo the edit and the same rollback succeeds.
    await writeFile(configPath, '{"managed":true}\n', "utf8");
    await executor.rollback(receipt);
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("takes restore ordering from the backups and refuses a superseded transaction", async () => {
    const { backupRoot, configRoot } = await fixture();
    const target = join(configRoot, "settings.json");
    const original = '{"provider":"original"}\n';
    const first = '{"provider":"apexnova"}\n';
    const second = '{"provider":"apexnova-2"}\n';
    await writeFile(target, original, "utf8");
    const executor = advancingExecutor(configRoot, backupRoot);

    const firstReceipt = await executor.apply(plan(update(target, original, first)));
    const secondReceipt = await executor.apply({
      ...plan(update(target, first, second)),
      id: "config-plan-2",
    });

    expect((await executor.listBackups()).map((item) => [item.transactionId, item.restorable])).toEqual([
      [transactionId(secondReceipt), true],
      [transactionId(firstReceipt), false],
    ]);

    // Holding the older receipt is not permission to undo it: the newer
    // transaction is what the file holds, and the backups are what say so.
    await expect(executor.rollback(firstReceipt)).rejects.toMatchObject({
      code: "ROLLBACK_ORDER_CONFLICT",
    });
    expect(await readFile(target, "utf8")).toBe(second);

    // Undoing the newer one hands the position back, so there is always a way
    // out rather than a transaction that no direction can restore.
    await executor.rollback(secondReceipt);
    expect(await readFile(target, "utf8")).toBe(first);
    expect((await executor.listBackups()).map((item) => [item.transactionId, item.restorable])).toEqual([
      [transactionId(firstReceipt), true],
    ]);

    await executor.rollback(firstReceipt);
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("scopes restore ordering to the integration that wrote the backup", async () => {
    const { backupRoot, configRoot } = await fixture();
    const own = join(configRoot, "own.json");
    const other = join(configRoot, "other.json");
    await writeFile(own, "{}\n", "utf8");
    await writeFile(other, "{}\n", "utf8");
    const executor = advancingExecutor(configRoot, backupRoot);

    const ownReceipt = await executor.apply(plan(update(own, "{}\n", '{"own":true}\n')));
    await executor.apply({
      ...plan(update(other, "{}\n", '{"other":true}\n')),
      id: "config-plan-2",
      integrationId: "other-agent",
    });

    // A newer transaction from another integration writes other files, so it
    // says nothing about this one.
    await executor.rollback(ownReceipt);
    expect(await readFile(own, "utf8")).toBe("{}\n");
    expect(await readFile(other, "utf8")).toBe('{"other":true}\n');
  });

  it("does not let a damaged sibling backup block an unrelated rollback", async () => {
    const { backupRoot, configRoot } = await fixture();
    const own = join(configRoot, "own.json");
    const other = join(configRoot, "other.json");
    await writeFile(own, "{}\n", "utf8");
    await writeFile(other, "{}\n", "utf8");
    const executor = advancingExecutor(configRoot, backupRoot);

    const ownReceipt = await executor.apply(plan(update(own, "{}\n", '{"own":true}\n')));
    const otherReceipt = await executor.apply({
      ...plan(update(other, "{}\n", '{"other":true}\n')),
      id: "config-plan-2",
      integrationId: "other-agent",
    });
    await writeFile(
      join(backupRoot, transactionId(otherReceipt), "transaction.json"),
      "not json\n",
      "utf8",
    );

    // Listing stays strict so damage is reported rather than hidden.
    await expect(executor.listBackups()).rejects.toMatchObject({ code: "INVALID_RECEIPT" });

    await executor.rollback(ownReceipt);
    expect(await readFile(own, "utf8")).toBe("{}\n");
  });
});
