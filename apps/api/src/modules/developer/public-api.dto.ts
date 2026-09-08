import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, IsUrl, Matches, Max, MaxLength, Min } from 'class-validator';
import { PUBLIC_CAPABILITIES, type Capability } from '@anystudio/shared';
import { MERCHANT_REF } from './developer.dto';

export class ApiCreateGenerationDto {
  @ApiProperty({ enum: PUBLIC_CAPABILITIES })
  @IsIn(PUBLIC_CAPABILITIES as readonly string[])
  capability!: Capability;

  @ApiProperty({ description: "The capability's parameters; GET /api/v1/capabilities lists them", type: Object })
  @IsObject()
  params!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Your idempotency key, unique per workspace. Retrying with the same key returns the same generation. Omit and one is minted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_\-:.]+$/)
  clientKey?: string;

  @ApiPropertyOptional({ description: 'Your reference for the merchant this is for. Opaque; used for fair-use limits and usage rollups.' })
  @IsOptional()
  @IsString()
  @Matches(MERCHANT_REF)
  merchantRef?: string;
}

export class ApiQuoteGenerationDto extends PickType(ApiCreateGenerationDto, ['capability', 'params'] as const) {}

export class ApiListGenerationsDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(MERCHANT_REF)
  merchantRef?: string;
}

export class ApiUploadUrlDto {
  @ApiProperty({ example: 'https://cdn.example.com/products/sku-9.jpg', description: 'A public https URL to an image, video or audio file' })
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  url!: string;
}
