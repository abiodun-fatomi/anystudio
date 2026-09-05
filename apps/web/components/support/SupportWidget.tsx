'use client';
/**
 * Help & support — the floater in the corner of every signed-in page.
 *
 * Closed, it is a launcher. Open, it is a small chat: a home with the
 * questions people actually ask and their previous chats, or the open
 * conversation with the assistant (and, when they step in, the team). Ending
 * a chat mails the transcript, and the panel says so.
 *
 * State lives here, not in the URL: the panel survives navigation because the
 * shell mounts it once. `?support=<id>` (from a bell notification) opens it.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { api, ApiError, type SupportConversation, type SupportHistoryRow, type SupportMessage } from '@/lib/api';
import { useApp } from '@/lib/app-context';
import { Button } from '@/components/ui';
import { cx } from '@/lib/cx';
import styles from './SupportWidget.module.css';

const SEEN_KEY = 'anystudio:help-seen';
const POLL_MS = 6000;

/** A conversation the widget can draw: an id, a status and a list of messages. */
function isConversation(c: unknown): c is SupportConversation {
  return Boolean(c) && typeof c === 'object' && typeof (c as SupportConversation).id === 'string' && Array.isArray((c as SupportConversation).messages);
}

const TOPICS: Array<{ id: string; title: string; hint: string; prompt: string; icon: 'credits' | 'whatsapp' | 'brand' | 'publish' | 'bug' }> = [
  {
    id: 'credits',
    title: 'Credits & payments',
    hint: 'Buying, balances, a payment that did not land',
    prompt: 'I have a question about credits or a payment.',
    icon: 'credits',
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    hint: 'Linking a number, sending photos, what comes back',
    prompt: 'How does the WhatsApp side work?',
    icon: 'whatsapp',
  },
  {
    id: 'brand',
    title: 'Brand kit & studio',
    hint: 'Logo, colours, sizes, getting a better result',
    prompt: 'I need help with the studio or my brand kit.',
    icon: 'brand',
  },
  { id: 'publish', title: 'Publishing', hint: 'Instagram, TikTok, scheduling', prompt: 'I need help with publishing.', icon: 'publish' },
  { id: 'bug', title: 'Something went wrong', hint: 'An error, a failed generation, a stuck screen', prompt: 'Something went wrong: ', icon: 'bug' },
];

const G = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z" />
      <path d="M9 11h6M9 14h3" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  minus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.8 5.6L19.5 9.4l-5.7 1.8L12 17l-1.8-5.8L4.5 9.4l5.7-1.8L12 2Zm7 12l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14Z" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12L20 4l-4 16-4-7-8-3Z" />
    </svg>
  ),
  arrow: (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12l5 5L20 6" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l10 18H2L12 3Z" />
      <path d="M12 10v5M12 18h.01" />
    </svg>
  ),
  credits: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" />
    </svg>
  ),
  whatsapp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" />
      <path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 1a4 4 0 0 1-2-2l1-1-1-2L9 9.5Z" />
    </svg>
  ),
  brand: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  publish: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4M6 10l6-6 6 6" />
      <path d="M4 20h16" />
    </svg>
  ),
  bug: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  ),
};

const fmtTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (iso: string): string => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

type Mode = 'home' | 'chat' | 'confirm' | 'ended';

export function SupportWidget() {
  const { me, workspace } = useApp();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [mode, setMode] = useState<Mode>('home');
  const [convo, setConvo] = useState<SupportConversation | null>(null);
  const [history, setHistory] = useState<SupportHistoryRow[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unseenStaff, setUnseenStaff] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastSeenCount = useRef(0);

  // First visit: the launcher breathes until it has been opened once.
  useEffect(() => {
    try {
      setFresh(!localStorage.getItem(SEEN_KEY));
    } catch {
      /* fine */
    }
  }, []);

  // Whatever is already open follows the person across pages and reloads.
  useEffect(() => {
    let live = true;
    api.support
      .current()
      .then((c) => {
        if (!live) return;
        // An API without the help chat yet answers with something else
        // entirely; only a real conversation opens the panel.
        if (isConversation(c)) {
          setConvo(c);
          setMode('chat');
          lastSeenCount.current = c.messages.length;
        }
      })
      .catch(() => {
        /* the home still works */
      });
    return () => {
      live = false;
    };
  }, []);

  // A bell notification links here with ?support=<id>.
  const wanted = params.get('support');
  useEffect(() => {
    if (!wanted) return;
    api.support
      .one(wanted)
      .then((c) => {
        if (!isConversation(c)) return setOpen(true);
        setConvo(c);
        setMode(c.status === 'OPEN' ? 'chat' : 'ended');
        setOpen(true);
      })
      .catch(() => setOpen(true));
  }, [wanted]);

  // Staff replies arrive while the chat is open: poll gently, only while the tab is visible.
  useEffect(() => {
    if (!convo || convo.status !== 'OPEN' || thinking) return;
    const id = convo.id;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const c = await api.support.one(id);
        if (!isConversation(c)) return;
        setConvo((cur) => (cur && cur.id === c.id && c.messages.length !== cur.messages.length ? c : cur?.status !== c.status ? c : cur));
        if (!open && c.messages.length > lastSeenCount.current && c.messages.some((m, i) => i >= lastSeenCount.current && m.role === 'STAFF'))
          setUnseenStaff(true);
      } catch {
        /* next tick */
      }
    };
    const t = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(t);
  }, [convo, open, thinking]);

  // Closed from the console (or by the sweeper) while the panel was open: say so rather than let the next message bounce.
  useEffect(() => {
    if (convo?.status === 'CLOSED' && (mode === 'chat' || mode === 'confirm')) setMode('ended');
  }, [convo, mode]);

  const scrollDown = useCallback(() => {
    const el = bodyRef.current;
    if (el)
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
  }, []);
  useEffect(() => {
    if (open && mode === 'chat') {
      scrollDown();
      lastSeenCount.current = convo?.messages.length ?? 0;
      setUnseenStaff(false);
    }
  }, [open, mode, convo, scrollDown, thinking]);

  const show = () => {
    setOpen(true);
    setLeaving(false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* fine */
    }
    setFresh(false);
    if (mode === 'home')
      api.support
        .history()
        .then(setHistory)
        .catch(() => {
          /* optional */
        });
    setTimeout(() => inputRef.current?.focus(), 350);
  };
  const hide = useCallback(() => {
    setLeaving(true);
    setTimeout(() => {
      setOpen(false);
      setLeaving(false);
    }, 200);
  }, []);
  const toggle = () => (open ? hide() : show());

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hide]);

  async function start(prefill?: string) {
    setError(null);
    try {
      const c = await api.support.open({ workspaceId: workspace?.id, page: pathname });
      setConvo(c);
      setMode('chat');
      lastSeenCount.current = c.messages.length;
      if (prefill && !prefill.endsWith(' ')) await sendText(c, prefill);
      else if (prefill) {
        setDraft(prefill);
        setTimeout(() => inputRef.current?.focus(), 50);
      } else setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the chat. Please try again.');
    }
  }

  async function sendText(c: SupportConversation, text: string) {
    const optimistic: SupportMessage = { id: `tmp-${Date.now()}`, role: 'USER', text, who: null, createdAt: new Date().toISOString() };
    setConvo({ ...c, messages: [...c.messages, optimistic] });
    setThinking(true);
    setError(null);
    scrollDown();
    try {
      const r = await api.support.send(c.id, text, pathname);
      setConvo((cur) =>
        cur ? { ...cur, needsHuman: r.needsHuman || cur.needsHuman, messages: [...cur.messages.filter((m) => m.id !== optimistic.id), ...r.messages] } : cur,
      );
    } catch (e) {
      setConvo((cur) => (cur ? { ...cur, messages: cur.messages.filter((m) => m.id !== optimistic.id) } : cur));
      setDraft(text);
      setError(
        e instanceof ApiError
          ? e.status === 429
            ? 'Slow down a little — try again in a minute.'
            : e.message
          : 'Could not send that. Check your connection and try again.',
      );
    } finally {
      setThinking(false);
      scrollDown();
    }
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !convo || thinking) return;
    setDraft('');
    void sendText(convo, text);
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }
  function grow(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  async function end() {
    if (!convo) return;
    try {
      const c = await api.support.close(convo.id, true);
      setConvo(c);
      setMode('ended');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not end the chat.');
      setMode('chat');
    }
  }
  function reset() {
    setConvo(null);
    setMode('home');
    setDraft('');
    setError(null);
    api.support
      .history()
      .then(setHistory)
      .catch(() => {
        /* optional */
      });
  }

  const first = me?.user.name?.trim().split(/\s+/)[0] ?? null;
  const said = convo?.messages.filter((m) => m.role !== 'SYSTEM').length ?? 0;
  const staffIn = Boolean(convo?.staffJoined);

  return (
    <>
      {open && (
        <section className={styles.panel} data-leaving={leaving} role="dialog" aria-label="Help and support" aria-modal="false">
          <header className={styles.head}>
            <div className={styles.orb} aria-hidden="true">
              {G.spark}
            </div>
            <div className={styles.headText}>
              <div className={styles.title}>{mode === 'home' ? 'Help' : staffIn ? 'AnyStudio team' : 'AnyStudio assistant'}</div>
              <div className={styles.status}>
                <span className={styles.live} data-tone={convo?.needsHuman && !staffIn ? 'warn' : undefined} aria-hidden="true" />
                {mode === 'home'
                  ? 'Answers in seconds · a person when it matters'
                  : staffIn
                    ? 'A member of the team is in this chat'
                    : convo?.needsHuman
                      ? 'Flagged for the team · keep writing here'
                      : 'Usually instant'}
              </div>
            </div>
            <div className={styles.headActions}>
              {mode === 'chat' && said > 0 && (
                <button type="button" className={styles.iconBtn} onClick={() => setMode('confirm')} aria-label="End chat" title="End chat">
                  {G.close}
                </button>
              )}
              <button type="button" className={styles.iconBtn} onClick={hide} aria-label="Minimise" title="Minimise">
                {G.minus}
              </button>
            </div>
          </header>

          <div className={styles.body} ref={bodyRef}>
            {mode === 'home' && (
              <div className={styles.home}>
                <div className={styles.hello}>
                  {first ? `Hi ${first}.` : 'Hi.'}
                  <br />
                  What can we help with?
                </div>
                <p className={styles.helloSub}>Pick one, or just start typing below.</p>
                <div className={styles.topics}>
                  {TOPICS.map((t) => (
                    <button key={t.id} type="button" className={styles.topic} onClick={() => void start(t.prompt)}>
                      <span className={styles.topicIcon}>{G[t.icon]}</span>
                      <span className={styles.topicText}>
                        <b>{t.title}</b>
                        <span>{t.hint}</span>
                      </span>
                      <span className={styles.arrow}>{G.arrow}</span>
                    </button>
                  ))}
                </div>
                {history.length > 0 && (
                  <div className={styles.prev}>
                    <div className={styles.prevHead}>Previous chats</div>
                    {history.slice(0, 4).map((h) => (
                      <div key={h.id} className={styles.prevRow}>
                        <span>{h.topic ?? 'Help chat'}</span>
                        <span>{fmtDay(h.closedAt ?? h.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {error && (
                  <div className={styles.notice}>
                    {G.warn}
                    <span>{error}</span>
                  </div>
                )}
              </div>
            )}

            {(mode === 'chat' || mode === 'confirm') && convo && (
              <>
                <div className={styles.day}>{fmtDay(convo.createdAt)}</div>
                {convo.messages.map((m) => (
                  <div key={m.id} className={styles.msg} data-role={m.role}>
                    {m.role !== 'USER' && (
                      <div className={styles.who}>
                        <b>{m.role === 'STAFF' ? (m.who ?? 'AnyStudio') : 'Assistant'}</b>
                        {m.role === 'STAFF' && <span className={styles.staffTag}>Team</span>}
                      </div>
                    )}
                    <div className={styles.bubble}>{m.text}</div>
                    <div className={styles.time}>{fmtTime(m.createdAt)}</div>
                  </div>
                ))}
                {thinking && (
                  <div className={styles.typing} aria-label="Assistant is typing">
                    <i />
                    <i />
                    <i />
                  </div>
                )}
                {convo.needsHuman && !staffIn && !thinking && (
                  <div className={styles.notice}>
                    {G.warn}
                    <span>This is with the team now. They will reply here and by email — you can keep writing in the meantime.</span>
                  </div>
                )}
                {error && (
                  <div className={styles.notice}>
                    {G.warn}
                    <span>{error}</span>
                  </div>
                )}
                {mode === 'confirm' && (
                  <div className={styles.sheet}>
                    <h3>End this chat?</h3>
                    <p>A copy of the conversation goes to {me?.user.email ?? 'your email'}. You can start a new chat any time.</p>
                    <div className={styles.sheetRow}>
                      <Button variant="ghost" size="sm" onClick={() => setMode('chat')}>
                        Keep chatting
                      </Button>
                      <Button size="sm" onClick={() => void end()}>
                        End &amp; email me a copy
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}

            {mode === 'ended' && (
              <div className={styles.ended}>
                <div className={styles.check}>{G.check}</div>
                <h3>Chat ended</h3>
                <p>
                  {convo?.transcriptSentAt ? `A copy is on its way to ${me?.user.email ?? 'your email'}.` : 'Nothing to send — the chat was empty.'}
                  {convo?.needsHuman ? ' The team has it too and will follow up.' : ''}
                </p>
                <Button size="sm" onClick={reset}>
                  Start another chat
                </Button>
              </div>
            )}
          </div>

          {mode !== 'ended' && mode !== 'confirm' && (
            <form className={styles.foot} onSubmit={submit}>
              <div className={styles.composer}>
                <textarea
                  ref={inputRef}
                  className={styles.input}
                  rows={1}
                  value={draft}
                  placeholder={mode === 'home' ? 'Or type your question…' : 'Write a message…'}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    grow(e.target);
                  }}
                  onKeyDown={
                    mode === 'chat'
                      ? onKey
                      : (e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (draft.trim()) void start(draft.trim());
                          }
                        }
                  }
                  aria-label="Your message"
                  maxLength={4000}
                />
                <button
                  type={mode === 'chat' ? 'submit' : 'button'}
                  className={styles.send}
                  disabled={!draft.trim() || thinking}
                  aria-label="Send"
                  onClick={
                    mode === 'chat'
                      ? undefined
                      : () => {
                          if (draft.trim()) {
                            const t = draft.trim();
                            setDraft('');
                            void start(t);
                          }
                        }
                  }
                >
                  {G.send}
                </button>
              </div>
              {mode === 'chat' ? (
                <div className={styles.end}>
                  <span>Enter to send · Shift+Enter for a new line</span>
                  {said > 0 && (
                    <button type="button" className={styles.linkBtn} onClick={() => setMode('confirm')}>
                      End chat
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.hint}>Answers come from our assistant; a person steps in when it matters.</div>
              )}
            </form>
          )}
        </section>
      )}

      <button
        type="button"
        className={cx(styles.launcher)}
        data-open={open}
        data-fresh={fresh && !open}
        onClick={toggle}
        aria-label={open ? 'Close help' : 'Help and support'}
        aria-expanded={open}
      >
        <span className={styles.glyphChat}>{G.chat}</span>
        <span className={styles.glyphClose}>{G.close}</span>
        {!open && unseenStaff && <span className={styles.dot} aria-label="New reply from the team" />}
      </button>
    </>
  );
}
