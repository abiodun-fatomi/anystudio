import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const JOB_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP'] as const;
const JOB_STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const;
const APP_STATUSES = ['NEW', 'REVIEWING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED'] as const;

export class JobDto {
  @ApiProperty({ maxLength: 120 }) @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @ApiPropertyOptional({ description: 'URL name; made from the title when blank', pattern: '^[a-z0-9-]+$' })
  @IsOptional()
  @Matches(/^[a-z0-9-]{3,80}$/)
  slug?: string;
  @ApiProperty({ maxLength: 60, example: 'Engineering' }) @IsString() @MinLength(2) @MaxLength(60) team!: string;
  @ApiProperty({ maxLength: 80, example: 'Lagos, or anywhere in WAT ±3' }) @IsString() @MinLength(2) @MaxLength(80) location!: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() remote?: boolean;
  @ApiPropertyOptional({ enum: JOB_TYPES, default: 'FULL_TIME' }) @IsOptional() @IsIn(JOB_TYPES) type?: (typeof JOB_TYPES)[number];
  @ApiProperty({ maxLength: 300 }) @IsString() @MinLength(10) @MaxLength(300) summary!: string;
  @ApiProperty({
    maxLength: 20000,
    description: 'Paragraphs separated by blank lines; lines starting with "- " are a list; a line ending with ":" is a heading',
  })
  @IsString()
  @MinLength(40)
  @MaxLength(20000)
  description!: string;
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) salary?: string | null;
  @ApiPropertyOptional({ enum: JOB_STATUSES }) @IsOptional() @IsIn(JOB_STATUSES) status?: (typeof JOB_STATUSES)[number];
}

export class JobPatchDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MinLength(3) @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[a-z0-9-]{3,80}$/) slug?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(60) team?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) location?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() remote?: boolean;
  @ApiPropertyOptional({ enum: JOB_TYPES }) @IsOptional() @IsIn(JOB_TYPES) type?: (typeof JOB_TYPES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(10) @MaxLength(300) summary?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(40) @MaxLength(20000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) salary?: string | null;
  @ApiPropertyOptional({ enum: JOB_STATUSES }) @IsOptional() @IsIn(JOB_STATUSES) status?: (typeof JOB_STATUSES)[number];
}

export class CvUploadDto {
  @ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) filename!: string;
  @ApiProperty({ enum: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] })
  @IsIn(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
  mime!: string;
  @ApiProperty({ minimum: 1, maximum: 8 * 1024 * 1024 }) @Type(() => Number) @IsInt() @Min(1) @Max(8 * 1024 * 1024) bytes!: number;
}

export class ApplyDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(80) slug!: string;
  @ApiProperty({ maxLength: 120 }) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiPropertyOptional({ maxLength: 40 }) @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @ApiPropertyOptional({ maxLength: 1000, description: 'Portfolio, LinkedIn, GitHub — one per line' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  links?: string;
  @ApiPropertyOptional({ maxLength: 3000 }) @IsOptional() @IsString() @MaxLength(3000) coverNote?: string;
  @ApiPropertyOptional({ description: 'The key returned by cv-upload, after the PUT succeeded' }) @IsOptional() @IsString() @MaxLength(300) cvKey?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) cvName?: string;
  /** Honeypot: bots fill every field. Anything here and the application is quietly dropped. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class ApplicationsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() jobId?: string;
  @ApiPropertyOptional({ enum: APP_STATUSES }) @IsOptional() @IsIn(APP_STATUSES) status?: (typeof APP_STATUSES)[number];
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
}

export class ApplicationPatchDto {
  @ApiPropertyOptional({ enum: APP_STATUSES }) @IsOptional() @IsIn(APP_STATUSES) status?: (typeof APP_STATUSES)[number];
  @ApiPropertyOptional({ maxLength: 4000 }) @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}
