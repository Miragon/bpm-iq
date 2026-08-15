/**
 * Path gate for content reads/writes/history: validate a repo-relative model
 * path through the live-room gate (splitRoom) against the ALREADY authorized
 * repo — a path that resolves to a different registry entry (GitLab subgroup
 * prefix collisions) is rejected, not silently re-scoped. Was a verbatim
 * private copy in content.ts and history.ts; the wire-visible error code
 * stays per caller.
 */
import { roomName } from "@bpmiq/contracts/live";
import { AppError } from "@bpmiq/http-kit";

import { type RegistryLookup, splitRoom } from "../domain/rooms.ts";
import type { ConnectedRepo } from "../repos/registry.ts";

export function modelPath(
  registry: RegistryLookup,
  repo: ConnectedRepo,
  path: string,
  code: "content/invalid-path" | "history/invalid-path",
): string {
  let split: { repo: ConnectedRepo; path: string };
  try {
    split = splitRoom(roomName(repo.fullName, path), registry);
  } catch (e) {
    throw new AppError(code, (e as Error).message, { status: 400, expose: true });
  }
  if (split.repo.fullName !== repo.fullName) {
    throw new AppError(code, `path resolves outside ${repo.fullName}: ${path}`, {
      status: 400,
      expose: true,
    });
  }
  return split.path;
}
