import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * A checkout names WHAT, never how much. The price comes from the plan or
 * pack row on the server; a client that sends an amount is ignored, because
 * `whitelist: true` strips it before this class is even instantiated.
 */
export class CheckoutDto {
  @ApiProperty({ enum: ['pack', 'plan'] })
  @IsIn(['pack', 'plan'])
  kind: 'pack' | 'plan';

  @ApiProperty({ example: 'pack.medium' })
  @IsString()
  @MaxLength(40)
  code: string;

  @ApiPropertyOptional({ enum: ['month', 'year'], description: 'Plans only' })
  @IsOptional()
  @IsIn(['month', 'year'])
  interval?: 'month' | 'year';
}

export class VerifyPaymentDto {
  @ApiPropertyOptional({ description: 'The gateway id the return URL carried (transaction_id / _ptxn)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  providerRef?: string;
}

export class PaymentsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class RefundRequestDto {
  @ApiProperty({ description: 'Why — in the person’s own words', minLength: 4, maxLength: 500 })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}

export class RefundDecisionDto {
  @ApiPropertyOptional({ description: 'On refusal, the sentence the customer reads; on approval, a note for the gateway', maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class RefundsQueryDto {
  @ApiPropertyOptional({ enum: ['REQUESTED', 'APPROVED', 'REFUSED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['REQUESTED', 'APPROVED', 'REFUSED', 'CANCELLED'])
  status?: 'REQUESTED' | 'APPROVED' | 'REFUSED' | 'CANCELLED';

  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
}
