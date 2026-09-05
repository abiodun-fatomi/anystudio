/**
 * Authentication endpoints, shared by all three surfaces.
 *
 * Thin by design: every handler names a use case on AuthService and nothing
 * else. Validation is the global ValidationPipe over the DTOs, authorization
 * is the guard over the decorators, and the response envelope is the global
 * interceptor — so a handler here cannot forget any of the three.
 *
 * The surface is derived from the request's origin inside the service, never
 * from a body field: a caller must not be able to ask for an admin session
 * by typing "ADMIN" into JSON.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  ForgotPasswordDto, GoogleCallbackQueryDto, GoogleStartQueryDto, HandoffDto, LoginDto, MfaDto, RegisterDto,
  ResetPasswordDto, StepUpDto, VerifyEmailDto,
} from './auth.dto';
import { CurrentActor, Public, RequireStepUp, RequireSurface } from './decorators';
import type { Actor, SessionActor } from './policy';

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('/register')
  @ApiOperation({ summary: 'Create an account and sign it in (APP surface only)' })
  @ApiResponse({ status: 201, description: 'Account created; session cookie set; welcome email sent' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'An account already exists with that email or phone' })
  register(@Body() body: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.register(body, req, res);
  }

  @Public()
  @Post('/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email or phone and a password' })
  @ApiResponse({ status: 200, description: 'signed_in, mfa_required or invalid_credentials — one shape, one timing' })
  login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.login(body, req, res);
  }

  @Public()
  @Post('/login/mfa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a second factor and finish sign-in' })
  @ApiResponse({ status: 200, description: 'signed_in or invalid_code; five attempts per challenge' })
  completeMfa(@Body() body: MfaDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.completeMfa(body, req, res);
  }

  @Public()
  @Post('/handoff')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem a sign-in that happened on the marketing host; mints the app-host session' })
  @ApiResponse({ status: 200, description: 'signed_in or invalid_token; tokens are single-use and live a minute' })
  handoff(@Body() body: HandoffDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.completeHandoff(body, req, res);
  }

  @Public()
  @Get('/google/start')
  @ApiOperation({ summary: 'Begin sign in with Google (navigate here, do not fetch)' })
  @ApiQuery({ name: 'next', required: false })
  @ApiResponse({ status: 302, description: 'Redirect to Google consent' })
  googleStart(@Query() query: GoogleStartQueryDto, @Req() req: Request, @Res() res: Response) {
    return this.authService.googleStart(query, req, res);
  }

  @Public()
  @Get('/google/callback')
  @ApiOperation({ summary: 'Finish sign in with Google' })
  @ApiResponse({ status: 302, description: 'Redirect into the app, or to /login?error=… on any failure' })
  googleCallback(@Query() query: GoogleCallbackQueryDto, @Req() req: Request, @Res() res: Response) {
    return this.authService.googleCallback(query, req, res);
  }

  @Public()
  @Post('/forgot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email a password reset link, if the address has an account' })
  @ApiResponse({ status: 200, description: 'Always "sent" — the response never reveals whether the address exists' })
  forgotPassword(@Body() body: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.forgotPassword(body, req);
  }

  @Public()
  @Post('/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password from a reset link; signs out everywhere' })
  @ApiResponse({ status: 200, description: 'reset or invalid_token' })
  resetPassword(@Body() body: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(body, req);
  }

  @Public()
  @Post('/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address from the welcome link' })
  @ApiResponse({ status: 200, description: 'verified or invalid_token' })
  verifyEmail(@Body() body: VerifyEmailDto) {
    return this.authService.verifyEmail(body);
  }

  @Post('/verify/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Send the confirmation link again to the signed-in owner' })
  @ApiResponse({ status: 202, description: 'Sent; earlier links stop working' })
  resendVerification(@CurrentActor() actor: SessionActor, @Req() req: Request) {
    return this.authService.resendVerification(actor, req);
  }

  @Get('/me')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Who is signed in on this surface, and what they can reach' })
  me(@CurrentActor() actor: Actor) {
    return this.authService.describeActor(actor);
  }

  @Post('/step-up')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Confirm a fresh second factor before a sensitive action' })
  stepUp(@CurrentActor() actor: SessionActor, @Body() body: StepUpDto, @Req() req: Request) {
    return this.authService.stepUp(actor, body, req);
  }

  @Public()
  @Post('/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token; a replayed token ends the whole session family' })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.refresh(req, res);
  }

  @Post('/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Sign out of this surface' })
  logout(@CurrentActor() actor: SessionActor, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.authService.signOut(actor, req, res);
  }

  @Post('/logout-everywhere')
  @RequireStepUp(5)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'End every session on every surface; needs a second factor within 5 minutes' })
  logoutEverywhere(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    return this.authService.signOutEverywhere(actor, res);
  }

  @Get('/sessions')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Active sessions for the signed-in user, across surfaces' })
  listSessions(@CurrentActor() actor: Actor) {
    return this.authService.listSessions(actor.userId);
  }

  @Get('/staff/context')
  @RequireSurface('ADMIN')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Staff grant and conflict-of-interest workspaces for the console' })
  staffContext(@CurrentActor() actor: Actor) {
    return this.authService.staffContext(actor);
  }
}
