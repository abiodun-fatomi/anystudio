/**
 * /me — the signed-in person's own account. Every handler names one use
 * case on AccountService; the guard, the pipe and the envelope do the rest.
 *
 * Nothing here takes a userId: the actor IS the subject. A staff member
 * editing someone else's account goes through the staff console, with the
 * audit trail that implies.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AccountService } from './account.service';
import {
  ChangeEmailDto, ChangePasswordDto, ConfirmEmailChangeDto, DeleteAccountDto, DisableMfaDto, MfaCodeDto, NotificationsDto, ProfileDto,
} from './account.dto';
import { CurrentActor, Public } from '../auth/decorators';
import type { SessionActor } from '../auth/policy';

@ApiTags('account')
@ApiCookieAuth('session')
@Controller({ path: 'me', version: '1' })
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('/profile')
  @ApiOperation({ summary: 'Profile, sign-in methods, two-step state, pending email change, deletion state' })
  profile(@CurrentActor() actor: SessionActor) { return this.account.profile(actor); }

  @Patch('/profile')
  @ApiOperation({ summary: 'Name, picture, language, time zone — send only what changed' })
  updateProfile(@CurrentActor() actor: SessionActor, @Body() body: ProfileDto, @Req() req: Request) { return this.account.updateProfile(actor, body, req); }

  @Post('/email')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start an email change: link to the new address, notice to the old' })
  @ApiResponse({ status: 202, description: 'Always "sent"' })
  requestEmailChange(@CurrentActor() actor: SessionActor, @Body() body: ChangeEmailDto, @Req() req: Request) { return this.account.requestEmailChange(actor, body, req); }

  @Public()
  @Post('/email/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finish an email change from the link in the new inbox' })
  confirmEmailChange(@Body() body: ConfirmEmailChangeDto, @Req() req: Request) { return this.account.confirmEmailChange(body.token, req); }

  @Post('/password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change (or set) the password; every other session ends' })
  changePassword(@CurrentActor() actor: SessionActor, @Body() body: ChangePasswordDto, @Req() req: Request) { return this.account.changePassword(actor, body, req); }

  @Post('/mfa/enrol')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin two-step setup: returns the secret and otpauth URI to scan' })
  enrolMfa(@CurrentActor() actor: SessionActor, @Req() req: Request) { return this.account.enrolMfa(actor, req); }

  @Post('/mfa/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Prove the app with its first code; returns the recovery codes, once' })
  confirmMfa(@CurrentActor() actor: SessionActor, @Body() body: MfaCodeDto, @Req() req: Request) { return this.account.confirmMfa(actor, body.code, req); }

  @Delete('/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Turn two-step off; needs the password and a current or recovery code' })
  disableMfa(@CurrentActor() actor: SessionActor, @Body() body: DisableMfaDto, @Req() req: Request) { return this.account.disableMfa(actor, body, req); }

  @Post('/mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace the recovery codes; needs a current code' })
  recoveryCodes(@CurrentActor() actor: SessionActor, @Body() body: MfaCodeDto, @Req() req: Request) { return this.account.regenerateRecoveryCodes(actor, body.code, req); }

  @Get('/sessions')
  @ApiOperation({ summary: 'Signed-in devices, this one marked' })
  sessions(@CurrentActor() actor: SessionActor) { return this.account.listSessions(actor); }

  @Delete('/sessions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign one device out' })
  revokeSession(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.account.revokeSession(actor, id, req); }

  @Post('/sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign every other device out; this one stays' })
  revokeOthers(@CurrentActor() actor: SessionActor, @Req() req: Request) { return this.account.revokeOtherSessions(actor, req); }

  @Delete('/identities/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlink a sign-in method; refused when it is the last one' })
  unlinkIdentity(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.account.unlinkIdentity(actor, id, req); }

  @Get('/security/activity')
  @ApiOperation({ summary: 'The last fifty security events on this account' })
  activity(@CurrentActor() actor: SessionActor) { return this.account.activity(actor); }

  @Get('/notifications')
  @ApiOperation({ summary: 'Notification switches and the current marketing choices' })
  notifications(@CurrentActor() actor: SessionActor) { return this.account.notifications(actor); }

  @Put('/notifications')
  @ApiOperation({ summary: 'Save switches; marketing choices write consent rows with the exact wording' })
  updateNotifications(@CurrentActor() actor: SessionActor, @Body() body: NotificationsDto, @Req() req: Request) { return this.account.updateNotifications(actor, body, req); }

  @Get('/export')
  @ApiOperation({ summary: 'Everything we hold about you, as JSON' })
  exportData(@CurrentActor() actor: SessionActor, @Req() req: Request) { return this.account.exportData(actor, req); }

  @Post('/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Schedule the account for deletion in 30 days; needs the current credential' })
  requestDeletion(@CurrentActor() actor: SessionActor, @Body() body: DeleteAccountDto, @Req() req: Request) { return this.account.requestDeletion(actor, body, req); }

  @Post('/delete/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Keep the account after all' })
  cancelDeletion(@CurrentActor() actor: SessionActor, @Req() req: Request) { return this.account.cancelDeletion(actor, req); }
}
