import { CursorPageOf } from "./cursor-page";

jest.mock("@nestjs/swagger", () => ({
  ApiProperty: jest.fn(() => () => undefined),
}));

class SampleDto {
  id!: string;
  name!: string;
}

class AnotherDto {
  value!: number;
}

describe("CursorPageOf()", () => {
  it("returns a class that can be instantiated", () => {
    const Page = CursorPageOf(SampleDto);
    const instance = new Page();
    expect(instance).toBeDefined();
  });

  it("names the generated class using the model name", () => {
    const Page = CursorPageOf(SampleDto);
    expect(Page.name).toBe("CursorPageSampleDto");
  });

  it("produces distinct named classes for distinct models", () => {
    const PageA = CursorPageOf(SampleDto);
    const PageB = CursorPageOf(AnotherDto);
    expect(PageA).not.toBe(PageB);
    expect(PageA.name).toBe("CursorPageSampleDto");
    expect(PageB.name).toBe("CursorPageAnotherDto");
  });

  it("generated class instances have the expected property shape", () => {
    const Page = CursorPageOf(SampleDto);
    const instance = Object.assign(new Page(), {
      items: [],
      nextCursor: null,
      hasNextPage: false,
    });
    expect(instance.items).toEqual([]);
    expect(instance.nextCursor).toBeNull();
    expect(instance.hasNextPage).toBe(false);
  });
});
