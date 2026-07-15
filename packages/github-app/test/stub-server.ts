/**
 * Tiny in-process HTTP stub for the wire tests: records every request
 * (method/url/headers/body) and replays a programmable response queue —
 * zero-dep (node:http), the package-local sibling of the app suites'
 * offline stub provider.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON-encoded unless it is already a string (raw text bodies for error paths) */
  body?: unknown;
}

export class StubServer {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: StubResponse[] = [];
  private server: Server | undefined;
  /** http://127.0.0.1:<port> — set by start() */
  url = "";

  /** queue the next responses, in order; an empty queue serves `{}` with 200 */
  reply(...responses: StubResponse[]): void {
    this.queue.push(...responses);
  }

  last(): RecordedRequest {
    const r = this.requests[this.requests.length - 1];
    if (!r) throw new Error("no request recorded");
    return r;
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        const r = this.queue.shift() ?? {};
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
        res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(body);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
