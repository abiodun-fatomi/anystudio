import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeadsService } from './leads.module';

/**
 * The reason the form exists is that someone reads it, so what is pinned is
 * that the whole form reaches the row and the email — not just the address
 * the old waitlist kept — that the email goes to LEADS_EMAIL and nowhere the
 * request could name, that a missing LEADS_EMAIL still stores the lead, that
 * a failed email never fails the submission, and that a filled honeypot is
 * dropped without a row.
 */

const row = (data: Record<string, unknown>) => ({
  id: 'lead-1',
  handledAt: null,
  createdAt: new Date('2026-09-15T09:00:00Z'),
  ...data,
});

let db: {
  lead: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};
let mailer: { send: ReturnType<typeof vi.fn> };
let service: LeadsService;
const req = { ip: '41.58.0.1' } as never;

beforeEach(() => {
  db = {
    lead: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => row(args.data)),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => row({ organization: 'Bimbo', email: 'ada@bimbo.ng' })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => row({ organization: 'Bimbo', email: 'ada@bimbo.ng', ...args.data })),
    },
  };
  mailer = { send: vi.fn(async () => ({ transport: 'log' })) };
  service = new LeadsService(db as never, mailer as never);
  process.env.LEADS_EMAIL = 'fatomi@anystudio.ai';
});
afterEach(() => {
  delete process.env.LEADS_EMAIL;
});

const form = {
  organization: ' Bimbo Marketplace ',
  email: 'Ada@BimboMarket.ng',
  role: 'Head of Product',
  volume: '5,000 images and 200 reels',
  timeline: 'Before the December sale',
  notes: 'Our catalogue images are on Cloudinary behind signed URLs.',
};

describe('a platform writes in', () => {
  it('keeps every field of the form, trimmed, with the address lowercased', async () => {
    const out = await service.create(form, req);
    expect(out).toEqual({ ok: true, id: 'lead-1' });
    expect(db.lead.create).toHaveBeenCalledWith({
      data: {
        organization: 'Bimbo Marketplace',
        email: 'ada@bimbomarket.ng',
        role: 'Head of Product',
        volume: '5,000 images and 200 reels',
        timeline: 'Before the December sale',
        notes: 'Our catalogue images are on Cloudinary behind signed URLs.',
        source: 'org-contact',
        ip: '41.58.0.1',
      },
    });
  });

  it('emails the whole form to LEADS_EMAIL, so it can be answered from a phone', async () => {
    await service.create(form, req);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    const mail = mailer.send.mock.calls[0]![0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe('fatomi@anystudio.ai');
    expect(mail.subject).toBe('Platform lead: Bimbo Marketplace');
    for (const s of ['ada@bimbomarket.ng', 'Head of Product', '5,000 images and 200 reels', 'Before the December sale', 'Cloudinary']) {
      expect(mail.text).toContain(s);
    }
  });

  it('still stores the lead when no LEADS_EMAIL is set, and sends nothing', async () => {
    delete process.env.LEADS_EMAIL;
    const out = await service.create(form, req);
    expect(out.id).toBe('lead-1');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('does not fail the submission because the email did', async () => {
    mailer.send.mockRejectedValueOnce(new Error('Resend refused the message (500)'));
    await expect(service.create(form, req)).resolves.toEqual({ ok: true, id: 'lead-1' });
  });

  it('drops a filled honeypot without a row or an email, and still says ok', async () => {
    const out = await service.create({ ...form, website: 'https://spam.example' }, req);
    expect(out).toEqual({ ok: true });
    expect(db.lead.create).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('empties blank optional fields rather than storing whitespace', async () => {
    await service.create({ organization: 'Bimbo', email: 'a@b.ng', role: '  ', notes: '' }, req);
    const data = db.lead.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).toMatchObject({ role: null, volume: null, timeline: null, notes: null });
  });
});

describe('reading them back', () => {
  it('lists open leads newest first, one past the page to know if there is more', async () => {
    db.lead.findMany.mockResolvedValueOnce([row({ id: 'a', organization: 'A', email: 'a@x' }), row({ id: 'b', organization: 'B', email: 'b@x' })]);
    const out = await service.list({ take: 1 });
    expect(db.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { handledAt: null }, orderBy: { createdAt: 'desc' }, take: 2 }));
    expect(out.rows.map((r) => r.id)).toEqual(['a']);
    expect(out.nextCursor).toBe('a');
    expect(out.rows[0]).toMatchObject({ createdAt: '2026-09-15T09:00:00.000Z', handledAt: null });
  });

  it('shows handled ones too when asked', async () => {
    await service.list({ show: 'all' });
    expect(db.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('marks a lead handled and back again', async () => {
    const handled = await service.setHandled('lead-1', true);
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { handledAt: expect.any(Date) } });
    expect(handled.handledAt).toEqual(expect.any(String));
    await service.setHandled('lead-1', false);
    expect(db.lead.update).toHaveBeenLastCalledWith({ where: { id: 'lead-1' }, data: { handledAt: null } });
  });
});
