/**
 * Typed application errors + the ONE error→HTTP mapping both backends share.
 *
 * Convention: domain/application code throws AppError with a stable,
 * dot/slash-namespaced machine code (e.g. "release/version-bump-required")
 * and a suggested HTTP status; the http catch-all maps it via errorBody().
 * Plain Errors keep today's behavior: 500, message only for authenticated
 * callers (fs paths / provider API bodies are operator information).
 *
 * erasableSyntaxOnly: fields are assigned explicitly in the constructor body
 * (no parameter properties), and codes are plain string literals (no enums).
 */

export class AppError extends Error {
  /** stable machine code, e.g. "release/version-bump-required" */
  readonly code: string;
  /** suggested HTTP status (the catch-all's send uses it verbatim) */
  readonly status: number;
  /** is the message safe to show an UNauthenticated caller? */
  readonly expose: boolean;

  constructor(code: string, message: string, opts: { status?: number; expose?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = opts.status ?? 500;
    this.expose = opts.expose ?? false;
  }
}

/**
 * Map any thrown value to { status, body } for the http catch-all.
 *
 * AppError → its status; message shown iff (expose || authenticated), else
 * "internal error"; `code` is always included (machine-readable even when the
 * text is sanitized). Anything else → 500; message iff authenticated, else
 * "internal error" — and NO `code` key, so plain-Error bodies stay exactly
 * what both backends returned before this module existed.
 */
export function errorBody(
  e: unknown,
  opts: { authenticated?: boolean } = {},
): { status: number; body: { error: string; code?: string } } {
  const authenticated = opts.authenticated ?? false;
  if (e instanceof AppError) {
    return {
      status: e.status,
      body: { error: e.expose || authenticated ? e.message : "internal error", code: e.code },
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { status: 500, body: { error: authenticated ? message : "internal error" } };
}
