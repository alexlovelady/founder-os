# Build context is the repository root (Railway uploads from the root). Select this file with RAILWAY_DOCKERFILE_PATH=shell/Dockerfile.
# The shell and every tool are npm workspaces, so dependencies install from the repo root.
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY shell/package.json shell/
COPY modules/sdk/package.json modules/sdk/
COPY modules/finance/package.json modules/finance/
COPY modules/compliance/package.json modules/compliance/
COPY modules/health/package.json modules/health/
COPY modules/tasks/package.json modules/tasks/
COPY modules/vault/package.json modules/vault/
COPY modules/sops/package.json modules/sops/
COPY modules/crm/package.json modules/crm/
COPY modules/marketing/package.json modules/marketing/
COPY modules/founderai/package.json modules/founderai/
COPY modules/product/package.json modules/product/
COPY modules/competitors/package.json modules/competitors/
RUN npm ci
COPY shell shell
COPY modules/sdk modules/sdk
COPY modules/finance modules/finance
COPY modules/compliance modules/compliance
COPY modules/health modules/health
COPY modules/tasks modules/tasks
COPY modules/vault modules/vault
COPY modules/sops modules/sops
COPY modules/crm modules/crm
COPY modules/marketing modules/marketing
COPY modules/founderai modules/founderai
COPY modules/product modules/product
COPY modules/competitors modules/competitors
# The rewrites in next.config.ts are fixed at build time: the address of the LegalAI service on Railway's private network.
ARG LEGAL_URL=http://localhost:8000
ENV LEGAL_URL=$LEGAL_URL
RUN npm run build --workspace shell

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0
# With the repository root as the tracing root, the standalone server lives at shell/server.js.
COPY --from=build /repo/shell/.next/standalone ./
COPY --from=build /repo/shell/.next/static ./shell/.next/static
COPY --from=build /repo/shell/public ./shell/public
COPY --from=build /repo/shell/migrations ./shell/migrations
COPY --from=build /repo/shell/scripts ./shell/scripts
# The base migration script runs before the server and needs the database driver (it has no dependencies of its own).
COPY --from=build /repo/node_modules/postgres ./node_modules/postgres
CMD ["sh", "-c", "node shell/scripts/migrate.mjs && node shell/server.js"]
