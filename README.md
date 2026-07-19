# boilerplate-nestjs-api.

> NestJS 11 · TypeScript 6 · Prisma 7 · PostgreSQL · JWT · OAuth 2.0 · Argon2 · Swagger

Production-grade REST API starter with auth, validation, and DevOps wired up.

## Stack

| Layer | Tech | Version |
|-------|------|---------|
| Framework | NestJS | 11.1 |
| Language | TypeScript | 6.0 |
| ORM | Prisma | 7.8 |
| Database | PostgreSQL | 17 |
| Auth | JWT + OAuth 2.0 (Passport) | |
| Hashing | Argon2 | 0.43 |
| Validation | class-validator + class-transformer | |
| Rate limiting | @nestjs/throttler | |
| Testing | Jest + Supertest | |

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-nestjs-api.git
cd boilerplate-nestjs-api
pnpm install

# Start Postgres + Redis
docker-compose up postgres redis -d

cp .env.example .env   # fill in JWT_SECRET and DATABASE_URL

pnpm db:generate
pnpm db:migrate
pnpm dev               # http://localhost:4000/v1
```

## API Endpoints

```
POST /v1/auth/register   → { accessToken, refreshToken, expiresIn }
POST /v1/auth/login      → { accessToken, refreshToken, expiresIn }
POST /v1/auth/refresh    → { accessToken, refreshToken, expiresIn }
GET  /v1/users/:id       → User
```

## Project Structure

```
src/
├── auth/           # JWT + OAuth 2.0 auth (service, controller, strategies)
├── users/          # Users CRUD
├── common/
│   ├── decorators/ # @Roles(), @CurrentUser()
│   ├── filters/    # AllExceptionsFilter → structured JSON errors
│   ├── guards/     # JwtAuthGuard, RolesGuard
│   ├── pipes/      # Custom validation pipes
│   └── prisma/     # Global PrismaModule + PrismaService
├── config/
│   └── env.schema.ts   # Zod-validated env vars
└── main.ts         # Bootstrap: versioning, global pipes/filters, CORS
prisma/
└── schema.prisma   # User, RefreshToken models
```

## Docker

```bash
docker-compose up        # postgres + redis + api
```

## Spec Progress

See [SPEC.md](./SPEC.md) for the full feature roadmap.
