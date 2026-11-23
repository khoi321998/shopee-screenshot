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
    return store.getValue<ShopeeSession>(sessionKey(host));
}

export async function saveSession(
    host: string,
    session: ShopeeSession,
    options: { forceCloud?: boolean } = {},
): Promise<void> {
    const store = await Actor.openKeyValueStore(SESSION_STORE, options);
    await store.setValue(sessionKey(host), session);
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
