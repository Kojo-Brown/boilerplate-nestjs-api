import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Extends the default ThrottlerGuard to extract the real client IP when the API
 * sits behind a reverse-proxy or load-balancer that sets X-Forwarded-For.
 * Falls back to the socket remote address when no forwarded header is present.
 */
@Injectable()
export class ProxyAwareThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = req["headers"] as Record<string, string | string[] | undefined> | undefined;
    const forwarded = headers?.["x-forwarded-for"];
    if (forwarded) {
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const ip = first?.split(",")[0]?.trim();
      if (ip) return ip;
    }
    return (req["ip"] as string | undefined) ?? "unknown";
  }
}
