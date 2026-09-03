/**
 * Email verification.
 *
 * Why it exists at all in a WhatsApp-first product: the phone is the account,
 * but the email is the recovery path. An unverified address means a password
 * reset can be sent somewhere its owner never chose, and it means anyone can
 * occupy someone else's address at signup. Neither is acceptable, and neither
 * is visible until it goes wrong.
 *
 * Same token discipline as password reset: random, single use, hashed at
 * rest, and issuing a new one retires the old, so a mailbox full of old
 * links contains nothing that still works.
 */

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { Mailer } from '../../common/mail/mailer';
import { welcomeAndVerify, verifyEmail } from '../../common/mail/templates';
import { logger } from '../../common/logging/logger';

/** Long enough to survive a night's sleep, short enough that a leaked inbox ages out. */
const TTL_MS = 24 * 60 * 60_000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

@Injectable()
export class VerificationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Issue a link and send it.
   *
   * `flavour` only changes the words: 'welcome' is the one email a new account
   * gets, and it does two jobs so a newcomer is not asked to read two.
   *
   * Mail failure is logged, never thrown. A signup that succeeded must not be
   * reported as failed because a provider had a bad minute — the account
   * exists, and /auth/verify/resend is one tap away.
   */
  async issue(userId: string, appOrigin: string, req: Request, flavour: 'welcome' | 'resend'): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });
    if (!user?.email || user.emailVerifiedAt) return;

    await this.db.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFY', consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    await this.db.authToken.create({
      data: {
        purpose: 'EMAIL_VERIFY',
        userId: user.id,
        email: user.email,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + TTL_MS),
        createdIp: req.ip,
      },
    });

    const link = `${appOrigin}/verify?token=${token}`;
    const mail = flavour === 'welcome'
      ? welcomeAndVerify(user.email, user.name, link)
      : verifyEmail(user.email, user.name, link);
    await this.mailer.send(mail).catch((err: unknown) =>
      logger.error({ err, purpose: 'EMAIL_VERIFY' }, 'verification mail failed'));
  }

  /**
   * Consume a token and mark the address verified.
   *
   * Returns false for unknown, expired, already-used and wrong-purpose alike.
   * Distinguishing them would let someone probe which tokens are live.
   *
   * The address on the token is compared with the address on the account: if
   * the person changed their email after the link was sent, the old link must
   * not verify the new address.
   */
  async complete(token: string): Promise<boolean> {
    const row = await this.db.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.purpose !== 'EMAIL_VERIFY' || !row.userId) return false;
    if (row.consumedAt || row.expiresAt < new Date()) return false;

    const user = await this.db.user.findUnique({ where: { id: row.userId }, select: { email: true } });
    if (!user?.email || user.email.toLowerCase() !== (row.email ?? '').toLowerCase()) return false;

    await this.db.$transaction([
      this.db.authToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
      this.db.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
    return true;
  }
}
