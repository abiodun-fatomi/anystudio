import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, IsUrl, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { API_SCOPES, WEBHOOK_EVENTS } from './developer.types';

export class CreateProjectDto {
  @ApiProperty({ example: 'Jumia storefront' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ description: 'Archive (true) or restore (false). Archived projects keep their history; their keys stop working.' })
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class CreateApiKeyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ example: 'Production server' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ enum: API_SCOPES, isArray: true, description: 'Defaults to every scope' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(API_SCOPES as readonly string[], { each: true })
  scopes?: string[];

  @ApiPropertyOptional({ description: 'Days until it expires; omit for no expiry', minimum: 1, maximum: 3650 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://example.com/anystudio/webhook' })
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: process.env.APP_ENV === 'production' })
  @MaxLength(500)
  url!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this project; omit for every project' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ enum: WEBHOOK_EVENTS, isArray: true, description: 'Defaults to every event' })
  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENTS as readonly string[], { each: true })
  events?: string[];
}

export class UpdateWebhookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: process.env.APP_ENV === 'production' })
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional({ enum: WEBHOOK_EVENTS, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENTS as readonly string[], { each: true })
  events?: string[];

  @ApiPropertyOptional({ description: 'Pause (false) or resume (true); resuming clears the failure count' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UsageQueryDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class DeliveriesQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}

/** The organization's own reference for the merchant a request is for. */
export const MERCHANT_REF = /^[A-Za-z0-9_\-:.@]{1,120}$/;
export class MerchantRefDto {
  @ApiPropertyOptional({
    description: 'Your reference for the merchant this is for (a store id, a customer id). Opaque to us; used for fair-use limits and usage rollups.',
  })
  @IsOptional()
  @IsString()
  @Matches(MERCHANT_REF)
  merchantRef?: string;
}
