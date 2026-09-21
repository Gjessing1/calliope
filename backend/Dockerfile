# syntax=docker/dockerfile:1
#
# Calliope's production image: the Fastify backend with the built web app inside
# it, served same-origin.
#
# The quality gate runs INSIDE this build (see the `gate` stage), so a failing
# lint, typecheck or test means no image is produced and nothing is pushed. That
# is the same rule CI relies on.
#
# Debian slim rather than Alpine: `sharp` needs libvips and Alpine's musl
# prebuilds have historically been the one that breaks on a version bump. The
# extra ~40 MB buys a build that does not need investigating.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/epub/package.json packages/epub/
COPY packages/metadata/package.json packages/metadata/
COPY packages/library/package.json packages/library/
COPY apps/web/package.json apps/web/
COPY backend/package.json backend/
# `npm ci` fails outright when the lockfile does not describe these manifests —
# which is exactly the packaging mistake this image build exists to catch.
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS gate
COPY . .
RUN npm run format:check \
 && npm run lint \
 && npm run build \
 && npm run typecheck \
 && npm test

# Reinstall without dev dependencies for the runtime layer. Done from the gate
# stage so the built dist/ directories come along with it.
FROM gate AS prune
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prune /app/node_modules ./node_modules
COPY --from=prune /app/package.json ./package.json

# Every workspace the backend imports at runtime must be here. A package missing
# from this list is invisible to typecheck and to the tests, and shows up only
# as an import-time crash loop in the deployed container.
COPY --from=gate /app/packages/core/package.json ./packages/core/
COPY --from=gate /app/packages/core/dist ./packages/core/dist
COPY --from=gate /app/packages/epub/package.json ./packages/epub/
COPY --from=gate /app/packages/epub/dist ./packages/epub/dist
COPY --from=gate /app/packages/metadata/package.json ./packages/metadata/
COPY --from=gate /app/packages/metadata/dist ./packages/metadata/dist
COPY --from=gate /app/packages/library/package.json ./packages/library/
COPY --from=gate /app/packages/library/dist ./packages/library/dist
COPY --from=gate /app/backend/package.json ./backend/
COPY --from=gate /app/backend/dist ./backend/dist

# The built web app, served same-origin by the backend.
COPY --from=gate /app/apps/web/dist ./backend/public

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
ENV PORT=3008
ENV CALLIOPE_LIBRARY_ROOT=/books
ENV CALLIOPE_DATA_DIR=/data

EXPOSE 3008
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3008/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/index.js"]
