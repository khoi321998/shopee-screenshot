/**
 * The Shopee login session: the cookies of a browser someone logged in to by hand
 * (`npm run login`). Shopee shows product pages only to logged-in visitors, so every capture loads
 * these cookies first.
 *
 * Kept in a named key-value store (private to the account), one record per storefront host:
 * locally `storage/key_value_stores/<store>/session-shopee.vn.json`, on the platform the named store
 * of the same name. The record is a secret (it logs in as the account): never log its content.
 */
import { Actor } from 'apify';

export const SESSION_STORE = process.env.SHOPEE_SESSION_STORE ?? 'shopee-session';

/** The cookie shape Playwright's `storageState()` / `addCookies()` use. */
export interface SessionCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
}

export interface ShopeeSession {
    cookies: SessionCookie[];
    /** ISO time of the manual login, for "how long do sessions last" questions. */
    loggedInAt?: string;
    /** ISO time the cookies were last written back after a successful capture. */
    refreshedAt?: string;
}

/** Shopee's login token cookie; without it the session cannot be logged in. */
export const LOGIN_COOKIE = 'SPC_ST';

export function sessionKey(host: string): string {
    return `session-${host}`;
}

/**
 * The keys a session may be stored under, in lookup order. Locally the record `session-shopee.vn`
 * is the file `session-shopee.vn.json`; uploading that file through the Apify Console keeps its
 * name as the key, so `session-shopee.vn.json` is accepted too and nobody has to rename the file.
 */
export function sessionKeys(host: string): [string, string] {
    return [sessionKey(host), `${sessionKey(host)}.json`];
}

/** The key each host's session was found under, so the refreshed cookies go back to the same record. */
const foundKeys = new Map<string, string>();

/** A record uploaded with a text content type comes back as a string. */
function parseSession(value: unknown): ShopeeSession | null {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as ShopeeSession;
        } catch {
            return null;
        }
    }
    return (value as ShopeeSession | null) ?? null;
}

export function hasLoginCookie(cookies: { name: string; value: string }[]): boolean {
    return cookies.some((c) => c.name === LOGIN_COOKIE && c.value.length > 0);
}

/** Cookies that belong to `host` (`.shopee.vn`, `shopee.vn`, `banhang.shopee.vn`, ...). */
export function cookiesForHost<T extends { domain: string }>(cookies: T[], host: string): T[] {
    return cookies.filter((c) => {
        const domain = c.domain.replace(/^\./, '');
        return domain === host || domain.endsWith(`.${host}`);
    });
}

export async function loadSession(host: string, options: { forceCloud?: boolean } = {}): Promise<ShopeeSession | null> {
    const store = await Actor.openKeyValueStore(SESSION_STORE, options);
    for (const key of sessionKeys(host)) {
        const session = parseSession(await store.getValue(key));
        if (session) {
            foundKeys.set(host, key);
            return session;
        }
    }
    return null;
}

/** The key `saveSession` writes `host`'s session to: where it was found, else `session-<host>`. */
export function savedSessionKey(host: string): string {
    return foundKeys.get(host) ?? sessionKey(host);
}

export async function saveSession(
    host: string,
    session: ShopeeSession,
    options: { forceCloud?: boolean } = {},
): Promise<void> {
    const store = await Actor.openKeyValueStore(SESSION_STORE, options);
    await store.setValue(savedSessionKey(host), session);
}

/** Names of the Shopee cookies, for logs (never their values). */
export function describeCookies(cookies: { name: string }[]): string {
    return (
        cookies
            .map((c) => c.name)
            .filter((n) => n.startsWith('SPC_'))
            .sort()
            .join(', ') || '(none)'
    );
}
