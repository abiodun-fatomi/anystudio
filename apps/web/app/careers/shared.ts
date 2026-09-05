/** What the two careers pages share: the shape of an opening and the page-only styles. */
export interface Opening {
  id: string;
  slug: string;
  title: string;
  team: string;
  location: string;
  remote: boolean;
  type: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERNSHIP';
  summary: string;
  description: string;
  salary: string | null;
  publishedAt: string | null;
}

export const TYPE_WORDS: Record<Opening['type'], string> = { FULL_TIME: 'Full time', PART_TIME: 'Part time', CONTRACT: 'Contract', INTERNSHIP: 'Internship' };

export const CAREERS_STYLE = `
.cr-hero{padding-top:clamp(36px,6vw,64px);padding-bottom:clamp(28px,4vw,44px);border-top:0}
.cr-hero h1{margin:0;font-family:var(--f-display);font-size:clamp(36px,6vw,64px);font-weight:800;letter-spacing:-.035em;line-height:1.04;text-wrap:balance;max-width:18ch}
.cr-hero h1 em{font-style:normal;color:var(--accent)}
.cr-hero p{margin-top:18px;font-size:clamp(16.5px,1.9vw,19px);color:var(--ink-soft);max-width:56ch;line-height:1.55}
.cr-eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:var(--f-mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:18px}
.cr-eyebrow::before{content:"";width:18px;height:2px;background:var(--accent)}
.cr-values{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line-soft);border:1px solid var(--line-soft);border-radius:8px;overflow:hidden;margin-top:30px}
@media(max-width:760px){.cr-values{grid-template-columns:1fr}}
.cr-values>div{background:var(--surface-2);padding:20px 22px}
.cr-values b{display:block;font-size:15.5px;margin-bottom:4px}
.cr-values span{color:var(--muted);font-size:14px;line-height:1.5}
.cr-list{display:grid;gap:12px}
.cr-job{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:22px 24px;text-decoration:none;color:inherit;transition:transform .2s,box-shadow .2s,border-color .2s}
.cr-job:hover{transform:translateY(-3px);box-shadow:var(--frame-shadow-lg);border-color:var(--ink);text-decoration:none}
.cr-job h3{margin:0 0 6px;font-size:20px;font-weight:800;letter-spacing:-.02em}
.cr-job p{margin:0 0 10px;color:var(--ink-soft);font-size:15px;line-height:1.5}
.cr-meta{display:flex;gap:8px;flex-wrap:wrap}
.cr-meta span{font-family:var(--f-mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 9px}
.cr-job .go{font-weight:700;color:var(--accent);white-space:nowrap}
.cr-empty{background:var(--surface);border:1px dashed var(--line);border-radius:8px;padding:34px;text-align:center;color:var(--muted);font-size:15.5px}
.cr-empty b{display:block;color:var(--ink);font-size:18px;margin-bottom:6px}
.cr-open{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:clamp(28px,4vw,56px);align-items:start}
@media(max-width:900px){.cr-open{grid-template-columns:1fr}}
.cr-body h3{font-size:18px;font-weight:800;margin:26px 0 8px}
.cr-body p{color:var(--ink-soft);font-size:16px;line-height:1.65;margin:0 0 12px}
.cr-body ul{margin:0 0 12px;padding-left:0;list-style:none;display:grid;gap:8px}
.cr-body li{font-size:15.5px;color:var(--ink-soft);display:flex;gap:10px;align-items:flex-start;line-height:1.5}
.cr-body li::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent);flex:none;margin-top:9px}
.cr-form{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:clamp(20px,3vw,28px);position:sticky;top:84px;display:grid;gap:14px}
.cr-form h2{font-size:22px;font-weight:800;margin:0}
.cr-form .lede{color:var(--muted);font-size:14px;margin:0 0 4px}
.cr-form label{display:grid;gap:6px;font-size:13.5px;font-weight:600}
.cr-form label small{font-weight:400;color:var(--muted)}
.cr-form input,.cr-form textarea{width:100%;box-sizing:border-box;padding:12px 13px;border:1px solid var(--line);border-radius:4px;background:var(--surface-2);color:var(--ink);font:inherit;font-size:15px}
.cr-form textarea{min-height:110px;resize:vertical}
.cr-form input:focus,.cr-form textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.cr-form .file{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cr-form .file input{display:none}
.cr-form .file .pick{border:1px dashed var(--line);border-radius:4px;padding:10px 14px;cursor:pointer;font-weight:600;font-size:14px;background:var(--surface-2)}
.cr-form .file .name{font-size:13px;color:var(--muted)}
.cr-form .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.cr-form .err{color:var(--accent);font-weight:600;font-size:13.5px;display:none}
.cr-form[data-error] .err{display:block}
.cr-form .done{display:none;text-align:center;padding:20px 0}
.cr-form .done b{display:block;font-size:20px;margin-bottom:6px}
.cr-form .done span{color:var(--muted);font-size:14.5px}
.cr-form[data-done] .fields{display:none}
.cr-form[data-done] .done{display:block}
.cr-back{display:block;margin-bottom:18px;color:var(--muted);text-decoration:none;font-size:14px}
.cr-back:hover{color:var(--ink)}
`;
