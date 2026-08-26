/**
 * The doc-codec capability (epic #118 step 8): how a STRUCTURED notation's
 * live document serializes to its canonical at-rest text — the bridge that
 * keeps git diffs, PR review, sha256 compare-and-set, per-file history and
 * the validator working on plain text while the LIVE document merges
 * element-wise (Y.Map, @bpmiq/contracts/live ELEMENTS_KEY/META_KEY).
 *
 * Dark-launched: the registry below is EMPTY — no shipped notation is
 * structured yet. The first canvas notation (event storming, #116) registers
 * its codec here; the pipeline (seed, write-through, stale-seed, CAS,
 * reconcile) is exercised in CI through injected test codecs until then.
 *
 * Pure + browser-safe like every capability module (no fs, no XML).
 */

/** the plain-object snapshot of a structured live document */
export interface StructuredSnapshot {
  /** element id → attributes (id is NOT repeated inside the attributes) */
  elements: Record<string, Record<string, unknown>>;
  /** document-level values (title, level, lanes, …) */
  meta: Record<string, unknown>;
}

export interface DocCodec {
  /**
   * DETERMINISTIC canonical text: same snapshot → same bytes, regardless of
   * insertion order. Everything downstream depends on it — git diff, the
   * sha256 baseVersion, history, the validator's input.
   */
  encode(snapshot: StructuredSnapshot): string;
  /** TOTAL: any bytes → a snapshot (garbage → empty board, unparseable lines
   *  skipped) — a decode must never fail a seed or a listing */
  decode(text: string): StructuredSnapshot;
}

/** recursively sort object keys so JSON.stringify is deterministic */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const HEADER_FORMAT = "bpmiq-structured";

/**
 * THE house codec: one JSON header line (format, version, meta), then one
 * JSON line per element sorted by id, trailing newline — a git diff of an
 * element edit touches exactly that element's line.
 */
export function jsonLinesCodec(): DocCodec {
  return {
    encode(snapshot) {
      const lines = [JSON.stringify(canonicalize({ format: HEADER_FORMAT, version: 1, meta: snapshot.meta }))];
      for (const id of Object.keys(snapshot.elements).sort()) {
        // the map KEY is the authoritative id — an attr literally named "id"
        // must never re-key the element in the canonical text
        lines.push(JSON.stringify(canonicalize({ ...snapshot.elements[id], id })));
      }
      return `${lines.join("\n")}\n`;
    },
    decode(text) {
      // null-prototype container: an "__proto__" element id must become an
      // OWN key, never a prototype assignment
      const snapshot: StructuredSnapshot = {
        elements: Object.create(null) as StructuredSnapshot["elements"],
        meta: {},
      };
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // total decode: unparseable lines are skipped, never fatal
        }
        if (parsed === null || typeof parsed !== "object") continue;
        const row = parsed as Record<string, unknown>;
        // a header NEVER carries an id — an element whose attrs happen to
        // contain format:"bpmiq-structured" must not be swallowed as one
        if (row.format === HEADER_FORMAT && typeof row.id !== "string") {
          if (row.meta !== null && typeof row.meta === "object") snapshot.meta = row.meta as Record<string, unknown>;
          continue;
        }
        if (typeof row.id === "string" && row.id.length > 0) {
          const { id, ...attrs } = row;
          snapshot.elements[id as string] = attrs;
        }
      }
      // spread-copy back to a normal prototype: spread CreateDataProperty's
      // every own key (incl. a literal "__proto__"), never invoking setters —
      // callers get an ordinary object, deep-equality behaves as expected
      return { elements: { ...snapshot.elements }, meta: snapshot.meta };
    },
  };
}

/** notation id → its doc codec — EMPTY until the first structured notation
 *  (#116) registers; registering here is the whole integration */
const DOC_CODECS: Record<string, DocCodec> = {};

export function docCodecFor(notation: string): DocCodec | undefined {
  return DOC_CODECS[notation];
}

// ── fractional-index ordering ────────────────────────────────────────────────

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A key strictly between `a` and `b` (base-36 fractional index, lexicographic
 * order) — timeline/board ordering without the Y.Array concurrent-insert
 * worst case: concurrent inserts at one gap yield distinct keys that still
 * sort deterministically. Omit `a` for "before b", `b` for "after a".
 */
export function fractionalIndexBetween(a?: string, b?: string): string {
  const lo = a ?? "";
  const hi = b ?? "";
  if (hi !== "" && lo >= hi) throw new Error(`fractional index bounds out of order: '${lo}' >= '${hi}'`);
  let result = "";
  for (let i = 0; ; i++) {
    // reaching the end of a non-empty upper bound with an equal prefix means
    // the interval is empty (a bound ending in the minimum digit — keys THIS
    // generator produces never do, so only malformed external input hits it)
    if (hi !== "" && i >= hi.length) throw new Error(`no key exists between '${lo}' and '${hi}'`);
    const dLo = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const dHi = i < hi.length ? DIGITS.indexOf(hi[i]!) : DIGITS.length;
    if (dHi - dLo > 1) {
      // room for a midpoint digit at this position
      return result + DIGITS[Math.floor((dLo + dHi) / 2)]!;
    }
    // adjacent (or equal) digits: keep the low digit, descend one position
    result += DIGITS[dLo]!;
    if (dHi - dLo === 1) {
      // between x… and (x+1): everything below the upper bound is open — walk
      // the LOW side's remainder until a digit leaves headroom to append
      for (let j = i + 1; ; j++) {
        const d = j < lo.length ? DIGITS.indexOf(lo[j]!) : 0;
        if (d < DIGITS.length - 1) {
          const rest = lo.slice(i + 1, j);
          return result + rest + DIGITS[Math.floor((d + DIGITS.length) / 2)]!;
        }
        // digit is the maximum ('z') — carry it and keep walking
      }
    }
  }
}
