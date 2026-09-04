import { DEFAULT_USER_PREFERENCES } from "./types/user-preferences";
import type { UserPreferences } from "./types/user-preferences";
import { isDeeplyFrozen } from "@/common/immutable";
import { UNCONDITIONAL, VersionConflictError } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import type { UsersStore } from "./ports";

/**
 * The behavioural contract every user store must satisfy.
 *
 * The users module's handlers are typed against the ports, so any
 * implementation may be
 * substituted for any other (LSP) — but the type system only checks the
 * signatures. What breaks in practice is behaviour: a double that resolves
 * with `undefined` where Prisma resolves with `null`, or that happily updates
 * a row that does not exist where Prisma rejects. Both compile; both make a
 * green suite worthless.
 *
 * So the contract lives here once and is run against every implementation by
 * `users-store.contract.spec.ts`. Adding a store means adding one line there,
 * not copying assertions.
 */
export function describeUsersStoreContract(name: string, createStore: () => UsersStore): void {
  describe(`${name} (users store contract)`, () => {
    let store: UsersStore;

    beforeEach(() => {
      store = createStore();
    });

    describe("findById()", () => {
      it("resolves with null — not undefined — for an unknown id", async () => {
        await expect(store.findById("missing")).resolves.toBeNull();
      });

      it("resolves with the created row", async () => {
        const created = await store.create({ email: "ada@example.test" });

        await expect(store.findById(created.id)).resolves.toMatchObject({ id: created.id });
      });
    });

    describe("findByEmail()", () => {
      it("resolves with null for an unknown address", async () => {
        await expect(store.findByEmail("nobody@example.test")).resolves.toBeNull();
      });

      it("matches the address exactly", async () => {
        await store.create({ email: "ada@example.test" });

        await expect(store.findByEmail("ada@example.test")).resolves.not.toBeNull();
        await expect(store.findByEmail("ADA@example.test")).resolves.toBeNull();
      });
    });

    describe("findByProviderAccount()", () => {
      it("resolves with null when only one half of the pair matches", async () => {
        await store.create({
          email: "ada@example.test",
          provider: "google",
          providerAccountId: "google-1",
        });

        await expect(store.findByProviderAccount("google", "google-2")).resolves.toBeNull();
        await expect(store.findByProviderAccount("github", "google-1")).resolves.toBeNull();
        await expect(store.findByProviderAccount("google", "google-1")).resolves.not.toBeNull();
      });

      it("does not match users with no linked provider", async () => {
        await store.create({ email: "local@example.test" });

        await expect(store.findByProviderAccount("google", "google-1")).resolves.toBeNull();
      });
    });

    describe("findMany()", () => {
      it("returns at most limit + 1 rows so the caller can detect a next page", async () => {
        for (const email of ["a@example.test", "b@example.test", "c@example.test"]) {
          await store.create({ email });
        }

        await expect(store.findMany({ limit: 1 })).resolves.toHaveLength(2);
      });

      it("orders by creation time, oldest first", async () => {
        const first = await store.create({ email: "first@example.test" });
        const second = await store.create({ email: "second@example.test" });

        const rows = await store.findMany({ limit: 10 });

        expect(rows.map((u) => u.id)).toEqual([first.id, second.id]);
      });

      it("excludes the cursor row itself", async () => {
        const first = await store.create({ email: "first@example.test" });
        const second = await store.create({ email: "second@example.test" });

        const rows = await store.findMany({ limit: 10, cursor: first.id });

        expect(rows.map((u) => u.id)).toEqual([second.id]);
      });

      it("matches search case-insensitively against name and email", async () => {
        await store.create({ email: "ada@example.test", name: "Ada Lovelace" });
        await store.create({ email: "grace@example.test", name: "Grace Hopper" });

        await expect(store.findMany({ limit: 10, search: "LOVELACE" })).resolves.toHaveLength(1);
        await expect(store.findMany({ limit: 10, search: "GRACE@" })).resolves.toHaveLength(1);
        await expect(store.findMany({ limit: 10, search: "turing" })).resolves.toHaveLength(0);
      });
    });

    describe("create()", () => {
      it("defaults every optional column to null rather than undefined", async () => {
        const created = await store.create({ email: "ada@example.test" });

        expect(created.name).toBeNull();
        expect(created.password).toBeNull();
        expect(created.provider).toBeNull();
        expect(created.providerAccountId).toBeNull();
        expect(created.avatarUrl).toBeNull();
      });

      it("assigns the default role", async () => {
        const created = await store.create({ email: "ada@example.test" });

        expect(created.role).toBe("USER");
      });
    });

    describe("update()", () => {
      it("rejects for an unknown id instead of creating a row", async () => {
        await expect(store.update("missing", { name: "Nobody" }, UNCONDITIONAL)).rejects.toThrow();
        await expect(store.findById("missing")).resolves.toBeNull();
      });

      it("leaves omitted fields untouched", async () => {
        const created = await store.create({ email: "ada@example.test", name: "Ada" });

        const updated = await store.update(
          created.id,
          { avatarUrl: "avatars/ada.png" },
          UNCONDITIONAL,
        );

        expect(updated.name).toBe("Ada");
        expect(updated.avatarUrl).toBe("avatars/ada.png");
      });
    });

    describe("delete()", () => {
      it("rejects for an unknown id", async () => {
        await expect(store.delete("missing", UNCONDITIONAL)).rejects.toThrow();
      });

      it("resolves with the deleted row and removes it", async () => {
        const created = await store.create({ email: "ada@example.test" });

        await expect(store.delete(created.id, UNCONDITIONAL)).resolves.toMatchObject({
          id: created.id,
        });
        await expect(store.findById(created.id)).resolves.toBeNull();
      });
    });

    describe("getPreferences()", () => {
      it("resolves with the defaults for an unknown id rather than rejecting", async () => {
        await expect(store.getPreferences("missing")).resolves.toEqual(DEFAULT_USER_PREFERENCES);
      });

      it("fills unset fields from the defaults", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.setPreferences(created.id, { theme: "dark" }, UNCONDITIONAL);

        await expect(store.getPreferences(created.id)).resolves.toEqual({
          ...DEFAULT_USER_PREFERENCES,
          theme: "dark",
        });
      });
    });

    describe("setPreferences()", () => {
      it("rejects for an unknown id", async () => {
        await expect(
          store.setPreferences("missing", { theme: "dark" }, UNCONDITIONAL),
        ).rejects.toThrow();
      });

      it("merges rather than replaces", async () => {
        const created = await store.create({ email: "ada@example.test" });

        await store.setPreferences(created.id, { theme: "dark" }, UNCONDITIONAL);
        const merged = await store.setPreferences(created.id, { language: "fr" }, UNCONDITIONAL);

        expect(merged.preferences).toEqual({
          ...DEFAULT_USER_PREFERENCES,
          theme: "dark",
          language: "fr",
        });
      });

      it("resolves with the same value a subsequent read returns", async () => {
        const created = await store.create({ email: "ada@example.test" });

        const written = await store.setPreferences(
          created.id,
          { pushNotifications: true },
          UNCONDITIONAL,
        );

        await expect(store.getPreferences(created.id)).resolves.toEqual(written.preferences);
      });

      it("hands out preferences the caller cannot mutate", async () => {
        // Not a dev-only guarantee, and not one either store implements on
        // purpose: it falls out of `DEFAULT_USER_PREFERENCES` being frozen at
        // module load and every merge going through a helper that preserves
        // frozen-ness. That matters because the values are *shared* — a patch
        // that changes nothing returns its input, and a user who has never set
        // a preference is handed the defaults object itself. Were it writable,
        // one caller normalising "its own copy" in place would change the
        // defaults for every user in the process.
        const created = await store.create({ email: "ada@example.test" });
        const written = await store.setPreferences(created.id, { theme: "dark" }, UNCONDITIONAL);
        const read = await store.getPreferences(created.id);

        expect(isDeeplyFrozen(written.preferences)).toBe(true);
        expect(isDeeplyFrozen(read)).toBe(true);
        expect(isDeeplyFrozen(await store.getPreferences("missing"))).toBe(true);

        expect(() => {
          (read as UserPreferences).theme = "light";
        }).toThrow(TypeError);
        // The store's own state is intact, which is the property being bought.
        await expect(store.getPreferences(created.id)).resolves.toMatchObject({ theme: "dark" });
      });

      it("hands every user with nothing stored the same defaults object", async () => {
        // Identity, not equality — and the reason the freeze above is not
        // optional. Two different users who have never touched a preference are
        // handed *the same object*, because merging an empty patch returns its
        // input. This is the sharing structural sharing is named for, observed
        // through the store rather than asserted on the helper.
        //
        // Note what is deliberately not claimed: that two reads of the *same*
        // stored preferences are identical. Each read re-derives the value from
        // the stored partial, so that would be a caching property, not this one.
        const one = await store.create({ email: "one@example.test" });
        const two = await store.create({ email: "two@example.test" });

        expect(await store.getPreferences(one.id)).toBe(DEFAULT_USER_PREFERENCES);
        expect(await store.getPreferences(two.id)).toBe(DEFAULT_USER_PREFERENCES);
        expect(await store.getPreferences("missing")).toBe(DEFAULT_USER_PREFERENCES);
      });

      it("ignores keys explicitly set to undefined rather than erasing them", async () => {
        // Not a hypothetical shape. A patch reaches the store as an
        // `UpdateUserPreferencesDto` instance, and under `target: ES2022` every
        // declared field exists on it — the untouched ones as `undefined`. A
        // store that spreads the patch straight over the current value wipes
        // every preference the caller did not mention, and the next read then
        // returns `undefined` rather than even the default, which a notification
        // channel reads as "the user switched this off".
        const created = await store.create({ email: "ada@example.test" });
        await store.setPreferences(
          created.id,
          { theme: "dark", smsNotifications: true },
          UNCONDITIONAL,
        );

        const patched = await store.setPreferences(
          created.id,
          { language: "fr", theme: undefined, smsNotifications: undefined },
          UNCONDITIONAL,
        );

        expect(patched.preferences).toEqual({
          ...DEFAULT_USER_PREFERENCES,
          theme: "dark",
          smsNotifications: true,
          language: "fr",
        });
      });
    });

    // ─── Optimistic concurrency ───────────────────────────────────────────────
    //
    // These are the assertions the `ETag`/`If-Match` endpoints rest on, and the
    // reason they live in the shared contract rather than beside the Prisma
    // adapter: the e2e suite drives the whole application against an in-memory
    // store, so a double whose version counter drifted from the real one would
    // make every conflict test pass without proving anything about Postgres.

    describe("version", () => {
      it("starts a new row at 0", async () => {
        const created = await store.create({ email: "ada@example.test" });

        expect(created.version).toBe(0);
      });

      it("increments on every successful write, conditional or not", async () => {
        const created = await store.create({ email: "ada@example.test" });

        const first = await store.update(created.id, { name: "Ada" }, UNCONDITIONAL);
        expect(first.version).toBe(1);

        const second = await store.update(created.id, { name: "Ada L" }, exactly(1));
        expect(second.version).toBe(2);
      });

      it("moves when preferences are written, because they live on the same row", async () => {
        const created = await store.create({ email: "ada@example.test" });

        const written = await store.setPreferences(created.id, { theme: "dark" }, UNCONDITIONAL);

        expect(written.version).toBe(1);
        await expect(store.findById(created.id)).resolves.toMatchObject({ version: 1 });
      });
    });

    describe("conditional writes", () => {
      it("applies an update whose expected version matches", async () => {
        const created = await store.create({ email: "ada@example.test" });

        await expect(store.update(created.id, { name: "Ada" }, exactly(0))).resolves.toMatchObject({
          name: "Ada",
          version: 1,
        });
      });

      it("rejects with VersionConflictError when the row has moved on", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.update(created.id, { name: "Ada" }, UNCONDITIONAL);

        await expect(store.update(created.id, { name: "Grace" }, exactly(0))).rejects.toThrow(
          VersionConflictError,
        );
      });

      it("reports the version the row is actually at, so the caller knows what to re-read", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.update(created.id, { name: "Ada" }, UNCONDITIONAL);
        await store.update(created.id, { name: "Ada L" }, UNCONDITIONAL);

        await expect(store.update(created.id, { name: "Grace" }, exactly(0))).rejects.toMatchObject(
          {
            currentVersion: 2,
          },
        );
      });

      it("leaves the row untouched when the precondition fails", async () => {
        const created = await store.create({ email: "ada@example.test", name: "Ada" });
        await store.update(created.id, { avatarUrl: "avatars/ada.png" }, UNCONDITIONAL);

        await expect(store.update(created.id, { name: "Grace" }, exactly(0))).rejects.toThrow();

        await expect(store.findById(created.id)).resolves.toMatchObject({ name: "Ada" });
      });

      it("settles a lost update: only the first of two writers holding the same version wins", async () => {
        const created = await store.create({ email: "ada@example.test" });
        // Both read version 0 — the interleaving optimistic concurrency exists
        // to catch. Sequential here because the in-memory store is not
        // genuinely concurrent; what is being pinned is that the *second*
        // write is refused rather than silently applied over the first.
        const bothRead = exactly(created.version);

        await expect(store.update(created.id, { name: "Ada" }, bothRead)).resolves.toBeDefined();
        await expect(store.update(created.id, { name: "Grace" }, bothRead)).rejects.toThrow(
          VersionConflictError,
        );

        await expect(store.findById(created.id)).resolves.toMatchObject({ name: "Ada" });
      });

      it("accepts any of several expected versions", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.update(created.id, { name: "Ada" }, UNCONDITIONAL);

        const expected: ExpectedVersion = {
          mode: "list",
          tags: [
            { weak: false, opaque: "0", version: 0 },
            { weak: false, opaque: "1", version: 1 },
          ],
        };

        await expect(store.update(created.id, { name: "Grace" }, expected)).resolves.toMatchObject({
          version: 2,
        });
      });

      it("treats `If-Match: *` as satisfied by whatever version exists", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.update(created.id, { name: "Ada" }, UNCONDITIONAL);

        await expect(
          store.update(created.id, { name: "Grace" }, { mode: "any" }),
        ).resolves.toMatchObject({ version: 2 });
      });

      it("refuses a conditional delete against a stale version and keeps the row", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.update(created.id, { name: "Ada" }, UNCONDITIONAL);

        await expect(store.delete(created.id, exactly(0))).rejects.toThrow(VersionConflictError);
        await expect(store.findById(created.id)).resolves.not.toBeNull();
      });

      it("refuses a conditional preference write against a stale version", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.setPreferences(created.id, { theme: "dark" }, UNCONDITIONAL);

        await expect(
          store.setPreferences(created.id, { language: "fr" }, exactly(0)),
        ).rejects.toThrow(VersionConflictError);

        await expect(store.getPreferences(created.id)).resolves.toMatchObject({ theme: "dark" });
      });

      it("prefers the absence of a row over a conflict — a deleted row is not a stale one", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.delete(created.id, UNCONDITIONAL);

        // Whatever error this is, it must not be a version conflict: telling a
        // caller to re-read and retry a row that no longer exists sends it
        // round a loop that cannot terminate.
        await expect(store.update(created.id, { name: "Grace" }, exactly(0))).rejects.not.toThrow(
          VersionConflictError,
        );
      });
    });
  });
}

/** The `If-Match` a client sends after reading version `version`. */
function exactly(version: number): ExpectedVersion {
  return {
    mode: "list",
    tags: [{ weak: false, opaque: String(version), version }],
  };
}
