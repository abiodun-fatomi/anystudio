import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CloneVoiceDto {
  @ApiProperty({ description: 'Storage key of the recording — an audio upload in this workspace, 10 s to 3 min of one person talking' })
  @IsString()
  @MaxLength(300)
  sampleKey!: string;

  @ApiPropertyOptional({ example: 'My voice', description: 'What the voice is called in the picker' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ example: 'en-NG', description: 'The language the sample is in; the voice reads that language best' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}(-[A-Za-z]{2})?$/)
  language?: string;

  @ApiProperty({
    description:
      'Must be true: the person recorded is you (or has given you permission), and you consent to a copy of the voice being made and kept by our voice vendor.',
  })
  @IsBoolean()
  @Equals(true, { message: 'You have to confirm it is your voice and that you consent before it can be cloned.' })
  consent!: boolean;
}
