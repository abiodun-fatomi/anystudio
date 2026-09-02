/**
 * Outbound email, behind an interface.
 *
 * Dependency inversion in one file: services depend on `Mailer`, never on
 * nodemailer, so a test can substitute a recorder and production can swap
 * SMTP for an HTTP provider without touching a caller. Two implementations
 * ship — SMTP when SMTP_URL is set, and a logger that prints the message
 * otherwise, which is what makes `pnpm dev` work on a laptop with nothing
 * configured.
 */

import { Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../logging/logger';

export interface Mail {
  to: string;
  subject: string;
  /** Plain text is mandatory: every client renders it, and it is what screen readers get. */
  text: string;
  html?: string;
}

/** What every sender depends on. Deliberately tiny. */
export abstract class Mailer {
  abstract send(mail: Mail): Promise<void>;
}

/** Real delivery over SMTP (Mailpit locally, a relay in production). */
@Injectable()
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(url: string, from: string) {
    super();
    this.transport = nodemailer.createTransport(url);
    this.from = from;
  }

  /** Send one message. Throws on transport failure; callers decide whether that is fatal. */
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail });
  }
}

/**
 * No transport configured: log it. The body is logged at debug only, because
 * a reset link in an INFO log shipped to a third party is a credential leak.
 */
@Injectable()
export class LogMailer extends Mailer {
  async send(mail: Mail): Promise<void> {
    logger.info({ to: mail.to, subject: mail.subject }, 'mail (not sent: SMTP_URL unset)');
    logger.debug({ text: mail.text }, 'mail body');
  }
}

/** Pick an implementation from the environment. The composition root calls this once. */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  const url = env.SMTP_URL;
  if (!url) return new LogMailer();
  return new SmtpMailer(url, env.MAIL_FROM ?? 'AnyStudio <no-reply@anystudio.ai>');
}
