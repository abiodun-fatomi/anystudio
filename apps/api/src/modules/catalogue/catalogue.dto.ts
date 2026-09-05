import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Connect a store. The secret is stored encrypted and never returned. */
export class ConnectStoreDto {
  @ApiProperty({ enum: ['SHOPIFY', 'WOOCOMMERCE'] })
  @IsIn(['SHOPIFY', 'WOOCOMMERCE'])
  kind!: 'SHOPIFY' | 'WOOCOMMERCE';

  @ApiProperty({ description: 'acme.myshopify.com, or https://shop.example for WooCommerce' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  domain!: string;

  @ApiPropertyOptional({ description: 'Shopify: the custom app Admin API access token (shpat_…)' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  accessToken?: string;

  @ApiPropertyOptional({ description: 'WooCommerce: consumer key (ck_…)' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  consumerKey?: string;

  @ApiPropertyOptional({ description: 'WooCommerce: consumer secret (cs_…)' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  consumerSecret?: string;
}

export class ProductsQueryDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @MaxLength(120) q?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 40 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
}
