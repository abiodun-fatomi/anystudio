import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, Max, ValidateNested } from 'class-validator';

export const WATERMARK_POSITIONS = ['tr', 'tl', 'br', 'bl'] as const;
export const FONTS = ['Bricolage Grotesque', 'Hanken Grotesk', 'Inter', 'Playfair Display', 'DM Serif Display', 'Space Grotesk', 'Nunito', 'Lora'] as const;
export const SIZE_KEYS = ['feed_square', 'feed_portrait', 'story', 'landscape', 'marketplace'] as const;

export class WatermarkDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: WATERMARK_POSITIONS })
  @IsOptional()
  @IsIn(WATERMARK_POSITIONS)
  position?: (typeof WATERMARK_POSITIONS)[number];

  @ApiPropertyOptional({ minimum: 0.1, maximum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(1)
  opacity?: number;
}

/** Every field optional: the editor saves what changed, and a partial kit is still a kit. */
export class BrandKitDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessName?: string | null;

  @ApiPropertyOptional({ description: 'Storage key of an uploaded logo (a READY MediaAsset this workspace owns)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  logoKey?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'Up to six hex colours, primary first' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @Matches(/^#[0-9a-fA-F]{6}$/, { each: true })
  palette?: string[];

  @ApiPropertyOptional({ enum: FONTS })
  @IsOptional()
  @IsIn(FONTS)
  fontDisplay?: string | null;

  @ApiPropertyOptional({ enum: FONTS })
  @IsOptional()
  @IsIn(FONTS)
  fontBody?: string | null;

  @ApiPropertyOptional({ maxLength: 300, description: 'Free prose the copy pipeline conditions on' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  tone?: string | null;

  @ApiPropertyOptional({ type: WatermarkDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WatermarkDto)
  watermark?: WatermarkDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showPrice?: boolean;

  @ApiPropertyOptional({ enum: SIZE_KEYS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsIn(SIZE_KEYS, { each: true })
  defaultSizes?: string[];
}
