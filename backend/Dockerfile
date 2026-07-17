# Multi-stage build for the paymaster backend.
#
# The stages exist for a security reason, not just image size: the final image contains no
# compiler, no dev dependencies, and no test code — so a vulnerability in any of them is not
# reachable in production, and there is nothing in the image to compile an exploit with.

# ---------------------------------------------------------------------------------------------
# deps: production dependencies only
# ---------------------------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/

# `npm ci` installs exactly the lockfile — never a resolved-at-build-time version. A build that
# silently picks up a new transitive dependency is a build that ships code nobody reviewed.
RUN npm ci --omit=dev --workspace @paymaster/backend --include-workspace-root

# ---------------------------------------------------------------------------------------------
# build: typecheck against the full dependency set
# ---------------------------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
RUN npm ci --workspace @paymaster/backend --include-workspace-root

COPY backend/ ./backend/

# Typecheck in the image, not just in CI. It costs seconds and it means an image can never be
# built from code that does not compile.
RUN npm run typecheck --workspace @paymaster/backend

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# tini as PID 1: node does not reap zombies or forward signals to children on its own, and
# without correct SIGTERM handling every rolling deploy drops in-flight requests.
RUN apk add --no-cache tini

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY package.json ./
COPY backend/package.json ./backend/
COPY backend/src ./backend/src
COPY backend/migrations ./backend/migrations

# Run unprivileged. The node image ships a `node` user; use it rather than inventing another.
USER node

EXPOSE 3000

# Liveness only — readiness depends on the chain and belongs to the orchestrator, which can route
# traffic away without killing the process. A container that restarts because an RPC blipped turns
# a degradation into an outage.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "backend/src/main.ts"]
