/**
 * The help chat's contract: the assistant always answers (a holding line when
 * it cannot), escalation is a flag on the row, and closing mails the
 * transcript exactly once — whoever closes it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { SupportService } from './support.service';
import { SupportAssistant } from './support.assistant';

type Msg = { id: string; conversationId: string; role: string; text: string; meta: unknown; createdAt: Date };
type Convo = Record<string, unknown> & { id: string; userId: string; status: string; needsHuman: boolean; topic: string | null; messageCount: number; messages?: Msg[] };

function harness(opts: { assistant?: Partial<SupportAssistant> } = {}) {
  const convos: Convo[] = [];
  const msgs: Msg[] = [];
  let n = 0;
  const withMessages = (c: Convo | undefined, include?: { messages?: unknown; user?: unknown }) => {
    if (!c) return null;
    const out: Convo = { ...c };
    if (include?.messages) out.messages = msgs.filter((m) => m.conversationId === c.id);
    if (include?.user) (out as Record<string, unknown>).user = { email: 'p@x.test', name: 'Pat Person' };
    return out;
  };
  const db = {
    supportConversation: {
      findFirst: vi.fn(async ({ where, include }: { where: { userId?: string; status?: string }; include?: { messages?: unknown } }) =>
        withMessages(convos.find((c) => (!where.userId || c.userId === where.userId) && (!where.status || c.status === where.status)), include)),
      findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: { messages?: unknown; user?: unknown } }) => withMessages(convos.find((c) => c.id === where.id), include)),
      findUniqueOrThrow: vi.fn(async ({ where, include }: { where: { id: string }; include?: { messages?: unknown } }) => withMessages(convos.find((c) => c.id === where.id), include)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> & { messages?: { create: Omit<Msg, 'id' | 'conversationId' | 'createdAt'> } } }) => {
        const c: Convo = { id: `c${++n}`, status: 'OPEN', needsHuman: false, topic: null, messageCount: 1, createdAt: new Date(), closedAt: null, transcriptSentAt: null, staffJoinedAt: null, workspaceId: null, page: null, ...data, userId: data.userId as string };
        delete (c as Record<string, unknown>).messages;
        convos.push(c);
        if (data.messages?.create) msgs.push({ id: `m${++n}`, conversationId: c.id, createdAt: new Date(), meta: null, ...data.messages.create });
        return withMessages(c, { messages: true });
      }),
      update: vi.fn(async ({ where, data, include }: { where: { id: string }; data: Record<string, unknown>; include?: { messages?: unknown; user?: unknown } }) => {
        const c = convos.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as object)) (c as Record<string, number>)[k] += (v as { increment: number }).increment;
          else (c as Record<string, unknown>)[k] = v;
        }
        return withMessages(c, include);
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    supportMessage: {
      create: vi.fn(async ({ data }: { data: Omit<Msg, 'id' | 'createdAt'> }) => { const m = { id: `m${++n}`, createdAt: new Date(), meta: null, ...data }; msgs.push(m); return m; }),
    },
    user: { findUniqueOrThrow: vi.fn(async () => ({ name: 'Pat Person' })) },
    workspace: { findUnique: vi.fn(async () => null) },
  };
  const assistant = { configured: true, answer: vi.fn(async () => ({ reply: 'Credits → Add credits.', needsHuman: false, topic: 'buying credits', meta: { model: 't' } })), ...opts.assistant };
  const mailer = { send: vi.fn(async () => ({ transport: 'log' as const })) };
  const notifications = { notify: vi.fn(async () => undefined) };
  const ledger = { balance: vi.fn(async () => 150) };
  const svc = new SupportService(db as never, assistant as never, ledger as never, notifications as never, mailer as never);
  const actor = { userId: 'u1', surface: 'APP', staffRole: null, workspaceRoles: new Map(), mfaLevel: 1, lastStepUpAt: null } as never;
  const staff = { userId: 's1', surface: 'ADMIN', staffRole: 'SUPPORT', workspaceRoles: new Map(), mfaLevel: 2, lastStepUpAt: new Date() } as never;
  const req = { ip: '1.1.1.1', get: () => undefined } as unknown as Request;
  return { svc, db, assistant, mailer, notifications, actor, staff, req, convos, msgs };
}

describe('help chat', () => {
  it('opens once per person, greets, and answers each message with the assistant', async () => {
    const h = harness();
    const a = await h.svc.open(h.actor, { page: '/library' }, h.req);
    const b = await h.svc.open(h.actor, {}, h.req);
    expect(a.data.id).toBe(b.data.id);
    expect(a.data.messages[0].role).toBe('SYSTEM');
    expect(a.data.messages[0].text).toContain('Hi Pat');

    const r = await h.svc.send(h.actor, a.data.id, { text: 'how do I buy credits?' }, h.req);
    expect(r.data.messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    expect(r.data.messages[1].text).toBe('Credits → Add credits.');
    expect(r.data.needsHuman).toBe(false);
    expect(h.convos[0].topic).toBe('buying credits');
    expect(h.convos[0].messageCount).toBe(3);
    // The greeting is not sent to the model; the person's words are.
    const turns = (h.assistant.answer.mock.calls[0] as unknown[])[0] as Array<{ role: string; text: string }>;
    expect(turns).toEqual([{ role: 'user', text: 'how do I buy credits?' }]);
  });

  it('flags the conversation for a person when the assistant says so, and keeps the flag', async () => {
    const h = harness({ assistant: { answer: vi.fn()
      .mockResolvedValueOnce({ reply: 'The team will look at this.', needsHuman: true, topic: 'payment not credited', meta: { model: 't' } })
      .mockResolvedValueOnce({ reply: 'Sure.', needsHuman: false, topic: 'x', meta: { model: 't' } }) } });
    const c = await h.svc.open(h.actor, {}, h.req);
    const r1 = await h.svc.send(h.actor, c.data.id, { text: 'I paid and got nothing' }, h.req);
    expect(r1.data.needsHuman).toBe(true);
    const r2 = await h.svc.send(h.actor, c.data.id, { text: 'thanks' }, h.req);
    expect(r2.data.needsHuman).toBe(true);
    expect(h.convos[0].topic).toBe('payment not credited');
  });

  it('still answers, with a holding line, when the assistant is not configured', async () => {
    const h = harness({ assistant: { configured: false, answer: new SupportAssistant().answer.bind(Object.assign(new SupportAssistant(), { apiKey: '' })) } });
    const c = await h.svc.open(h.actor, {}, h.req);
    const r = await h.svc.send(h.actor, c.data.id, { text: 'hello?' }, h.req);
    expect(r.data.messages[1].text).toContain("can't reach the assistant");
    expect(r.data.needsHuman).toBe(true);
  });

  it('closing mails the transcript once and refuses further messages', async () => {
    const h = harness();
    const c = await h.svc.open(h.actor, {}, h.req);
    await h.svc.send(h.actor, c.data.id, { text: 'how do I buy credits?' }, h.req);
    const closed = await h.svc.close(h.actor, c.data.id, {});
    expect(closed.data.status).toBe('CLOSED');
    expect(closed.data.transcriptSentAt).not.toBeNull();
    expect(h.mailer.send).toHaveBeenCalledOnce();
    const mail = (h.mailer.send.mock.calls[0] as unknown[])[0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe('p@x.test');
    expect(mail.subject).toContain('buying credits');
    expect(mail.text).toContain('how do I buy credits?');
    expect(mail.text).toContain('Credits → Add credits.');
    expect(mail.text).not.toContain("I'm the AnyStudio assistant");

    await h.svc.close(h.actor, c.data.id, {});
    expect(h.mailer.send).toHaveBeenCalledOnce();
    await expect(h.svc.send(h.actor, c.data.id, { text: 'one more' }, h.req)).rejects.toThrow(/closed/);
  });

  it('does not mail a chat nobody said anything in', async () => {
    const h = harness();
    const c = await h.svc.open(h.actor, {}, h.req);
    await h.svc.close(h.actor, c.data.id, {});
    expect(h.mailer.send).not.toHaveBeenCalled();
  });

  it('a staff reply lands in the thread, rings the bell, and the assistant sees it as the team', async () => {
    const h = harness();
    const c = await h.svc.open(h.actor, {}, h.req);
    await h.svc.staffReply(h.staff, c.data.id, { text: 'Hi Pat, I have added the credits.' }, h.req);
    expect(h.notifications.notify).toHaveBeenCalledWith('u1', expect.objectContaining({ kind: 'SYSTEM', href: `/today?support=${c.data.id}` }));
    expect(h.convos[0].staffJoinedAt).toBeInstanceOf(Date);
    await h.svc.send(h.actor, c.data.id, { text: 'thank you!' }, h.req);
    const turns = (h.assistant.answer.mock.calls[0] as unknown[])[0] as Array<{ role: string; text: string }>;
    expect(turns[0]).toEqual({ role: 'assistant', text: '[A member of the AnyStudio team wrote:] Hi Pat, I have added the credits.' });
  });

  it('a person cannot read another person\'s chat', async () => {
    const h = harness();
    const c = await h.svc.open(h.actor, {}, h.req);
    const other = { ...(h.actor as object), userId: 'u2' } as never;
    await expect(h.svc.one(other, c.data.id)).rejects.toThrow(/not found/);
  });
});
