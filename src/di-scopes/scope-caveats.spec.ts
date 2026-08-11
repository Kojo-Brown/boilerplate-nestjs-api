import { Controller, Get, Injectable, Module, Scope } from "@nestjs/common";
import type {
  CallHandler,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Observable } from "rxjs";

/**
 * Two things request scope takes away that are easy to find out the hard way.
 *
 * Both are framework behaviour rather than behaviour of this repository, and
 * both are relied on by [docs/di-scopes.md](../../docs/di-scopes.md), so they
 * are pinned here: if a Nest upgrade changes either, this fails and the
 * document gets corrected instead of quietly becoming wrong.
 */
describe("Request scope caveats", () => {
  let app: INestApplication;
  let baseUrl: string;

  const hookCalls: string[] = [];
  let interceptorBuilds = 0;

  @Injectable({ scope: Scope.REQUEST })
  class ScopedWithHooks implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
    onModuleInit(): void {
      hookCalls.push("onModuleInit");
    }

    onApplicationBootstrap(): void {
      hookCalls.push("onApplicationBootstrap");
    }

    onModuleDestroy(): void {
      hookCalls.push("onModuleDestroy");
    }
  }

  @Injectable({ scope: Scope.REQUEST })
  class ScopedInterceptor implements NestInterceptor {
    constructor() {
      interceptorBuilds += 1;
    }

    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
      return next.handle();
    }
  }

  /** Injects the scoped provider, so it is request-scoped itself. */
  @Controller("scoped")
  class ScopedController {
    constructor(private readonly scoped: ScopedWithHooks) {}

    @Get()
    get(): { hooked: boolean } {
      return { hooked: this.scoped instanceof ScopedWithHooks };
    }
  }

  /** Injects nothing. Untouched by the scoped provider — or so it looks. */
  @Controller("plain")
  class PlainController {
    @Get()
    get(): { ok: boolean } {
      return { ok: true };
    }
  }

  @Module({
    controllers: [ScopedController, PlainController],
    providers: [ScopedWithHooks, { provide: APP_INTERCEPTOR, useClass: ScopedInterceptor }],
  })
  class CaveatsModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CaveatsModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  it("never calls a lifecycle hook on a request-scoped provider", async () => {
    expect(hookCalls).toEqual([]);

    await fetch(`${baseUrl}/scoped`);
    await fetch(`${baseUrl}/scoped`);

    // Not at boot, because no instance exists yet; not per request either.
    // Anything a provider would normally do in `onModuleInit` — open a client,
    // warm a cache, register a listener — has to move into the constructor,
    // where it runs on the request's own latency budget, every request.
    expect(hookCalls).toEqual([]);
  });

  it("rebuilds a request-scoped global enhancer on every route, not just the scoped ones", async () => {
    const before = interceptorBuilds;

    await fetch(`${baseUrl}/scoped`);
    await fetch(`${baseUrl}/plain`);

    // `/plain` injects nothing and its controller is a singleton, yet the
    // global interceptor was still built for it. A request-scoped enhancer
    // registered with `APP_INTERCEPTOR`, `APP_GUARD`, `APP_PIPE` or
    // `APP_FILTER` applies to every route in the application, so its scope
    // costs every route in the application.
    expect(interceptorBuilds).toBe(before + 2);
  });
});
