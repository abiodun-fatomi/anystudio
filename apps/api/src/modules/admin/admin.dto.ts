import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { CAPABILITIES, STAFF_ROLES, PRESERVATION_POLICIES, TEMPLATE_CATEGORY_KEYS, type PreservationUseCase } from '@anystudio/shared';

export class SearchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) cursor?: string;
}

export class GenerationsQueryDto extends SearchDto {
  @ApiPropertyOptional({ enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'])
  status?: string;
  @ApiPropertyOptional({ enum: CAPABILITIES }) @IsOptional() @IsIn(CAPABILITIES as readonly string[]) capability?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() workspaceId?: string;
}

export class PaymentsQueryDto extends SearchDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'REFUNDED'] })
  @IsOptional()
  @IsIn(['PENDING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'REFUNDED'])
  status?: string;
}

export class AuditQueryDto extends SearchDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) type?: string;
}

export class ReasonDto {
  @ApiProperty({ minLength: 4, maxLength: 300 }) @IsString() @MinLength(4) @MaxLength(300) reason!: string;
}

export class CreditsDto extends ReasonDto {
  @ApiProperty({ description: 'Signed: positive grants, negative removes', minimum: -100000, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  delta!: number;
}

export class ProviderPatchDto {
  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(PRESERVATION_POLICIES.map((p) => p.id))
  preservationUseCase?: PreservationUseCase;
  @ApiPropertyOptional({ minimum: 0.1, maximum: 1 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(0.1)
  @Max(1)
  preservationAcceptance?: number;
  @ApiPropertyOptional({ minimum: 0.1, maximum: 1 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(0.1)
  @Max(1)
  sceneAcceptance?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 1000 }) @ValidateIf((_object, value) => value !== undefined) @IsInt() @Min(1) @Max(1000) scenePriority?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ minimum: 1, maximum: 1000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class PricePatchDto extends ReasonDto {
  @ApiProperty({ minimum: 0, maximum: 100000 }) @Type(() => Number) @IsInt() @Min(0) @Max(100000) credits!: number;
}

/**
 * A plan or pack, as the console may change it. Every field is optional: a
 * merge-patch, so the screen that owns gateway ids can send only those and the
 * screen that owns money can send only money.
 *
 * The JSON-shaped fields are declared loosely here and validated precisely in
 * the service, against the market list and the same gateway-id predicates the
 * readiness check uses — a nested class-validator schema would say
 * "priceByMarket.NGN must be a number" where the service can say which market
 * is missing and which gateway id is malformed.
 */
export class CataloguePatchDto extends ReasonDto {
  @ApiPropertyOptional({ example: { USD: 9, NGN: 12000, GBP: 7 }, description: 'Whole units per market, not minor units.' })
  @IsOptional()
  @IsObject()
  priceByMarket?: Record<string, unknown>;

  @ApiPropertyOptional({ example: { paddle: { month: 'pri_abc', year: 'pri_def' }, flutterwave: { month: 12345, year: 12346 } } })
  @IsOptional()
  @IsObject()
  providerRefs?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Shown and sellable. An inactive row stays for old invoices.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) sort?: number;
}

/** A plan additionally carries a yearly price. Null clears it: monthly only. */
export class PlanPatchDto extends CataloguePatchDto {
  @ApiPropertyOptional({ example: { USD: 90, NGN: 120000, GBP: 70 }, description: 'Send null for monthly-only.' })
  @IsOptional()
  @IsObject()
  yearlyPriceByMarket?: Record<string, unknown> | null;
}

/**
 * A new template.
 *
 * `code` is the primary key and is never reused, so it is validated tightly:
 * lowercase, digits and underscores only. It also becomes part of the
 * thumbnail's object key, which is the real reason a slash or a dot cannot be
 * allowed anywhere near it.
 */
export class TemplateCreateDto extends ReasonDto {
  @ApiProperty({ pattern: '^[a-z0-9_]{3,60}$' }) @IsString() @Matches(/^[a-z0-9_]{3,60}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) note!: string;
  @ApiProperty({ enum: TEMPLATE_CATEGORY_KEYS }) @IsIn(TEMPLATE_CATEGORY_KEYS as readonly string[]) category!: string;
  @ApiProperty({ enum: ['cut', 'scene'] }) @IsIn(['cut', 'scene']) kind!: 'cut' | 'scene';
  /** Empty for a `cut`, which paints a colour instead of asking a model for a setting. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) prompt?: string;
  @ApiPropertyOptional({ description: 'One or two #rrggbb colours for the fallback tile' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @Matches(/^#[0-9A-Fa-f]{6}$/, { each: true })
  colors?: string[];
  @ApiPropertyOptional({ enum: ['light', 'dark'] }) @IsOptional() @IsIn(['light', 'dark']) ink?: 'light' | 'dark';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) keywords?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 100000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) sort?: number;
}

/**
 * A change to an existing template.
 *
 * Every field optional and `@ValidateIf` rather than `@IsOptional` on the
 * nullable ones, because clearing a template's keywords and never mentioning
 * them are different requests and the service has to be able to tell.
 */
export class TemplatePatchDto extends ReasonDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) note?: string;
  @ApiPropertyOptional({ enum: TEMPLATE_CATEGORY_KEYS }) @IsOptional() @IsIn(TEMPLATE_CATEGORY_KEYS as readonly string[]) category?: string;
  @ApiPropertyOptional({ enum: ['cut', 'scene'] }) @IsOptional() @IsIn(['cut', 'scene']) kind?: 'cut' | 'scene';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) prompt?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @Matches(/^#[0-9A-Fa-f]{6}$/, { each: true })
  colors?: string[];
  @ApiPropertyOptional({ enum: ['light', 'dark'] }) @IsOptional() @IsIn(['light', 'dark']) ink?: 'light' | 'dark';
  @ApiPropertyOptional({ description: 'Empty string clears it' }) @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(200) keywords?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional({ minimum: 0, maximum: 100000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) sort?: number;
}

/**
 * Asking for somewhere to put an example render.
 *
 * The console uploads straight to storage with the returned signature rather
 * than posting the bytes through the API — an image has no business
 * occupying a Node process, and the API never has to hold it in memory.
 */
export class TemplateThumbnailDto extends ReasonDto {
  @ApiProperty({ enum: ['image/webp', 'image/jpeg', 'image/png'] }) @IsIn(['image/webp', 'image/jpeg', 'image/png']) mime!: string;
  @ApiProperty({ minimum: 1, maximum: 5_000_000 }) @Type(() => Number) @IsInt() @Min(1) @Max(5_000_000) bytes!: number;
}

export class StaffGrantDto extends ReasonDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: STAFF_ROLES }) @IsIn(STAFF_ROLES as readonly string[]) role!: string;
  @ApiPropertyOptional({ description: 'ISO date; omit for no expiry' }) @IsOptional() @IsISO8601() expiresAt?: string;
}

export class PlatformMessageDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) title!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(2000) body!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) href?: string;
  @ApiPropertyOptional({ enum: ['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'] })
  @IsOptional()
  @IsIn(['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'])
  audience?: 'ALL' | 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() publish?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() expiresAt?: string;
}

export class PlatformMessagePatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(2000) body?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) href?: string;
  @ApiPropertyOptional({ enum: ['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'] })
  @IsOptional()
  @IsIn(['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'])
  audience?: 'ALL' | 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() published?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() expiresAt?: string;
}
