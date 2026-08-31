import { Role } from "@prisma/client";
import type { AnyDomainEvent } from "@/events";
import { isVisibleTo, type StreamAudience } from "./stream-visibility";

const registered = (userId: string): AnyDomainEvent => ({
  id: "evt-1",
  name: "user.registered",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: null,
  payload: { userId, email: "erin@example.com", name: "Erin Example", provider: null },
});

const deleted = (userId: string): AnyDomainEvent => ({
  id: "evt-2",
  name: "user.deleted",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: null,
  payload: { userId, email: "erin@example.com" },
});

const admin: StreamAudience = { id: "admin-1", role: Role.ADMIN };
const erin: StreamAudience = { id: "user-1", role: Role.USER };

describe("isVisibleTo", () => {
  it("shows an administrator the whole catalogue", () => {
    expect(isVisibleTo(registered("someone-else"), admin)).toBe(true);
    expect(isVisibleTo(deleted("someone-else"), admin)).toBe(true);
  });

  it("shows an ordinary user their own events", () => {
    expect(isVisibleTo(registered("user-1"), erin)).toBe(true);
    expect(isVisibleTo(deleted("user-1"), erin)).toBe(true);
  });

  /**
   * The reason this module exists. `user.registered` carries an email address,
   * and the bus carries every registration in the process — so an endpoint
   * without this filter would stream the address of everyone who signs up to
   * every authenticated caller, in real time.
   */
  it("hides another user's events, including the address they carry", () => {
    expect(isVisibleTo(registered("user-2"), erin)).toBe(false);
    expect(isVisibleTo(deleted("user-2"), erin)).toBe(false);
  });

  it("does not treat an unrecognised role as privileged", () => {
    expect(isVisibleTo(registered("user-2"), { id: "user-1", role: "SUPPORT" })).toBe(false);
  });

  /**
   * `user.deleted` for the connected user is reachable rather than academic:
   * the access token outlives the row, so their own stream stays open and
   * authenticated after the account is gone. It is the one event that makes
   * that connection worth keeping until the token expires.
   */
  it("tells a user their own account was deleted", () => {
    expect(isVisibleTo(deleted("user-1"), erin)).toBe(true);
  });
});
