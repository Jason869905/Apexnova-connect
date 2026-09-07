const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR = /^(>=|<=|>|<|=)?\s*(.+)$/;

interface ParsedVersion {
  readonly parts: readonly [number, number, number];
  readonly prerelease: string | undefined;
}

export class VersionRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionRangeError";
  }
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION.exec(value.trim());
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4],
  };
}

function compare(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.parts[index]! - right.parts[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  // A prerelease of the same triple precedes the release, per semver.
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Evaluates the comparator-set subset of semver ranges that integration
 * manifests use, such as `>=1.18.29 <2.0.0`. Anything richer (`^`, `~`, `||`,
 * `x` wildcards) is rejected rather than approximated, so an unreadable range
 * can never be mistaken for a satisfied one.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new VersionRangeError(`Version ${version} is not a dotted numeric version.`);
  }

  const comparators = range.trim().split(/\s+/).filter((part) => part.length > 0);
  if (comparators.length === 0) {
    throw new VersionRangeError("A version range must contain at least one comparator.");
  }

  for (const comparator of comparators) {
    const match = COMPARATOR.exec(comparator);
    const bound = match ? parseVersion(match[2]!) : undefined;
    if (!match || !bound) {
      throw new VersionRangeError(
        `Version range ${range} uses unsupported syntax; use explicit >=, >, <=, < or = comparators.`,
      );
    }
    const result = compare(parsed, bound);
    const operator = match[1] ?? "=";
    const satisfied =
      operator === ">=" ? result >= 0 :
      operator === ">" ? result > 0 :
      operator === "<=" ? result <= 0 :
      operator === "<" ? result < 0 :
      result === 0;
    if (!satisfied) return false;
  }

  return true;
}
