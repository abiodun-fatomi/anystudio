/**
 * Why the bell says 57 and the list says nothing.
 *
 * The count and the list are built from the same table with the same
 * predicate in the same request, so from reading the code they cannot
 * disagree — which means the answer is in the data, not the source. This
 * asks the two questions separately and prints where they part company.
 *
 * Run from the repo root:   node why-57.mjs
 * Prints counts and ids only. No credentials, no notification text.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const line = (s) => process.stdout.write(`${s}\n`);

try {
  // 1. Personal notifications, by user. The bell's count is per user.
  const byUser = await db.notification.groupBy({
    by: ['userId'],
    _count: { _all: true },
    orderBy: { _count: { userId: 'desc' } },
    take: 5,
  });
  line('PERSONAL NOTIFICATIONS, top users by row count');
  if (byUser.length === 0) line('  (none at all — the table is empty)');
  for (const r of byUser) {
    const unread = await db.notification.count({ where: { userId: r.userId, readAt: null } });
    line(`  user ${r.userId.slice(0, 8)}…  rows ${r._count._all}  unread ${unread}`);
  }

  // 2. Platform messages, the other half of the count. A published,
  //    unexpired message counts as unread for anyone with no read row —
  //    including, if the audience is wrong, people who should never see it.
  const now = new Date();
  const pm = await db.platformMessage.findMany({
    where: { publishedAt: { not: null, lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, audience: true, publishedAt: true, _count: { select: { reads: true } } },
    orderBy: { publishedAt: 'desc' },
  });
  line('');
  line(`PLATFORM MESSAGES live right now: ${pm.length}`);
  for (const m of pm.slice(0, 10)) line(`  ${m.id.slice(0, 8)}…  audience ${m.audience}  reads ${m._count.reads}`);
  if (pm.length > 10) line(`  …and ${pm.length - 10} more`);

  // 3. The workspace types a user belongs to decide which platform messages
  //    they are in the audience for. A user in NO workspace matches only
  //    audience ALL — and a user whose membership row is missing entirely
  //    would still be counted by anything that does not check.
  const users = await db.user.count();
  const members = await db.workspaceMember.count();
  line('');
  line(`users ${users}   workspace memberships ${members}`);

  // 4. The newest few, so the shape of what is there is visible.
  const newest = await db.notification.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, userId: true, kind: true, readAt: true, createdAt: true, workspaceId: true },
  });
  line('');
  line('NEWEST PERSONAL ROWS');
  for (const n of newest) {
    line(`  ${n.createdAt.toISOString()}  ${n.kind}  user ${n.userId.slice(0, 8)}…  ws ${n.workspaceId?.slice(0, 8) ?? '—'}  ${n.readAt ? 'read' : 'UNREAD'}`);
  }

  line('');
  line('WHAT TO LOOK FOR');
  line('  · personal rows 0 and live platform messages ≈ 57  → the count is all');
  line('    platform, and the list is dropping them on the audience filter.');
  line('  · personal unread ≈ 57 for your user               → the list query is');
  line('    the problem, not the count.');
  line('  · neither adds to 57                               → the browser is');
  line('    talking to a different API than this database.');
} finally {
  await db.$disconnect();
}
