/**
 * Shopee screenshot Actor.
 *
 * Captures a screenshot of a Shopee page (product / shop / search) and stores it as a signed
 * key-value-store PNG. Output per URL: `{ url, screenshotUrl, actorRunId }`, or
 * `{ url, screenshotUrl: null, actorRunId, error, errorCode }` on failure.
 *
 * Shopee shows product and shop pages only to logged-in visitors (measured 2026-11-20, see
 * shopee.ts and the README), so every capture runs in a browser that carries the cookies of an
 * account someone logged in to by hand (`npm run login`, kept in the named key-value store
 * `shopee-session`). The browser setup follows the sibling `dhgate-screenshot` Actor:
 *
 *   1. Patchright (Playwright fork without the automation leaks) driving the real Google Chrome.
 *   2. Headed: headless Chrome with the same session is refused by Shopee. Xvfb on the platform.
 *   3. No fabricated fingerprint, no locale / viewport emulation.
 *   4. One exit IP per account, kept as long as the proxy allows: `proxyUrl` (a static proxy) or an
 *      Apify RESIDENTIAL proxy in the storefront's country with a fixed session id.
 *
 * Never rotate IPs to get past a refusal: Shopee ties its anti-bot check to the account, and the
 * same session used from VN, US and SG IPs in a row ended behind a captcha on every IP, the home
 * one included (measured 2026-11-20). So a refusal ends the URL (and the storefront, for a
 * challenge) at once with an `errorCode`; only a product API that never answered is retried, on
 * the same IP.
 *
 * ESM project — relative imports must use the `.js` extension even from `.ts` sources.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import {
    NonRetryableError,
    PlaywrightCrawler,
    type PlaywrightCrawlingContext,
    ProxyConfiguration,
} from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { chromium as patchrightChromium } from 'patchright';
import type { BrowserType, Page } from 'playwright';

import { chooseChrome } from './browser.js';
import { currentActorRunId, type ErrorCode, errorCodeOf, type OutputItem, taggedMessage } from './dataset.js';
import { captureAndSave, type CaptureOptions, waitForContent } from './screenshot.js';
import {
    cookiesForHost,
    describeCookies,
    hasLoginCookie,
    loadSession,
    saveSession,
    SESSION_STORE,
    sessionKeys,
    type ShopeeSession,
} from './session.js';
import {
    accountProxySession,
    classifyPage,
    isProductApiUrl,
    isProductUrl,
    normalizeShopeeUrl,
    proxyCountryForHost,
    shopeeHost,
} from './shopee.js';

interface Input {
    startUrls?: { url: string }[];
    fullPage?: boolean;
    maxScrollHeight?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    maxRequestsPerCrawl?: number;
    headless?: boolean;
    proxy?: boolean;
    /** A static proxy (http://user:pass@host:port) used instead of Apify Proxy. A secret input. */
    proxyUrl?: string;
    hideAccount?: boolean;
}

interface RequestData {
    inputUrl: string;
    host: string;
}

// --- Hard-coded operational config (intentionally NOT exposed as input) --------------------------
const FORMAT = 'png' as const;
/** One page at a time: one account, and Shopee watches how fast an account browses. */
const MAX_CONCURRENCY = 1;
/** Only a product API that never answered (slow proxy) is retried, on the same IP. */
const MAX_REQUEST_RETRIES = 1;
const WAIT_MS = 2_000;
const RETRY_DELAY_MILLIS = 5_000;
/** Through a residential proxy the product API took 20-35 s to answer in testing. */
const PRODUCT_API_TIMEOUT_MS = 60_000;
/** How long the page may take to draw its content after the API answered (slow residential proxy). */
const CONTENT_TIMEOUT_MS = 45_000;

await Actor.init();
log.info(`Actor run ID: ${currentActorRunId() ?? '(none — running locally)'}`);

const input = ((await Actor.getInput<Input>()) ?? {}) as Input;
const viewportWidth = input.viewportWidth ?? 1920;
const viewportHeight = input.viewportHeight ?? 1080;
const maxRequestsPerCrawl = input.maxRequestsPerCrawl ?? 10;
// Headed by default, and not as a debugging leftover: see the header comment.
const headless = input.headless ?? process.env.HEADLESS === 'true';
const useProxy = input.proxy ?? true;
const captureOptions: CaptureOptions = {
    fullPage: input.fullPage ?? true,
    format: FORMAT,
    waitMs: WAIT_MS,
    hideAccount: input.hideAccount ?? true,
    maxHeight: input.maxScrollHeight ?? 5_000,
};

const chrome = chooseChrome();
log[chrome.useChrome ? 'info' : 'warning'](`Browser: ${chrome.description}`);
if (headless) log.warning('Browser: headless — Shopee refuses headless Chrome even when logged in.');

Actor.on('aborting', async () => {
    await sleep(1_000);
    await Actor.exit();
});

async function pushError(url: string, code: ErrorCode, error: string): Promise<void> {
    const item: OutputItem = { url, screenshotUrl: null, actorRunId: currentActorRunId(), error, errorCode: code };
    await Actor.pushData(item);
}

// --- Input → requests, sessions ------------------------------------------------------------------

const requests: { url: string; uniqueKey: string; userData: RequestData }[] = [];
for (const { url: inputUrl } of input.startUrls ?? []) {
    if (!inputUrl) continue;
    const host = shopeeHost(inputUrl);
    if (!host) {
        log.warning(`Not a Shopee storefront URL, skipped: ${inputUrl}`);
        await pushError(inputUrl, 'INVALID_URL', 'Not a Shopee storefront URL.');
        continue;
    }
    const url = normalizeShopeeUrl(inputUrl);
    requests.push({ url, uniqueKey: url, userData: { inputUrl, host } });
}

/** The session per storefront host, loaded once; dropped when Shopee says it is no longer logged in. */
const sessions = new Map<string, ShopeeSession>();
for (const host of new Set(requests.map((r) => r.userData.host))) {
    const session = await loadSession(host);
    if (session && hasLoginCookie(session.cookies)) {
        sessions.set(host, session);
        log.info(
            `Session for ${host}: logged in ${session.loggedInAt ?? '?'}, refreshed ${session.refreshedAt ?? 'never'}, ` +
                `cookies ${describeCookies(session.cookies)}`,
        );
    } else {
        log.error(
            `No logged-in session for ${host} in key-value store "${SESSION_STORE}" ` +
                `(key "${sessionKeys(host).join('" or "')}"). Run "npm run login".`,
        );
    }
}

function sessionExpired(host: string): string {
    return taggedMessage(
        'SESSION_EXPIRED',
        `Shopee requires a login and the saved session for ${host} is missing or no longer accepted. ` +
            `Log in again with "npm run login" and upload the session.`,
    );
}

/** Storefronts whose account hit a captcha in this run: their remaining URLs fail without a visit. */
const challenged = new Set<string>();

function captchaRequired(host: string): string {
    return taggedMessage(
        'CAPTCHA_REQUIRED',
        `Shopee asks the ${host} account to solve a captcha. Solve it with "npm run login -- --unlock --upload"; ` +
            `until then every capture with this account is refused.`,
    );
}

// --- Proxy ---------------------------------------------------------------------------------------

/**
 * One exit IP per account, kept for as long as the proxy allows. Either `proxyUrl` (a static
 * proxy: the steadiest choice), or Apify RESIDENTIAL in the storefront's country with a fixed
 * session id per storefront, ignoring Crawlee's session rotation. Apify keeps a residential
 * session's IP only while the IP stays available, so the IP still changes between runs (seen).
 */
async function buildProxy(): Promise<ProxyConfiguration | undefined> {
    if (input.proxyUrl) {
        log.info('Proxy: static proxyUrl from input.');
        return new ProxyConfiguration({ proxyUrls: [input.proxyUrl] });
    }
    if (!useProxy) {
        log.info('Proxy: none — disabled by `proxy: false`.');
        return undefined;
    }
    const byCountry = new Map<string, ProxyConfiguration>();
    for (const host of new Set(requests.map((r) => r.userData.host))) {
        const country = proxyCountryForHost(host);
        if (byCountry.has(country)) continue;
        const config = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: country });
        if (!config) {
            log.warning('Proxy: none — Apify Proxy was requested but no token or password is available.');
            return undefined;
        }
        byCountry.set(country, config);
    }
    log.info(`Proxy: RESIDENTIAL ${[...byCountry.keys()].join(', ')}, one fixed session per storefront`);
    return new ProxyConfiguration({
        newUrlFunction: async (_sessionId, options) => {
            const host = (options?.request?.userData as RequestData | undefined)?.host ?? 'shopee.vn';
            const config = byCountry.get(proxyCountryForHost(host)) ?? [...byCountry.values()][0];
            return (await config.newUrl(accountProxySession(host))) ?? null;
        },
    });
}

// --- Page helpers --------------------------------------------------------------------------------

/** The product API's `error` field per page, recorded from the first navigation response on. */
const productApiCodes = new WeakMap<Page, Promise<number | null>>();

function watchProductApi(page: Page): void {
    const code = page
        .waitForResponse((response) => isProductApiUrl(response.url()), { timeout: PRODUCT_API_TIMEOUT_MS })
        .then(async (response) => {
            const body = (await response.json()) as { error?: unknown };
            return typeof body.error === 'number' ? body.error : 0;
        })
        .catch(() => null);
    productApiCodes.set(page, code);
}

/** Best-effort: close a promotion popup that would cover the page. */
async function dismissPopups(page: Page): Promise<void> {
    const close = page.locator('.shopee-popup__close-btn, .home-popup__close-area, .shopee-popup-form__close').first();
    if (await close.isVisible().catch(() => false)) {
        await close.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
    }
}

/** Write the cookies Shopee renewed during this capture back to the session store. */
async function refreshSession(page: Page, host: string, ctxLog: PlaywrightCrawlingContext['log']): Promise<void> {
    const session = sessions.get(host);
    if (!session) return;
    const cookies = cookiesForHost(await page.context().cookies(), host) as ShopeeSession['cookies'];
    if (!hasLoginCookie(cookies)) return;
    const refreshed: ShopeeSession = { ...session, cookies, refreshedAt: new Date().toISOString() };
    sessions.set(host, refreshed);
    await saveSession(host, refreshed).catch((error: Error) => {
        ctxLog.warning(`Could not write the refreshed session back: ${error.message}`);
    });
}

// --- Crawler -------------------------------------------------------------------------------------

async function buildCrawler(): Promise<PlaywrightCrawler> {
    return new PlaywrightCrawler({
        proxyConfiguration: await buildProxy(),
        navigationTimeoutSecs: 90,
        requestHandlerTimeoutSecs: 300,
        minConcurrency: 1,
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestsPerCrawl,
        maxRequestRetries: MAX_REQUEST_RETRIES,
        useSessionPool: true,
        // The login cookies come from the session store, not from Crawlee's per-session jar.
        persistCookiesPerSession: false,
        sessionPoolOptions: {
            maxPoolSize: 4,
            sessionOptions: { maxUsageCount: 5 },
            // Judged in the request handler, where the login state is known.
            blockedStatusCodes: [],
        },
        errorHandler: async ({ request }, error) => {
            log.warning(
                `Attempt ${request.retryCount + 1}/${MAX_REQUEST_RETRIES + 1} failed for ${request.url}: ` +
                    `${error.message}. Retrying in ${RETRY_DELAY_MILLIS / 1000}s.`,
            );
            await sleep(RETRY_DELAY_MILLIS);
        },
        launchContext: {
            // Drop-in Playwright fork; the cast bridges a type-version gap, not a behavioural one.
            launcher: patchrightChromium as unknown as BrowserType,
            useChrome: chrome.useChrome,
            launchOptions: {
                headless,
                executablePath: chrome.executablePath,
                // The real window size, set with --window-size rather than emulated.
                viewport: null,
                args: ['--disable-gpu', `--window-size=${viewportWidth},${viewportHeight}`],
            },
        },
        browserPoolOptions: {
            // A generated fingerprint on top of a real Chrome only adds mismatches.
            useFingerprints: !chrome.useChrome,
            retireBrowserAfterPageCount: 5,
        },
        preNavigationHooks: [
            async ({ page, request }, gotoOptions) => {
                // Shopee keeps connections open; `load`/`networkidle` would hang.
                // eslint-disable-next-line no-param-reassign
                if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';
                const { host } = request.userData as RequestData;
                if (challenged.has(host)) throw new NonRetryableError(captchaRequired(host));
                const session = sessions.get(host);
                if (!session) throw new NonRetryableError(sessionExpired(host));
                await page.context().addCookies(cookiesForHost(session.cookies, host));
                watchProductApi(page);
            },
        ],
        failedRequestHandler: async ({ request, log: ctxLog }, error) => {
            const message =
                error.message || request.errorMessages?.[request.errorMessages.length - 1] || 'Unknown error';
            const code = errorCodeOf(message);
            ctxLog.error('Request failed.', { url: request.url, errorCode: code, error: message });
            await pushError((request.userData as RequestData).inputUrl, code, message);
        },
        requestHandler: async ({ page, request, log: ctxLog }) => {
            const { host, inputUrl } = request.userData as RequestData;
            const product = isProductUrl(request.url);

            // On a product page the API's answer is the verdict; elsewhere only the URL can tell.
            const apiCode = product ? await (productApiCodes.get(page) ?? Promise.resolve(null)) : null;
            // The redirect to the verification page follows a refusal by a moment. A product API that
            // answered 0 is no refusal, so there is nothing to wait for: on a good page this wait
            // always ran to its timeout.
            if (!(product && apiCode === 0)) {
                await page
                    .waitForURL(/\/(verify|buyer\/login)\//, { timeout: product ? 5_000 : 10_000 })
                    .catch(() => undefined);
            }

            const loginCookies = cookiesForHost(await page.context().cookies(), host);
            const verdict = classifyPage(page.url(), apiCode, hasLoginCookie(loginCookies));
            ctxLog.info(`Page check: ${verdict.kind}`, { url: request.url, apiCode, finalUrl: page.url() });

            if (verdict.kind === 'login_required') {
                // Every later URL of this storefront would get the same answer: fail them fast.
                sessions.delete(host);
                throw new NonRetryableError(sessionExpired(host));
            }
            if (verdict.kind === 'challenge') {
                challenged.add(host);
                throw new NonRetryableError(captchaRequired(host));
            }
            if (verdict.kind === 'blocked') {
                throw new NonRetryableError(taggedMessage('BLOCKED', verdict.reason));
            }
            if (product && apiCode === null) {
                // Seen through a slow proxy, and always headless: the shell renders, the product data never arrives.
                throw new Error(taggedMessage('BLOCKED', 'The product API never answered.'));
            }
            if (apiCode !== null && apiCode !== 0) {
                // e.g. a removed product: Shopee's own error page is still the page to document.
                ctxLog.info(`Product API answered error ${apiCode}; capturing the page Shopee shows.`);
            }

            // Short on purpose: Shopee keeps connections open, so networkidle rarely comes and a long
            // timeout here was spent idle before the scroll. The scroll waits for its own images.
            await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
            await dismissPopups(page);

            // The API answering is not the page being drawn: never store a capture of the empty shell.
            const started = Date.now();
            const { filled, fill } = await waitForContent(page, CONTENT_TIMEOUT_MS);
            if (filled) {
                ctxLog.info(`Content rendered in ${Date.now() - started} ms.`, fill);
            } else if (apiCode !== null && apiCode !== 0) {
                // Shopee's own error page (e.g. a removed product) is short: capture it as it is.
                ctxLog.info('Error page with little content; capturing it as it is.', fill);
            } else {
                throw new Error(
                    taggedMessage(
                        'BLOCKED',
                        `The page did not render its content within ${CONTENT_TIMEOUT_MS / 1000}s ` +
                            `(height ${fill.height}px, ${fill.textLength} chars of text).`,
                    ),
                );
            }

            await captureAndSave(page, inputUrl, captureOptions, ctxLog);
            await refreshSession(page, host, ctxLog);
        },
    });
}

// --- Run -----------------------------------------------------------------------------------------

if (requests.length === 0) {
    log.warning('No Shopee URLs to capture.');
} else {
    log.info(`Starting Shopee screenshot Actor: ${requests.length} URL(s), window ${viewportWidth}x${viewportHeight}`);
    const crawler = await buildCrawler();
    await crawler.run(requests);
}

await Actor.exit();
