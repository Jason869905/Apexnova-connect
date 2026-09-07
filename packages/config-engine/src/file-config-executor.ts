import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  ApplyReceipt,
  ChangeExecutor,
  ChangePlan,
  WriteFileOperation,
} from "@apexnova-connect/integration-sdk";

export type ConfigExecutionErrorCode =
  | "INVALID_PLAN"
  | "PATH_OUTSIDE_ALLOWED_ROOT"
  | "SYMLINK_NOT_ALLOWED"
  | "CONFLICT"
  | "INVALID_RECEIPT"
  | "APPLY_FAILED"
  | "ROLLBACK_FAILED";

export class ConfigExecutionError extends Error {
  readonly code: ConfigExecutionErrorCode;

  constructor(code: ConfigExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigExecutionError";
    this.code = code;
  }
}

export interface FileConfigExecutorOptions {
  readonly allowedRoots: readonly string[];
  readonly backupRoot: string;
  readonly now?: () => Date;
}

export interface FileRollbackEntry {
  readonly targetPath: string;
  readonly mode: "create" | "update";
  readonly backupPath: string | null;
  readonly originalContentHash: string | null;
  readonly appliedContentHash: string;
  readonly originalFileMode: number | null;
}

export interface FileRollbackToken {
  readonly version: 2;
  readonly transactionId: string;
}

export type FileBackupState = "applying" | "applied" | "rolling-back";

export interface FileBackupSummary {
  readonly transactionId: string;
  readonly planId: string;
  readonly integrationId: string;
  readonly createdAt: string;
  readonly appliedAt: string;
  readonly state: FileBackupState;
  readonly operationCount: number;
}

interface FileTransaction {
  readonly version: 1;
  readonly transactionId: string;
  readonly planId: string;
  readonly integrationId: string;
  readonly createdAt: string;
  readonly appliedAt: string;
  readonly state: FileBackupState;
  readonly entries: readonly FileRollbackEntry[];
}

interface FileTransactionDocument {
  readonly checksum: string;
  readonly transaction: FileTransaction;
}

interface PreparedWrite {
  readonly operation: WriteFileOperation;
  readonly targetPath: string;
  readonly parentPath: string;
  readonly originalContentHash: string | null;
  readonly originalFileMode: number | null;
}

function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizedComparisonPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}

async function pathMetadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isFileRollbackEntry(value: unknown): value is FileRollbackEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<FileRollbackEntry>;
  return (
    typeof entry.targetPath === "string" &&
    (entry.mode === "create" || entry.mode === "update") &&
    (entry.backupPath === null || typeof entry.backupPath === "string") &&
    (entry.originalContentHash === null || isSha256(entry.originalContentHash)) &&
    isSha256(entry.appliedContentHash) &&
    (entry.originalFileMode === null || Number.isInteger(entry.originalFileMode))
  );
}

function isFileRollbackToken(value: unknown): value is FileRollbackToken {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Partial<FileRollbackToken>;
  return (
    token.version === 2 &&
    typeof token.transactionId === "string" &&
    /^transaction-[0-9]+-[0-9a-f-]{36}$/.test(token.transactionId)
  );
}

function isFileBackupState(value: unknown): value is FileBackupState {
  return value === "applying" || value === "applied" || value === "rolling-back";
}

function isFileTransaction(value: unknown): value is FileTransaction {
  if (typeof value !== "object" || value === null) return false;
  const transaction = value as Partial<FileTransaction>;
  return (
    transaction.version === 1 &&
    typeof transaction.transactionId === "string" &&
    /^transaction-[0-9]+-[0-9a-f-]{36}$/.test(transaction.transactionId) &&
    typeof transaction.planId === "string" &&
    transaction.planId.length > 0 &&
    typeof transaction.integrationId === "string" &&
    transaction.integrationId.length > 0 &&
    typeof transaction.createdAt === "string" &&
    typeof transaction.appliedAt === "string" &&
    isFileBackupState(transaction.state) &&
    Array.isArray(transaction.entries) &&
    transaction.entries.every(isFileRollbackEntry)
  );
}

async function removeTransactionDirectory(transactionDirectory: string): Promise<void> {
  const entries = await readdir(transactionDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      (entry.name !== "transaction.json" && !/^\d{4}\.backup$/.test(entry.name))
    ) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Unexpected backup entry ${entry.name}; refusing recursive cleanup.`,
      );
    }
    await unlink(join(transactionDirectory, entry.name));
  }
  await rmdir(transactionDirectory);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FileConfigExecutor implements ChangeExecutor {
  readonly #allowedRoots: readonly string[];
  readonly #backupRoot: string;
  readonly #now: () => Date;

  constructor(options: FileConfigExecutorOptions) {
    if (options.allowedRoots.length === 0) {
      throw new ConfigExecutionError(
        "INVALID_PLAN",
        "At least one allowed configuration root is required.",
      );
    }

    for (const root of [...options.allowedRoots, options.backupRoot]) {
      if (!isAbsolute(root)) {
        throw new ConfigExecutionError(
          "INVALID_PLAN",
          `Executor paths must be absolute: ${root}.`,
        );
      }
    }

    this.#allowedRoots = options.allowedRoots.map((root) => resolve(root));
    this.#backupRoot = resolve(options.backupRoot);
    this.#now = options.now ?? (() => new Date());
  }

  async #resolvedAllowedRoots(): Promise<readonly string[]> {
    return Promise.all(this.#allowedRoots.map(async (root) => normalizedComparisonPath(await realpath(root))));
  }

  async #assertAllowedTarget(
    targetPath: string,
    allowedRoots: readonly string[],
  ): Promise<{ readonly targetPath: string; readonly parentPath: string }> {
    if (!isAbsolute(targetPath)) {
      throw new ConfigExecutionError(
        "INVALID_PLAN",
        `Configuration target must be absolute: ${targetPath}.`,
      );
    }

    const resolvedTarget = resolve(targetPath);
    const parentPath = await realpath(dirname(resolvedTarget));
    const comparableParent = normalizedComparisonPath(parentPath);
    const actualTarget = join(parentPath, basename(resolvedTarget));
    const comparableTarget = normalizedComparisonPath(actualTarget);

    if (!allowedRoots.some((root) => isPathInside(root, comparableParent))) {
      throw new ConfigExecutionError(
        "PATH_OUTSIDE_ALLOWED_ROOT",
        `Configuration target is outside the allowed roots: ${targetPath}.`,
      );
    }

    const metadata = await pathMetadata(actualTarget);
    if (metadata?.isSymbolicLink()) {
      throw new ConfigExecutionError(
        "SYMLINK_NOT_ALLOWED",
        `Configuration target cannot be a symbolic link: ${targetPath}.`,
      );
    }
    if (metadata && !metadata.isFile()) {
      throw new ConfigExecutionError(
        "INVALID_PLAN",
        `Configuration target must be a regular file: ${targetPath}.`,
      );
    }

    return {
      targetPath: actualTarget,
      parentPath,
    };
  }

  async #prepare(plan: ChangePlan): Promise<readonly PreparedWrite[]> {
    if (!plan.id.trim() || !plan.integrationId.trim() || plan.operations.length === 0) {
      throw new ConfigExecutionError(
        "INVALID_PLAN",
        "A change plan requires IDs and at least one operation.",
      );
    }

    const allowedRoots = await this.#resolvedAllowedRoots();
    const seenTargets = new Set<string>();
    const prepared: PreparedWrite[] = [];

    for (const operation of plan.operations) {
      if (
        operation.type !== "write-file" ||
        operation.containsSecrets !== false ||
        typeof operation.path !== "string" ||
        typeof operation.content !== "string" ||
        (operation.mode !== "create" && operation.mode !== "update")
      ) {
        throw new ConfigExecutionError(
          "INVALID_PLAN",
          "Only non-secret write-file operations are supported.",
        );
      }

      const target = await this.#assertAllowedTarget(operation.path, allowedRoots);
      if (seenTargets.has(target.targetPath)) {
        throw new ConfigExecutionError(
          "INVALID_PLAN",
          `A plan cannot write the same target more than once: ${operation.path}.`,
        );
      }
      seenTargets.add(target.targetPath);

      const metadata = await pathMetadata(target.targetPath);
      const original = metadata ? await readFile(target.targetPath) : null;
      const originalContentHash = original ? sha256(original) : null;

      if (operation.mode === "create" && metadata) {
        throw new ConfigExecutionError(
          "CONFLICT",
          `Create target already exists: ${operation.path}.`,
        );
      }
      if (operation.mode === "create" && operation.expectedContentHash !== null) {
        throw new ConfigExecutionError(
          "INVALID_PLAN",
          "Create operations must use a null expected content hash.",
        );
      }
      if (operation.mode === "update" && !isSha256(operation.expectedContentHash)) {
        throw new ConfigExecutionError(
          "INVALID_PLAN",
          "Update operations require a SHA-256 expected content hash.",
        );
      }
      if (operation.mode === "update" && !metadata) {
        throw new ConfigExecutionError(
          "CONFLICT",
          `Update target does not exist: ${operation.path}.`,
        );
      }
      if (
        operation.mode === "update" &&
        operation.expectedContentHash !== originalContentHash
      ) {
        throw new ConfigExecutionError(
          "CONFLICT",
          `Configuration changed after planning: ${operation.path}.`,
        );
      }

      prepared.push({
        operation,
        targetPath: target.targetPath,
        parentPath: target.parentPath,
        originalContentHash,
        originalFileMode: metadata ? metadata.mode & 0o777 : null,
      });
    }

    return prepared;
  }

  async #atomicWrite(
    targetPath: string,
    parentPath: string,
    content: string | Uint8Array,
    fileMode: number,
    expectedContentHash: string | null,
  ): Promise<void> {
    const allowedRoots = await this.#resolvedAllowedRoots();
    await this.#assertAllowedTarget(targetPath, allowedRoots);
    await this.#assertExpectedContent(targetPath, expectedContentHash);

    const temporaryPath = join(
      parentPath,
      `.${basename(targetPath)}.apexnova-connect-${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporaryPath, "wx", fileMode);
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#assertExpectedContent(targetPath, expectedContentHash);
      await rename(temporaryPath, targetPath);
      await chmod(targetPath, fileMode);
      await syncDirectory(parentPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  async #assertExpectedContent(
    targetPath: string,
    expectedContentHash: string | null,
  ): Promise<void> {
    const metadata = await pathMetadata(targetPath);
    if (expectedContentHash === null) {
      if (metadata) {
        throw new ConfigExecutionError(
          "CONFLICT",
          `Create target appeared after planning: ${targetPath}.`,
        );
      }
      return;
    }

    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new ConfigExecutionError(
        "CONFLICT",
        `Update target changed type or disappeared after planning: ${targetPath}.`,
      );
    }
    const currentHash = sha256(await readFile(targetPath));
    if (currentHash !== expectedContentHash) {
      throw new ConfigExecutionError(
        "CONFLICT",
        `Configuration changed after planning: ${targetPath}.`,
      );
    }
  }

  async #resolvedBackupRoot(): Promise<string> {
    await mkdir(this.#backupRoot, { recursive: true, mode: 0o700 });
    return (await this.#existingBackupRoot())!;
  }

  async #existingBackupRoot(): Promise<string | null> {
    const existing = await pathMetadata(this.#backupRoot);
    if (existing === null) return null;
    const metadata = await lstat(this.#backupRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        "Backup root must be a regular directory, not a symbolic link.",
      );
    }
    return normalizedComparisonPath(await realpath(this.#backupRoot));
  }

  async #transactionDirectory(transactionId: string): Promise<string> {
    if (!/^transaction-[0-9]+-[0-9a-f-]{36}$/.test(transactionId)) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        "Backup transaction ID is invalid.",
      );
    }
    const backupRoot = await this.#existingBackupRoot();
    if (backupRoot === null) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup transaction does not exist: ${transactionId}.`,
      );
    }
    const transactionDirectory = join(backupRoot, transactionId);
    if (normalizedComparisonPath(dirname(transactionDirectory)) !== backupRoot) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        "Backup transaction escaped the configured backup root.",
      );
    }
    return transactionDirectory;
  }

  async #writeStorageFile(path: string, content: string): Promise<void> {
    const parentPath = dirname(path);
    const current = await pathMetadata(path);
    if (current?.isSymbolicLink() || (current && !current.isFile())) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup metadata target must be a regular file: ${path}.`,
      );
    }

    const temporaryPath = join(parentPath, `.transaction-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
      await syncDirectory(parentPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  async #writeTransaction(transaction: FileTransaction): Promise<void> {
    const transactionDirectory = await this.#transactionDirectory(
      transaction.transactionId,
    );
    const directoryMetadata = await lstat(transactionDirectory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        "Backup transaction must be a regular directory.",
      );
    }

    const payload = JSON.stringify(transaction);
    const document: FileTransactionDocument = {
      checksum: sha256(payload),
      transaction,
    };
    await this.#writeStorageFile(
      join(transactionDirectory, "transaction.json"),
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }

  async #readTransaction(transactionId: string): Promise<FileTransaction> {
    const transactionDirectory = await this.#transactionDirectory(transactionId);
    const directoryMetadata = await pathMetadata(transactionDirectory);
    if (
      !directoryMetadata ||
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup transaction does not exist: ${transactionId}.`,
      );
    }

    const metadataPath = join(transactionDirectory, "transaction.json");
    const metadata = await pathMetadata(metadataPath);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup transaction metadata is missing: ${transactionId}.`,
      );
    }

    let document: unknown;
    try {
      document = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (cause) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup transaction metadata is invalid: ${transactionId}.`,
        { cause },
      );
    }
    if (typeof document !== "object" || document === null) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup transaction metadata is invalid: ${transactionId}.`,
      );
    }
    const candidate = document as Partial<FileTransactionDocument>;
    if (
      !isSha256(candidate.checksum) ||
      !isFileTransaction(candidate.transaction) ||
      candidate.transaction.transactionId !== transactionId ||
      sha256(JSON.stringify(candidate.transaction)) !== candidate.checksum
    ) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        `Backup transaction failed integrity validation: ${transactionId}.`,
      );
    }

    for (const [index, entry] of candidate.transaction.entries.entries()) {
      const expectedBackupPath = join(
        transactionDirectory,
        `${index.toString().padStart(4, "0")}.backup`,
      );
      if (
        (entry.mode === "create" && entry.backupPath !== null) ||
        (entry.mode === "update" &&
          normalizedComparisonPath(entry.backupPath ?? "") !==
            normalizedComparisonPath(expectedBackupPath))
      ) {
        throw new ConfigExecutionError(
          "INVALID_RECEIPT",
          `Backup transaction contains an invalid backup path: ${transactionId}.`,
        );
      }
    }

    return candidate.transaction;
  }

  /**
   * Validates every entry before anything is written, and returns the ones that
   * still need undoing. Throwing from here means the target files were not
   * touched, which is what lets a refused rollback leave the transaction in the
   * state it was actually in.
   */
  async #planRollback(
    entries: readonly FileRollbackEntry[],
  ): Promise<ReadonlySet<FileRollbackEntry>> {
    const allowedRoots = await this.#resolvedAllowedRoots();
    const pending = new Set<FileRollbackEntry>();

    for (const entry of entries) {
      const target = await this.#assertAllowedTarget(entry.targetPath, allowedRoots);
      const metadata = await pathMetadata(target.targetPath);
      const currentHash = metadata ? sha256(await readFile(target.targetPath)) : null;

      if (entry.mode === "create") {
        if (currentHash === null) continue;
        if (currentHash !== entry.appliedContentHash) {
          throw new ConfigExecutionError(
            "CONFLICT",
            `Configuration changed after apply; refusing to remove it: ${entry.targetPath}.`,
          );
        }
        pending.add(entry);
        continue;
      }

      if (!entry.backupPath || !(await pathMetadata(entry.backupPath))?.isFile()) {
        throw new ConfigExecutionError(
          "INVALID_RECEIPT",
          `Rollback backup is missing: ${entry.targetPath}.`,
        );
      }
      const backupHash = sha256(await readFile(entry.backupPath));
      if (backupHash !== entry.originalContentHash) {
        throw new ConfigExecutionError(
          "INVALID_RECEIPT",
          `Rollback backup failed integrity verification: ${entry.targetPath}.`,
        );
      }
      if (currentHash === entry.originalContentHash) continue;
      if (currentHash !== entry.appliedContentHash) {
        throw new ConfigExecutionError(
          "CONFLICT",
          `Configuration changed after apply; refusing to overwrite it: ${entry.targetPath}.`,
        );
      }
      pending.add(entry);
    }

    return pending;
  }

  async #rollbackEntries(entries: readonly FileRollbackEntry[]): Promise<void> {
    await this.#applyRollback(entries, await this.#planRollback(entries));
  }

  async #applyRollback(
    entries: readonly FileRollbackEntry[],
    pending: ReadonlySet<FileRollbackEntry>,
  ): Promise<void> {
    for (const entry of [...entries].reverse()) {
      if (!pending.has(entry)) continue;
      if (entry.mode === "create") {
        await this.#assertExpectedContent(entry.targetPath, entry.appliedContentHash);
        await unlink(entry.targetPath);
        await syncDirectory(dirname(entry.targetPath));
        continue;
      }

      const backup = await readFile(entry.backupPath!);
      await this.#atomicWrite(
        entry.targetPath,
        dirname(entry.targetPath),
        backup,
        entry.originalFileMode ?? 0o600,
        entry.appliedContentHash,
      );
    }
  }

  async listBackups(): Promise<readonly FileBackupSummary[]> {
    const backupRoot = await this.#existingBackupRoot();
    if (backupRoot === null) return [];
    const entries = await readdir(backupRoot, { withFileTypes: true });
    const summaries: FileBackupSummary[] = [];

    for (const entry of entries) {
      if (!/^transaction-[0-9]+-[0-9a-f-]{36}$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ConfigExecutionError(
          "INVALID_RECEIPT",
          `Backup transaction path is not a regular directory: ${entry.name}.`,
        );
      }
      const transaction = await this.#readTransaction(entry.name);
      summaries.push({
        transactionId: transaction.transactionId,
        planId: transaction.planId,
        integrationId: transaction.integrationId,
        createdAt: transaction.createdAt,
        appliedAt: transaction.appliedAt,
        state: transaction.state,
        operationCount: transaction.entries.length,
      });
    }

    return summaries.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
  }

  async getReceipt(transactionId: string): Promise<ApplyReceipt> {
    const transaction = await this.#readTransaction(transactionId);
    return {
      planId: transaction.planId,
      appliedAt: transaction.appliedAt,
      rollbackToken: {
        version: 2,
        transactionId: transaction.transactionId,
      } satisfies FileRollbackToken,
    };
  }

  async apply(plan: ChangePlan): Promise<ApplyReceipt> {
    const prepared = await this.#prepare(plan);
    const backupRoot = await this.#resolvedBackupRoot();
    const appliedAt = this.#now().toISOString();
    const transactionId = `transaction-${this.#now().getTime()}-${randomUUID()}`;
    const transactionDirectory = join(backupRoot, transactionId);
    await mkdir(transactionDirectory, { mode: 0o700 });
    await syncDirectory(backupRoot);

    const entries: FileRollbackEntry[] = [];
    let transaction: FileTransaction | undefined;
    try {
      for (const [index, item] of prepared.entries()) {
        const backupPath =
          item.operation.mode === "update"
            ? join(transactionDirectory, `${index.toString().padStart(4, "0")}.backup`)
            : null;

        if (backupPath) {
          await copyFile(item.targetPath, backupPath);
          await chmod(backupPath, 0o600);
          await syncFile(backupPath);
        }

        entries.push({
          targetPath: item.targetPath,
          mode: item.operation.mode,
          backupPath,
          originalContentHash: item.originalContentHash,
          appliedContentHash: sha256(item.operation.content),
          originalFileMode: item.originalFileMode,
        });
      }
      await syncDirectory(transactionDirectory);

      transaction = {
        version: 1,
        transactionId,
        planId: plan.id,
        integrationId: plan.integrationId,
        createdAt: plan.createdAt,
        appliedAt,
        state: "applying",
        entries,
      };
      await this.#writeTransaction(transaction);

      for (const [index, item] of prepared.entries()) {
        await this.#atomicWrite(
          item.targetPath,
          item.parentPath,
          item.operation.content,
          item.originalFileMode ?? 0o600,
          item.originalContentHash,
        );
        if (entries[index]?.appliedContentHash !== sha256(item.operation.content)) {
          throw new ConfigExecutionError(
            "APPLY_FAILED",
            "Transaction entry order changed unexpectedly.",
          );
        }
      }

      transaction = { ...transaction, state: "applied" };
      await this.#writeTransaction(transaction);
    } catch (cause) {
      try {
        if (transaction) {
          await this.#writeTransaction({ ...transaction, state: "rolling-back" }).catch(
            () => undefined,
          );
        }
        if (entries.length > 0) await this.#rollbackEntries(entries);
        await removeTransactionDirectory(transactionDirectory);
        await syncDirectory(backupRoot);
      } catch (rollbackCause) {
        throw new ConfigExecutionError(
          "ROLLBACK_FAILED",
          "Applying configuration failed and internal rollback did not complete.",
          { cause: new AggregateError([cause, rollbackCause]) },
        );
      }
      if (cause instanceof ConfigExecutionError) throw cause;
      throw new ConfigExecutionError("APPLY_FAILED", "Applying configuration failed.", {
        cause,
      });
    }

    return {
      planId: plan.id,
      appliedAt,
      rollbackToken: {
        version: 2,
        transactionId,
      } satisfies FileRollbackToken,
    };
  }

  async rollback(receipt: ApplyReceipt): Promise<void> {
    if (!isFileRollbackToken(receipt.rollbackToken)) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        "Rollback receipt was not created by FileConfigExecutor.",
      );
    }

    let transaction = await this.#readTransaction(receipt.rollbackToken.transactionId);
    if (transaction.planId !== receipt.planId) {
      throw new ConfigExecutionError(
        "INVALID_RECEIPT",
        "Rollback receipt plan ID does not match its persisted transaction.",
      );
    }

    const transactionDirectory = await this.#transactionDirectory(transaction.transactionId);
    // Validate first: a rollback that is going to be refused must not leave the
    // transaction marked `rolling-back`, because nothing was rolled back and a
    // later recovery scan would misread a still-applied transaction as half-undone.
    const pending = await this.#planRollback(transaction.entries);
    transaction = { ...transaction, state: "rolling-back" };
    await this.#writeTransaction(transaction);

    try {
      await this.#applyRollback(transaction.entries, pending);
      await removeTransactionDirectory(transactionDirectory);
      await syncDirectory(dirname(transactionDirectory));
    } catch (cause) {
      if (cause instanceof ConfigExecutionError) throw cause;
      throw new ConfigExecutionError("ROLLBACK_FAILED", "Configuration rollback failed.", {
        cause,
      });
    }
  }
}
