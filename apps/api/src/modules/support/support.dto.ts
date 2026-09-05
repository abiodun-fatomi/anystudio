import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class OpenConversationDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'The workspace the person is in' })
  @IsOptional() @IsUUID() workspaceId?: string;

  @ApiPropertyOptional({ description: 'The app path they were on', example: '/library' })
  @IsOptional() @IsString() @MaxLength(300) page?: string;
}

export class SupportMessageDto {
  @ApiProperty({ description: 'What the person typed', maxLength: 4000 })
  @IsString() @MinLength(1) @MaxLength(4000) text: string;

  @ApiPropertyOptional({ description: 'The app path they are on now' })
  @IsOptional() @IsString() @MaxLength(300) page?: string;
}

export class CloseConversationDto {
  @ApiPropertyOptional({ description: 'Send the transcript by email (default true)' })
  @IsOptional() @IsBoolean() email?: boolean;
}

export class StaffReplyDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString() @MinLength(1) @MaxLength(4000) text: string;
}

export class SupportListQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'needs_human', 'closed', 'all'] })
  @IsOptional() @IsIn(['open', 'needs_human', 'closed', 'all']) filter?: 'open' | 'needs_human' | 'closed' | 'all';

  @ApiPropertyOptional({ description: 'Email, name or topic' })
  @IsOptional() @IsString() @MaxLength(120) q?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
  @IsOptional() @IsString() @MaxLength(40) cursor?: string;
}
