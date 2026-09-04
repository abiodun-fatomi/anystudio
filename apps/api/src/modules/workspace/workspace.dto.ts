import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

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
  @IsOptional() @IsString() @MaxLength(120)
  sells?: string;

  @ApiPropertyOptional({ enum: CHANNELS, isArray: true, description: 'Where they sell today; drives which connectors we suggest first' })
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsIn(CHANNELS, { each: true })
  channels?: Channel[];

  @ApiPropertyOptional({ enum: TONES, description: 'How captions should sound' })
  @IsOptional() @IsIn(TONES)
  tone?: Tone;
}
