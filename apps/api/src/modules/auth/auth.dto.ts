/**
 * Request bodies for the auth module.
 *
 * class-validator does the checking through the global ValidationPipe
 * (`whitelist: true` strips anything not declared here, so a field that is
 * not on a DTO cannot reach a service). @ApiProperty feeds the OpenAPI doc.
 *
 * The identifier is one field for email or phone on purpose: the sign-in
 * screen has one box, and a seller should not have to know which of their two
 * contact details we filed them under.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, IsUrl, IsUUID, Length, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'ada@bimbofabrics.ng', description: 'Email address or E.164 phone number' })
  @IsString()
  @IsNotEmpty()
  @Length(3, 320)
  identifier: string;

  @ApiProperty({ example: 'correct horse battery staple', maxLength: 400 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(400)
  password: string;
}

export class MfaDto {
  @ApiProperty({ format: 'uuid', description: 'From the login response that said mfa_required' })
  @IsUUID()
  challengeId: string;

  @ApiProperty({ example: '123456', description: 'Six-digit TOTP code, or a WebAuthn assertion' })
  @IsString()
  @Length(6, 400)
  code: string;
}

export class HandoffDto {
  @ApiProperty({ description: 'The one-time token from the marketing host sign-in' })
  @IsString()
  @Length(20, 200)
  token: string;
}

export class HopDto {
  @ApiProperty({ description: 'The workspace to open on the other portal host', format: 'uuid' })
  @IsUUID()
  workspaceId: string;

  @ApiPropertyOptional({ description: 'Path to land on there', example: '/today' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  next?: string;
}

export class StepUpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 400)
  code: string;
}

export class MarketingConsentDto {
  @ApiProperty({ description: 'Ticked or not. Must default to unticked in the UI.' })
  @IsBoolean()
  granted: boolean;

  @ApiProperty({ description: 'The exact sentence shown next to the box. Stored verbatim.', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  wording: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'Adaeze Okonkwo', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'ada@bimbofabrics.ng', maxLength: 320 })
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiProperty({ example: '+2348012345678', description: 'E.164 from any country; a local number is read in `country` (default NG)' })
  @IsString()
  @Length(6, 24)
  phone: string;

  @ApiPropertyOptional({ example: 'KE', description: 'ISO 3166-1 alpha-2, for a phone given without its country code' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  @ApiProperty({ minLength: 8, maxLength: 400 })
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  password: string;

  @ApiPropertyOptional({ default: false, description: 'Functional: can we deliver over WhatsApp. Not consent to market.' })
  @IsOptional()
  @IsBoolean()
  phoneIsWhatsApp?: boolean;

  @ApiProperty({ type: MarketingConsentDto })
  @ValidateNested()
  @Type(() => MarketingConsentDto)
  marketing: MarketingConsentDto;

  @ApiPropertyOptional({ description: 'Page the form was on, for the consent record' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  sourceUrl?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'ada@bimbofabrics.ng' })
  @IsEmail()
  @MaxLength(320)
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'From the emailed link' })
  @IsString()
  @Length(20, 200)
  token: string;

  @ApiProperty({ minLength: 8, maxLength: 400 })
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  password: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'From the emailed link' })
  @IsString()
  @Length(20, 200)
  token: string;
}

export class GoogleStartQueryDto {
  @ApiPropertyOptional({ description: 'Path inside the app to return to afterwards', example: '/today' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  next?: string;
}

export class GoogleCallbackQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  state?: string;

  @ApiPropertyOptional({ description: 'Set by Google when the person declined' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  error?: string;
}
