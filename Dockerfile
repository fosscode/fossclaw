# FossClaw Dockerfile
# Multi-stage build for minimal production image

FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY web/package.json web/bun.lock* ./web/

# Install dependencies
WORKDIR /app/web
RUN bun install --frozen-lockfile

# Copy source files
COPY web/ ./

# Build frontend
RUN bun run build

# Production stage
FROM oven/bun:1-slim

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built assets and server code from builder
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/web/server ./web/server
COPY --from=builder /app/web/package.json ./web/package.json

# Copy additional files
COPY LICENSE README.md ./

# Install production dependencies
WORKDIR /app/web
RUN bun install --production --frozen-lockfile

# Create data directories
RUN mkdir -p /data/sessions /data/certs

# Environment variables with defaults
ENV NODE_ENV=production \
    PORT=3456 \
    FOSSCLAW_SESSION_DIR=/data/sessions \
    FOSSCLAW_CERT_DIR=/data/certs \
    FOSSCLAW_CWD=/workspace

# Expose port
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://localhost:3456/api/health').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1

# Run server
CMD ["bun", "server/index.ts"]
