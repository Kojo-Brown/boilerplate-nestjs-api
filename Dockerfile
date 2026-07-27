# ─── Stage 1: Base ────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ─── Stage 2: All deps (needed for build + prisma generate) ───────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ─── Stage 3: Build ───────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client before compiling TypeScript
RUN pnpm exec prisma generate
RUN pnpm build
# Drop devDependencies in place. Prisma 7 writes the generated client into the
# package's own directory inside pnpm's store, so it cannot be cherry-picked from
# a separately-installed production tree — pruning here keeps the generated
# client and the pnpm symlink layout consistent with each other.
RUN pnpm prune --prod

# ─── Stage 4: Runner (minimal, non-root) ──────────────────────────────────────
FROM node:22-alpine AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

WORKDIR /app

# Production node_modules, including the generated Prisma client
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules

# Compiled application
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist

# Prisma schema + migrations (needed for prisma migrate deploy at startup)
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# package.json for runtime metadata
COPY --chown=nestjs:nodejs package.json ./

USER nestjs
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/main"]
