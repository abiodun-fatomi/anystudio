/** "/careers" — the open roles, read from the API at request time. */
import { apiGet, esc, marketingPage } from '@/lib/marketing-page';
import { CAREERS_STYLE, TYPE_WORDS, type Opening } from './shared';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const jobs = await apiGet<Opening[]>(req, '/careers/jobs');
  // An unreachable API must not publish an empty careers page to the CDN.
  if (jobs === null)
    return new Response('The careers page is briefly unavailable. Try again in a minute.', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '60' },
    });
  const list = jobs.length
    ? `<div class="cr-list">${jobs
        .map(
          (j) => `<a class="cr-job rv" href="/careers/${esc(j.slug)}">
  <div>
    <h3>${esc(j.title)}</h3>
    <p>${esc(j.summary)}</p>
    <div class="cr-meta"><span>${esc(j.team)}</span><span>${esc(j.location)}${j.remote ? ' · remote ok' : ''}</span><span>${TYPE_WORDS[j.type] ?? j.type}</span>${j.salary ? `<span>${esc(j.salary)}</span>` : ''}</div>
  </div>
  <span class="go">Read &amp; apply →</span>
</a>`,
        )
        .join('\n')}</div>`
    : `<div class="cr-empty rv"><b>No openings right now.</b>New roles are posted here first. If you think you belong on the team anyway, write to <a href="mailto:careers@anystudio.ai">careers@anystudio.ai</a> and say what you would build.</div>`;

  const body = `
<section class="sec lead cr-hero" id="top">
  <div class="wrap">
    <div class="cr-eyebrow rv">Careers</div>
    <h1 class="rv">Build the studio <em>every seller</em> can afford.</h1>
    <p class="rv">AnyStudio turns one phone photo into everything a seller posts — for a fabric shop in Lagos, a creator in Nairobi, and the platforms that host ten thousand merchants. Small team, real product, customers who pay in their own currency.</p>
    <div class="cr-values rv">
      <div><b>Ship to people you can name</b><span>Every feature has a seller behind it. We show our work on WhatsApp before we show it in a deck.</span></div>
      <div><b>Infrastructure, not demos</b><span>A real ledger, multi-provider routing, honest failure. The boring parts are the product.</span></div>
      <div><b>Remote by default</b><span>Lagos, Accra, Nairobi, London — overlap a few hours with West Africa and the rest is yours.</span></div>
    </div>
  </div>
</section>
<section class="sec" id="openings">
  <div class="wrap">
    <div class="sec-head rv"><div><h2>Open roles</h2><p class="sec-lede">Every application is read by a person on the team, and answered within two weeks either way.</p></div></div>
    ${list}
  </div>
</section>`;
  return marketingPage(
    {
      path: '/careers',
      title: 'Careers — AnyStudio',
      ogTitle: 'Build the studio every seller can afford.',
      description: 'Open roles at AnyStudio. Remote by default, customers you can name, infrastructure over demos.',
    },
    body,
    { style: CAREERS_STYLE },
  );
}
