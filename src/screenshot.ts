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
 * Capture a screenshot, store it in the default key-value store, and push
 * `{ url, screenshotUrl, actorRunId }` to the dataset. `screenshotUrl` is a signed public KV URL
 * with `disableRedirect=true` so it resolves directly to the PNG/JPEG.
 */
export async function captureAndSave(page: Page, url: string, opts: CaptureOptions, log: Logger): Promise<void> {
    if (opts.fullPage) {
        await lazyLoadScroll(page, opts.maxHeight, log);
    }
    if (opts.hideAccount) {
        await hideAccount(page);
    }
    if (opts.waitMs > 0) {
        await page.waitForTimeout(opts.waitMs);
    }

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
