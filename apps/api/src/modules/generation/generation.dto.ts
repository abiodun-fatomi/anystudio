/**
 * The HTTP contract for generations.
 *
 * `params` is validated by the capability's Zod schema in the service, not
 * by class-validator here — the schema is the single definition the studio
 * also renders its controls from. This DTO only checks the envelope.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CAPABILITIES, type Capability } from '@anystudio/shared';

export class CreateGenerationDto {
  @ApiProperty({ enum: CAPABILITIES })
  @IsIn(CAPABILITIES as readonly string[])
  capability!: Capability;

  @ApiProperty({ description: "The capability's parameters — see packages/shared capabilityParams", type: Object })
  @IsObject()
  params!: Record<string, unknown>;

  @ApiProperty({ description: 'Client-generated, unique per workspace. Retrying with the same key returns the same generation.', example: 'b3f1…' })
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9_\-:.]+$/)
  clientKey!: string;

  @ApiPropertyOptional({ description: 'Override the CreditCost code (e.g. a plan pricing its shots under video.ad_30s)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  costCode?: string;
}

export class GenerationHistoryQueryDto {
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
  take?: number;
}

export class QuoteQueryDto {
  @ApiProperty({ enum: CAPABILITIES })
  @IsIn(CAPABILITIES as readonly string[])
  capability!: Capability;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  costCode?: string;
}

export class EditTextDto {
  @ApiProperty({ example: 'captions.instagram', description: 'A key of COPY_FIELDS in packages/shared' })
  @IsString()
  @MaxLength(60)
  field!: string;

  @ApiProperty({ maxLength: 3000 })
  @IsString()
  @MaxLength(3000)
  value!: string;
}
