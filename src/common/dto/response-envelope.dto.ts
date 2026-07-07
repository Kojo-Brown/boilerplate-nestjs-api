import { ApiProperty } from "@nestjs/swagger";
import type { Type } from "@nestjs/common";

export class ResponseMetaDto {
  @ApiProperty({ example: "2024-01-01T00:00:00.000Z", description: "ISO 8601 response timestamp" })
  timestamp!: string;

  @ApiProperty({ example: "v1", description: "API version that served this response" })
  version!: string;
}

export class ResponseEnvelopeDto<T> {
  @ApiProperty({ example: true })
  success!: true;

  data!: T;

  @ApiProperty({ type: ResponseMetaDto })
  meta!: ResponseMetaDto;
}

/**
 * Generates a concrete, Swagger-introspectable subclass for a given data DTO.
 * Usage: @ApiOkResponse({ type: ApiEnvelopeOf(MyDto) })
 */
export function ApiEnvelopeOf<T>(model: Type<T>): Type<ResponseEnvelopeDto<T>> {
  class EnvelopeHost {
    @ApiProperty({ example: true })
    success!: true;

    @ApiProperty({ type: model })
    data!: T;

    @ApiProperty({ type: ResponseMetaDto })
    meta!: ResponseMetaDto;
  }
  Object.defineProperty(EnvelopeHost, "name", { value: `${model.name}Envelope` });
  return EnvelopeHost as Type<ResponseEnvelopeDto<T>>;
}
