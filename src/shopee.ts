/**
 * Shopee URL handling and page classification. Pure functions, unit-tested in test/main.test.ts.
 *
 * Measured 2026-11-20 against shopee.vn (see README "Why it works this way"):
 * - Without a logged-in session every product page, desktop or mobile, headless or headed, local or
 *   residential VN IP, ends on `/verify/traffic/error?is_logged_in=false` and the product API
 *   (`/api/v4/pdp/get_pc`) answers `error: 90309999`.
 * - With a session loaded into a fresh headed Chrome the product renders in full, also through an
 *   Apify residential VN proxy (a different IP from the one that logged in).
 * - Headless with the same session is refused (`is_logged_in=true`, 90309999) or never calls the
 *   product API. So the browser runs headed (Xvfb on the platform).
 */

/** Shopee storefronts and the proxy country that matches each. */
const COUNTRY_BY_HOST: Record<string, string> = {
    'shopee.vn': 'VN',
    'shopee.co.th': 'TH',
    'shopee.sg': 'SG',
    'shopee.com.my': 'MY',
    'shopee.ph': 'PH',
    'shopee.co.id': 'ID',
    'shopee.tw': 'TW',
    'shopee.com.br': 'BR',
};

/** The product API answers this when the visitor must log in (or is treated as a bot). */
export const LOGIN_REQUIRED_CODE = 90309999;

/** `shopee.vn` for `https://www.shopee.vn/...`, or null when the URL is not a Shopee storefront. */
export function shopeeHost(url: string): string | null {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
    host = host.replace(/^(www|m)\./, '');
    return host in COUNTRY_BY_HOST ? host : null;
}

export function proxyCountryForHost(host: string): string {
    return COUNTRY_BY_HOST[host] ?? 'VN';
}

/** Apify proxy session ids allow `[a-zA-Z0-9_.~]`, up to 50 chars. One per storefront = one account = one IP. */
export function accountProxySession(host: string): string {
    return `shopee_${host.replace(/\W/g, '_')}`;
}

/** Desktop and mobile hosts serve the same page; the session cookies are set on the bare host. */
export function normalizeShopeeUrl(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^(www|m)\./, '');
    return parsed.toString();
}

/** Product pages: `/<slug>-i.<shopId>.<itemId>` or `/product/<shopId>/<itemId>`. */
export function isProductUrl(url: string): boolean {
    try {
        const { pathname } = new URL(url);
        return /-i\.\d+\.\d+\/?$/.test(pathname) || /^\/product\/\d+\/\d+\/?$/.test(pathname);
    } catch {
        return false;
    }
}

/** The product-detail API the page calls: get_pc on desktop, get_rw on mobile. */
export function isProductApiUrl(url: string): boolean {
    return /\/api\/v4\/pdp\/get_(pc|rw)\b/.test(url);
}

export type PageVerdict =
    /** The page Shopee meant to show (product, shop, search, or its own "product not found"). */
    | { kind: 'ok' }
    /** Not logged in: the session is missing, expired or was logged out. Retrying cannot help. */
    | { kind: 'login_required' }
    /**
     * Shopee's anti-bot check on the account (`/verify/captcha`, `/verify/traffic?anti_bot_tracking_id=`):
     * a slider puzzle a person must solve. It follows the session to every IP, so switching IP
     * cannot help and only adds suspicion (measured 2026-11-20).
     */
    | { kind: 'challenge'; reason: string }
    /** Logged in but refused without a challenge (e.g. headless Chrome). */
    | { kind: 'blocked'; reason: string };

/**
 * Judge where the browser ended up. `apiCode` is the product API's `error` field, or null when it
 * was not seen (non-product page, or the API never answered).
 */
export function classifyPage(finalUrl: string, apiCode: number | null, hasSessionCookie: boolean): PageVerdict {
    let parsed: URL | null = null;
    try {
        parsed = new URL(finalUrl);
    } catch {
        /* keep null */
    }
    const path = parsed?.pathname ?? '';

    if (path.startsWith('/buyer/login')) return { kind: 'login_required' };
    if (
        path.startsWith('/verify/captcha') ||
        (path.startsWith('/verify/') && parsed?.searchParams.has('anti_bot_tracking_id'))
    ) {
        return { kind: 'challenge', reason: `Shopee anti-bot check ${path}` };
    }
    if (path.startsWith('/verify/')) {
        // Shopee's own flag says whether it saw a login; fall back to whether we sent one.
        const flag = parsed?.searchParams.get('is_logged_in');
        const loggedIn = flag === null ? hasSessionCookie : flag === 'true';
        if (!loggedIn) return { kind: 'login_required' };
        return { kind: 'blocked', reason: `Shopee verification page ${path}` };
    }
    if (apiCode === LOGIN_REQUIRED_CODE) {
        return hasSessionCookie
            ? { kind: 'blocked', reason: `product API error ${LOGIN_REQUIRED_CODE} while logged in` }
            : { kind: 'login_required' };
    }
    return { kind: 'ok' };
}
