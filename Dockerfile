# syntax=docker/dockerfile:1
# Built for linux/amd64 only (DS220+ is an Intel J4025):
#   docker buildx build --platform linux/amd64 -t ghcr.io/azthrun/dreambig-nas-mcp .

# --- build: compile TypeScript ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- deps: production dependencies only ---
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runtime: compiled output + production deps ---
FROM node:24-alpine
ENV NODE_ENV=production \
    NAS_MCP_ROOT=/data \
    NAS_MCP_PORT=8080 \
    NAS_MCP_HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Files stay root-owned and world-readable, so any UID/GID can run them but none can modify them.
# Default to the unprivileged "node" user; compose overrides with the owner's UID/GID.
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${NAS_MCP_PORT}/healthz" || exit 1
CMD ["node", "dist/index.js"]
