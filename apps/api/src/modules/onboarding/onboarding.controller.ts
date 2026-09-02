/**
 * Onboarding tour state.
 *
 * Whether someone has seen a tour is stored on the server, per user, per
 * surface, per tour version — not in localStorage.
 *
 * That is the whole reason this module exists. localStorage would replay the
 * entire tour the first time somebody opens a second browser, switches to a
 * laptop, or clears their site data — which is exactly the "a second login
 * shouldn't show this" case. Seeing the tour twice is a bug, and one that makes
 * a product feel like it does not know you.
 */

import { Body, Controller, Get, Post, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { OnboardingService } from './onboarding.service';
import { CurrentActor } from '../../common/guards';
import type { Actor } from '../../common/policy/policy';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /**
   * What tour, if any, this person owes on this surface.
   *
   * WHAT     Returns the tour definition to run, or null. Null is the answer on
   *          every visit after the first, on every device.
   * WHO      Any signed-in user, on any surface.
   * COSTS    Nothing.
   * WRITES   Nothing on a repeat visit. On the very first call it creates the
   *          PENDING row, so the tour is owed even if the browser closes before
   *          the first step renders.
   *
   * The surface comes from the session, never from a query string — otherwise
   * a customer could ask for the admin tour and read its copy.
   */
  @Get('pending')
  async pending(@CurrentActor() actor: Actor) {
    return this.onboarding.pendingFor(actor);
  }

  /**
   * Record progress through a tour.
   *
   * WHAT     Stores the step the person reached.
   * WHO      The signed-in user, for their own state only.
   * COSTS    Nothing.
   * WRITES   OnboardingState.stepIndex and status IN_PROGRESS.
   *
   * Saved per step rather than at the end, so a closed tab resumes where it
   * stopped instead of starting over.
   */
  @Post('progress')
  @HttpCode(204)
  async progress(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = z
      .object({ tourKey: z.string().max(80), stepIndex: z.number().int().min(0).max(50) })
      .parse(body);
    await this.onboarding.recordProgress(actor, input.tourKey, input.stepIndex);
  }

  /**
   * Finish or skip a tour.
   *
   * WHAT     Marks the tour done. SKIPPED and COMPLETED both mean "never show
   *          this again unaided" — the distinction is kept only so we can tell
   *          how many people found it worth finishing.
   * WHO      The signed-in user, for their own state only.
   * COSTS    Nothing.
   * WRITES   OnboardingState.status and finishedAt.
   *
   * Skip is written the instant it is pressed, before any animation finishes.
   * Someone who dismisses a tour has told us something clearly, and the worst
   * possible response is to show it again because a request was still in flight.
   */
  @Post('finish')
  @HttpCode(204)
  async finish(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = z
      .object({ tourKey: z.string().max(80), outcome: z.enum(['SKIPPED', 'COMPLETED']) })
      .parse(body);
    await this.onboarding.finish(actor, input.tourKey, input.outcome);
  }

  /**
   * Run a tour again on purpose.
   *
   * WHAT     Resets one tour to PENDING so it plays on the next page load.
   * WHO      The signed-in user, from Help → Replay the tour.
   * COSTS    Nothing.
   * WRITES   OnboardingState.status back to PENDING, stepIndex to 0.
   *
   * Dismissing something permanently with no way back is a trap. This is the
   * way back, and it is the only thing that may resurrect a finished tour —
   * nothing automatic ever does.
   */
  @Post('replay')
  @HttpCode(204)
  async replay(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const input = z.object({ tourKey: z.string().max(80) }).parse(body);
    await this.onboarding.replay(actor, input.tourKey);
  }
}
