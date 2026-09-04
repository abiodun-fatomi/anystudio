import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsString, IsUUID, Length, MaxLength } from 'class-validator';

/** Roles a member can be given. OWNER is not granted — it is transferred. */
export const GRANTABLE_ROLES = ['ADMIN', 'MEMBER', 'BILLING', 'AUDITOR'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export class InviteDto {
  @ApiProperty({ example: 'kemi@bimbofabrics.ng', maxLength: 320 }) @IsEmail() @MaxLength(320)
  email: string;

  @ApiProperty({ enum: GRANTABLE_ROLES }) @IsIn(GRANTABLE_ROLES)
  role: GrantableRole;
}

export class RoleDto {
  @ApiProperty({ enum: GRANTABLE_ROLES }) @IsIn(GRANTABLE_ROLES)
  role: GrantableRole;
}

export class AcceptInviteDto {
  @ApiProperty() @IsString() @Length(20, 200)
  token: string;
}

export class TransferDto {
  @ApiProperty({ format: 'uuid', description: 'The member who becomes owner' }) @IsUUID()
  userId: string;
}
