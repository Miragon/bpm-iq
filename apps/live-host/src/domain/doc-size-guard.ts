/**
 * In-session document size guard (audit M3 residual). The persist path already
 * refuses to WRITE an oversized room, but a CRDT can't be un-grown: without an
 * ingest-side cap a collaborator could keep inflating the in-memory Y.Doc until
 * the cell OOMs. This guard bounds ingest — updates that would push a document
 * past the cap are rejected BEFORE they are applied (beforeHandleMessage).
 *
 * Cheap by design: it tracks an over-estimate (base size at load + raw bytes of
 * every message since), and only when that estimate crosses the cap does it
 * re-measure precisely via `measure()` (a full Y.encodeStateAsUpdate — the same
 * cost the store path pays anyway). Sync-protocol chatter counted into `pending`
 * only makes the estimate MORE conservative, never lets an oversized doc slip by.
 *
 * Measures are rate-limited per doc (`measureCooldownMs`): a full encode of an
 * 8 MB doc blocks the event loop ~10 ms, so an attacker parked just under the
 * cap must not be able to force one per message (CPU amplification). Within the
 * cooldown an over-the-cap ESTIMATE rejects conservatively — a legitimate client
 * caught by that reconnects a second later, after the cooldown, and the exact
 * re-measure re-anchors. The estimate can overshoot the true size by at most one
 * store-debounce window of in-flight bytes (admit runs before apply, the store
 * encode may miss the last messages) — the cap is "≈max", non-compounding.
 */
export class DocSizeGuard {
  private readonly max: number;
  private readonly measureCooldownMs: number;
  private readonly sizes = new Map<string, { base: number; pending: number; measuredAt: number }>();

  constructor(maxBytes: number, measureCooldownMs = 5_000) {
    this.max = maxBytes;
    this.measureCooldownMs = measureCooldownMs;
  }

  /** record a document's size when it is loaded (restored blob / seeded file) */
  load(name: string, baseBytes: number): void {
    this.sizes.set(name, { base: baseBytes, pending: 0, measuredAt: 0 });
  }

  /** re-anchor on the exact size the store path just encoded (free precision) */
  stored(name: string, baseBytes: number): void {
    const s = this.sizes.get(name);
    this.sizes.set(name, { base: baseBytes, pending: 0, measuredAt: s?.measuredAt ?? 0 });
  }

  /** forget an unloaded document (afterUnloadDocument) — the map must not grow */
  drop(name: string): void {
    this.sizes.delete(name);
  }

  /**
   * Admit or reject an incoming update. `measure` returns the document's exact
   * encoded size; it is only called when the running estimate crosses the cap
   * AND the per-doc cooldown has elapsed. false = the update must NOT be
   * applied (the doc would exceed the cap).
   */
  admit(name: string, updateBytes: number, measure: () => number, now: number = Date.now()): boolean {
    const s = this.sizes.get(name) ?? { base: 0, pending: 0, measuredAt: 0 };
    this.sizes.set(name, s);
    if (s.base + s.pending + updateBytes <= this.max) {
      s.pending += updateBytes;
      return true;
    }
    // estimate crossed the cap — re-anchor on the exact size before deciding,
    // unless a measure just ran (cooldown): then reject on the estimate alone
    if (now - s.measuredAt < this.measureCooldownMs) return false;
    s.base = measure();
    s.measuredAt = now;
    s.pending = 0;
    if (s.base + updateBytes > this.max) return false; // rejected — doc unchanged
    s.pending = updateBytes;
    return true;
  }

  /** current tracked rooms (introspection/tests) */
  get tracked(): number {
    return this.sizes.size;
  }
}
