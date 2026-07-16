# syntax=docker/dockerfile:1
# Portal (VitePress) + MCP server (Streamable HTTP) in one image.
# Runtime = packages/mcp/http.ts serving process-documentation/.vitepress/dist
# and POST /mcp. Build context = the monorepo root (pnpm workspace).
#
# Build (from the repo root):  docker build -t bpmiq-portal .
# Serves any content repo: set BPM_CONTENT_ROOT / mount your checkout (docs/on-prem).

FROM node:25-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/live-host/package.json ./apps/live-host/
COPY apps/web/package.json ./apps/web/
COPY apps/vscode/package.json ./apps/vscode/
COPY packages/notations/package.json ./packages/notations/
COPY packages/cell-protocol/package.json ./packages/cell-protocol/
COPY packages/github-app/package.json ./packages/github-app/
COPY packages/http-kit/package.json ./packages/http-kit/
COPY packages/validator/package.json ./packages/validator/
COPY packages/mcp/package.json ./packages/mcp/
COPY process-documentation/package.json ./process-documentation/
# --frozen-lockfile: the image must install the EXACT versions CI validated, not
# resolve caret ranges fresh (reproducible + closes in-range dependency substitution)
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm portal:build

FROM node:25-slim
RUN corepack enable
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Runtime needs: the MCP server + its deps, the built portal, and the content
# the MCP tools read (process-documentation/processes, /landscape).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/pnpm-workspace.yaml /app/.npmrc /app/package.json ./
COPY --from=build /app/packages/notations ./packages/notations
COPY --from=build /app/packages/mcp ./packages/mcp
COPY --from=build /app/process-documentation ./process-documentation
EXPOSE 8080
USER node
CMD ["node", "packages/mcp/http.ts"]
