# The customer dashboard and public site, as a standalone Next.js server.
#
# Built from `web/` as the context (docker build -t paymaster-web web). It is not a workspace of the
# root monorepo and has its own lockfile, so nothing outside this directory is needed.
#
# `output: "standalone"` (next.config.ts) traces exactly the files the server imports into
# `.next/standalone`, so the runtime stage copies that and never installs `node_modules` — the
# identity SDK alone would otherwise be most of the image.

# ---------------------------------------------------------------------------------------------
# deps
# ---------------------------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm install` against the committed lockfile, not `npm ci`. On this dependency tree npm disagrees
# with itself: a lockfile freshly written by `npm install` is rejected by `npm ci` as out of sync
# (@emnapi/* optional peers under the Tailwind oxide WASM fallback, and date-fns under the identity
# SDK). Verified with npm 10 and 11. `install` still takes every version the lockfile pins; it only
# fills in the optional platform packages `ci` refuses to resolve. Switch back to `ci` once
# `npm ci` passes on a clean checkout.
RUN npm install --no-audit --no-fund

# ---------------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# NEXT_PUBLIC_* values are INLINED into the browser bundle at build time, so they are build args and
# not runtime env: setting NEXT_PUBLIC_PRIVY_APP_ID on the running container changes nothing. The
# app id is public by design (it names the Privy app; the backend's audience check is what protects
# sign-in), so baking it into an image is safe. Build one image per Privy app.
ARG NEXT_PUBLIC_PRIVY_APP_ID=""
ENV NEXT_PUBLIC_PRIVY_APP_ID=${NEXT_PUBLIC_PRIVY_APP_ID}
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Runtime configuration, read on the server only (lib/session.ts). Set these on the container:
#   PAYMASTER_API_URL           the backend, e.g. http://paymaster.internal — never exposed to browsers
#   PAYMASTER_TIMEOUT_MS        optional, default 8000
#   DASHBOARD_INSECURE_COOKIES  leave unset in production; "true" only for plain-http local testing

# The standalone server does not include static assets; they are copied next to it, where
# server.js serves them. `public/` is copied only if the app has one.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
