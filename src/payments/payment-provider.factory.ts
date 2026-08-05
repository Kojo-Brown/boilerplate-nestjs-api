import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentProviderNotConfiguredError, UnknownPaymentProviderError } from "./payment.errors";
import { PAYMENT_PROVIDERS, isPaymentProviderName } from "./ports";
import type { PaymentProvider, PaymentProviderName } from "./ports";

/**
 * Resolves the payment gateway to use, at call time, from configuration.
 *
 * The registry is built from the injected {@link PAYMENT_PROVIDERS} collection,
 * so the factory names no implementation: adding a gateway is one entry in
 * `payments.module.ts` and nothing here changes (OCP). Consumers depend on the
 * `PaymentProvider` port and on this factory, never on `StripePaymentProvider`
 * — which is what lets `PAYMENTS_PROVIDER=mock` run a whole checkout suite
 * without a network.
 *
 * "At call time" is deliberate rather than a boot-time `useFactory` binding of
 * one provider: `resolve(name)` lets a request, a tenant, or a saved customer
 * preference pick a different gateway from the default without a redeploy, and
 * a boot-time binding cannot express that.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly logger = new Logger(PaymentProviderFactory.name);
  private readonly registry: ReadonlyMap<PaymentProviderName, PaymentProvider>;
  private readonly defaultName: PaymentProviderName;

  constructor(
    config: ConfigService,
    @Inject(PAYMENT_PROVIDERS) providers: readonly PaymentProvider[],
  ) {
    const registry = new Map<PaymentProviderName, PaymentProvider>();
    for (const provider of providers) {
      if (registry.has(provider.name)) {
        // Two providers on one name means one silently shadows the other, and
        // which one wins depends on module registration order. Fail at boot.
        throw new Error(`Duplicate payment provider registered for name "${provider.name}"`);
      }
      registry.set(provider.name, provider);
    }
    this.registry = registry;

    const configured = config.get<string>("PAYMENTS_PROVIDER") ?? "mock";
    if (!isPaymentProviderName(configured) || !registry.has(configured)) {
      throw new Error(
        `PAYMENTS_PROVIDER is "${configured}", which is not a registered provider ` +
          `(${[...registry.keys()].join(", ")})`,
      );
    }
    this.defaultName = configured;

    const unconfigured = [...registry.values()]
      .filter((provider) => !provider.isConfigured)
      .map((provider) => provider.name);
    if (unconfigured.length > 0) {
      // Not fatal: an unconfigured provider is only a problem if something asks
      // for it, and the env schema already guarantees the default is usable.
      this.logger.log(
        `Payment providers without credentials, unavailable until configured: ${unconfigured.join(", ")}`,
      );
    }
  }

  /** The provider named by `PAYMENTS_PROVIDER`. */
  get defaultProvider(): PaymentProvider {
    return this.resolve(this.defaultName);
  }

  get defaultProviderName(): PaymentProviderName {
    return this.defaultName;
  }

  /** Every registered name, whether or not it has credentials. */
  get registered(): readonly PaymentProviderName[] {
    return [...this.registry.keys()];
  }

  /** The names that could actually take a payment right now. */
  get available(): readonly PaymentProviderName[] {
    return [...this.registry.values()]
      .filter((provider) => provider.isConfigured)
      .map((provider) => provider.name);
  }

  /**
   * Resolves a provider by name, falling back to the configured default.
   *
   * Throws `UnknownPaymentProviderError` (400) for a name that is not
   * registered — that is caller input — and
   * `PaymentProviderNotConfiguredError` (503) for one that is registered but
   * has no credentials, which is an operator problem and not the caller's
   * fault. Collapsing both into one status would make the difference
   * undebuggable from a log line.
   */
  resolve(name?: string | null): PaymentProvider {
    const requested = name ?? this.defaultName;

    if (!isPaymentProviderName(requested)) {
      throw new UnknownPaymentProviderError(requested, this.registered);
    }

    const provider = this.registry.get(requested);
    if (!provider) {
      throw new UnknownPaymentProviderError(requested, this.registered);
    }
    if (!provider.isConfigured) {
      throw new PaymentProviderNotConfiguredError(provider.name, requiredEnvFor(provider.name));
    }

    return provider;
  }
}

/**
 * Credentials each provider needs, for the error message only.
 *
 * Kept here rather than on the port so `PaymentProvider` stays a behavioural
 * interface: an implementation should not have to describe its own environment
 * variables to satisfy the type.
 */
function requiredEnvFor(name: PaymentProviderName): readonly string[] {
  switch (name) {
    case "stripe":
      return ["STRIPE_SECRET_KEY"];
    case "paypal":
      return ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"];
    case "mock":
      return [];
  }
}
