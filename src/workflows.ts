import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import {
  parseVersionLiteral,
  renderVersion,
  representativeStyle,
  type ParsedVersion,
} from "./format.js";
import type { Editor, FilePlan, VersionChange } from "./reconcile.js";
import type { Schedule } from "./schedule.js";

const SETUP_NODE = /^actions\/setup-node(@.*)?$/;
const MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/;

/** A step scope: workflow jobs carry a matrix + steps; composite actions carry steps only. */
interface Scope {
  matrix?: YAMLMap;
  steps?: YAMLSeq;
}

/** The Node-version-bearing locations found in one document. */
interface Analysis {
  /** Matrix arrays referenced by a setup-node `${{ matrix.KEY }}` node-version (multi-version). */
  matrixSeqs: YAMLSeq[];
  /** Scalar setup-node node-version pins holding a concrete numeric version (single-version). */
  scalarPins: Scalar[];
}

function getNode(map: unknown, key: string): Node | undefined {
  if (!isMap(map)) return undefined;
  return (map.get(key, true) as Node | undefined) ?? undefined;
}

function collectScopes(doc: Document): Scope[] {
  const scopes: Scope[] = [];
  const root = doc.contents;
  if (!isMap(root)) return scopes;

  const jobs = getNode(root, "jobs");
  if (isMap(jobs)) {
    for (const pair of jobs.items) {
      const job = pair.value;
      if (!isMap(job)) continue;
      const strategy = getNode(job, "strategy");
      const matrix = isMap(strategy) ? getNode(strategy, "matrix") : undefined;
      const steps = getNode(job, "steps");
      scopes.push({
        matrix: isMap(matrix) ? matrix : undefined,
        steps: isSeq(steps) ? steps : undefined,
      });
    }
  }

  // Composite action: runs.steps (no matrix concept).
  const runs = getNode(root, "runs");
  if (isMap(runs)) {
    const steps = getNode(runs, "steps");
    if (isSeq(steps)) scopes.push({ steps });
  }

  return scopes;
}

/** Read the parsed version out of a sequence/scalar item. */
function itemVersion(item: unknown): ParsedVersion | undefined {
  return parseVersionLiteral(isScalar(item) ? (item as Scalar).value : item);
}

function analyze(doc: Document): Analysis {
  const matrixSeqs: YAMLSeq[] = [];
  const scalarPins: Scalar[] = [];

  for (const scope of collectScopes(doc)) {
    if (!scope.steps) continue;
    for (const step of scope.steps.items) {
      if (!isMap(step)) continue;
      const uses = step.get("uses");
      if (typeof uses !== "string" || !SETUP_NODE.test(uses.trim())) continue;

      const withMap = getNode(step, "with");
      if (!isMap(withMap)) continue;
      const nv = withMap.get("node-version", true);
      if (!isScalar(nv)) continue;

      const value = nv.value;
      if (typeof value === "string") {
        const ref = MATRIX_REF.exec(value.trim());
        if (ref) {
          const seq = scope.matrix
            ? (scope.matrix.get(ref[1], true) as Node | undefined)
            : undefined;
          if (isSeq(seq) && !matrixSeqs.includes(seq)) matrixSeqs.push(seq);
          continue;
        }
      }

      if (
        parseVersionLiteral(value) !== undefined &&
        !scalarPins.includes(nv)
      ) {
        scalarPins.push(nv);
      }
    }
  }

  return { matrixSeqs, scalarPins };
}

function insertMajor(seq: YAMLSeq, major: number): void {
  const numeric: ParsedVersion[] = [];
  for (const item of seq.items) {
    const p = itemVersion(item);
    if (p) {
      if (p.major === major) return; // already present
      numeric.push(p);
    }
  }

  const style = representativeStyle(numeric);
  const value = renderVersion(major, style);
  const node = new Scalar(value);

  if (typeof value === "string") {
    // Copy the quote style of an existing string entry so the new one matches.
    const rep = seq.items.find(
      (it) => isScalar(it) && typeof (it as Scalar).value === "string",
    );
    if (isScalar(rep)) node.type = (rep as Scalar).type;
  }

  // Insert before the first numeric entry with a higher major, keeping ascending order.
  let idx = seq.items.length;
  for (let i = 0; i < seq.items.length; i++) {
    const p = itemVersion(seq.items[i]);
    if (p && p.major > major) {
      idx = i;
      break;
    }
  }
  seq.items.splice(idx, 0, node);
}

function removeMajor(seq: YAMLSeq, major: number): void {
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const p = itemVersion(seq.items[i]);
    if (p && p.major === major) seq.items.splice(i, 1);
  }
}

function applyWorkflow(
  content: string,
  change: VersionChange,
  schedule: Schedule,
): string {
  const doc = parseDocument(content);
  const { matrixSeqs, scalarPins } = analyze(doc);

  if (change.kind === "add") {
    for (const seq of matrixSeqs) insertMajor(seq, change.major);
  } else {
    for (const seq of matrixSeqs) removeMajor(seq, change.major);
    if (schedule.newestEven !== undefined) {
      for (const pin of scalarPins) {
        const p = parseVersionLiteral(pin.value);
        if (p && p.major === change.major) {
          const value = renderVersion(schedule.newestEven, p.style);
          pin.value = value;
          if (typeof value === "number") pin.type = Scalar.PLAIN;
        }
      }
    }
  }

  // `flowCollectionPadding: false` keeps `[20, 22, 24]` compact (no inner padding),
  // minimising cosmetic diff noise in the resulting PR.
  return doc.toString({ flowCollectionPadding: false });
}

export const workflowEditor: Editor = {
  plan(path: string, content: string, schedule: Schedule): FilePlan | null {
    let doc: Document;
    try {
      doc = parseDocument(content);
    } catch {
      return null;
    }
    if (doc.errors.length > 0 || !isMap(doc.contents)) return null;

    const { matrixSeqs, scalarPins } = analyze(doc);
    if (matrixSeqs.length === 0 && scalarPins.length === 0) return null;

    const changes = new Map<string, VersionChange>();
    const record = (kind: VersionChange["kind"], major: number) =>
      changes.set(`${kind}:${major}`, { kind, major });

    for (const seq of matrixSeqs) {
      const majors = new Set<number>();
      for (const item of seq.items) {
        const p = itemVersion(item);
        if (p) majors.add(p.major);
      }
      for (const even of schedule.activeEven)
        if (!majors.has(even)) record("add", even);
      for (const m of majors) if (!schedule.isActive(m)) record("drop", m);
    }

    for (const pin of scalarPins) {
      const p = parseVersionLiteral(pin.value);
      if (p && !schedule.isActive(p.major)) record("drop", p.major);
    }

    if (changes.size === 0) return null;

    return {
      path,
      changes: [...changes.values()],
      apply: (c, change) => applyWorkflow(c, change, schedule),
    };
  },
};
