import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  CapabilityError,
  assertCompatibilityEvidence,
  assertRedacted,
  evidenceDigest,
  type CompatibilityEvidence,
  type EvidenceSubject,
} from "./evidence.js";

/** Both the pinned form and the one records carried before it was agreed. */
const EVIDENCE_ID = /^(?:ev\.sha256\.[0-9a-f]{64}|evidence\.[0-9a-f]{32})$/;
const EVIDENCE_FILE = /^((?:ev\.sha256\.[0-9a-f]{64}|evidence\.[0-9a-f]{32}))\.json$/;

export interface EvidenceStoreOptions {
  readonly root: string;
}

export interface EvidenceFilter {
  readonly agentId?: string;
  readonly integrationId?: string;
  readonly deploymentId?: string;
  readonly protocol?: string;
  readonly platform?: string;
}

export interface EvidenceAppendResult {
  readonly evidence: CompatibilityEvidence;
  /** False when this exact record was already stored, which makes a retry safe. */
  readonly created: boolean;
  readonly path: string;
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}

function subjectMatchesFilter(subject: EvidenceSubject, filter: EvidenceFilter): boolean {
  return (
    (filter.agentId === undefined || subject.agentId === filter.agentId) &&
    (filter.integrationId === undefined || subject.integrationId === filter.integrationId) &&
    (filter.deploymentId === undefined || subject.deploymentId === filter.deploymentId) &&
    (filter.protocol === undefined || subject.protocol === filter.protocol) &&
    (filter.platform === undefined || subject.platform === filter.platform)
  );
}

/**
 * An append-only local evidence store. Records are content-addressed, so the
 * same run written twice is the same file; a different record claiming an
 * existing ID is refused rather than merged. Correcting a record means writing
 * a new one whose `supersedes` points at it -- nothing here overwrites or
 * deletes, because expiry is not deletion and an inconvenient result must not
 * be quietly removable.
 */
export class FileEvidenceStore {
  readonly #root: string;

  constructor(options: EvidenceStoreOptions) {
    if (!isAbsolute(options.root)) {
      throw new CapabilityError("INVALID_EVIDENCE", `Evidence root must be absolute: ${options.root}.`);
    }
    this.#root = options.root;
  }

  #pathFor(id: string): string {
    if (!EVIDENCE_ID.test(id)) {
      throw new CapabilityError("INVALID_EVIDENCE", `Evidence ID is invalid: ${id}.`);
    }
    return join(this.#root, `${id}.json`);
  }

  async append(evidence: CompatibilityEvidence): Promise<EvidenceAppendResult> {
    assertCompatibilityEvidence(evidence);
    assertRedacted(evidence);
    const path = this.#pathFor(evidence.id);
    const content = `${JSON.stringify(evidence, null, 2)}\n`;

    const existing = await this.get(evidence.id);
    if (existing) {
      if (evidenceDigest(existing) !== evidenceDigest(evidence)) {
        throw new CapabilityError(
          "EVIDENCE_IMMUTABLE",
          `Evidence ${evidence.id} is already stored with different content; write a new record with supersedes instead.`,
        );
      }
      return { evidence, created: false, path };
    }

    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.#root, `.${evidence.id}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }

    return { evidence, created: true, path };
  }

  async get(id: string): Promise<CompatibilityEvidence | null> {
    let content: string;
    try {
      content = await readFile(this.#pathFor(id), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    return this.#parse(content, id);
  }

  async list(filter: EvidenceFilter = {}): Promise<readonly CompatibilityEvidence[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.#root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && EVIDENCE_FILE.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }

    const records: CompatibilityEvidence[] = [];
    for (const name of entries) {
      const id = EVIDENCE_FILE.exec(name)?.[1];
      if (id === undefined) continue;
      const record = this.#parse(await readFile(join(this.#root, name), "utf8"), id);
      if (subjectMatchesFilter(record.subject, filter)) records.push(record);
    }

    return records.sort(
      (left, right) =>
        right.observedAt.localeCompare(left.observedAt) || right.id.localeCompare(left.id),
    );
  }

  #parse(content: string, id: string): CompatibilityEvidence {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new CapabilityError("INVALID_EVIDENCE", `Stored evidence ${id} is not valid JSON.`, {
        cause,
      });
    }
    assertCompatibilityEvidence(parsed);
    if (parsed.id !== id) {
      throw new CapabilityError(
        "INVALID_EVIDENCE",
        `Stored evidence ${id} carries a different ID: ${parsed.id}.`,
      );
    }
    return parsed;
  }
}

/** Records another stored record explicitly replaces. They stay on disk, but stop counting. */
export function supersededIds(records: readonly CompatibilityEvidence[]): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const record of records) {
    if (record.supersedes !== undefined) superseded.add(record.supersedes);
  }
  return superseded;
}
