import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export const PLATFORMS = ['INSTAGRAM', 'TIKTOK'] as const;
export const FORMATS = ['IMAGE', 'VIDEO', 'REEL', 'STORY'] as const;
export const JOB_STATUSES = ['SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'] as const;

export class ConnectStartQueryDto {
  @ApiPropertyOptional({ description: 'App path to return to afterwards', example: '/publishing' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  next?: string;
}

export class ConnectCallbackQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) error?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) error_description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) error_reason?: string;
}

export class PublishCreateDto {
  @ApiProperty({ description: 'Connected accounts to post through; one job is made per account', type: [String] })
  @IsUUID('4', { each: true })
  accountIds: string[];

  @ApiPropertyOptional({ description: 'The generation the media came from', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  generationId?: string;

  @ApiProperty({ description: 'Storage key of the image or video to post' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  mediaKey: string;

  @ApiProperty({ enum: FORMATS })
  @IsIn(FORMATS)
  format: (typeof FORMATS)[number];

  @ApiProperty({ maxLength: 2200 })
  @IsString()
  @MaxLength(2200)
  caption: string;

  @ApiPropertyOptional({ description: 'ISO time to post at; omit to post now' })
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}

export class PublishPatchDto {
  @ApiPropertyOptional({ maxLength: 2200 }) @IsOptional() @IsString() @MaxLength(2200) caption?: string;
  @ApiPropertyOptional({ description: 'ISO time' }) @IsOptional() @IsISO8601() scheduledFor?: string;
}

export class PublishListQueryDto {
  @ApiPropertyOptional({ enum: ['upcoming', 'history'], default: 'upcoming' })
  @IsOptional()
  @IsIn(['upcoming', 'history'])
  view?: 'upcoming' | 'history';

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;

  @ApiPropertyOptional({ description: 'The id of the last row seen' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class ShareDto {
  @ApiProperty({ description: 'Storage key of the file to share' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  mediaKey: string;
}
