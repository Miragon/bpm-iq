/**
 * Hocuspocus wire-envelope peek (#115) — every ws message reaches
 * beforeHandleMessage, but only SYNC payloads are ever applied to the Y.Doc.
 * Awareness became first-class traffic with live cursors (a moving pointer is
 * ~30 msgs/s per user, forever): counting those bytes against the doc-size
 * guard would steadily inflate its estimate (forcing pointless full re-encodes
 * to re-anchor) and, on a doc already at the cap, CLOSE the session on a mere
 * cursor move — including for someone only viewing.
 *
 * The envelope is lib0-encoded: varString(documentName) then
 * varUint(messageType). We skip the string and read the type — no payload
 * decode, no lib0 dependency (the varint scheme is 7 data bits per byte,
 * high bit = continuation).
 */

// the two Hocuspocus MessageTypes whose payload mutates the document
const SYNC = 0;
const SYNC_REPLY = 4;

/** true when this raw ws message can grow the Y.Doc (sync protocol) — and,
 *  conservatively, for anything malformed/truncated: an unparseable message
 *  still counts against the cap, Hocuspocus rejects it on its own later */
export function growsDocument(message: Uint8Array): boolean {
  try {
    let pos = 0;
    const readVarUint = (): number => {
      let value = 0;
      let shift = 0;
      for (;;) {
        if (pos >= message.length) throw new Error("truncated");
        const byte = message[pos++]!;
        value |= (byte & 0x7f) * 2 ** shift; // * not << — stays exact past 31 bits
        shift += 7;
        if (byte < 0x80) return value;
        if (shift > 53) throw new Error("varint too long");
      }
    };
    const nameLength = readVarUint(); // documentName: varUint byteLength + utf8 bytes
    pos += nameLength;
    if (pos > message.length) throw new Error("truncated");
    const type = readVarUint();
    return type === SYNC || type === SYNC_REPLY;
  } catch {
    return true;
  }
}
