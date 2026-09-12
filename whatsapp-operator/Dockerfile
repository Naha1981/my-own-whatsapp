# syntax=docker/dockerfile:1
FROM node:20-slim AS build
# Baileys depends on packages fetched straight from GitHub (libsignal). Two
# failure modes on node:20-slim, both hit during package installation:
#   1. git is not installed              -> "npm error spawn git ENOENT"
#   2. npm resolves those deps as          "git+ssh://git@github.com/..."
#      and anonymous SSH has no SSH key  -> "Permission denied (publickey)"
# Fix: install git and rewrite every SSH GitHub URL to HTTPS — public repos
# clone anonymously over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --global url."https://github.com/".insteadOf "git@github.com:"
WORKDIR /app
COPY package.json package-lock.json* ./
# Use npm install so the lockfile can be regenerated when new MCP dependencies
# are introduced by a deployment build. The committed package.json remains the
# source of truth for production dependencies.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/db ./db
EXPOSE 3001
CMD ["node", "dist/index.js"]
