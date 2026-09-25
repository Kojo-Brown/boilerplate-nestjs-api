import {
  encryptedField,
  fieldKeyContext,
  fieldName,
  FIELD_ENCRYPTION_VERSION,
  InvalidEncryptedFieldError,
  recordAad,
} from "./encrypted-field";

describe("encryptedField", () => {
  it("accepts the camelCase columns this schema uses", () => {
    const field = encryptedField("orders", "itemsCiphertext");

    expect(fieldName(field)).toBe("orders.itemsCiphertext");
  });

  it("is frozen, because a descriptor that can be edited is authenticated data that can be", () => {
    const field = encryptedField("orders", "itemsCiphertext");

    expect(() => {
      (field as { table: string }).table = "somethingElse";
    }).toThrow();
  });

  it.each([
    ["empty", ""],
    ["a leading digit", "1orders"],
    ["a dot", "public.orders"],
    ["a quote", 'orders"'],
    ["a newline", "orders\nitems"],
    ["a space", "order items"],
  ])("refuses a table name with %s", (_case, table) => {
    expect(() => encryptedField(table, "itemsCiphertext")).toThrow(InvalidEncryptedFieldError);
  });

  it("refuses a column name that is not an identifier", () => {
    expect(() => encryptedField("orders", "items->>'sku'")).toThrow(InvalidEncryptedFieldError);
  });
});

describe("fieldKeyContext", () => {
  it("names the column and the format, and nothing per-record", () => {
    // Per-column rather than per-record on purpose: one data key serves many
    // rows, which is what makes the materials cache possible. If this ever
    // carries a record id, every insert becomes a KMS call.
    expect(fieldKeyContext(encryptedField("orders", "itemsCiphertext"))).toEqual({
      purpose: FIELD_ENCRYPTION_VERSION,
      table: "orders",
      column: "itemsCiphertext",
    });
  });
});

describe("recordAad", () => {
  const field = encryptedField("orders", "itemsCiphertext");

  it("differs per record, which is what binds a value to its row", () => {
    expect(recordAad(field, "order-1").equals(recordAad(field, "order-2"))).toBe(false);
  });

  it("differs per column of the same record", () => {
    const other = encryptedField("orders", "otherCiphertext");

    expect(recordAad(field, "order-1").equals(recordAad(other, "order-1"))).toBe(false);
  });

  it("is stable for the same field and record", () => {
    expect(recordAad(field, "order-1").equals(recordAad(field, "order-1"))).toBe(true);
  });

  it("cannot be made to collide by a record id that contains the framing", () => {
    // The whole reason every part is length-prefixed. Joined with separators, an
    // id crafted to contain one would let a value from one field authenticate as
    // another's, with no weakness in AES-GCM at all.
    const collidingId = `x\ncolumn:15:otherCiphertext\nrecord:7:order-1`;

    expect(recordAad(field, collidingId).equals(recordAad(field, "order-1"))).toBe(false);
    expect(
      recordAad(encryptedField("orders", "otherCiphertext"), "order-1").equals(
        recordAad(field, collidingId),
      ),
    ).toBe(false);
  });

  it("refuses an empty record id", () => {
    // Binding a value to "some row" is not binding it to a row.
    expect(() => recordAad(field, "")).toThrow(InvalidEncryptedFieldError);
  });

  it("carries the format version, so a future format cannot replay this one", () => {
    expect(recordAad(field, "order-1").toString("utf8")).toContain(FIELD_ENCRYPTION_VERSION);
  });
});
