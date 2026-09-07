import { UnservicedDestinationError } from "../orders.errors";
import { InMemoryShippingService, SERVICED_COUNTRIES } from "./in-memory-shipping.service";

describe("InMemoryShippingService", () => {
  let shipping: InMemoryShippingService;

  beforeEach(() => {
    shipping = new InMemoryShippingService();
  });

  const book = (shipmentId: string, destination = "GB") =>
    shipping.createShipment({
      orderId: "order-1",
      destination,
      lines: [{ sku: "SKU-DESK-01", quantity: 1 }],
      shipmentId,
    });

  it("books a parcel with a carrier and a tracking code", async () => {
    const shipment = await book("saga-1:create-shipment");

    expect(shipment.id).toBe("saga-1:create-shipment");
    expect(shipment.destination).toBe("GB");
    expect(shipment.trackingCode).toMatch(/^TRK\d{8}$/);
    expect(shipment.carrier).not.toBe("");
  });

  it("returns the same parcel for a repeated id rather than booking a second one", async () => {
    // This is the pivot step. Two parcels for one order is the failure that
    // costs real money and that nothing downstream would report.
    const first = await book("saga-1:create-shipment");
    const second = await book("saga-1:create-shipment");

    expect(second).toEqual(first);
    expect(shipping.booked).toHaveLength(1);
  });

  it("refuses a destination no carrier serves", async () => {
    await expect(book("saga-1:create-shipment", "AQ")).rejects.toThrow(UnservicedDestinationError);
    await expect(book("saga-1:create-shipment", "AQ")).rejects.toThrow(/No carrier serves "AQ"/);
    expect(shipping.booked).toHaveLength(0);
  });

  it("normalises the destination before deciding", async () => {
    const shipment = await book("saga-1:create-shipment", "gb");
    expect(shipment.destination).toBe("GB");
  });

  it("serves every country it advertises", async () => {
    for (const [index, country] of SERVICED_COUNTRIES.entries()) {
      await expect(book(`saga-${index}:create-shipment`, country)).resolves.toEqual(
        expect.objectContaining({ destination: country }),
      );
    }
  });

  it("resolves null, never undefined, for a parcel nobody booked", async () => {
    expect(await shipping.find("saga-9:create-shipment")).toBeNull();
  });
});
