# boilerplate-nestjs-api — Agent Instructions

## What this repo is
Production-grade NestJS 11 REST API boilerplate. Spec-driven: features added one at a time per SPEC.md.

## Your job (scheduled agent)
1. Read `SPEC.md` — find the first `- [ ]` item
2. Implement it completely (module, service, controller, DTOs, tests)
3. `pnpm typecheck && pnpm lint && pnpm test` before committing
4. `git add -A && git commit -m "feat: <feature>" && git push origin main`
5. Mark the item `- [x]` in SPEC.md and push: `git commit -m "chore: mark spec done" && git push`
6. Update `/Users/nicholasbrown/Desktop/Boilerplates/PROGRESS.md`

## Versions (do not change)
- NestJS 11.1.27 | TypeScript 6.0.3 | Prisma 7.8.0
- argon2 | class-validator | passport-jwt | @nestjs/swagger

## Conventions
- Modules follow NestJS module pattern: `*.module.ts`, `*.service.ts`, `*.controller.ts`, `dto/`
- Path alias `@/` maps to `src/`
- All routes under `/v1/` (URI versioning already configured in main.ts)
- DTOs use class-validator decorators; never use raw `any`
- Prisma is `@Global()` via PrismaModule — never re-import in feature modules
- Error responses always go through `AllExceptionsFilter` — never `.status(500).json()` manually
