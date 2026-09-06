/** "/careers/<slug>" — one opening and the application form. */
import { apiGet, esc, marketingPage, prose } from '@/lib/marketing-page';
import { CAREERS_STYLE, TYPE_WORDS, type Opening } from '../shared';

export const dynamic = 'force-dynamic';

const APPLY_SCRIPT = `
(function(){
  var form = document.getElementById('applyForm'); if (!form) return;
  var fileInput = form.querySelector('input[type=file]'), nameEl = form.querySelector('.file .name'), err = form.querySelector('.err'), btn = form.querySelector('button[type=submit]');
  var cv = null;
  fileInput.addEventListener('change', function(){
    var f = fileInput.files && fileInput.files[0]; cv = null; nameEl.textContent = '';
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { fail('That file is over 8 MB.'); fileInput.value = ''; return; }
    var okTypes = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (okTypes.indexOf(f.type) < 0) { fail('PDF or Word, please.'); fileInput.value = ''; return; }
    cv = f; nameEl.textContent = f.name + ' · ' + Math.round(f.size / 1024) + ' KB'; form.removeAttribute('data-error');
  });
  function fail(msg){ err.textContent = msg; form.setAttribute('data-error',''); btn.disabled = false; btn.textContent = 'Send application'; }
  form.addEventListener('submit', async function(e){
    e.preventDefault(); form.removeAttribute('data-error');
    var data = new FormData(form);
    var body = { slug: form.dataset.slug, name: (data.get('name')||'').toString().trim(), email: (data.get('email')||'').toString().trim(), phone: (data.get('phone')||'').toString().trim(), links: (data.get('links')||'').toString().trim(), coverNote: (data.get('coverNote')||'').toString().trim(), website: (data.get('website')||'').toString() };
    if (body.name.length < 2) return fail('Your name, please.');
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(body.email)) return fail('That email does not look right.');
    if (!cv && !body.links) return fail('Attach a CV, or give at least one link.');
    btn.disabled = true; btn.textContent = cv ? 'Uploading CV…' : 'Sending…';
    try {
      if (cv) {
        var pre = await fetch('/api/v1/careers/cv-upload', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ filename: cv.name, mime: cv.type, bytes: cv.size }) });
        var pj = await pre.json(); if (!pre.ok) throw new Error((pj && pj.message) || 'upload refused');
        var put = await fetch(pj.data.url, { method: 'PUT', headers: pj.data.headers, body: cv });
        if (!put.ok) throw new Error('The CV did not upload. Try again.');
        body.cvKey = pj.data.key; body.cvName = cv.name;
        btn.textContent = 'Sending…';
      }
      var res = await fetch('/api/v1/careers/apply', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      var rj = await res.json().catch(function(){ return {}; });
      if (!res.ok) throw new Error((rj && rj.message) || 'Something went wrong.');
      form.setAttribute('data-done','');
    } catch (ex) { fail(ex && ex.message ? ex.message : 'Something went wrong. Try again in a moment.'); }
  });
})();`;

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const job = /^[a-z0-9-]{3,80}$/.test(slug) ? await apiGet<Opening>(req, `/careers/jobs/${slug}`) : null;
  if (!job) {
    const body = `<section class="sec lead cr-hero"><div class="wrap"><a class="cr-back" href="/careers">← All openings</a><h1>That opening is closed.</h1><p>It may have been filled, or the link is old. The roles we are hiring for right now are on the careers page.</p><div class="hero-actions"><a class="btn btn-primary" href="/careers">See open roles</a></div></div></section>`;
    const res = marketingPage({ path: '/careers', title: 'Opening closed — AnyStudio', description: 'That opening is closed.' }, body, {
      style: CAREERS_STYLE,
    });
    return new Response(await res.text(), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const body = `
<section class="sec lead cr-hero" id="top">
  <div class="wrap">
    <a class="cr-back" href="/careers">← All openings</a>
    <div class="cr-eyebrow">${esc(job.team)}</div>
    <h1>${esc(job.title)}</h1>
    <p>${esc(job.summary)}</p>
    <div class="cr-meta" style="margin-top:16px"><span>${esc(job.location)}${job.remote ? ' · remote ok' : ''}</span><span>${TYPE_WORDS[job.type] ?? job.type}</span><span>${esc(job.salary ?? 'Compensation discussed at offer')}</span></div>
  </div>
</section>
<section class="sec" style="border-top:0;padding-top:0">
  <div class="wrap cr-open">
    <div class="cr-body">${prose(job.description)}</div>
    <form class="cr-form" id="applyForm" data-slug="${esc(job.slug)}" novalidate>
      <div class="fields">
        <h2>Apply</h2>
        <p class="lede">A person reads every application and replies within two weeks, either way.</p>
        <label>Your name<input name="name" autocomplete="name" required maxlength="120"></label>
        <label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <label>Phone <small>optional</small><input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
        <label>Links <small>portfolio, LinkedIn, GitHub — one per line</small><textarea name="links" maxlength="1000" style="min-height:70px"></textarea></label>
        <label>A few lines about you <small>what you have built, what you want to build here</small><textarea name="coverNote" maxlength="3000"></textarea></label>
        <label>CV <small>PDF or Word, up to 8 MB — or just links</small>
          <span class="file"><label class="pick"><input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document">Choose a file</label><span class="name"></span></span>
        </label>
        <label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
        <span class="err" role="alert"></span>
        <button class="btn btn-primary btn-lg" type="submit" style="justify-content:center">Send application</button>
      </div>
      <div class="done"><b>Thank you — it is in.</b><span>A confirmation is on its way to your email. We reply within two weeks.</span></div>
    </form>
  </div>
</section>`;
  return marketingPage(
    {
      path: `/careers/${job.slug}`,
      title: `${job.title} — Careers at AnyStudio`,
      ogTitle: `${job.title} · ${job.team} · AnyStudio`,
      description: job.summary,
    },
    body,
    { style: CAREERS_STYLE, script: APPLY_SCRIPT },
  );
}
