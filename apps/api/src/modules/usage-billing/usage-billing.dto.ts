import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

/** What the organization itself may change: who the invoice is addressed to. Terms are staff's. */
export class BillToDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) company?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) taxId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) contact?: string;
}

export class AccountPatchDto {
  @ApiPropertyOptional({ description: 'Where invoices are sent, besides the owners' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  billingEmail?: string | null;

  @ApiPropertyOptional({ type: BillToDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BillToDto)
  billTo?: BillToDto;
}

export class InvoicesQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
}

// ------------------------------------------------------------------ staff

export class StaffReasonDto {
  @ApiProperty({ minLength: 4, maxLength: 300 }) @IsString() @MinLength(4) @MaxLength(300) reason!: string;
}

/** Terms are a credit decision. Every field is optional on update; creditLimit is required when the account is being opened. */
export class AccountTermsDto extends StaffReasonDto {
  @ApiPropertyOptional({ description: 'Credits of exposure allowed between invoices', minimum: 0, maximum: 10_000_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  creditLimit?: number;

  @ApiPropertyOptional({ description: 'Negotiated rate, minor units per 100 credits. Null returns to the list price.', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  per100Minor?: number | null;

  @ApiPropertyOptional({ description: 'Monthly minimum, minor units', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  minimumMinor?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 90 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(90) netDays?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 60 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(60) graceDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsEmail() @MaxLength(254) billingEmail?: string | null;
  @ApiPropertyOptional({ description: 'Staff-only note on the terms' }) @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}

export class MarkPaidDto extends StaffReasonDto {
  @ApiProperty({ description: 'Bank or gateway reference for the money received', maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  reference!: string;
}

export class AdminInvoicesQueryDto extends InvoicesQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'PAID', 'OVERDUE', 'VOID'] })
  @IsOptional()
  @IsIn(['OPEN', 'PAID', 'OVERDUE', 'VOID'])
  status?: 'OPEN' | 'PAID' | 'OVERDUE' | 'VOID';

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() workspaceId?: string;
}
