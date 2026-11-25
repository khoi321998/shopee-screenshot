/**
 * Save a Shopee login session for the Actor.
 *
 *   npm run login                          # log in by hand in a Chrome window, save locally
 *   npm run login -- --upload              # ... and upload it to the Apify named store (needs APIFY_TOKEN)
 *   npm run login -- --import <file.json>  # take the cookies of a Playwright storageState file instead
 *   npm run login -- --host shopee.co.th   # another storefront (default shopee.vn)
 *   npm run login -- --unlock              # solve the captcha Shopee put on the saved session (CAPTCHA_REQUIRED)
 *
 * The session is a secret (it logs in as the account): this script prints cookie names only.
 * Locally it lands in storage/key_value_stores/shopee-session/session-<host>.json, which `apify run`
 * reads; `--upload` writes the same record to the account's private named store `shopee-session`,
 * which the Actor reads on the platform.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Actor } from 'apify';
import { chromium } from 'patchright';

import {
    cookiesForHost,
    describeCookies,
    hasLoginCookie,
    loadSession,
    saveSession,
    SESSION_STORE,
    savedSessionKey,
    type ShopeeSession,
} from '../src/session.js';
import { classifyPage, isProductApiUrl } from '../src/shopee.js';

/** A product page per storefront to prove the session works. Pass --check <url> for others. */
const CHECK_URLS: Record<string, string> = {
    'shopee.vn': 'https://shopee.vn/product/7669738/57555754369',
};

// APIFY_TOKEN (and any other setting) from the project's .env, if there is one. Never committed.
// A variable already set in the shell wins over the file.
try {
    process.loadEnvFile(resolve(import.meta.dirname, '..', '.env'));
} catch {
    /* no .env: the shell's environment only */
}

const args = process.argv.slice(2);
const arg =(name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const host = arg('--host') ?? 'shopee.vn';
const importFile = arg('--import');
const checkUrl = arg('--check') ?? CHECK_URLS[host];
const upload = args.includes('--upload');
const unlock = args.includes('--unlock');

if (upload && !process.env.APIFY_TOKEN) {
    console.log(
        '--upload needs APIFY_TOKEN, in .env or the environment (Apify Console → Settings → API & Integrations).',
    );
    process.exit(1);
}

await Actor.init();

let cookies: ShopeeSession['cookies'];
let loggedInAt = new Date().toISOString();

if (unlock) {
    // The saved session in a visible Chrome, on a product page: Shopee shows its slider captcha there.
    // The local copy first (the one --import / login wrote); else the one on Apify.
    const saved = (await loadSession(host)) ?? (upload ? await loadSession(host, { forceCloud: true }) : null);
    if (!saved || !checkUrl) {
        console.log(`No saved session for ${host}${checkUrl ? '' : ' or no --check URL'}. Nothing to unlock.`);
        await Actor.exit({ exitCode: 1 });
    }
    const browser = await chromium.launch({ channel: 'chrome', headless: false });
    const context = await browser.newContext({ viewport: null });
    await context.addCookies(saved!.cookies);
    const page = await context.newPage();
    await page.goto(checkUrl!, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`
Chrome is open on a ${host} product page with the saved session.`);
    console.log('1. If Shopee shows "Xác nhận để tiếp tục" (slide the puzzle piece), solve it.');
    console.log('2. When the product page shows, come back here.');
    await rl.question('Press Enter once the product page shows... ');
    rl.close();

    cookies = cookiesForHost(await context.cookies(), host) as ShopeeSession['cookies'];
    loggedInAt = saved!.loggedInAt ?? loggedInAt;
    await browser.close();
} else if (importFile) {
    const state = JSON.parse(readFileSync(resolve(importFile), 'utf8')) as { cookies?: ShopeeSession['cookies'] };
    cookies = cookiesForHost(state.cookies ?? [], host);
    loggedInAt = statSync(resolve(importFile)).mtime.toISOString();
    console.log(`Imported ${cookies.length} cookies for ${host} from ${importFile}: ${describeCookies(cookies)}`);
} else {
    // A persistent profile, so a closed or crashed window keeps the login for the next try.
    const context = await chromium.launchPersistentContext(resolve(`storage/login-profile/${host}`), {
        channel: 'chrome',
        headless: false,
        viewport: null,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`https://${host}/buyer/login`, { waitUntil: 'domcontentloaded' });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nChrome is open on the ${host} login page.`);
    console.log('1. Log in there (phone/email + password, captcha, OTP).');
    console.log('2. When you see the Shopee home page logged in, come back here.');
    await rl.question('Press Enter once you are logged in... ');
    rl.close();

    cookies = cookiesForHost(await context.cookies(), host) as ShopeeSession['cookies'];
    await context.close();
}

if (!hasLoginCookie(cookies)) {
    console.log(`NOT logged in: no login cookie for ${host} (cookies: ${describeCookies(cookies)}). Nothing saved.`);
    await Actor.exit({ exitCode: 1 });
}

if (checkUrl) {
    // The same check the Actor makes: a fresh headed Chrome with only these cookies.
    console.log(`Checking the session on ${checkUrl} ...`);
    const browser = await chromium.launch({ channel: 'chrome', headless: false });
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    const apiCode = page
        .waitForResponse((r) => isProductApiUrl(r.url()), { timeout: 45_000 })
        .then(async (r) => ((await r.json()) as { error?: number }).error ?? 0)
        .catch(() => null);
    await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const code = await apiCode;
    await page.waitForTimeout(3_000);
    const verdict = classifyPage(page.url(), code, true);
    await browser.close();
    if (verdict.kind !== 'ok' || code === null) {
        console.log(`Session check FAILED (${verdict.kind}, product API error=${code}). Nothing saved.`);
        await Actor.exit({ exitCode: 1 });
    }
    console.log('Session check OK: the product page loaded.');
} else {
    console.log(`No check URL for ${host} (pass --check <product url>); saving without checking.`);
}

const session: ShopeeSession = { cookies, loggedInAt };
await saveSession(host, session);
console.log(`Saved locally: store "${SESSION_STORE}", key "${savedSessionKey(host)}".`);
if (upload) {
    await saveSession(host, session, { forceCloud: true });
    console.log(`Uploaded to the Apify named store "${SESSION_STORE}", key "${savedSessionKey(host)}".`);
}
console.log('The session is a secret: do not commit it or paste it anywhere.');
await Actor.exit();
