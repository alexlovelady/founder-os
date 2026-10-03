# Build context is the repository root (Railway uploads from the root). Select this file with RAILWAY_DOCKERFILE_PATH=shell/Dockerfile.
FROM node:22-slim AS build
WORKDIR /app
COPY shell/package.json shell/package-lock.json ./
RUN npm ci
COPY shell .
# The rewrites in next.config.ts are fixed at build time: the address of the LegalAI service on Railway's private network.
ARG LEGAL_URL=http://localhost:8000
ENV LEGAL_URL=$LEGAL_URL
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# The migration script runs before the server and needs the database driver (it has no dependencies of its own).
COPY --from=build /app/node_modules/postgres ./node_modules/postgres
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
