FROM node:20-bookworm-slim AS build
WORKDIR /app

# Native deps need a C++ toolchain + python at install time:
#   better-sqlite3 — compiled SQLite binding (node-gyp)
#   sharp          — usually fetches a prebuilt libvips, but falls back to a
#                    source build if the prebuilt isn't found for the arch.
#   @whiskeysockets/baileys + libsignal — pure JS but pulls in deps that
#                    occasionally need a compiler.
# We install build tools in the build stage only and discard them from the
# runtime image (multi-stage keeps the final image small).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      pkg-config \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && test -f dist/index.js   # fail the build clearly if dist layout regresses

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# tzdata is required for the TZ env var to actually map a zone name like
# "Africa/Johannesburg" — the slim base image strips it out otherwise and
# JS Date.toLocaleString() silently falls back to UTC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
RUN mkdir -p /data/photos /data/baileys-auth
ENV DATA_DIR=/data
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
