# boilerplate-nestjs-api — Agent Instructions

## What this repo is
Production-grade NestJS 11 REST API boilerplate. Spec-driven: features added one at a time per SPEC.md.

## Your job (scheduled agent, every 4h)
1. `git checkout main && git pull --ff-only origin main`
2. Read `SPEC.md`, take the **first** `- [ ]` item. Phase 0 items always win.
3. `git checkout -b <type>/<kebab-slug>` (`feat`/`fix`/`chore`/`ci`/`docs`)
4. Implement it completely — module, service, controller, DTOs, tests, docs.
5. Run every gate locally; **all must pass** before pushing:
   ```
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```
6. Commit, `git push -u origin <branch>`, then `gh pr create`.
7. `gh pr checks --watch` → **merge only if every check is green**:
   `gh pr merge --squash --delete-branch`
8. Pull main, mark the item `- [x]` in `SPEC.md`, update `../PROGRESS.md`,
   push as a `chore:` commit.

If a check fails, fix forward on the same branch. Never merge red. Never weaken
a test or lower the coverage threshold to force green.

## Secrets
Never commit real credentials, tokens, keys, or `.env` files. JWT secrets, DB
URLs, and OAuth client secrets come from the environment and are validated by
the Zod config module at boot. Scan `git diff --cached` before every push.

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
