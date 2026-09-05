import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CAPABILITIES, STAFF_ROLES } from '@anystudio/shared';

export class SearchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) take?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) cursor?: string;
}

export class GenerationsQueryDto extends SearchDto {
  @ApiPropertyOptional({ enum: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'])
  status?: string;
  @ApiPropertyOptional({ enum: CAPABILITIES }) @IsOptional() @IsIn(CAPABILITIES as readonly string[]) capability?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() workspaceId?: string;
}

export class PaymentsQueryDto extends SearchDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'] })
  @IsOptional()
  @IsIn(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'])
  status?: string;
}

export class AuditQueryDto extends SearchDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) type?: string;
}

export class ReasonDto {
  @ApiProperty({ minLength: 4, maxLength: 300 }) @IsString() @MinLength(4) @MaxLength(300) reason!: string;
}

export class CreditsDto extends ReasonDto {
  @ApiProperty({ description: 'Signed: positive grants, negative removes', minimum: -100000, maximum: 100000 })
  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  delta!: number;
}

export class ProviderPatchDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ minimum: 1, maximum: 1000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) priority?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class PricePatchDto extends ReasonDto {
  @ApiProperty({ minimum: 0, maximum: 100000 }) @Type(() => Number) @IsInt() @Min(0) @Max(100000) credits!: number;
}

export class StaffGrantDto extends ReasonDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: STAFF_ROLES }) @IsIn(STAFF_ROLES as readonly string[]) role!: string;
  @ApiPropertyOptional({ description: 'ISO date; omit for no expiry' }) @IsOptional() @IsISO8601() expiresAt?: string;
}

export class PlatformMessageDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) title!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(2000) body!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) href?: string;
  @ApiPropertyOptional({ enum: ['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'] })
  @IsOptional()
  @IsIn(['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'])
  audience?: 'ALL' | 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() publish?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() expiresAt?: string;
}

export class PlatformMessagePatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(2000) body?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) href?: string;
  @ApiPropertyOptional({ enum: ['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'] })
  @IsOptional()
  @IsIn(['ALL', 'PERSONAL', 'BUSINESS', 'ORGANIZATION'])
  audience?: 'ALL' | 'PERSONAL' | 'BUSINESS' | 'ORGANIZATION';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() published?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() expiresAt?: string;
}
