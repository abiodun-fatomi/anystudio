import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const LIBRARY_TYPES = ['all', 'image', 'video', 'copy', 'audio'] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];

/**
 * Two orders, because a merchant looks for their work in two ways.
 *
 * Newest first is what they want nine times in ten — "the thing I made this
 * morning". Oldest first is for the tenth: working forward through a
 * catalogue shot over weeks, where starting at the end means scrolling to
 * the beginning every time.
 */
export const LIBRARY_SORTS = ['newest', 'oldest'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export class LibraryQueryDto {
  @ApiPropertyOptional({ description: 'Words to search for in titles, prompts, details and the copy that came back' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: LIBRARY_TYPES, default: 'all' })
  @IsOptional()
  @IsIn(LIBRARY_TYPES)
  type?: LibraryType;

  @ApiPropertyOptional({ description: 'Only this product' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  product?: string;

  @ApiPropertyOptional({ description: 'Only starred items' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  favourite?: boolean;

  @ApiPropertyOptional({ description: 'ISO date; items made on or after' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date; items made before' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: LIBRARY_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(LIBRARY_SORTS)
  sort?: LibrarySort;

  @ApiPropertyOptional({ format: 'uuid', description: 'The last id of the previous page' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 60, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  take?: number;
}

export class LibraryItemPatchDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  favourite?: boolean;

  @ApiPropertyOptional({ maxLength: 120, description: 'Move it under a product' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productKey?: string | null;
}
