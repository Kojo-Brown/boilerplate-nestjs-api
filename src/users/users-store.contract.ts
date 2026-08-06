import { DEFAULT_USER_PREFERENCES } from "./types/user-preferences";
import type { UsersStore } from "./ports";

/**
 * The behavioural contract every user store must satisfy.
 *
 * `UsersService` is typed against the ports, so any implementation may be
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
        await expect(store.update("missing", { name: "Nobody" })).rejects.toThrow();
        await expect(store.findById("missing")).resolves.toBeNull();
      });

      it("leaves omitted fields untouched", async () => {
        const created = await store.create({ email: "ada@example.test", name: "Ada" });

        const updated = await store.update(created.id, { avatarUrl: "avatars/ada.png" });

        expect(updated.name).toBe("Ada");
        expect(updated.avatarUrl).toBe("avatars/ada.png");
      });
    });

    describe("delete()", () => {
      it("rejects for an unknown id", async () => {
        await expect(store.delete("missing")).rejects.toThrow();
      });

      it("resolves with the deleted row and removes it", async () => {
        const created = await store.create({ email: "ada@example.test" });

        await expect(store.delete(created.id)).resolves.toMatchObject({ id: created.id });
        await expect(store.findById(created.id)).resolves.toBeNull();
      });
    });

    describe("getPreferences()", () => {
      it("resolves with the defaults for an unknown id rather than rejecting", async () => {
        await expect(store.getPreferences("missing")).resolves.toEqual(DEFAULT_USER_PREFERENCES);
      });

      it("fills unset fields from the defaults", async () => {
        const created = await store.create({ email: "ada@example.test" });
        await store.setPreferences(created.id, { theme: "dark" });

        await expect(store.getPreferences(created.id)).resolves.toEqual({
          ...DEFAULT_USER_PREFERENCES,
          theme: "dark",
        });
      });
    });

    describe("setPreferences()", () => {
      it("rejects for an unknown id", async () => {
        await expect(store.setPreferences("missing", { theme: "dark" })).rejects.toThrow();
      });

      it("merges rather than replaces", async () => {
        const created = await store.create({ email: "ada@example.test" });

        await store.setPreferences(created.id, { theme: "dark" });
        const merged = await store.setPreferences(created.id, { language: "fr" });

        expect(merged).toEqual({
          ...DEFAULT_USER_PREFERENCES,
          theme: "dark",
          language: "fr",
        });
      });

      it("resolves with the same value a subsequent read returns", async () => {
        const created = await store.create({ email: "ada@example.test" });

        const written = await store.setPreferences(created.id, { pushNotifications: true });

        await expect(store.getPreferences(created.id)).resolves.toEqual(written);
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
        await store.setPreferences(created.id, { theme: "dark", smsNotifications: true });

        const patched = await store.setPreferences(created.id, {
          language: "fr",
          theme: undefined,
          smsNotifications: undefined,
        });

        expect(patched).toEqual({
          ...DEFAULT_USER_PREFERENCES,
          theme: "dark",
          smsNotifications: true,
          language: "fr",
        });
      });
    });
  });
}
