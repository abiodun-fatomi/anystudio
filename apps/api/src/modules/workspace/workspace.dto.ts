import { MARKET_CURRENCIES, type MarketCurrency } from '@anystudio/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsISO31661Alpha2, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export const CHANNELS = ['whatsapp', 'instagram', 'tiktok', 'facebook', 'jiji', 'shop', 'market'] as const;
export const TONES = ['warm', 'direct', 'playful', 'premium'] as const;
export type Channel = (typeof CHANNELS)[number];
export type Tone = (typeof TONES)[number];

/**
 * The welcome-screen answers. Every field optional: the whole point of the
 * screen is that it can be skipped, and a partial answer is still useful.
 */
export class WorkspaceProfileDto {
  @ApiPropertyOptional({ example: 'Ankara fabrics', maxLength: 120, description: 'What they sell; feeds the copywriting prompt' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sells?: string;

  @ApiPropertyOptional({ enum: CHANNELS, isArray: true, description: 'Where they sell today; drives which connectors we suggest first' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsIn(CHANNELS, { each: true })
  channels?: Channel[];

  @ApiPropertyOptional({ enum: TONES, description: 'How captions should sound' })
  @IsOptional()
  @IsIn(TONES)
  tone?: Tone;
}

export class WorkspaceUpdateDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ enum: MARKET_CURRENCIES, description: 'The currency prices are shown and charged in. Credits already held are unaffected.' })
  @IsOptional()
  @IsIn(MARKET_CURRENCIES)
  currency?: MarketCurrency;

  @ApiPropertyOptional({ description: 'Storage key of an uploaded image to use as the logo; null removes it', nullable: true, maxLength: 400 })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(400)
  logoKey?: string | null;
}

export class WorkspaceDeleteDto {
  @ApiProperty({ description: 'The workspace name, typed exactly' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  confirmName: string;
}

/** A second workspace: a business beside the personal one, or an organization for the API. */
export class WorkspaceCreateDto {
  @ApiPropertyOptional({ example: 'NG', description: 'Confirmed business billing country; determines this new workspace currency only.' })
  @IsOptional()
  @IsISO31661Alpha2()
  billingCountry?: string;

  @ApiProperty({ maxLength: 80, example: 'Acme Commerce' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiProperty({ enum: ['BUSINESS', 'ORGANIZATION'] })
  @IsIn(['BUSINESS', 'ORGANIZATION'])
  type!: 'BUSINESS' | 'ORGANIZATION';
}
