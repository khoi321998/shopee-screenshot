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

/** The storefront's own time zone (its capital's), for the browser's clock. */
const TIME_ZONE_BY_HOST: Record<string, string> = {
    'shopee.vn': 'Asia/Ho_Chi_Minh',
    'shopee.co.th': 'Asia/Bangkok',
    'shopee.sg': 'Asia/Singapore',
    'shopee.com.my': 'Asia/Kuala_Lumpur',
    'shopee.ph': 'Asia/Manila',
    'shopee.co.id': 'Asia/Jakarta',
    'shopee.tw': 'Asia/Taipei',
    'shopee.com.br': 'America/Sao_Paulo',
};

/**
 * The time zone the browser should report for `host`. The platform's containers run on UTC: a
 * browser on a Vietnamese IP saying UTC is one of the marks Shopee's page script holds against a
 * session (see `browserArgs`).
 */
export function timeZoneForHost(host: string): string {
    return TIME_ZONE_BY_HOST[host] ?? 'Asia/Ho_Chi_Minh';
}

/**
 * Chrome flags. On Linux (the platform: Xvfb, no GPU) Chrome otherwise has no WebGL at all;
 * SwiftShader renders it in software, and `reportDesktopGpu` hides that it is SwiftShader. Shopee
 * judges the WebGL renderer: measured 2026-11-25 on a Windows desktop where the shop page passed,
 * turning WebGL off or switching it to SwiftShader got it refused every time (its shop API
 * `rcmd_items` answered 90309999 and the page went to /verify/traffic/error), while a US time zone
 * or a Linux user agent changed nothing. See README "Why it works this way".
 */
export function browserArgs(platform: string, width: number, height: number): string[] {
    const size = `--window-size=${width},${height}`;
    if (platform === 'linux') return [size, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    return ['--disable-gpu', size];
}

export function proxyCountryForHost(host: string): string {
    return COUNTRY_BY_HOST[host] ?? 'VN';
}

/** Apify proxy session ids allow `[a-zA-Z0-9_.~]`, up to 50 chars. One per storefront = one account = one IP. */
export function accountProxySession(host: string): string {
    return `shopee_${host.replace(/\W/g, '_')}`;
}

/**
 * A fresh proxy session id for `host`, for when the residential IP behind the current one is
 * unreachable: Apify then hands out another IP in the same country. `now` keeps it unique.
 */
export function nextAccountProxySession(host: string, now = Date.now()): string {
    return `${accountProxySession(host)}_${now.toString(36)}`;
}

/**
 * The proxy could not reach Shopee at all (the residential IP went offline). Shopee never saw the
 * request, so moving to another IP costs nothing; retrying on the same session id only hit the same
 * dead IP again, ten times in a row (seen on the platform 2026-11-23).
 */
export function isProxyConnectionError(message: string): boolean {
    return /ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|PROXY_AUTH|SOCKS_CONNECTION_FAILED)/.test(message);
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

/** Single-segment paths that are Shopee pages, not shop usernames. */
const RESERVED_PATHS = new Set([
    'search',
    'mall',
    'cart',
    'user',
    'buyer',
    'verify',
    'daily_discover',
    'flash_sale',
    'm',
    'events3',
    'universal-link',
]);

/** Shop pages: `/shop/<shopId>` or `/<username>` (not a category `/<name>-cat.<id>` or a reserved page). */
export function isShopUrl(url: string): boolean {
    let pathname: string;
    try {
        ({ pathname } = new URL(url));
    } catch {
        return false;
    }
    if (isProductUrl(url)) return false;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 2) return segments[0].toLowerCase() === 'shop' && /^\d+$/.test(segments[1]);
    return segments.length === 1 && !RESERVED_PATHS.has(segments[0].toLowerCase()) && !/-cat\./i.test(segments[0]);
}

/** The shop API the page calls for the shop's header (name, rating, ...). */
export function isShopApiUrl(url: string): boolean {
    return /\/api\/v4\/shop\/get_shop_base(_v2)?(\?|$)/.test(url);
}

/**
 * The page kinds whose data API decides the verdict (product → `pdp/get_pc`, shop →
 * `shop/get_shop_base_v2`, measured 2026-11-23), or null for pages judged by their URL only (search).
 */
export type WatchedPage = 'product' | 'shop';

export function watchedPageKind(url: string): WatchedPage | null {
    if (isProductUrl(url)) return 'product';
    if (isShopUrl(url)) return 'shop';
    return null;
}

export function isPageApiUrl(kind: WatchedPage, url: string): boolean {
    return kind === 'product' ? isProductApiUrl(url) : isShopApiUrl(url);
}

export type PageVerdict =
    /** The page Shopee meant to show (product, shop, search, or its own "not found" page). */
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
 * Judge where the browser ended up. `apiCode` is the page API's `error` field (product or shop, see
 * `watchedPageKind`), or null when it was not seen (other page, or the API never answered).
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
            ? { kind: 'blocked', reason: `page API error ${LOGIN_REQUIRED_CODE} while logged in` }
            : { kind: 'login_required' };
    }
    return { kind: 'ok' };
}
