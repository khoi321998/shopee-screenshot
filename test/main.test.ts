import { describe, expect, it } from 'vitest';

import { errorCodeOf, taggedMessage } from '../src/dataset.js';
import { buildKey, isPageFilled, MIN_TEXT_LENGTH } from '../src/screenshot.js';
import { cookiesForHost, hasLoginCookie, sessionKey, sessionKeys } from '../src/session.js';
import {
    accountProxySession,
    classifyPage,
    isProductApiUrl,
    isProxyConnectionError,
    isProductUrl,
    isShopApiUrl,
    isShopUrl,
    LOGIN_REQUIRED_CODE,
    nextAccountProxySession,
    normalizeShopeeUrl,
    proxyCountryForHost,
    shopeeHost,
    watchedPageKind,
} from '../src/shopee.js';

const PRODUCT = 'https://shopee.vn/%E1%BB%90p-L%C6%B0ng-Iphone-Silicon-Awifi-X5-1-i.7669738.57555754369';

describe('shopeeHost / normalizeShopeeUrl', () => {
    it('recognises storefronts, with or without www./m.', () => {
        expect(shopeeHost(PRODUCT)).toBe('shopee.vn');
        expect(shopeeHost('https://www.shopee.co.th/x-i.1.2')).toBe('shopee.co.th');
        expect(shopeeHost('https://m.shopee.vn/product/1/2')).toBe('shopee.vn');
    });

    it('rejects other sites and garbage', () => {
        expect(shopeeHost('https://shopee.example.com/x')).toBeNull();
        expect(shopeeHost('https://banhang.shopee.vn/')).toBeNull();
        expect(shopeeHost('not a url')).toBeNull();
    });

    it('drops www./m. so the session cookies apply', () => {
        expect(normalizeShopeeUrl('https://www.shopee.vn/product/1/2?x=1')).toBe('https://shopee.vn/product/1/2?x=1');
    });

    it('maps a storefront to its proxy country', () => {
        expect(proxyCountryForHost('shopee.vn')).toBe('VN');
        expect(proxyCountryForHost('shopee.com.my')).toBe('MY');
    });
});

describe('isProductUrl / isProductApiUrl', () => {
    it('knows both product URL shapes', () => {
        expect(isProductUrl(PRODUCT)).toBe(true);
        expect(isProductUrl('https://shopee.vn/product/7669738/57555754369')).toBe(true);
        expect(isProductUrl('https://shopee.vn/shop/7669738')).toBe(false);
        expect(isProductUrl('https://shopee.vn/search?keyword=x')).toBe(false);
    });

    it('matches the desktop and mobile product APIs only', () => {
        expect(isProductApiUrl('https://shopee.vn/api/v4/pdp/get_pc?item_id=1&shop_id=2')).toBe(true);
        expect(isProductApiUrl('https://shopee.vn/api/v4/pdp/get_rw?item_id=1')).toBe(true);
        expect(isProductApiUrl('https://shopee.vn/api/v4/pdp/get_pc_extra')).toBe(false);
        expect(isProductApiUrl('https://shopee.vn/api/v4/shop/get_shop_base_v2')).toBe(false);
    });
});

describe('classifyPage', () => {
    const wall = (loggedIn: string) =>
        `https://shopee.vn/verify/traffic/error?home_url=https%3A%2F%2Fshopee.vn&is_logged_in=${loggedIn}&tracking_id=x`;

    it('a rendered product is ok', () => {
        expect(classifyPage(PRODUCT, 0, true)).toEqual({ kind: 'ok' });
    });

    it('the wall with is_logged_in=false means the session is gone', () => {
        expect(classifyPage(wall('false'), LOGIN_REQUIRED_CODE, true)).toEqual({ kind: 'login_required' });
    });

    it('the wall with is_logged_in=true is a bot refusal, worth another IP', () => {
        expect(classifyPage(wall('true'), LOGIN_REQUIRED_CODE, true).kind).toBe('blocked');
    });

    it('the login page means login required', () => {
        expect(classifyPage('https://shopee.vn/buyer/login?next=x', null, true)).toEqual({ kind: 'login_required' });
    });

    it('90309999 before the redirect: judged by whether a login cookie was sent', () => {
        expect(classifyPage(PRODUCT, LOGIN_REQUIRED_CODE, true).kind).toBe('blocked');
        expect(classifyPage(PRODUCT, LOGIN_REQUIRED_CODE, false).kind).toBe('login_required');
    });

    it("another API error (e.g. removed product) is still Shopee's page to capture", () => {
        expect(classifyPage(PRODUCT, 4, true)).toEqual({ kind: 'ok' });
    });
});

describe('session helpers', () => {
    const cookie = (name: string, domain: string, value = 'v') => ({ name, domain, value });

    it('keeps the cookies of the host and its subdomains only', () => {
        const cookies = [
            cookie('SPC_ST', '.shopee.vn'),
            cookie('SPC_SI', 'banhang.shopee.vn'),
            cookie('SPC_ST', '.shopee.co.th'),
            cookie('x', 'notshopee.vn'),
        ];
        expect(cookiesForHost(cookies, 'shopee.vn').map((c) => c.domain)).toEqual(['.shopee.vn', 'banhang.shopee.vn']);
    });

    it('needs a non-empty SPC_ST to count as logged in', () => {
        expect(hasLoginCookie([cookie('SPC_ST', '.shopee.vn')])).toBe(true);
        expect(hasLoginCookie([cookie('SPC_ST', '.shopee.vn', '')])).toBe(false);
        expect(hasLoginCookie([cookie('SPC_F', '.shopee.vn')])).toBe(false);
    });

    it('session keys are valid key-value-store keys', () => {
        expect(sessionKey('shopee.com.my')).toMatch(/^[a-zA-Z0-9!\-_.'()]+$/);
    });

    it('also accepts the local file name as the key (Console upload)', () => {
        expect(sessionKeys('shopee.vn')).toEqual(['session-shopee.vn', 'session-shopee.vn.json']);
    });
});

describe('error codes', () => {
    it('round-trip through the message prefix', () => {
        expect(errorCodeOf(taggedMessage('SESSION_EXPIRED', 'x'))).toBe('SESSION_EXPIRED');
        expect(errorCodeOf(taggedMessage('BLOCKED', 'x'))).toBe('BLOCKED');
        expect(errorCodeOf('Navigation timed out')).toBe('FAILED');
        expect(errorCodeOf('[SOMETHING_ELSE] x')).toBe('FAILED');
    });
});

describe('buildKey', () => {
    it('produces a key containing only KV-store-safe characters', () => {
        expect(buildKey(PRODUCT)).toMatch(/^[a-zA-Z0-9!\-_.'()]+$/);
    });
});

describe('buildKey length', () => {
    it('stays short for long Shopee slugs and unique per URL', () => {
        const long = `https://shopee.vn/${'%E1%BB%90p-L%C6%B0ng'.repeat(20)}-i.1.2`;
        expect(buildKey(long).length).toBeLessThanOrEqual(11 + 100 + 1 + 32);
        expect(buildKey(long)).not.toBe(buildKey(`${long}3`));
    });
});

describe('anti-bot challenge', () => {
    it('the captcha page and anti_bot_tracking_id pages are a challenge, not a login problem', () => {
        expect(
            classifyPage('https://shopee.vn/verify/captcha?anti_bot_tracking_id=x', LOGIN_REQUIRED_CODE, true).kind,
        ).toBe('challenge');
        expect(
            classifyPage('https://shopee.vn/verify/traffic?anti_bot_tracking_id=x', LOGIN_REQUIRED_CODE, true).kind,
        ).toBe('challenge');
    });

    it('CAPTCHA_REQUIRED survives the message prefix', () => {
        expect(errorCodeOf(taggedMessage('CAPTCHA_REQUIRED', 'x'))).toBe('CAPTCHA_REQUIRED');
    });

    it('one valid Apify proxy session id per storefront', () => {
        expect(accountProxySession('shopee.com.my')).toBe('shopee_shopee_com_my');
        expect(accountProxySession('shopee.com.my')).toMatch(/^[\w.~]{1,50}$/);
    });
});

describe('isPageFilled', () => {
    it('rejects the empty shell: one window tall or almost no text', () => {
        expect(isPageFilled({ height: 1080, viewportHeight: 1080, textLength: 2000 }, MIN_TEXT_LENGTH)).toBe(false);
        expect(isPageFilled({ height: 6000, viewportHeight: 1080, textLength: 40 }, MIN_TEXT_LENGTH)).toBe(false);
    });

    it('accepts a rendered page', () => {
        expect(isPageFilled({ height: 6000, viewportHeight: 1080, textLength: 3000 }, MIN_TEXT_LENGTH)).toBe(true);
    });
});

describe('shop pages and their API', () => {
    it('knows shop URLs by id or username, not categories, search or products', () => {
        expect(isShopUrl('https://shopee.vn/shop/820223003')).toBe(true);
        expect(isShopUrl('https://shopee.vn/chanhstore195')).toBe(true);
        expect(isShopUrl('https://shopee.vn/Women-Clothes-cat.11044951')).toBe(false);
        expect(isShopUrl('https://shopee.vn/search?keyword=x')).toBe(false);
        expect(isShopUrl(PRODUCT)).toBe(false);
    });

    it('matches the shop header API only', () => {
        expect(isShopApiUrl('https://shopee.vn/api/v4/shop/get_shop_base_v2?username=chanhstore195')).toBe(true);
        expect(isShopApiUrl('https://shopee.vn/api/v4/shop/get_shop_base?shopid=1')).toBe(true);
        expect(isShopApiUrl('https://shopee.vn/api/v4/shop/get_shop_tab?shopid=1')).toBe(false);
    });

    it('watches the product API on products, the shop API on shops, nothing elsewhere', () => {
        expect(watchedPageKind(PRODUCT)).toBe('product');
        expect(watchedPageKind('https://shopee.vn/chanhstore195')).toBe('shop');
        expect(watchedPageKind('https://shopee.vn/search?keyword=x')).toBeNull();
    });
});

describe('proxy sessions', () => {
    it('switches to a new, valid Apify session id after a dead IP', () => {
        const next = nextAccountProxySession('shopee.com.my', 1_800_000_000_000);
        expect(next).toMatch(/^shopee_shopee_com_my_[a-z0-9]+$/);
        expect(next.length).toBeLessThanOrEqual(50);
        expect(next).not.toBe(accountProxySession('shopee.com.my'));
    });

    it('treats only "could not reach the site" proxy failures as a dead IP', () => {
        expect(isProxyConnectionError('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://shopee.vn/x')).toBe(
            true,
        );
        expect(isProxyConnectionError('page.goto: net::ERR_PROXY_CONNECTION_FAILED')).toBe(true);
        expect(isProxyConnectionError('[BLOCKED] The product API never answered.')).toBe(false);
        expect(isProxyConnectionError('page.goto: Timeout 90000ms exceeded.')).toBe(false);
    });
});
