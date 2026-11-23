/**
 * Shape of what this Actor pushes to the dataset, and the one place the Apify run ID is read.
 */
import { Actor } from 'apify';

/**
 * The ID of the Apify run we are currently in, or `null` when there is none — i.e. a local
 * `apify run`, where the platform never sets `ACTOR_RUN_ID`.
 *
 * Deliberately read on every call rather than captured once at module load: the env is only
 * populated by `Actor.init()`, so a module-level constant evaluated at import time would be
 * `null` for the whole run.
 */
export function currentActorRunId(): string | null {
    return Actor.getEnv().actorRunId ?? null;
}

/**
 * One dataset item. `screenshotUrl` is `null` (and `error` set) when the request failed every
 * retry. `actorRunId` is required, not optional — every item carries the run it came from, so a
 * dataset consumed across runs can always be traced back; `null` is the local-run value, not a
 * "field missing" one.
 */
export interface OutputItem {
    url: string;
    screenshotUrl: string | null;
    actorRunId: string | null;
    error?: string;
    /** Set with `error`: what kind of failure, so the caller can react (e.g. alert on SESSION_EXPIRED). */
    errorCode?: ErrorCode;
}

/**
 * - `SESSION_EXPIRED`: no saved login for this storefront, or Shopee no longer accepts it. Someone
 *   must run `npm run login` again; retrying cannot help.
 * - `CAPTCHA_REQUIRED`: Shopee put the account behind a slider captcha. A person must solve it once
 *   (`npm run login -- --unlock`); the Actor does not try other IPs, which only adds suspicion.
 * - `BLOCKED`: logged in but refused without a challenge (e.g. headless), or the product never loaded.
 * - `INVALID_URL`: not a Shopee storefront URL.
 * - `FAILED`: anything else (timeouts, crashes).
 */
export type ErrorCode = 'SESSION_EXPIRED' | 'CAPTCHA_REQUIRED' | 'BLOCKED' | 'INVALID_URL' | 'FAILED';

const ERROR_CODES: readonly ErrorCode[] = ['SESSION_EXPIRED', 'CAPTCHA_REQUIRED', 'BLOCKED', 'INVALID_URL', 'FAILED'];

/** Errors carry their code as a `[CODE] ` prefix so it survives Crawlee's string-only error log. */
export function taggedMessage(code: ErrorCode, message: string): string {
    return `[${code}] ${message}`;
}

export function errorCodeOf(message: string): ErrorCode {
    const tag = /^\[([A-Z_]+)\]/.exec(message)?.[1];
    return ERROR_CODES.find((code) => code === tag) ?? 'FAILED';
}
