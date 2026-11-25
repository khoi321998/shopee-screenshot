/**
 * Print what a page sees of the browser the Actor launches (same launcher, flags, headed), to
 * compare the platform with a desktop where Shopee does not object. Visits example.com, not Shopee.
 *   node scripts/fingerprint.mjs            (in the Docker image: xvfb-run -a node scripts/fingerprint.mjs)
 */
import { chromium } from 'patchright';

const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: process.env.FP_ARGS ? JSON.parse(process.env.FP_ARGS) : ['--disable-gpu', '--window-size=1920,1080'],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
const info = await page.evaluate(async () => {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    const fonts = [
        'Arial',
        'Times New Roman',
        'Segoe UI',
        'Tahoma',
        'Roboto',
        'Noto Sans',
        'DejaVu Sans',
        'Liberation Sans',
        'Helvetica',
    ];
    const uaData = navigator.userAgentData
        ? await navigator.userAgentData.getHighEntropyValues([
              'platform',
              'platformVersion',
              'architecture',
              'model',
              'fullVersionList',
          ])
        : null;
    return {
        userAgent: navigator.userAgent,
        uaPlatform: uaData?.platform,
        uaPlatformVersion: uaData?.platformVersion,
        platform: navigator.platform,
        webdriver: navigator.webdriver,
        languages: navigator.languages,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMin: new Date().getTimezoneOffset(),
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        screen: [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth],
        window: [outerWidth, outerHeight, innerWidth, innerHeight],
        dpr: devicePixelRatio,
        webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl ? 'no debug ext' : 'no webgl',
        webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        plugins: navigator.plugins.length,
        mimeTypes: navigator.mimeTypes.length,
        pdfViewer: navigator.pdfViewerEnabled,
        fonts: (() => {
            // A font is installed when text in it measures differently from the generic fallbacks.
            const c = document.createElement('canvas').getContext('2d');
            const w = (font) => ((c.font = `32px ${font}`), c.measureText('mmmmmmmmmmlli WwQ@#').width);
            const base = ['monospace', 'serif', 'sans-serif'].map(w);
            return fonts.filter((f) =>
                ['monospace', 'serif', 'sans-serif'].some((g, i) => w(`"${f}", ${g}`) !== base[i]),
            );
        })(),
        notification: typeof Notification !== 'undefined' ? Notification.permission : 'none',
        connection: navigator.connection
            ? { type: navigator.connection.effectiveType, rtt: navigator.connection.rtt }
            : null,
        chromeObj: typeof window.chrome,
        mediaDevices: navigator.mediaDevices
            ? (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind)
            : null,
        battery: 'getBattery' in navigator,
    };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
