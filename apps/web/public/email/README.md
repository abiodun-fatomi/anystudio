# Email images

Static images the transactional emails reference, served by the marketing
host at `https://<base>/email/<file>`. The API only links to them when
`MAIL_ASSET_BASE` is set (e.g. `https://anystudio.ai/email`); unset, the
emails send without pictures and lose nothing that matters.

- `welcome-hero.jpg` — 1056×594 (2× of 528×297), under 150 KB. Shown at the
  top of the welcome email.
