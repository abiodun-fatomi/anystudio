import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export const IDEA_TOOLS = ['video', 'scene', 'background', 'restyle'] as const;
export type IdeaTool = (typeof IDEA_TOOLS)[number];

export class IdeasDto {
  @ApiProperty({ enum: IDEA_TOOLS, description: 'Which studio tool the ideas are for' })
  @IsIn(IDEA_TOOLS)
  tool!: IdeaTool;

  @ApiPropertyOptional({ description: 'Storage key of the product photo the tool will work from' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceKey?: string;

  @ApiPropertyOptional({ example: 'reveal', description: 'Video only: the ad format' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  format?: string;

  @ApiPropertyOptional({ example: 4, description: 'Video only: how many shots (1 is a reel)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  shots?: number;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productName?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  price?: string;

  @ApiPropertyOptional({ description: 'Ask for a fresh set rather than the cached one' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  round?: number;
}

export const CAPTION_PLATFORMS = ['instagram', 'tiktok', 'whatsapp', 'facebook'] as const;
export const CAPTION_GOALS = ['sell', 'message', 'launch', 'restock', 'promo', 'brand'] as const;

export class CaptionsDto {
  @ApiPropertyOptional({ description: 'Storage key of the image or video being posted; the model looks at an image' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  sourceKey?: string;

  @ApiPropertyOptional({ enum: CAPTION_PLATFORMS, description: 'Where it is going; decides length, hashtags and the call to action' })
  @IsOptional()
  @IsIn(CAPTION_PLATFORMS)
  platform?: (typeof CAPTION_PLATFORMS)[number];

  @ApiPropertyOptional({ enum: ['feed', 'story', 'reel'] })
  @IsOptional()
  @IsIn(['feed', 'story', 'reel'])
  kind?: 'feed' | 'story' | 'reel';

  @ApiPropertyOptional({ enum: CAPTION_GOALS, description: 'What the post is for: sell now, get DMs, announce a launch or restock, a promo, or brand warmth' })
  @IsOptional()
  @IsIn(CAPTION_GOALS)
  goal?: (typeof CAPTION_GOALS)[number];

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productName?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  price?: string;

  @ApiPropertyOptional({ description: 'Anything the seller wants said or avoided', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;

  @ApiPropertyOptional({ example: 'en', description: 'Language of the caption' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}(-[A-Za-z]{2})?$/)
  language?: string;

  @ApiPropertyOptional({ description: 'Ask for a fresh set rather than the cached one' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  round?: number;
}
