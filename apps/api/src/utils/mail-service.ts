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
import { logger } from '../../config/logger';

export interface Mail {
  to: string;
  subject: string;
  /** Plain text is mandatory: every client renders it, and it is what screen readers get. */
  text: string;
  html?: string;
}

/**
 * What a send produced. The provider's own id is the thing support needs when
 * someone says an email never arrived — without it the answer is a shrug.
 */
export interface MailReceipt {
  transport: 'resend' | 'smtp' | 'log';
  id?: string;
}

/** What every sender depends on. Deliberately tiny. */
export abstract class Mailer {
  abstract send(mail: Mail): Promise<MailReceipt>;
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
  async send(mail: Mail): Promise<MailReceipt> {
    const info = (await this.transport.sendMail({ from: this.from, ...mail })) as { messageId?: string };
    return { transport: 'smtp', id: info.messageId };
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
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }

  /** Send one message. Throws on refusal; callers decide whether that is fatal. */
  async send(mail: Mail): Promise<MailReceipt> {
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
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { transport: 'resend', id: body.id };
  }
}

/**
 * No transport configured: log it. The body is logged at debug only, because
 * a reset link in an INFO log shipped to a third party is a credential leak.
 */
@Injectable()
export class LogMailer extends Mailer {
  async send(mail: Mail): Promise<MailReceipt> {
    logger.debug({ text: mail.text }, 'mail body');
    return { transport: 'log' };
  }
}

/**
 * Logs every send, whichever transport is underneath.
 *
 * A decorator rather than a line in each implementation: there is one place
 * to change the shape, and a new transport gets the same logging for free.
 *
 * Callers treat a failed email as non-fatal — a signup must not fail because
 * Resend is having a bad morning — which is right, and is exactly why this
 * has to be loud. A swallowed exception with no log is how you discover in a
 * week that nobody has received a password reset since Tuesday.
 *
 * The body is never logged here. A verification link in a log shipped to a
 * third party is a credential, and anyone with log access could use it.
 */
export class LoggingMailer extends Mailer {
  constructor(private readonly inner: Mailer) {
    super();
  }

  async send(mail: Mail): Promise<MailReceipt> {
    const started = Date.now();
    try {
      const receipt = await this.inner.send(mail);
      logger.info(
        { event: 'mail.sent', transport: receipt.transport, providerId: receipt.id, to: mail.to, subject: mail.subject, ms: Date.now() - started },
        'mail sent',
      );
      return receipt;
    } catch (err) {
      logger.error({ event: 'mail.failed', to: mail.to, subject: mail.subject, ms: Date.now() - started, err }, 'mail failed to send');
      throw err;
    }
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
  if (env.RESEND_API_KEY) return new LoggingMailer(new ResendMailer(env.RESEND_API_KEY, from));
  if (env.SMTP_URL) return new LoggingMailer(new SmtpMailer(env.SMTP_URL, from));
  logger.warn({ event: 'mail.unconfigured' }, 'no mail transport: set RESEND_API_KEY or SMTP_URL, or nothing will be delivered');
  return new LoggingMailer(new LogMailer());
}
