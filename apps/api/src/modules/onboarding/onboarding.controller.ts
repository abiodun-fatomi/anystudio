/**
 * Guided-tour state. The tour is data (packages/shared); this only remembers
 * who has seen which one, so a second sign-in never shows it again and a
 * closed tab resumes instead of restarting.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { TourFinishDto, TourKeyDto, TourProgressDto } from './onboarding.dto';
import { CurrentActor } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('onboarding')
@ApiCookieAuth('session')
@Controller({ path: 'onboarding', version: '1' })
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get('/pending')
  @ApiOperation({ summary: 'The tour this person still owes on this surface, or null' })
  pending(@CurrentActor() actor: Actor) {
    return this.onboardingService.pendingFor(actor);
  }

  @Post('/progress')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Save the step reached, so a closed tab resumes' })
  progress(@CurrentActor() actor: Actor, @Body() body: TourProgressDto) {
    return this.onboardingService.recordProgress(actor, body.tourKey, body.stepIndex);
  }

  @Post('/finish')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark a tour skipped or completed; it never shows again' })
  finish(@CurrentActor() actor: Actor, @Body() body: TourFinishDto) {
    return this.onboardingService.finish(actor, body.tourKey, body.outcome);
  }

  @Post('/replay')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Replay a finished tour — the only thing that can resurrect one' })
  replay(@CurrentActor() actor: Actor, @Body() body: TourKeyDto) {
    return this.onboardingService.replay(actor, body.tourKey);
  }
}
