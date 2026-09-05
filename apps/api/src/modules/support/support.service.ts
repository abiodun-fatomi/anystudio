/**
 * Help & support.
 *
 * One open conversation per person at a time. The assistant answers every
 * message the person sends; staff can write into the same thread from the
 * console, which the person sees on their next poll and in the bell. Closing
 * a conversation (by the person, by staff, or by the sweeper after a quiet
 * day) mails the person a transcript — once, whoever closed it.
 *
 * Story in the logs: support.opened → support.message (who, needsHuman) →
 * support.staff_reply → support.closed (by whom, transcript sent or why not).
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type SupportConversation, type SupportMessage, type SupportRole } from '@prisma/client';
import type { Request } from 'express';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationService } from '../notification/notification.service';
import { Mailer } from '../../utils/mail-service';
import { supportTranscript } from '../../assets/email-templates';
import { ForbiddenError, NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { Helpers } from '../../utils/helpers';
import { assertStaffMutation, type Actor } from '../auth/policy';
import { authLog } from '../auth/auth.log';
import { SupportAssistant, type AssistantTurn } from './support.assistant';
import type { CloseConversationDto, OpenConversationDto, StaffReplyDto, SupportListQueryDto, SupportMessageDto } from './support.dto';

/** A message as the client sees it. */
export interface MessageView {
  id: string;
  role: SupportRole;
  text: string;
  who: string | null;
  createdAt: string;
}
export interface ConversationView {
  id: string;
  status: 'OPEN' | 'CLOSED';
  topic: string | null;
  needsHuman: boolean;
  staffJoined: boolean;
  createdAt: string;
  closedAt: string | null;
  transcriptSentAt: string | null;
  messages: MessageView[];
}

const GREETING = (name: string | null): string =>
  `Hi${name ? ` ${name.split(/\s+/)[0]}` : ''} — I'm the AnyStudio assistant. Ask me anything about the studio, credits, WhatsApp or your account, or tell me what went wrong and I'll help or bring in the team.`;

/** Conversations quiet for this long are closed by the sweeper and the transcript sent. */
const IDLE_CLOSE_MS = 24 * 3600_000;
const STEP_UP_MIN = 30;

@Injectable()
export class SupportService {
  constructor(
    private readonly db: PrismaClient,
    private readonly assistant: SupportAssistant,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationService,
    private readonly mailer: Mailer,
  ) {}

  // ------------------------------------------------------------------ person

  /** The person's open conversation, creating one (with the greeting) if none. */
  async open(actor: Actor, dto: OpenConversationDto, req: Request) {
    const existing = await this.db.supportConversation.findFirst({
      where: { userId: actor.userId, status: 'OPEN' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (existing) return Helpers.successResponse(200, 'OK', this.view(existing));
    const workspaceId = dto.workspaceId && actor.workspaceRoles.has(dto.workspaceId) ? dto.workspaceId : null;
    const user = await this.db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } });
    const row = await this.db.supportConversation.create({
      data: {
        userId: actor.userId,
        workspaceId,
        page: dto.page?.slice(0, 300) ?? null,
        messageCount: 1,
        messages: { create: { role: 'SYSTEM', text: GREETING(user.name) } },
      },
      include: { messages: true },
    });
    logger.info({ conversationId: row.id, userId: actor.userId, workspaceId, page: row.page, ip: req.ip }, 'support.opened');
    return Helpers.successResponse(201, 'OK', this.view(row));
  }

  /** The open conversation if any (the floater's first call), else null. */
  async current(actor: Actor) {
    const row = await this.db.supportConversation.findFirst({
      where: { userId: actor.userId, status: 'OPEN' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return Helpers.successResponse(200, 'OK', row ? this.view(row) : null);
  }

  /** Past conversations, newest first — the "previous chats" list. */
  async history(actor: Actor) {
    const rows = await this.db.supportConversation.findMany({ where: { userId: actor.userId, status: 'CLOSED' }, orderBy: { closedAt: 'desc' }, take: 20 });
    return Helpers.successResponse(
      200,
      'OK',
      rows.map((r) => ({
        id: r.id,
        topic: r.topic,
        createdAt: r.createdAt.toISOString(),
        closedAt: r.closedAt?.toISOString() ?? null,
        messageCount: r.messageCount,
      })),
    );
  }

  async one(actor: Actor, id: string) {
    const row = await this.own(actor, id);
    return Helpers.successResponse(200, 'OK', this.view(row));
  }

  /** The person writes; the assistant answers in the same request. */
  async send(actor: Actor, id: string, dto: SupportMessageDto, req: Request) {
    const convo = await this.own(actor, id);
    if (convo.status !== 'OPEN') throw new ForbiddenError('This chat is closed. Start a new one.');
    const text = dto.text.trim();
    const mine = await this.db.supportMessage.create({ data: { conversationId: id, role: 'USER', text } });
    await this.db.supportConversation.update({
      where: { id },
      data: { messageCount: { increment: 1 }, lastMessageAt: new Date(), ...(dto.page ? { page: dto.page.slice(0, 300) } : {}) },
    });

    // Everything the assistant needs to answer well, none of it secret.
    const [user, workspace] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } }),
      convo.workspaceId
        ? this.db.workspace.findUnique({ where: { id: convo.workspaceId }, select: { name: true, type: true, wallet: { select: { id: true } } } })
        : null,
    ]);
    let balance: number | null = null;
    if (workspace?.wallet) balance = await this.ledger.balance(workspace.wallet.id).catch(() => null);
    const turns: AssistantTurn[] = [...convo.messages, mine]
      .filter((m) => m.role !== 'SYSTEM')
      .map((m) => ({
        role: m.role === 'USER' ? 'user' : 'assistant',
        text: m.role === 'STAFF' ? `[A member of the AnyStudio team wrote:] ${m.text}` : m.text,
      }));

    const answer = await this.assistant.answer(
      turns,
      { userName: user.name, workspace: workspace ? { name: workspace.name, type: workspace.type, balance } : null, page: dto.page ?? convo.page },
      id,
    );
    const reply = await this.db.supportMessage.create({
      data: { conversationId: id, role: 'ASSISTANT', text: answer.reply, meta: answer.meta as Prisma.InputJsonValue },
    });
    const becameHuman = answer.needsHuman && !convo.needsHuman;
    await this.db.supportConversation.update({
      where: { id },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: new Date(),
        ...(answer.needsHuman ? { needsHuman: true } : {}),
        ...(convo.topic ? {} : { topic: answer.topic }),
      },
    });
    logger.info(
      {
        conversationId: id,
        userId: actor.userId,
        chars: text.length,
        needsHuman: answer.needsHuman,
        escalated: becameHuman,
        fallback: answer.meta.fallback ?? null,
        ip: req.ip,
      },
      'support.message',
    );
    return Helpers.successResponse(200, 'OK', { messages: [this.msg(mine), this.msg(reply)], needsHuman: answer.needsHuman || convo.needsHuman });
  }

  /** The person ends the chat. */
  async close(actor: Actor, id: string, dto: CloseConversationDto) {
    const convo = await this.own(actor, id);
    if (convo.status !== 'OPEN') return Helpers.successResponse(200, 'OK', this.view(convo));
    const closed = await this.finish(id, 'user', dto.email !== false);
    return Helpers.successResponse(200, 'OK', this.view(closed));
  }

  // ------------------------------------------------------------------- staff

  async list(q: SupportListQueryDto) {
    const take = Math.min(q.take ?? 40, 100);
    const where: Prisma.SupportConversationWhereInput = {};
    if (q.filter === 'open' || !q.filter) where.status = 'OPEN';
    else if (q.filter === 'needs_human') {
      where.status = 'OPEN';
      where.needsHuman = true;
    } else if (q.filter === 'closed') where.status = 'CLOSED';
    if (q.q)
      where.OR = [
        { topic: { contains: q.q, mode: 'insensitive' } },
        { user: { email: { contains: q.q, mode: 'insensitive' } } },
        { user: { name: { contains: q.q, mode: 'insensitive' } } },
      ];
    const rows = await this.db.supportConversation.findMany({
      where,
      orderBy: [{ needsHuman: 'desc' }, { lastMessageAt: 'desc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        user: { select: { id: true, name: true, email: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, where: { role: { not: 'SYSTEM' } } },
      },
    });
    const page = rows.slice(0, take);
    const [open, needsHuman] = await Promise.all([
      this.db.supportConversation.count({ where: { status: 'OPEN' } }),
      this.db.supportConversation.count({ where: { status: 'OPEN', needsHuman: true } }),
    ]);
    return Helpers.successResponse(200, 'OK', {
      counts: { open, needsHuman },
      rows: page.map((r) => ({
        id: r.id,
        status: r.status,
        topic: r.topic,
        needsHuman: r.needsHuman,
        staffJoined: Boolean(r.staffJoinedAt),
        page: r.page,
        user: r.user,
        workspaceId: r.workspaceId,
        messageCount: r.messageCount,
        lastMessageAt: r.lastMessageAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        last: r.messages[0] ? { role: r.messages[0].role, text: r.messages[0].text.slice(0, 160) } : null,
      })),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    });
  }

  async staffOne(id: string) {
    const row = await this.db.supportConversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true } },
      },
    });
    if (!row) throw new NotFoundError('Conversation');
    const workspace = row.workspaceId
      ? await this.db.workspace.findUnique({ where: { id: row.workspaceId }, select: { id: true, name: true, type: true } })
      : null;
    return Helpers.successResponse(200, 'OK', {
      ...this.view(row),
      page: row.page,
      user: row.user,
      workspace,
      messagesMeta: row.messages.map((m) => ({ id: m.id, meta: m.meta })),
    });
  }

  /** A staff member writes into the person's chat. */
  async staffReply(actor: Actor, id: string, dto: StaffReplyDto, req: Request) {
    assertStaffMutation(actor, { min: 'SUPPORT', stepUpMinutes: STEP_UP_MIN });
    const convo = await this.db.supportConversation.findUnique({ where: { id } });
    if (!convo) throw new NotFoundError('Conversation');
    if (convo.status !== 'OPEN') throw new ForbiddenError('This chat is closed.');
    const staff = await this.db.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true } });
    const who = staff.name?.split(/\s+/)[0] ?? 'AnyStudio';
    const row = await this.db.supportMessage.create({
      data: { conversationId: id, role: 'STAFF', text: dto.text.trim(), meta: { staffId: actor.userId, name: who } },
    });
    await this.db.supportConversation.update({
      where: { id },
      data: { messageCount: { increment: 1 }, lastMessageAt: new Date(), staffJoinedAt: convo.staffJoinedAt ?? new Date() },
    });
    await this.notifications
      .notify(convo.userId, {
        workspaceId: convo.workspaceId,
        kind: 'SYSTEM',
        title: `${who} from AnyStudio replied in your help chat`,
        body: dto.text.trim().slice(0, 140),
        href: `/today?support=${id}`,
        refId: `support:${id}`,
      })
      .catch((err: unknown) => logger.warn({ err, conversationId: id }, 'support.staff_reply: bell notification failed'));
    authLog('admin.support', 'succeeded', { userId: actor.userId, conversationId: id, target: convo.userId, action: 'reply' }, req);
    logger.info({ conversationId: id, staffId: actor.userId }, 'support.staff_reply');
    return Helpers.successResponse(200, 'OK', this.msg(row));
  }

  async staffClose(actor: Actor, id: string, req: Request) {
    assertStaffMutation(actor, { min: 'SUPPORT', stepUpMinutes: STEP_UP_MIN });
    const convo = await this.db.supportConversation.findUnique({ where: { id } });
    if (!convo) throw new NotFoundError('Conversation');
    const closed =
      convo.status === 'OPEN'
        ? await this.finish(id, `staff:${actor.userId}`, true)
        : await this.db.supportConversation.findUniqueOrThrow({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    authLog('admin.support', 'succeeded', { userId: actor.userId, conversationId: id, target: convo.userId, action: 'close' }, req);
    return Helpers.successResponse(200, 'OK', this.view(closed));
  }

  /** Staff marks it handled (needsHuman off) without closing. */
  async staffResolve(actor: Actor, id: string, req: Request) {
    assertStaffMutation(actor, { min: 'SUPPORT', stepUpMinutes: STEP_UP_MIN });
    const row = await this.db.supportConversation.update({
      where: { id },
      data: { needsHuman: false },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    authLog('admin.support', 'succeeded', { userId: actor.userId, conversationId: id, target: row.userId, action: 'resolve' }, req);
    return Helpers.successResponse(200, 'OK', this.view(row));
  }

  // ----------------------------------------------------------------- sweeper

  /** Close chats nobody has touched for a day. Called from the worker's hourly tick. */
  async sweepIdle(): Promise<number> {
    const stale = await this.db.supportConversation.findMany({
      where: { status: 'OPEN', lastMessageAt: { lt: new Date(Date.now() - IDLE_CLOSE_MS) } },
      select: { id: true },
      take: 200,
    });
    for (const s of stale)
      await this.finish(s.id, 'idle', true).catch((err: unknown) => logger.error({ err, conversationId: s.id }, 'support.sweep: close failed'));
    if (stale.length) logger.info({ count: stale.length }, 'support.sweep: idle chats closed');
    return stale.length;
  }

  // ----------------------------------------------------------------- private

  private async finish(id: string, by: string, email: boolean): Promise<SupportConversation & { messages: SupportMessage[] }> {
    const now = new Date();
    const row = await this.db.supportConversation.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: now, closedBy: by },
      include: { messages: { orderBy: { createdAt: 'asc' } }, user: { select: { email: true, name: true } } },
    });
    let sent: 'sent' | 'skipped' | 'failed' | 'empty' | 'no_email' = 'skipped';
    const said = row.messages.filter((m) => m.role !== 'SYSTEM');
    if (!email) sent = 'skipped';
    else if (said.length === 0) sent = 'empty';
    else if (!row.user.email) sent = 'no_email';
    else {
      try {
        await this.mailer.send(
          supportTranscript(row.user.email, row.user.name, {
            topic: row.topic,
            openedAt: row.createdAt,
            closedAt: now,
            needsHuman: row.needsHuman,
            lines: row.messages.map((m) => ({
              role: m.role,
              text: m.text,
              at: m.createdAt,
              who: m.role === 'STAFF' ? ((m.meta as { name?: string } | null)?.name ?? null) : null,
            })),
          }),
        );
        await this.db.supportConversation.update({ where: { id }, data: { transcriptSentAt: now } });
        row.transcriptSentAt = now;
        sent = 'sent';
      } catch (err) {
        // The chat is closed either way; a mail failure is a mail failure, not a reason to keep it open.
        sent = 'failed';
        logger.error({ err, conversationId: id, userId: row.userId }, 'support.closed: transcript mail failed');
      }
    }
    logger.info({ conversationId: id, userId: row.userId, by, messages: row.messageCount, needsHuman: row.needsHuman, transcript: sent }, 'support.closed');
    return row;
  }

  private async own(actor: Actor, id: string): Promise<SupportConversation & { messages: SupportMessage[] }> {
    const row = await this.db.supportConversation.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!row || row.userId !== actor.userId) throw new NotFoundError('Conversation');
    return row;
  }

  private view(row: SupportConversation & { messages: SupportMessage[] }): ConversationView {
    return {
      id: row.id,
      status: row.status,
      topic: row.topic,
      needsHuman: row.needsHuman,
      staffJoined: Boolean(row.staffJoinedAt),
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      transcriptSentAt: row.transcriptSentAt?.toISOString() ?? null,
      messages: row.messages.map((m) => this.msg(m)),
    };
  }

  private msg(m: SupportMessage): MessageView {
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      who: m.role === 'STAFF' ? ((m.meta as { name?: string } | null)?.name ?? 'AnyStudio') : null,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
