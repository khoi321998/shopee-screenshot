import { createHash } from 'node:crypto';

import { Actor } from 'apify';
import type { Page } from 'playwright';

import { currentActorRunId, type OutputItem } from './dataset.js';
import type { Logger } from './logger.js';

export interface CaptureOptions {
    fullPage: boolean;
    format: 'png' | 'jpeg';
    waitMs: number;
    /** Hide the logged-in account (avatar + username) in Shopee's top bar. */
    hideAccount: boolean;
    /** Full-page captures stop at this many CSS pixels from the top. */
    maxHeight: number;
}

/**
 * Build a key-value-store-safe key for a screenshot. KV keys allow only `[a-zA-Z0-9!\-_.'()]`
 * and must be ≤256 chars, so we sanitize the URL and append an md5 hash to keep it unique.
 * The readable part is capped at 100 chars: Shopee slugs are long and percent-encoded, and a local
 * run stores each key as a file name, which Windows refuses past a 260-char path.
 */
export const KEY_URL_CHARS = 100;

export function buildKey(url: string): string {
    const hash = createHash('md5').update(url).digest('hex');
    const sanitized = url.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, KEY_URL_CHARS);
    return `screenshot_${sanitized}_${hash}`;
}

/**
 * The account the capture is logged in as shows in the top bar (avatar + username). It belongs to
 * the scraper, not to the page being documented, so it is hidden. `visibility` keeps the layout.
 */
export const ACCOUNT_SELECTORS = ['.navbar__link--account__container', '.navbar__username', '.shopee-avatar'];

async function hideAccount(page: Page): Promise<void> {
    await page
        .addStyleTag({ content: `${ACCOUNT_SELECTORS.join(', ')} { visibility: hidden !important; }` })
        .catch(() => undefined);
}

const WHEEL_STEP_PX = 400;
const WHEEL_PAUSE_MS = 500;
/** Upper bound on waiting for the images the scroll triggered. */
const IMAGES_TIMEOUT_MS = 10_000;
/** Lets the page insert what the scroll asked for before the images are counted. */
const RENDER_SETTLE_MS = 1_000;

/**
 * Wait until every visible `<img>` above `maxHeight` has finished (loaded or failed), bounded by
 * `timeoutMs`. Replaces `networkidle`, which Shopee never reaches: it keeps connections open, so
 * that wait always ran to its timeout. Images with no size (hidden) are skipped, since a lazy one
 * of those never loads. Returns how many were still pending when the time ran out (0 = all done).
 */
async function waitForImages(page: Page, maxHeight: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const pending = await page
            .evaluate(
                (limit) =>
                    Array.from(document.images).filter((img) => {
                        const rect = img.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return false;
                        if (rect.top + window.scrollY >= limit) return false;
                        return !img.complete;
                    }).length,
                maxHeight,
            )
            .catch(() => 0);
        if (pending === 0 || Date.now() >= deadline) return pending;
        await page.waitForTimeout(250);
    }
}

/** What the page shows right now: how tall it is and how much text it has. */
export interface PageFill {
    height: number;
    viewportHeight: number;
    textLength: number;
}

/** How much a page must show before it counts as rendered. */
export interface ContentRule {
    /** CSS px of page height at least (absolute), on top of being taller than the window. */
    minHeight: number;
    /** Characters of visible text at least. */
    minTextLength: number;
}

/**
 * Product and shop pages: rendered ones measured 2,900-19,800 px and 3,500-7,800 characters
 * (2026-11-23, locally and through the residential proxy), while half-loaded ones through a slow
 * residential proxy measured 1,220-1,520 px and came out as a capture of a few sections or of
 * Shopee's loading spinner. 2,000 px sits between the two, with room for a small shop.
 */
export const LISTING_CONTENT: ContentRule = { minHeight: 2_000, minTextLength: 2_500 };

/** Any other page (search, ...): just more than the empty shell (top bar, chat button). */
export const ANY_CONTENT: ContentRule = { minHeight: 0, minTextLength: 500 };

/**
 * Whether the page has rendered its content, not just Shopee's empty shell or part of it.
 * Through a slow residential proxy the page API answers long before the page draws the listing:
 * a capture then came out blank, one window tall (seen on the platform 2026-11-23).
 */
export function isPageFilled(fill: PageFill, rule: ContentRule): boolean {
    return (
        fill.height > fill.viewportHeight + 200 &&
        fill.height >= rule.minHeight &&
        fill.textLength >= rule.minTextLength
    );
}

/**
 * Wait until the page has rendered its content (see `isPageFilled`), bounded by `timeoutMs`.
 * Returns the last measurement and whether it was filled.
 */
export async function waitForContent(
    page: Page,
    timeoutMs: number,
    rule: ContentRule,
): Promise<{ filled: boolean; fill: PageFill }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const fill = await page
            .evaluate(() => ({
                height: Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight),
                viewportHeight: window.innerHeight,
                textLength: (document.body?.innerText ?? '').replace(/\s+/g, ' ').length,
            }))
            .catch(() => ({ height: 0, viewportHeight: 0, textLength: 0 }));
        const filled = isPageFilled(fill, rule);
        if (filled || Date.now() >= deadline) return { filled, fill };
        await page.waitForTimeout(500);
    }
}

/**
 * Scroll down to `maxHeight` (or the bottom, if sooner) to trigger lazy-loaded content, let it
 * load, then return to the top. Only as far as the capture reaches: the rest of the page is not in
 * the picture, so loading it costs time for nothing.
 *
 * With the mouse wheel, not `window.scrollBy`: Shopee renders the product details, description and
 * reviews only after a real scroll (measured 2026-11-20).
 */
async function lazyLoadScroll(page: Page, maxHeight: number, log: Logger): Promise<void> {
    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    await page.mouse.move(viewport.w / 2, viewport.h / 2);
    for (let step = 0; step * WHEEL_STEP_PX < maxHeight; step++) {
        await page.mouse.wheel(0, WHEEL_STEP_PX);
        await page.waitForTimeout(WHEEL_PAUSE_MS);
        const atBottom = await page.evaluate(
            () =>
                window.scrollY + window.innerHeight >=
                Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - 5,
        );
        if (atBottom) break;
    }

    // Let the images the scroll triggered load; bounded, and a capture goes ahead either way.
    await page.waitForTimeout(RENDER_SETTLE_MS);
    const started = Date.now();
    const pending = await waitForImages(page, maxHeight, IMAGES_TIMEOUT_MS);
    if (pending > 0) {
        log.warning(`${pending} image(s) still loading after ${IMAGES_TIMEOUT_MS / 1000}s; capturing anyway.`);
    } else {
        log.info(`Images loaded in ${Date.now() - started} ms.`);
    }

    await page.mouse.wheel(0, -100_000);
    await page.waitForTimeout(1_000);
}

/**
 * Throws when the page is no longer the page to capture (redirected to a verification page, or back
 * on Shopee's loading spinner). `timeoutMs` is how long the page may take to show its content again.
 */
export type PageCheck = (timeoutMs: number) => Promise<void>;

/** Time the page may take to show its content again right before the capture (after the scroll). */
const RECHECK_TIMEOUT_MS = 30_000;

/**
 * Capture a screenshot, store it in the default key-value store, and push
 * `{ url, screenshotUrl, actorRunId }` to the dataset. `screenshotUrl` is a signed public KV URL
 * with `disableRedirect=true` so it resolves directly to the PNG/JPEG.
 */
export async function captureAndSave(
    page: Page,
    url: string,
    opts: CaptureOptions,
    check: PageCheck | null,
    log: Logger,
): Promise<void> {
    if (opts.fullPage) {
        await lazyLoadScroll(page, opts.maxHeight, log);
    }
    if (opts.hideAccount) {
        await hideAccount(page);
    }
    if (opts.waitMs > 0) {
        await page.waitForTimeout(opts.waitMs);
    }
    // Checked right before the capture, after every wait: the page was seen back on a full-window
    // spinner after the scroll, and a capture of that spinner was stored (2026-11-23).
    if (check) await check(RECHECK_TIMEOUT_MS);

    // A full-page capture is clipped at maxHeight; the clip is in page coordinates.
    const pageSize = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    }));
    const screenshot = await page.screenshot({
        fullPage: opts.fullPage,
        ...(opts.fullPage
            ? { clip: { x: 0, y: 0, width: pageSize.width, height: Math.min(pageSize.height, opts.maxHeight) } }
            : {}),
        type: opts.format,
        ...(opts.format === 'jpeg' ? { quality: 85 } : {}),
    });
    // And once more right after: the page can switch away while the full-page capture is taken.
    if (check) await check(0);

    const key = buildKey(url);
    const contentType = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const store = await Actor.openKeyValueStore();
    await store.setValue(key, screenshot, { contentType });

    const publicUrl = store.getPublicUrl(key);
    const screenshotUrl = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}disableRedirect=true`;

    log.info('Screenshot captured.', { url, key });
    log.info(`Screenshot URL: ${screenshotUrl}`);
    const item: OutputItem = { url, screenshotUrl, actorRunId: currentActorRunId() };
    await Actor.pushData(item);
}
