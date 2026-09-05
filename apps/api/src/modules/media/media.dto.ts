import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class PresignUploadDto {
  @ApiProperty({ example: 'IMG_2041.jpg' })
  @IsString()
  @MaxLength(200)
  filename!: string;

  @ApiProperty({ example: 'image/jpeg', description: 'What the browser believes it is; verified from the bytes on completion' })
  @IsString()
  @MaxLength(80)
  mime!: string;

  @ApiProperty({ example: 2411331 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300 * 1024 * 1024)
  bytes!: number;
}

export class CompleteUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  assetId!: string;
}

export class MediaListQueryDto {
  @ApiPropertyOptional({ enum: ['SOURCE', 'OUTPUT', 'DERIVED'] })
  @IsOptional()
  @IsIn(['SOURCE', 'OUTPUT', 'DERIVED'])
  kind?: 'SOURCE' | 'OUTPUT' | 'DERIVED';

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

export class ReadUrlQueryDto {
  @ApiProperty({ description: 'The storage key, as returned by uploads and generations' })
  @IsString()
  @MaxLength(512)
  key!: string;
}

export class ReadUrlsDto {
  @ApiProperty({ type: [String], description: 'Up to 50 storage keys; each gets a short-lived URL' })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  keys!: string[];
}
