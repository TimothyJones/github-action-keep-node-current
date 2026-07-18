/**
 * Understands the handful of ways a Node.js version is written in configuration
 * files so we can read the major out of an existing entry and render a new entry
 * in the same shape.
 */

export type VersionStyle = "number" | "bare-string" | "dotx" | "full-string";

export interface ParsedVersion {
  major: number;
  style: VersionStyle;
}

/**
 * Interpret a scalar value (YAML number/string, or a plain string) as a Node
 * version. Returns undefined for anything that is not a concrete numeric version
 * — `lts/*`, `latest`, `node`, codenames, ranges — which must be left untouched.
 */
export function parseVersionLiteral(value: unknown): ParsedVersion | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return { major: Math.trunc(value), style: "number" };
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return { major: Number(trimmed), style: "bare-string" };
  }
  if (/^\d+\.x$/.test(trimmed)) {
    return {
      major: Number(trimmed.slice(0, trimmed.indexOf("."))),
      style: "dotx",
    };
  }
  if (/^\d+\.\d+(\.\d+)?$/.test(trimmed)) {
    return {
      major: Number(trimmed.slice(0, trimmed.indexOf("."))),
      style: "full-string",
    };
  }
  return undefined;
}

/** Render a major version in the given style. `number` yields a JS number; the rest yield strings. */
export function renderVersion(
  major: number,
  style: VersionStyle,
): number | string {
  switch (style) {
    case "number":
      return major;
    case "bare-string":
      return String(major);
    case "dotx":
      return `${major}.x`;
    case "full-string":
      return String(major);
  }
}

/**
 * Pick the representative style for a group of existing entries (e.g. a matrix
 * array) so newly inserted versions match the surrounding convention. Falls back
 * to `number` when there is nothing numeric to copy.
 */
export function representativeStyle(existing: ParsedVersion[]): VersionStyle {
  return existing.length ? existing[0].style : "number";
}
