# syntax=docker/dockerfile:1
# bpmiq Live Host — collaborative editing platform (Hocuspocus sync + REST API +
# web app on ONE port). Multi-repo: connected repos are cloned on demand, so the
# runtime needs git. Build context = the monorepo root (pnpm workspace).
#
# Published as ghcr.io/miragon/bpmiq-live-host by .github/workflows/release.yml —
# the same image serves on-prem installs and Miragon's hosted cells (ADR 0004).

FROM node:26-slim AS build
RUN corepack enable
WORKDIR /app
# workspace manifests first (better layer caching for installs)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/live-host/package.json ./apps/live-host/
COPY apps/web/package.json ./apps/web/
COPY apps/vscode/package.json ./apps/vscode/
COPY packages/notations/package.json ./packages/notations/
COPY packages/ui-kit/package.json ./packages/ui-kit/
COPY packages/api-client/package.json ./packages/api-client/
COPY packages/cell-protocol/package.json ./packages/cell-protocol/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/github-app/package.json ./packages/github-app/
COPY packages/http-kit/package.json ./packages/http-kit/
COPY packages/validator/package.json ./packages/validator/
COPY packages/mcp/package.json ./packages/mcp/
# --frozen-lockfile: install the EXACT versions CI validated (reproducible + closes
# in-range dependency substitution into the OAuth/token-minting image)
RUN pnpm install --frozen-lockfile
# source + build the web app the live host serves
COPY . .
RUN pnpm --filter @bpmiq/web build

FROM node:26-slim
LABEL org.opencontainers.image.title="bpmiq live-host" \
  org.opencontainers.image.description="Collaborative BPM platform server: live model sync + REST API + web app on one port; releases become pull requests" \
  org.opencontainers.image.source="https://github.com/Miragon/bpm-iq" \
  org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080 LIVE_DATA_DIR=/data
WORKDIR /app
# git: clone/fetch/worktree of connected repos at runtime; ca-certs for HTTPS
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# the built workspace the server needs (pnpm symlinks stay valid — root store +
# the two packages that reference it). Intentionally NOT process-documentation:
# the deployed platform clones real content repos, it doesn't serve bundled demo
# content.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/pnpm-workspace.yaml /app/.npmrc /app/package.json ./
COPY --from=build /app/apps/live-host ./apps/live-host
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/notations ./packages/notations
COPY --from=build /app/packages/cell-protocol ./packages/cell-protocol
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/packages/github-app ./packages/github-app
COPY --from=build /app/packages/http-kit ./packages/http-kit
COPY --from=build /app/packages/validator ./packages/validator
RUN mkdir -p /data
EXPOSE 8080
# runs as root so the mounted /data volume (root-owned) is writable — the
# platform key lives in Fly secrets, not on this box; harden per MR-3.
CMD ["node", "apps/live-host/src/server.ts"]
