# syntax=docker/dockerfile:1
# MCP server (Streamable HTTP) image. Runtime = packages/mcp/http.ts serving
# POST /mcp over the bundled example content (process-documentation). Build
# context = the monorepo root (pnpm workspace).
#
# Build (from the repo root):  docker build -t bpmiq-mcp .
# Serves any content repo: set BPM_CONTENT_ROOT / mount your checkout (docs/on-prem).

FROM node:24-slim AS build
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
# --frozen-lockfile: the image must install the EXACT versions CI validated, not
# resolve caret ranges fresh (reproducible + closes in-range dependency substitution)
RUN pnpm install --frozen-lockfile
COPY . .

FROM node:24-slim
RUN corepack enable
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Runtime needs: the MCP server + its deps and the content the tools read
# (process-documentation: bpmiq.yml + processes/*.bpmn — the default example).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/pnpm-workspace.yaml /app/.npmrc /app/package.json ./
COPY --from=build /app/packages/notations ./packages/notations
# tools.ts imports @bpmiq/contracts/todo-anchor (list_todos) — the workspace
# symlink in node_modules dangles without the real package source
COPY --from=build /app/packages/contracts ./packages/contracts
COPY --from=build /app/packages/mcp ./packages/mcp
COPY --from=build /app/process-documentation ./process-documentation
EXPOSE 8080
USER node
CMD ["node", "packages/mcp/http.ts"]
