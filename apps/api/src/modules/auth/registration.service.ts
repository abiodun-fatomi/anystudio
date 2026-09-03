/**
 * Registration — turning a stranger into an account.
 *
 * Kept out of AuthService on purpose (single responsibility): AuthService
 * answers "is this person who they say they are"; this service answers "make
 * this person exist". They share nothing but the password hasher.
 *
 * One registration is ONE transaction that writes six things — user,
 * password identity, personal workspace, membership, wallet, and the signup
 * credit grant — plus the consent rows. Either all of them exist afterwards
 * or none do. A user with no workspace, or a workspace with no wallet, is a
 * support ticket we would rather not be able to create.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type User } from '@prisma/client';
import type { Request } from 'express';
import { SIGNUP_PROMO_CREDITS, signupGrantKey } from '@anystudio/shared';
import { hashPassword } from '../../utils/crypto/password';
import { ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { LedgerService } from '../ledger/ledger.service';

export interface RegistrationInput {
  name: string;
  email: string;
  /** E.164, already validated by the controller. */
  phone: string;
  password: string;
  /** Functional: can we deliver over WhatsApp. Not consent to market. */
  phoneIsWhatsApp: boolean;
  /** Marketing consent, and the exact sentence that was ticked. */
  marketing: { granted: boolean; wording: string };
  /** Where the form lived, for the consent record. */
  sourceUrl?: string;
}

export type RegistrationOutcome =
  | { kind: 'created'; user: User; workspaceId: string }
  /** Email or phone already belongs to an account. Same shape either way. */
  | { kind: 'conflict' };

@Injectable()
export class RegistrationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Create the account, its first workspace and its starting credits.
   *
   * Duplicate email/phone is reported as a single 'conflict' rather than as
   * "which field" — the sign-up form is the other half of the login oracle,
   * and telling an attacker that +234… is already registered is the same leak
   * as telling them the password was wrong for it.
   *
   * The password is hashed BEFORE the transaction opens, because Argon2 takes
   * tens of milliseconds and a transaction should not hold locks while we do
   * CPU work.
   */
  async register(input: RegistrationInput, req: Request): Promise<RegistrationOutcome> {
    const passwordHash = await hashPassword(input.password);
    const workspaceName = `${input.name.trim().split(/\s+/)[0] ?? 'My'}'s studio`;

    try {
      const result = await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: input.name.trim(),
            email: input.email,
            phone: input.phone,
            phoneIsWhatsApp: input.phoneIsWhatsApp,
            passwordHash,
            identities: { create: { provider: 'PASSWORD', providerUid: input.email } },
            consents: {
              create: {
                channel: 'WHATSAPP_MARKETING',
                granted: input.marketing.granted,
                wording: input.marketing.wording,
                sourceUrl: input.sourceUrl,
                ip: req.ip,
                userAgent: req.get('user-agent')?.slice(0, 400),
              },
            },
          },
        });

        const workspace = await tx.workspace.create({
          data: {
            type: 'PERSONAL',
            name: workspaceName,
            members: { create: { userId: user.id, role: 'OWNER' } },
            wallet: { create: {} },
          },
          include: { wallet: { select: { id: true } } },
        });

        // Starting credits go through the same Postgres function as every
        // other movement — no special-cased "initial balance" column.
        if (workspace.wallet) {
          await this.ledger.grant(
            {
              walletId: workspace.wallet.id,
              amount: SIGNUP_PROMO_CREDITS,
              idempotencyKey: signupGrantKey(workspace.id),
              reason: 'Welcome credits',
            },
            tx,
          );
        }

        await tx.authEvent.create({
          data: {
            userId: user.id,
            type: 'SIGNED_UP',
            surface: 'APP',
            requestId: req.requestId,
            ip: req.ip,
            userAgent: req.get('user-agent')?.slice(0, 400),
          },
        });

        return { user, workspaceId: workspace.id };
      });

      return { kind: 'created', ...result };
    } catch (err) {
      // P2002 = unique violation. Email and phone are both unique; we do not
      // say which one collided (see the method comment).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { kind: 'conflict' };
      }
      logger.error({ err }, 'registration failed');
      throw err;
    }
  }

  /**
   * Validate a phone number into E.164 or throw a field error.
   *
   * Deliberately strict: a number we cannot normalise is a number we cannot
   * send a WhatsApp message to, so accepting it would only move the failure
   * to a worse place.
   */
  static normalisePhone(raw: string): string {
    const digits = raw.replace(/[\s().-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
    // Nigerian local format (0801…) is by far the most common mistake on our
    // forms; fix it rather than lecture about country codes.
    if (/^0[789][01]\d{8}$/.test(digits)) return `+234${digits.slice(1)}`;
    throw new ValidationError({ fields: [{ path: 'phone', message: 'Enter the number with its country code, like +234 801 234 5678.' }] });
  }
}
