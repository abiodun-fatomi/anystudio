/**
 * Forgot / reset password.
 *
 * The rules, in order of how often they get broken elsewhere:
 *
 *  1. The request endpoint answers identically whether or not the address
 *     exists. Otherwise it is an email-enumeration oracle.
 *  2. The token in the link is random, single-use, hashed at rest and dies
 *     in 30 minutes. A leaked database or log never contains a usable link.
 *  3. A successful reset bumps credentialEpoch, which ends every session on
 *     every surface. If someone is resetting their password it is because
 *     they suspect the old one — the sessions minted under it must go.
 */

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { hashPassword } from '../../common/crypto/password';
import { Mailer } from '../../common/mail/mailer';
import { logger } from '../../common/logging/logger';

const RESET_TTL_MS = 30 * 60_000;

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly db: PrismaClient,
    private readonly mailer: Mailer,
  ) {}

  /**
   * Issue a reset link if — and only if — the address belongs to an account.
   *
   * Returns nothing either way. The mail send is awaited so a transport error
   * surfaces in the logs, but its outcome is never reflected to the caller.
   */
  async request(email: string, appOrigin: string, req: Request): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { email },
      select: { id: true, name: true, status: true },
    });
    if (!user || user.status === 'DELETED') return;

    // Only the newest link works: issuing a new one retires the old ones, so
    // an attacker cannot stockpile links from repeated requests.
    await this.db.authToken.updateMany({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    await this.db.authToken.create({
      data: {
        purpose: 'PASSWORD_RESET',
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
        createdIp: req.ip,
      },
    });

    const link = `${appOrigin}/reset?token=${token}`;
    await this.mailer
      .send({
        to: email,
        subject: 'Reset your AnyStudio password',
        text: [
          `Hi${user.name ? ` ${user.name.split(' ')[0]}` : ''},`,
          '',
          'Someone asked to reset the password on your AnyStudio account. If that was you, open this link within 30 minutes:',
          link,
          '',
          "If it wasn't you, ignore this — your password has not changed and nobody can use this link without your inbox.",
        ].join('\n'),
      })
      .catch((err: unknown) => logger.error({ err }, 'password reset mail failed'));
  }

  /**
   * Consume a reset token and set the new password.
   *
   * Returns false for any token that is unknown, expired, or already used —
   * one answer, so the endpoint cannot be used to probe which tokens are live.
   */
  async complete(token: string, newPassword: string, req: Request): Promise<boolean> {
    const row = await this.db.authToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.purpose !== 'PASSWORD_RESET' || !row.userId) return false;
    if (row.consumedAt || row.expiresAt < new Date()) return false;

    const passwordHash = await hashPassword(newPassword);

    // consume + set + retire sessions, atomically. If the epoch bump failed
    // after the hash was written, the attacker's sessions would survive a
    // reset — which is the one thing a reset must guarantee cannot happen.
    await this.db.$transaction([
      this.db.authToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
      this.db.user.update({
        where: { id: row.userId },
        data: { passwordHash, credentialEpoch: { increment: 1 } },
      }),
      this.db.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password_reset' },
      }),
      this.db.authEvent.create({
        data: {
          userId: row.userId, type: 'PASSWORD_CHANGED', surface: 'APP',
          requestId: req.requestId, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 400),
          detail: { via: 'reset_link' },
        },
      }),
    ]);
    return true;
  }
}
