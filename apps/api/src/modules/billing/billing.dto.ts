import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * A checkout names WHAT, never how much. The price comes from the plan or
 * pack row on the server; a client that sends an amount is ignored, because
 * `whitelist: true` strips it before this class is even instantiated.
 */
export class CheckoutDto {
  @ApiProperty({ enum: ['pack', 'plan'] }) @IsIn(['pack', 'plan'])
  kind: 'pack' | 'plan';

  @ApiProperty({ example: 'pack.medium' }) @IsString() @MaxLength(40)
  code: string;

  @ApiPropertyOptional({ enum: ['month', 'year'], description: 'Plans only' }) @IsOptional() @IsIn(['month', 'year'])
  interval?: 'month' | 'year';
}

export class VerifyPaymentDto {
  @ApiPropertyOptional({ description: 'The gateway id the return URL carried (transaction_id / _ptxn)' }) @IsOptional() @IsString() @MaxLength(120)
  providerRef?: string;
}

export class PaymentsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  take?: number;
}
