import { Injectable, Logger, OnApplicationBootstrap, Scope } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
// Not re-exported from the package root, and imported the same way
// `AspectWeaver` imports it.
import type { InstanceWrapper, PropertyMetadata } from "@nestjs/core/injector/instance-wrapper";

export type ScopeName = "DEFAULT" | "REQUEST" | "TRANSIENT";

export interface ScopedComponent {
  readonly name: string;
  readonly kind: "provider" | "controller";
  /** The scope written on the class — `DEFAULT` when the scope was inherited. */
  readonly declaredScope: ScopeName;
  /**
   * How the component ended up non-singleton: `declared` if its own
   * `@Injectable({ scope })` says so, `inherited` if a dependency's did.
   */
  readonly reason: "declared" | "inherited";
  /**
   * For an inherited scope, the dependency chain from this component to the
   * request-scoped provider responsible, this component first. Empty when the
   * scope was declared, or when no chain could be attributed.
   */
  readonly causedBy: readonly string[];
}

export interface ScopeAuditReport {
  /** Rebuilt for every request: the ones that asked for it, and the ones that did not. */
  readonly requestScoped: readonly ScopedComponent[];
  /** One instance per injection site. Cheap, and unrelated to request lifetime. */
  readonly transient: readonly ScopedComponent[];
}

/**
 * Reports, at boot, every component the container will rebuild per request —
 * and which dependency is responsible for the ones that never asked to be.
 *
 * Scope propagates upwards and silently. A provider is non-static if anything
 * in its dependency tree is, so adding one request-scoped dependency four
 * layers down converts every consumer above it, up to and including the
 * controller. Nothing in those files changes, no warning is printed, and the
 * unit tests still pass, because constructing one instance and making one call
 * cannot tell a singleton from a per-request instance. The first symptom is
 * usually a cache with a permanent 0% hit rate, or a `p99` that grew during a
 * release nobody associates with DI.
 *
 * This makes that visible. `InstanceWrapper.isDependencyTreeStatic()` is the
 * same computation Nest itself uses to decide whether to clone a provider per
 * request, so the report is not an approximation of the rule — it is the rule,
 * read back. Attribution walks the wrapper's own constructor and property
 * dependency metadata, which is populated by the injector as it resolves the
 * graph.
 *
 * Two deliberate limits:
 *
 * - It runs on `onApplicationBootstrap`, after the whole graph is resolved.
 *   Anything resolved lazily afterwards — `moduleRef.create()`, a module
 *   registered at runtime — is not in the report.
 * - It reports; it does not fail. Request scope is a legitimate choice, and a
 *   boot that refuses to start over a design decision would be worse than a
 *   warning. Assert on {@link audit} in a test if you want a repository to hold
 *   a specific line, the way `scope-audit.service.spec.ts` does for this one.
 */
@Injectable()
export class ScopeAudit implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScopeAudit.name);

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    const report = this.audit();
    const inherited = report.requestScoped.filter((entry) => entry.reason === "inherited");

    if (report.requestScoped.length === 0) {
      this.logger.log("No request-scoped components: the whole graph is built once.");
      return;
    }

    this.logger.log(
      `${report.requestScoped.length} component(s) are rebuilt per request, ` +
        `${report.transient.length} provider(s) are transient.`,
    );

    for (const entry of inherited) {
      this.logger.warn(
        `${entry.name} is rebuilt per request but never asked to be` +
          (entry.causedBy.length > 1 ? `: ${entry.causedBy.join(" → ")}` : "") +
          ". Pass the request data in as an argument, or resolve it through " +
          "RequestContextResolver, to keep it a singleton.",
      );
    }
  }

  /** Exposed so tests can assert on the shape of the graph rather than on log output. */
  audit(): ScopeAuditReport {
    const requestScoped: ScopedComponent[] = [];
    const transient: ScopedComponent[] = [];

    for (const [kind, wrappers] of [
      ["provider", this.discovery.getProviders()],
      ["controller", this.discovery.getControllers()],
    ] as const) {
      for (const wrapper of wrappers) {
        // An alias (`useExisting`) is a second name for a provider already in
        // this list; reporting it would double-count one instance. Framework
        // internals are dropped for a different reason: `REQUEST` and
        // `INQUIRER` are request-scoped and transient *by definition*, and a
        // report whose first two lines are always the same two lines trains
        // the reader to skip it.
        if (wrapper.isAlias || isFrameworkInternal(wrapper)) continue;

        if (wrapper.isTransient) {
          transient.push(describe(wrapper, kind, "TRANSIENT", "declared", []));
          continue;
        }
        if (wrapper.isDependencyTreeStatic()) continue;

        const declared = wrapper.scope === Scope.REQUEST;
        requestScoped.push(
          describe(
            wrapper,
            kind,
            declared ? "REQUEST" : "DEFAULT",
            declared ? "declared" : "inherited",
            declared ? [] : traceToRequestScope(wrapper),
          ),
        );
      }
    }

    return { requestScoped: sortByName(requestScoped), transient: sortByName(transient) };
  }
}

function describe(
  wrapper: InstanceWrapper,
  kind: "provider" | "controller",
  declaredScope: ScopeName,
  reason: "declared" | "inherited",
  causedBy: readonly string[],
): ScopedComponent {
  return { name: nameOf(wrapper), kind, declaredScope, reason, causedBy };
}

function nameOf(wrapper: InstanceWrapper): string {
  const name: unknown = wrapper.name;
  if (typeof name === "string") return name;
  if (typeof name === "function") return name.name;
  return String(name);
}

/**
 * The container's own request-scoped and transient providers. `REQUEST` is the
 * request object itself and `INQUIRER` is the consumer handed to a transient —
 * neither is a design decision anybody in this repository made, and neither can
 * be changed.
 */
function isFrameworkInternal(wrapper: InstanceWrapper): boolean {
  const name = nameOf(wrapper);
  return name === "REQUEST" || name === "INQUIRER";
}

/**
 * The shortest dependency chain from `wrapper` to a provider that declares
 * request scope, breadth-first so the chain named is the closest cause rather
 * than an arbitrary one.
 *
 * Breadth-first also bounds the work: the search stops at the first declared
 * scope on each path, and `visited` keeps a cycle (a `forwardRef` pair, say)
 * from looping.
 */
function traceToRequestScope(wrapper: InstanceWrapper): readonly string[] {
  const visited = new Set<InstanceWrapper>([wrapper]);
  const queue: InstanceWrapper[][] = [[wrapper]];

  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const tail = path[path.length - 1];
    if (!tail) continue;

    if (path.length > 1 && tail.scope === Scope.REQUEST) {
      return path.map(nameOf);
    }

    for (const dependency of dependenciesOf(tail)) {
      // Only non-static dependencies can be the cause, and following the
      // static ones would walk most of the container for nothing.
      if (visited.has(dependency) || dependency.isDependencyTreeStatic()) continue;
      visited.add(dependency);
      queue.push([...path, dependency]);
    }
  }

  return [];
}

/**
 * Both accessors read a field the injector only creates when it has something
 * to put there, so a provider with no constructor arguments — or none injected
 * by property — returns `undefined` rather than an empty array, despite what
 * the return types say. Nest's own `introspectDepsAttribute` guards the same
 * way.
 */
function dependenciesOf(wrapper: InstanceWrapper): InstanceWrapper[] {
  const ctor: readonly InstanceWrapper[] = wrapper.getCtorMetadata() ?? [];
  const properties: readonly PropertyMetadata[] = wrapper.getPropertiesMetadata() ?? [];
  return [...ctor, ...properties.map((property) => property.wrapper)].filter(
    (dependency): dependency is InstanceWrapper => Boolean(dependency),
  );
}

function sortByName(components: ScopedComponent[]): ScopedComponent[] {
  return [...components].sort((a, b) => a.name.localeCompare(b.name));
}
