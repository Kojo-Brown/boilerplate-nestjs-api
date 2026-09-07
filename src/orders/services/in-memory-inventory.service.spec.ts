import { OutOfStockError } from "../orders.errors";
import { InMemoryInventoryService, SEED_STOCK, mergeLines } from "./in-memory-inventory.service";

describe("InMemoryInventoryService", () => {
  let inventory: InMemoryInventoryService;

  beforeEach(() => {
    inventory = new InMemoryInventoryService();
  });

  const reserve = (reservationId: string, sku = "SKU-DESK-01", quantity = 2) =>
    inventory.reserve({ orderId: "order-1", reservationId, lines: [{ sku, quantity }] });

  it("starts with the seeded catalogue on the shelves", () => {
    expect(inventory.stockOf("SKU-DESK-01")).toBe(SEED_STOCK["SKU-DESK-01"]);
    expect(inventory.stockOf("SKU-SOLD-OUT")).toBe(0);
  });

  it("holds stock and takes it off the shelf", async () => {
    const reservation = await reserve("saga-1:reserve-stock");

    expect(reservation.held).toBe(true);
    expect(reservation.lines).toEqual([{ sku: "SKU-DESK-01", quantity: 2 }]);
    expect(inventory.stockOf("SKU-DESK-01")).toBe(23);
  });

  it("returns the same hold for a repeated id rather than taking a second one", async () => {
    // The property the saga depends on: a step retried after a lost response
    // must not reserve twice.
    const first = await reserve("saga-1:reserve-stock");
    const second = await reserve("saga-1:reserve-stock");

    expect(second).toEqual(first);
    expect(inventory.stockOf("SKU-DESK-01")).toBe(23);
  });

  it("refuses what it does not have, naming what it does", async () => {
    await expect(reserve("saga-1:reserve-stock", "SKU-SOLD-OUT", 1)).rejects.toThrow(
      OutOfStockError,
    );
    await expect(reserve("saga-1:reserve-stock", "SKU-SOLD-OUT", 1)).rejects.toThrow(
      /Only 0 of "SKU-SOLD-OUT" available, 1 requested/,
    );
  });

  it("refuses a SKU it has never heard of", async () => {
    await expect(reserve("saga-1:reserve-stock", "SKU-IMAGINARY", 1)).rejects.toThrow(
      OutOfStockError,
    );
  });

  it("holds all the lines or none of them", async () => {
    // A partial hold is unaddressable: the caller is about to be told it
    // failed, so nothing will ever release the part that succeeded.
    await expect(
      inventory.reserve({
        orderId: "order-1",
        reservationId: "saga-1:reserve-stock",
        lines: [
          { sku: "SKU-DESK-01", quantity: 1 },
          { sku: "SKU-SOLD-OUT", quantity: 1 },
        ],
      }),
    ).rejects.toThrow(OutOfStockError);

    expect(inventory.stockOf("SKU-DESK-01")).toBe(25);
  });

  it("counts two lines of the same SKU as one quantity", async () => {
    // Checked separately, each of these would be compared against the whole
    // shelf and both would pass — an oversell in which no individual line looks
    // wrong.
    await expect(
      inventory.reserve({
        orderId: "order-1",
        reservationId: "saga-1:reserve-stock",
        lines: [
          { sku: "SKU-LAMP-03", quantity: 7 },
          { sku: "SKU-LAMP-03", quantity: 7 },
        ],
      }),
    ).rejects.toThrow(/Only 12 of "SKU-LAMP-03" available, 14 requested/);

    expect(inventory.stockOf("SKU-LAMP-03")).toBe(12);
  });

  it("puts released stock back", async () => {
    await reserve("saga-1:reserve-stock");
    await inventory.release("saga-1:reserve-stock");

    expect(inventory.stockOf("SKU-DESK-01")).toBe(25);
    expect((await inventory.find("saga-1:reserve-stock"))?.held).toBe(false);
  });

  it("is silent about releasing a hold it never took", async () => {
    // The compensation runs for a reserve that failed, too — and "there was
    // nothing to undo" is the state it is trying to reach, not an error.
    await expect(inventory.release("saga-9:reserve-stock")).resolves.toBeUndefined();
  });

  it("does not put stock back twice for a repeated release", async () => {
    await reserve("saga-1:reserve-stock");
    await inventory.release("saga-1:reserve-stock");
    await inventory.release("saga-1:reserve-stock");

    expect(inventory.stockOf("SKU-DESK-01")).toBe(25);
  });

  it("resolves null, never undefined, for a hold nobody took", async () => {
    expect(await inventory.find("saga-9:reserve-stock")).toBeNull();
  });
});

describe("mergeLines", () => {
  it("sums duplicate SKUs so two lines of one item are a single hold", () => {
    expect(
      mergeLines([
        { sku: "SKU-DESK-01", quantity: 1 },
        { sku: "SKU-LAMP-03", quantity: 3 },
        { sku: "SKU-DESK-01", quantity: 2 },
      ]),
    ).toEqual([
      { sku: "SKU-DESK-01", quantity: 3 },
      { sku: "SKU-LAMP-03", quantity: 3 },
    ]);
  });
});
