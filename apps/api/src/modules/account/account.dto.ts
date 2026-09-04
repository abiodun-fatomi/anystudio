/**
 * Request bodies for the account module.
 *
 * Anything that changes a credential carries proof of the current one:
 * `currentPassword` for accounts with a password, a fresh authenticator
 * `code` for accounts without one but with two-step on. A session cookie
 * alone is what an attacker on a shared laptop already has.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength,
  ValidateNested,
} from 'class-validator';

export const LOCALES = ['en', 'en-NG', 'en-GH', 'en-KE', 'en-ZA', 'fr', 'pt', 'pt-BR', 'yo', 'ha', 'ig', 'sw'] as const;

export class ProfileDto {
  @ApiPropertyOptional({ maxLength: 120 }) @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Storage key of a READY MediaAsset in one of your workspaces; null removes the picture' })
  @IsOptional() @IsString() @MaxLength(512)
  avatarKey?: string | null;

  @ApiPropertyOptional({ enum: LOCALES }) @IsOptional() @IsIn(LOCALES)
  locale?: string | null;

  @ApiPropertyOptional({ example: 'Africa/Lagos', description: 'IANA zone name' })
  @IsOptional() @IsString() @Matches(/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/) @MaxLength(64)
  timezone?: string | null;
}

/** Proof of the current credential, for anything that changes one. */
export class ReauthDto {
  @ApiPropertyOptional({ description: 'Required when the account has a password', maxLength: 400 })
  @IsOptional() @IsString() @MaxLength(400)
  currentPassword?: string;

  @ApiPropertyOptional({ description: 'A fresh authenticator or recovery code; required when the account has two-step on and no password' })
  @IsOptional() @IsString() @Length(6, 40)
  code?: string;
}

export class ChangeEmailDto extends ReauthDto {
  @ApiProperty({ example: 'ada@newshop.ng', maxLength: 320 }) @IsEmail() @MaxLength(320)
  email: string;
}

export class ConfirmEmailChangeDto {
  @ApiProperty() @IsString() @Length(20, 200)
  token: string;
}

export class ChangePasswordDto extends ReauthDto {
  @ApiProperty({ minLength: 8, maxLength: 400 }) @IsString() @MinLength(8) @MaxLength(400)
  newPassword: string;
}

export class MfaCodeDto {
  @ApiProperty({ example: '123456', description: 'Six digits from the authenticator app' }) @IsString() @Length(6, 12)
  code: string;
}

export class DisableMfaDto extends ReauthDto {}

export class NotificationSwitchesDto {
  @ApiPropertyOptional({ description: 'Email when a video or batch finishes while you are away' }) @IsOptional() @IsBoolean()
  generationDoneEmail?: boolean;

  @ApiPropertyOptional({ description: 'WhatsApp message when a video or batch finishes' }) @IsOptional() @IsBoolean()
  generationDoneWhatsApp?: boolean;

  @ApiPropertyOptional({ description: 'Email when credits run low' }) @IsOptional() @IsBoolean()
  lowCreditsEmail?: boolean;

  @ApiPropertyOptional({ description: 'A weekly note on what was made and what worked' }) @IsOptional() @IsBoolean()
  weeklyDigest?: boolean;
}

export class ConsentChoiceDto {
  @ApiProperty() @IsBoolean()
  granted: boolean;

  @ApiProperty({ description: 'The exact sentence shown next to the switch. Stored verbatim.', maxLength: 500 })
  @IsString() @IsNotEmpty() @MaxLength(500)
  wording: string;
}

export class NotificationsDto {
  @ApiPropertyOptional({ type: NotificationSwitchesDto }) @IsOptional() @ValidateNested() @Type(() => NotificationSwitchesDto)
  switches?: NotificationSwitchesDto;

  @ApiPropertyOptional({ type: ConsentChoiceDto, description: 'Marketing email — writes a Consent row' })
  @IsOptional() @ValidateNested() @Type(() => ConsentChoiceDto)
  emailMarketing?: ConsentChoiceDto;

  @ApiPropertyOptional({ type: ConsentChoiceDto, description: 'Marketing on WhatsApp — writes a Consent row' })
  @IsOptional() @ValidateNested() @Type(() => ConsentChoiceDto)
  whatsappMarketing?: ConsentChoiceDto;

  @ApiPropertyOptional({ description: 'Where the choice was made, for the consent record' }) @IsOptional() @IsString() @MaxLength(500)
  sourceUrl?: string;
}

export class DeleteAccountDto extends ReauthDto {
  @ApiProperty({ description: 'Must be the literal word DELETE, typed by the person' }) @IsIn(['DELETE'])
  confirm: 'DELETE';
}

export class SessionIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID()
  id: string;
}

/** What `prefs.notifications` holds on the User row. Defaults apply where a key is missing. */
export interface NotificationSwitches {
  generationDoneEmail: boolean;
  generationDoneWhatsApp: boolean;
  lowCreditsEmail: boolean;
  weeklyDigest: boolean;
}

export const NOTIFICATION_DEFAULTS: NotificationSwitches = {
  generationDoneEmail: true, generationDoneWhatsApp: true, lowCreditsEmail: true, weeklyDigest: false,
};
