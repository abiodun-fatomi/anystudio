import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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
