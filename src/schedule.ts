import { readFile } from "node:fs/promises";

/** A single entry in the Node.js release schedule, keyed by "vN" in the source JSON. */
export interface ScheduleEntry {
  start: string;
  end: string;
  lts?: string;
  maintenance?: string;
  codename?: string;
}

export type RawSchedule = Record<string, ScheduleEntry>;

/**
 * A view over the Node.js release schedule evaluated against a fixed "today".
 * All majors are plain integers (the numeric part of the "vN" key).
 */
export interface Schedule {
  /** True when `today` is within [start, end) for the given major. */
  isActive(major: number): boolean;
  /** Every active major, ascending. */
  active: number[];
  /** Every active even-numbered major (the LTS lines), ascending. */
  activeEven: number[];
  /** Highest active even major, or undefined if none are active. */
  newestEven: number | undefined;
  /** Lowest active even major, or undefined if none are active. */
  lowestEven: number | undefined;
}

/** Parse "YYYY-MM-DD" into a UTC timestamp (midnight). Returns NaN on bad input. */
function parseDate(value: string): number {
  return Date.parse(`${value}T00:00:00Z`);
}

/** Extract the integer major from a schedule key such as "v18" or "18". */
export function parseMajor(key: string): number | undefined {
  const match = /^v?(\d+)$/.exec(key.trim());
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

/**
 * Build a Schedule view from the raw JSON and a reference date.
 * A major is "active" when start <= now < end. Entries with unparseable or
 * missing dates are skipped defensively.
 */
export function buildSchedule(raw: RawSchedule, now: Date): Schedule {
  const nowMs = now.getTime();
  const active: number[] = [];

  for (const [key, entry] of Object.entries(raw)) {
    const major = parseMajor(key);
    if (major === undefined) continue;
    if (
      !entry ||
      typeof entry.start !== "string" ||
      typeof entry.end !== "string"
    ) {
      continue;
    }
    const start = parseDate(entry.start);
    const end = parseDate(entry.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (nowMs >= start && nowMs < end) active.push(major);
  }

  active.sort((a, b) => a - b);
  const activeSet = new Set(active);
  const activeEven = active.filter((m) => m % 2 === 0);

  return {
    isActive: (major: number) => activeSet.has(major),
    active,
    activeEven,
    newestEven: activeEven.length
      ? activeEven[activeEven.length - 1]
      : undefined,
    lowestEven: activeEven.length ? activeEven[0] : undefined,
  };
}

/**
 * Fetch and parse the schedule from an HTTP(S) URL or a local file path.
 * Local paths are supported to make dry-runs and tests deterministic.
 */
export async function fetchSchedule(source: string): Promise<RawSchedule> {
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch schedule from ${source}: ${response.status} ${response.statusText}`,
      );
    }
    text = await response.text();
  } else {
    const path = source.replace(/^file:\/\//, "");
    text = await readFile(path, "utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Schedule at ${source} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Schedule at ${source} did not parse to an object.`);
  }
  return parsed as RawSchedule;
}
