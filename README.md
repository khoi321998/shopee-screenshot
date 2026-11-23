# Shopee Screenshot Actor

Screenshots of Shopee pages (product, shop, search), stored in the run's key-value store.
Built like `dhgate-screenshot`: Patchright driving the real Google Chrome, headed. Unlike it, one exit IP per
account and no IP rotation (see "IPs and proxies").

Output per URL (dataset):

```json
{ "url": "<input url>", "screenshotUrl": "https://api.apify.com/v2/key-value-stores/.../records/screenshot_...?disableRedirect=true", "actorRunId": "..." }
{ "url": "<input url>", "screenshotUrl": null, "actorRunId": "...", "error": "...", "errorCode": "SESSION_EXPIRED" }
```

`errorCode`: `SESSION_EXPIRED` (log in again), `CAPTCHA_REQUIRED` (solve the account's captcha, see below),
`BLOCKED` (refused without a challenge, or the product never loaded), `INVALID_URL` (not a Shopee storefront),
`FAILED` (anything else). None of the first three is retried.

## Why it needs a logged-in account

Measured 2026-11-20 on shopee.vn:

- Without a login every product and shop page ends on `/verify/traffic/error?is_logged_in=false` ("Login Required") and
  the product API `/api/v4/pdp/get_pc` answers `error: 90309999`. Tried: curl, headless and headed Chrome, Patchright,
  residential VN proxy, home page first, mobile emulation. Oxylabs' Web Scraper API refuses Shopee URLs outright.
  Search pages still work without a login.
- A logged-in session (its cookies only) loaded into a fresh headed Chrome works, also through a residential VN proxy,
  i.e. from a different IP than the one that logged in.
- Headless Chrome with the same session is refused (`is_logged_in=true`, 90309999) or never gets product data. The
  Actor therefore runs headed; the Apify base image provides an Xvfb display.
- Shopee renders the details, description and reviews only after a real (mouse wheel) scroll; `window.scrollBy` left
  them blank. Full-page captures scroll with the wheel down to `maxScrollHeight` (default 5000 px) and stop there.

## One account per country

Every storefront needs its own account and session (measured 2026-11-20):

- The session's cookies belong to `shopee.vn` only; the browser never sends them to `shopee.co.th` etc. Copied onto
  `shopee.co.th`, they are not accepted ("Login Required").
- Without a login, shopee.sg, .com.my, .ph, .co.id, .tw, .com.br and .co.th refuse even the search page; shopee.vn
  still shows search results.
- Each storefront is a separate Shopee: an account is registered in one country (usually with a local phone number).

## IPs and proxies

Shopee's anti-bot check follows the account, not the IP (measured 2026-11-20). After ~10 captures through changing
VN residential IPs went fine, the same session was opened from a US and an SG residential IP: from then on every IP,
the home one included, got `/verify/captcha` (a slider puzzle) for that account. Also seen: a US residential IP got
`/verify/traffic` straight away.

So the Actor keeps one exit IP per account and never rotates IPs to get past a refusal:

- `proxyUrl` (input, secret): a static proxy in the account's country. The steadiest choice: the account always
  browses from the same IP.
- Otherwise Apify RESIDENTIAL in the storefront's country with a fixed session id per storefront. Apify keeps that
  IP only while it stays available; in testing two runs with the same session id got two different VN IPs.
- `proxy: false`: the machine's own IP. On the Apify platform that is a datacenter IP outside VN: not recommended.
  Apify's datacenter proxy did not even reach the test page.

Not measured yet: whether changing VN IPs alone (without the foreign ones) would have triggered the captcha too, and
how many pages a day one account may view.

## The login session

The Actor reads the session from the named key-value store `shopee-session`, record `session-<host>`
(e.g. `session-shopee.vn`): the cookies of a browser someone logged in to by hand. It writes the cookies Shopee renews
back after each successful capture. The record logs in as the account: it is a secret, never commit or paste it.

Use a dedicated Shopee account, not a personal one: an account that browses a lot may be restricted.

### Log in (on your machine, by hand)

```bash
npm install
npm run login                      # Chrome opens on the login page: log in (captcha, OTP), then press Enter
npm run login -- --upload          # same, and upload the session to Apify (needs APIFY_TOKEN in the environment)
npm run login -- --import file.json   # use the cookies of a Playwright storageState file instead of logging in
npm run login -- --host shopee.co.th --check <a product url>   # another storefront
```

The script checks the session on a product page in a fresh Chrome and saves it only if the product loads.
Locally the session lands in `storage/key_value_stores/shopee-session/`, which `apify run` reads.

### When it expires

Runs then return `errorCode: SESSION_EXPIRED` for every URL of that storefront. Run `npm run login -- --upload` again.
How long a session lasts is not measured yet (the login cookie `SPC_ST` says 400 days; Shopee may end it sooner).

### When Shopee asks for a captcha

Runs return `errorCode: CAPTCHA_REQUIRED`; the Actor stops using that account for the rest of the run. Solve it by
hand, ideally from the IP the Actor uses:

```bash
npm run login -- --unlock --upload   # opens the saved session on a product page: slide the puzzle, press Enter
```

### On the Apify platform

The Actor must be able to open the account's named store `shopee-session`. An Actor with limited permissions can only
open storages it created itself, so either run it with full permissions or let the first run create the store and
upload into that one.

## Input

| Field                              | Default     |                                                                            |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------- |
| `startUrls`                        |             | Shopee URLs. `www.` / `m.` are dropped so the session cookies apply.       |
| `fullPage`                         | `true`      | Capture from the top down to `maxScrollHeight` instead of just the window. |
| `maxScrollHeight`                  | `5000`      | CSS px to scroll and capture.                                              |
| `hideAccount`                      | `true`      | Hide the scraper account's avatar and username in the top bar.             |
| `proxy`                            | `true`      | Apify RESIDENTIAL in the storefront's country, one fixed session.          |
| `proxyUrl`                         |             | Static proxy instead of Apify Proxy (recommended, see above).              |
| `headless`                         | `false`     | Leave off: Shopee refuses headless Chrome.                                 |
| `viewportWidth` / `viewportHeight` | 1920 / 1080 | Window size.                                                               |
| `maxRequestsPerCrawl`              | 10          | Cap including retries.                                                     |

One page at a time (`MAX_CONCURRENCY` 1): one account, and Shopee watches how fast an account browses.
Not measured yet: how many pages an account may view before Shopee restricts it.

## Development

```bash
npm run build && npm run lint && npm test
apify run      # or: npx tsx src/main.ts with storage/key_value_stores/default/INPUT.json
```
