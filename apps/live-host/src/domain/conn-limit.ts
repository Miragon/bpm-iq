/**
 * Concurrent WebSocket connection ceiling for a cell (DoS guard). The Hocuspocus
 * upgrade path had no cap, so an anonymous flood could exhaust fds/memory. A GLOBAL
 * cap bounds the cell; a smaller PER-IP cap stops one client monopolising the fleet
 * slot (behind Fly the real client is the Fly-Client-IP header, not the proxy socket).
 */
export class ConnectionLimiter {
  private total = 0;
  private readonly perIp = new Map<string, number>();
  private readonly maxTotal: number;
  private readonly maxPerIp: number;

  constructor(maxTotal: number, maxPerIp: number) {
    this.maxTotal = maxTotal;
    this.maxPerIp = maxPerIp;
  }

  /** admit a connection from `ip`, or return false if the global or per-IP cap is hit */
  tryAcquire(ip: string): boolean {
    if (this.total >= this.maxTotal) return false;
    const n = this.perIp.get(ip) ?? 0;
    if (n >= this.maxPerIp) return false;
    this.total++;
    this.perIp.set(ip, n + 1);
    return true;
  }

  /** release a previously-acquired slot; prunes the per-IP entry at zero (no leak) */
  release(ip: string): void {
    if (this.total > 0) this.total--;
    const n = (this.perIp.get(ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, n);
  }

  get active(): number {
    return this.total;
  }
}
