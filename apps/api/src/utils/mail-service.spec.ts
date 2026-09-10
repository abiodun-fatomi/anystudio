import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogMailer, LoggingMailer, Mailer, ResendMailer, mailerFromEnv, type Mail, type MailReceipt } from './mail-service';

const message: Mail = { to: 'someone@example.test', subject: 'Confirm your email', text: 'link: https://x/verify?token=abc' };

class Recorder extends Mailer {
  sent: Mail[] = [];
  async send(mail: Mail): Promise<MailReceipt> {
    this.sent.push(mail);
    return { transport: 'log', id: 'rec-1' };
  }
}

class Broken extends Mailer {
  async send(): Promise<MailReceipt> {
    throw new Error('provider is down');
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('mailerFromEnv', () => {
  it('prefers a real provider, then a relay, then the log', () => {
    expect(mailerFromEnv({ RESEND_API_KEY: 'k', SMTP_URL: 's' } as NodeJS.ProcessEnv)).toBeInstanceOf(LoggingMailer);
    // The chosen transport shows up in the receipt, which is what the log records.
    expect(mailerFromEnv({} as NodeJS.ProcessEnv)).toBeInstanceOf(LoggingMailer);
  });

  it('still returns a working mailer with nothing configured, so a bare checkout boots', async () => {
    const mailer = mailerFromEnv({} as NodeJS.ProcessEnv);
    await expect(mailer.send(message)).resolves.toMatchObject({ transport: 'log' });
  });
});

describe('LoggingMailer', () => {
  it('passes the message through untouched', async () => {
    const inner = new Recorder();
    const receipt = await new LoggingMailer(inner).send(message);

    expect(inner.sent).toEqual([message]);
    expect(receipt.id).toBe('rec-1');
  });

  it('rethrows, so a caller still decides whether a failed email is fatal', async () => {
    await expect(new LoggingMailer(new Broken()).send(message)).rejects.toThrow('provider is down');
  });
});

describe('ResendMailer', () => {
  it('returns the provider id, which is what support needs later', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 })),
    );

    const receipt = await new ResendMailer('key', 'AnyStudio <a@b.test>').send(message);

    expect(receipt).toEqual({ transport: 'resend', id: 're_123' });
  });

  it("throws with the provider's own words when it refuses", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('domain is not verified', { status: 403 })),
    );

    await expect(new ResendMailer('key', 'from').send(message)).rejects.toThrow(/403.*domain is not verified/);
  });

  it('sends text as well as html, because plain text is what every client renders', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ResendMailer('key', 'from').send({ ...message, html: '<p>hi</p>' });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toBe(message.text);
    expect(body.html).toBe('<p>hi</p>');
    expect(body.to).toEqual([message.to]);
  });
});

describe('LogMailer', () => {
  it('reports the log transport rather than pretending it delivered', async () => {
    await expect(new LogMailer().send(message)).resolves.toEqual({ transport: 'log' });
  });
});
