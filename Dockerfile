# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.4.1

# The admin UI is static files, so it is built once on the build machine for all target platforms
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS admin-ui
ARG PNPM_VERSION
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/admin-ui/package.json packages/admin-ui/
RUN pnpm install --frozen-lockfile --filter @ebics-test-server/admin-ui
COPY packages/admin-ui packages/admin-ui
RUN pnpm build:admin

# Production dependencies per target platform: better-sqlite3 and esbuild ship native binaries
FROM node:${NODE_VERSION}-slim AS server-deps
ARG PNPM_VERSION
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/
COPY packages/admin-ui/package.json packages/admin-ui/
RUN pnpm install --frozen-lockfile --prod --filter @ebics-test-server/server

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    PORT=4150 \
    EBICS_DB_PATH=/data/ebics-test.db
WORKDIR /app/packages/server
COPY --from=server-deps /app /app
COPY packages/server/schemas schemas
COPY packages/server/src src
COPY --from=admin-ui /app/packages/admin-ui/build /app/packages/admin-ui/build
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4150
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/index.ts"]
