/**
 * Room migrations (#208) — the bookkeeping that lets a rename move an OPEN
 * model to a new file. Rooms are keyed by path, so a renamed document needs a
 * new room; the old one is closed for good:
 *
 *   retire(room)   the old room never writes through or persists again — its
 *                  debounced store (and the store Hocuspocus runs on unload)
 *                  would otherwise recreate the old file / lineage row
 *   hold(rooms)    loads of the NEW rooms wait until the rename has written
 *                  file + lineage — the notice sends the editors there at once,
 *                  and a reconnect must not seed from a file that is not yet
 *                  in place (a second, divergent CRDT history)
 *
 * The collab hooks consult it (isRetired, settled) and clean up on unload
 * (forget); server.ts retires a loaded room through it. In-memory on purpose:
 * a restart unloads every room anyway.
 */
export class RoomMigrations {
  private readonly retired = new Set<string>();
  private readonly holds = new Map<string, Promise<void>>();

  /** the room's document must never persist again */
  retire(room: string): void {
    this.retired.add(room);
  }

  isRetired(room: string): boolean {
    return this.retired.has(room);
  }

  /** the retired room unloaded — a file created at its path later is a new room */
  forget(room: string): void {
    this.retired.delete(room);
  }

  /** block loads of `rooms` until the returned release() runs (idempotent) */
  hold(rooms: string[]): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const room of rooms) this.holds.set(room, held);
    return () => {
      release();
      for (const room of rooms) if (this.holds.get(room) === held) this.holds.delete(room);
    };
  }

  /** resolves once no migration holds the room */
  async settled(room: string): Promise<void> {
    await this.holds.get(room);
  }
}
