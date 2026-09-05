/**
 * What a platform connector must do, and nothing more. Two exist —
 * Instagram (through the Facebook Graph API) and TikTok — and they differ
 * in every detail: how consent is asked for, how long a token lives, how a
 * file gets there. This is the seam that keeps those differences out of the
 * job runner.
 */
import type { PublishFormat, SocialPlatform } from '@prisma/client';

/** A token set as the platform hands it back, before it is encrypted. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** Absolute; null when the platform says the token does not expire. */
  expiresAt: Date | null;
  scopes: string[];
}

/** One account the person may connect, as the platform describes it. */
export interface RemoteAccount {
  externalId: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Instagram: the Facebook Page the account hangs off; posting uses its token. */
  pageId?: string | null;
  /** Instagram: each Page has its own token; this is the one that posts. */
  pageToken?: string | null;
}

export interface PublishInput {
  format: PublishFormat;
  /** A URL the platform can fetch the file from — signed, short-lived. */
  mediaUrl: string;
  mime: string;
  caption: string;
  /** Bytes, for platforms that want the file pushed rather than pulled. */
  bytes: () => Promise<Buffer>;
}

export interface PublishOutcome {
  externalPostId: string;
  externalUrl: string | null;
}

/**
 * Thrown by a connector when the platform said no. `permanent` means
 * retrying will not help (a rejected caption, an unsupported file, a token
 * that is gone); everything else is retried with a growing gap.
 * `reauth` means the account's token is dead and the person must connect
 * again — the account is marked, not just the job.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly reauth = false,
    /** The sentence the customer sees. */
    readonly customer?: string,
  ) {
    super(message);
  }
}

export interface Connector {
  readonly platform: SocialPlatform;
  /** False when this environment has no app credentials for the platform. */
  configured(): boolean;
  /** The consent URL to send the browser to. `state` is opaque and round-trips. */
  authorizeUrl(redirectUri: string, state: string, pkce?: { challenge: string }): string;
  /** Trade the code for tokens and the account(s) behind them. */
  exchange(code: string, redirectUri: string, pkce?: { verifier: string }): Promise<{ tokens: TokenSet; accounts: RemoteAccount[] }>;
  /** A fresh token set from the old one, when the platform supports it. */
  refresh(tokens: TokenSet): Promise<TokenSet>;
  /** Post. The token here is the one that posts (a Page token for Instagram). */
  publish(account: { externalId: string; accessToken: string; pageId?: string | null }, input: PublishInput): Promise<PublishOutcome>;
  /** Which formats this platform takes, so the UI can offer the right ones. */
  formats(): PublishFormat[];
}
