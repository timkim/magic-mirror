import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  OAUTH_KV: KVNamespace;
  RELAY: DurableObjectNamespace<import('./relay').Relay>;
  /** The owner's key: approves claude.ai's access and pairs Magic Mirror tabs. A Worker secret. */
  OWNER_KEY: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Compare secrets without leaking how much matched (hash both, then compare in constant time). */
export async function sameSecret(a: string, b: string) {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export const relay = (env: Env) => env.RELAY.get(env.RELAY.idFromName('owner'));
