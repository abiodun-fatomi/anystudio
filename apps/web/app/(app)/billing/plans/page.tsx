'use client';
/**
 * Plans and packs, in the workspace's own currency.
 *
 * Every price on this page came from the server for THIS currency; nothing
 * is converted and nothing is typed by the client. Pressing a button asks
 * the API for a checkout and follows the URL it returns — the page never
 * knows an amount, only a code.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/app-context';
import { api, type Catalogue } from '@/lib/api';
import { money, PACK_WORDS, PLAN_WORDS } from '@/lib/billing/money';
import { PageHeader } from '@/components/shell/Page';
import { Badge, Button, EmptyState, SegmentedControl, Skeleton, useToast } from '@/components/ui';
import { Icon } from '@/components/shell/icons';
import styles from './plans.module.css';

export default function PlansPage() {
  const { workspace, balance } = useApp();
  const { toast } = useToast();
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState<string | null>(null);
  const canBuy = ['OWNER', 'ADMIN', 'BILLING'].includes(workspace.role);

  const load = useCallback(async () => {
    try { setCat(await api.billing.catalogue(workspace.id)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load prices.'); }
  }, [workspace.id]);
  useEffect(() => { void load(); }, [load]);

  const buy = async (kind: 'pack' | 'plan', code: string) => {
    setBusy(`${kind}:${code}`);
    try {
      const out = await api.billing.checkout(workspace.id, { kind, code, interval: kind === 'plan' ? interval : undefined });
      try { sessionStorage.setItem(`anystudio:pay:${out.reference}`, out.paymentId); } catch { /* the return page can still look it up */ }
      window.location.assign(out.url);
    } catch (e) {
      setBusy(null);
      toast({ title: 'Could not open the payment page', body: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };

  const yearly = cat?.plans.some((p) => p.year) ?? false;

  return (
    <div className="rise">
      <PageHeader title="Add credits" lede={`Prices in ${cat?.currency ?? workspace.currency}, fixed for this workspace. A plan is the better rate; a pack is for when you need more this month.`} crumbs={[{ label: 'Credits', href: '/billing' }, { label: 'Add credits' }]}
        actions={balance !== null ? <span className="mono" style={{ color: 'var(--muted)' }}>{balance.toLocaleString()} credits now</span> : undefined} />

      {error && <EmptyState title={error} actions={<Button variant="ghost" onClick={() => void load()}>Try again</Button>} />}
      {!error && cat && !cat.available && (
        <div className={styles.notice}><strong>Payments in {cat.currency} are not switched on yet.</strong><span>Message support and we will add credits by hand until they are.</span></div>
      )}
      {!canBuy && <div className={styles.notice}><strong>Only the owner, an admin or the billing contact can buy.</strong><span>Ask them, or ask to be made the billing contact under Settings → Workspace.</span></div>}

      <section className={styles.section} aria-labelledby="plans">
        <div className={styles.sectionHead}>
          <div><h2 id="plans">Plans</h2><p>Credits every month. Unused plan credits roll into the next month for as long as the plan runs.</p></div>
          {yearly && <SegmentedControl label="Billing period" value={interval} onChange={setInterval} items={[{ id: 'month', label: 'Monthly' }, { id: 'year', label: <>Yearly <Badge tone="ok">2 months free</Badge></> }]} />}
        </div>
        <div className={styles.grid}>
          {cat === null ? [0, 1, 2].map((i) => <Skeleton key={i} height={280} />) : cat.plans.map((p) => {
            const offer = interval === 'year' && p.year ? p.year : p.month;
            const words = PLAN_WORDS[p.code] ?? { name: p.code, who: '' };
            const perMonth = interval === 'year' && p.year?.price ? p.year.price / 12 : offer.price;
            return (
              <article key={p.code} className={styles.card} data-current={p.current || undefined} data-featured={p.code === 'business' || undefined}>
                <div className={styles.cardHead}><h3>{words.name}</h3>{p.current && <Badge tone="accent">Your plan</Badge>}{p.code === 'business' && !p.current && <Badge tone="ok">Most chosen</Badge>}</div>
                <p className={styles.who}>{words.who}</p>
                <div className={styles.price}>
                  {offer.price === null ? <span className={styles.na}>Not priced in {cat.currency}</span> : <><strong>{money(perMonth ?? 0, cat.currency)}</strong><span>/month{interval === 'year' ? `, billed ${money(offer.price, cat.currency)} a year` : ''}</span></>}
                </div>
                <ul className={styles.facts}>
                  <li><Icon.check width={16} height={16} /> {p.credits.toLocaleString()} credits {interval === 'year' ? 'a month' : 'every month'}</li>
                  <li><Icon.check width={16} height={16} /> about {Math.floor(p.credits / 10)} branded photos, or {Math.floor(p.credits / 120)} reels</li>
                  <li><Icon.check width={16} height={16} /> cancel any time; the month you paid for stays yours</li>
                </ul>
                <Button full variant={p.code === 'business' ? 'primary' : 'subtle'} disabled={!canBuy || !offer.canBuy || p.current || (cat.subscription !== null && !cat.subscription.cancelAtPeriodEnd)} loading={busy === `plan:${p.code}`} onClick={() => void buy('plan', p.code)}
                  title={!offer.canBuy && cat.available ? 'Not available through this payment provider yet' : undefined}>
                  {p.current ? 'Current plan' : cat.subscription && !cat.subscription.cancelAtPeriodEnd ? 'Cancel your plan first' : `Choose ${words.name}`}
                </Button>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="packs">
        <div className={styles.sectionHead}><div><h2 id="packs">Packs</h2><p>One-time credits that never expire. Good for a launch week or a plan that ran dry.</p></div></div>
        <div className={styles.grid}>
          {cat === null ? [0, 1, 2, 3].map((i) => <Skeleton key={i} height={180} />) : cat.packs.map((k) => (
            <article key={k.code} className={styles.pack}>
              <div className={styles.cardHead}><h3>{k.credits.toLocaleString()} credits</h3></div>
              <p className={styles.who}>{PACK_WORDS[k.code] ?? ''}</p>
              <div className={styles.price}>{k.price === null ? <span className={styles.na}>Not priced in {cat.currency}</span> : <strong>{money(k.price, cat.currency)}</strong>}</div>
              <Button full variant="subtle" disabled={!canBuy || !k.canBuy} loading={busy === `pack:${k.code}`} onClick={() => void buy('pack', k.code)}>Buy</Button>
            </article>
          ))}
        </div>
      </section>

      <p className={styles.fine}>Payments are taken by {cat?.provider === 'PADDLE' ? 'Paddle, our merchant of record, which handles VAT and receipts' : cat?.provider === 'FLUTTERWAVE' ? 'Flutterwave — cards, bank transfer, USSD and mobile money' : 'our payment partner'}. We never see your card. Credits arrive the moment the payment is confirmed; if that ever takes more than a few minutes, the Credits page has the receipt and support has the reference.</p>
    </div>
  );
}
