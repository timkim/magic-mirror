// Web Push without a third-party service: VAPID-signed pushes with no payload. The service
// worker (farm page) wakes up, fetches the latest farm status and shows the notification itself,
// so nothing needs encrypting here.

export interface PushSubscriptionJson {
  endpoint: string;
  keys?: { p256dh: string; auth: string };
}

export interface VapidKeys {
  publicKey: string; // uncompressed P-256 point, base64url (what the browser's subscribe() takes)
  privateJwk: JsonWebKey;
}

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { publicKey: b64url(raw), privateJwk };
}

/** The Authorization header for one push service (its origin is the JWT audience). */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto's ECDSA signature is already the raw r||s form JWT's ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** Send an empty push. Returns the push service's status (404/410 = the subscription is gone). */
export async function sendPush(sub: PushSubscriptionJson, keys: VapidKeys, subject: string): Promise<number> {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(sub.endpoint, keys, subject), TTL: String(24 * 3600), Urgency: 'normal', 'Content-Length': '0' },
  });
  return r.status;
}
