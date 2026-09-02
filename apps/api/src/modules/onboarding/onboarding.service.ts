/**
 * Onboarding state. Small on purpose — the interesting decisions are the two
 * upsert shapes and the fact that nothing here ever resurrects a finished tour
 * except an explicit replay.
 */

import { Injectable } from '@nestjs/common';
import { PrismaClient, TourStatus } from '@prisma/client';
import { TOURS, FIRST_RUN_BY_SURFACE, type TourDefinition, type TourStep } from '@anystudio/shared';
import type { Actor } from '../../common/policy/policy';

@Injectable()
export class OnboardingService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The tour this person owes on this surface, or null.
   *
   * Creates the PENDING row on first sight so the tour survives a browser that
   * closes before the first step paints — otherwise a person who bounces on
   * arrival would get a "first run" every time they came back.
   */
  async pendingFor(actor: Actor): Promise<{ tour: TourDefinition; stepIndex: number } | null> {
    const key = FIRST_RUN_BY_SURFACE[actor.surface];
    const def = TOURS[key];
    if (!def) return null;

    const state = await this.db.onboardingState.upsert({
      where: { userId_surface_tourKey: { userId: actor.userId, surface: actor.surface, tourKey: key } },
      create: { userId: actor.userId, surface: actor.surface, tourKey: key, status: 'PENDING' },
      update: {}, // never resets an existing row — that is what replay() is for
    });

    if (state.status === 'SKIPPED' || state.status === 'COMPLETED') return null;

    return { tour: this.filterSteps(def, actor), stepIndex: state.stepIndex };
  }

  /**
   * Drop steps that would point at something this person cannot see.
   *
   * A tour that spotlights a menu item the viewer does not have is worse than
   * no tour: it highlights an empty rectangle and teaches them the product is
   * broken.
   */
  private filterSteps(def: TourDefinition, actor: Actor): TourDefinition {
    const allow = (s: TourStep) => {
      switch (s.when) {
        case undefined:
          return true;
        case 'hasWorkspace':
          return actor.workspaceRoles.size > 0;
        case 'hasStaffAccess':
          return actor.staffRole !== null;
        case 'isOrgOwner':
          return [...actor.workspaceRoles.values()].includes('OWNER');
        default:
          return true;
      }
    };
    return { ...def, steps: def.steps.filter(allow) };
  }

  /** Save the step reached, so a closed tab resumes rather than restarts. */
  async recordProgress(actor: Actor, tourKey: string, stepIndex: number): Promise<void> {
    await this.db.onboardingState.updateMany({
      where: { userId: actor.userId, surface: actor.surface, tourKey, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      data: { status: 'IN_PROGRESS', stepIndex, startedAt: new Date() },
    });
  }

  /**
   * Mark a tour done.
   *
   * updateMany with a status filter rather than update-by-id: if two tabs both
   * finish the same tour, the second write is a no-op instead of an error, and
   * a COMPLETED tour is never quietly downgraded to SKIPPED by a late request
   * from a tab the person abandoned.
   */
  async finish(actor: Actor, tourKey: string, outcome: 'SKIPPED' | 'COMPLETED'): Promise<void> {
    await this.db.onboardingState.updateMany({
      where: { userId: actor.userId, surface: actor.surface, tourKey, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      data: { status: outcome as TourStatus, finishedAt: new Date() },
    });
  }

  /** The only thing that may replay a finished tour. Always user-initiated. */
  async replay(actor: Actor, tourKey: string): Promise<void> {
    await this.db.onboardingState.updateMany({
      where: { userId: actor.userId, surface: actor.surface, tourKey },
      data: { status: 'PENDING', stepIndex: 0, startedAt: null, finishedAt: null },
    });
  }
}
