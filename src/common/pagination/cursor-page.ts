import { ApiProperty } from "@nestjs/swagger";
import type { Type } from "@nestjs/common";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

/**
 * Generates a concrete, Swagger-introspectable CursorPage subclass for a given item DTO.
 * Usage: @ApiOkResponse({ type: CursorPageOf(MyItemDto) })
 */
export function CursorPageOf<T>(model: Type<T>): Type<CursorPage<T>> {
  class CursorPageHost {
    @ApiProperty({ type: [model] })
    items!: T[];

    @ApiProperty({ type: String, nullable: true, example: "Y3Vyc29yOjE=" })
    nextCursor!: string | null;

    @ApiProperty({ example: true })
    hasNextPage!: boolean;
  }
  Object.defineProperty(CursorPageHost, "name", { value: `CursorPage${model.name}` });
  return CursorPageHost as Type<CursorPage<T>>;
}
