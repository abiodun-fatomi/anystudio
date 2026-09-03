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
 * Resend, over its REST API.
 *
 * No SDK: the whole surface we use is one POST, and a dependency that wraps
 * one fetch is a dependency to patch for no gain. A non-2xx throws with the
 * provider's own message, because "why did that email not arrive" is a
 * question you answer at 2am with whatever the log kept.
 */
@Injectable()
export class ResendMailer extends Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) { super(); }

  /** Send one message. Throws on refusal; callers decide whether that is fatal. */
  async send(mail: Mail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend refused the message (${res.status}): ${detail.slice(0, 300)}`);
    }
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

/**
 * Pick an implementation from the environment. The composition root calls this
 * once.
 *
 * Order is deliberate: a real provider beats a local relay beats a log. So a
 * deployed environment that has RESEND_API_KEY sends for real, `pnpm dev`
 * with docker-compose up gets Mailpit, and a bare checkout still boots and
 * prints what it would have sent instead of failing at the first signup.
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  const from = env.MAIL_FROM ?? 'AnyStudio <no-reply@anystudio.ai>';
  if (env.RESEND_API_KEY) return new ResendMailer(env.RESEND_API_KEY, from);
  if (env.SMTP_URL) return new SmtpMailer(env.SMTP_URL, from);
  return new LogMailer();
}
