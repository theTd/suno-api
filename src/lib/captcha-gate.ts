import pino from 'pino';

const logger = pino();

/**
 * Thrown when the caller disconnected (AbortSignal fired) before its queued
 * request got a turn. Routes map this to a log-only response since the client
 * is already gone; the gate treats it neutrally so one dropped client never
 * fails the backlog behind it.
 */
export class ClientGoneError extends Error {
  constructor(message: string = 'Client disconnected before the request was processed') {
    super(message);
    this.name = 'ClientGoneError';
  }
}

interface QueueWaiter {
  /** `true` = speculative wake (the check we waited for found no CAPTCHA). */
  resolve: (speculative: boolean) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envInt(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Gate states:
 * - `open`: no CAPTCHA context, requests run fully concurrently.
 * - `checking`: one request is running its (cheap) CAPTCHA check; arrivals
 *   queue speculatively and are all released at once if the check comes back
 *   clean, so plain traffic never serializes.
 * - `siege`: CAPTCHA was engaged (a solver holds the account). Arrivals queue
 *   as real backlog and are released strictly one at a time, after a random
 *   interval, each re-checking CAPTCHA; if the account is still flagged the
 *   released request keeps the siege going as the next de-facto solver.
 */
type GateMode = 'open' | 'checking' | 'siege';

/**
 * Per-account (per SunoApi instance) soft lock for CAPTCHA sieges.
 *
 * `job` must be the short CAPTCHA-critical section of a request (auth refresh,
 * captcha check/solve, generate submission) — NOT long-running polling. It
 * receives an `engage` callback to invoke once, right after it learns CAPTCHA
 * verification is required, which locks the gate.
 *
 * Callers pass their `AbortSignal`; if it fires while the request is queued,
 * the entry is removed from the queue and the returned promise rejects with
 * `ClientGoneError` without ever running `job`.
 */
export class CaptchaGate {
  private mode: GateMode = 'open';
  private queue: QueueWaiter[] = [];
  private readonly drainMinMs: number;
  private readonly drainMaxMs: number;

  constructor() {
    const min = envInt('CAPTCHA_QUEUE_MIN_INTERVAL_MS', 2000);
    const max = envInt('CAPTCHA_QUEUE_MAX_INTERVAL_MS', 8000);
    this.drainMinMs = Math.min(min, max);
    this.drainMaxMs = Math.max(min, max);
  }

  async run<T>(job: (engage: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let speculativeWake = false;
    // Per-request role, tracked explicitly: dispatching the finally block on
    // the global mode is wrong because concurrent open-state runners share the
    // mode without holding any turn.
    let enteredAsChecker = false;
    let turnGranted = false;
    // Entry is a synchronous check-and-set loop, so it cannot race with
    // engage(): a request either enters before the lock and becomes the
    // solver, or queues behind it.
    for (;;) {
      if (signal?.aborted)
        throw new ClientGoneError();
      if (this.mode === 'open') {
        // Only the first arrival of a batch marks the gate as checking;
        // requests woken speculatively after a clean check re-enter here and
        // must NOT flip the mode, otherwise every batch would serialize.
        if (!speculativeWake) {
          this.mode = 'checking';
          enteredAsChecker = true;
        }
        break;
      }
      logger.info(`CaptchaGate ${this.mode}; queueing request (depth=${this.queue.length + 1})`);
      speculativeWake = await this.waitTurn(signal);
      if (!speculativeWake) {
        turnGranted = true; // siege turn granted: run as the next de-facto solver
        break;
      }
      // Speculative wake: the check we waited for found no CAPTCHA; loop back
      // and enter as a concurrent open-state request.
    }
    let engaged = false;
    const engage = () => {
      if (this.mode !== 'siege') {
        this.mode = 'siege';
        engaged = true;
        logger.info('CaptchaGate locked by CAPTCHA solver (siege)');
      }
    };
    const holdsTurn = () => engaged || turnGranted;
    let failure: Error | null = null;
    try {
      if (signal?.aborted)
        throw new ClientGoneError();
      return await job(engage);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      if (failure && holdsTurn() && !(failure instanceof ClientGoneError)) {
        // Turn holder failed: releasing the queue would just run everyone into
        // the same wall. Fail the backlog with the holder's error and reopen.
        this.flushQueue(
          new Error('CAPTCHA solver failed; queued request released: ' + failure.message)
        );
        this.mode = 'open';
      } else if (enteredAsChecker && this.mode === 'checking') {
        // No CAPTCHA after all: release every speculative waiter at once.
        this.mode = 'open';
        this.releaseAll();
      } else if (holdsTurn()) {
        // Siege persists and this request held the turn: hand it to the next
        // waiter. Not awaited on purpose: the backlog drains in the background
        // while this caller's result propagates.
        this.releaseNext();
      }
      // Pure concurrent runners (no turn, not the checker) do nothing: the
      // turn holder drives the state machine.
    }
  }

  /** Current backlog depth. Exposed for observability/logging only. */
  get pendingCount(): number {
    return this.queue.length;
  }

  private waitTurn(signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new ClientGoneError());
        return;
      }
      const waiter: QueueWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0)
            this.queue.splice(index, 1);
          logger.info(`CaptchaGate: queued request removed (client gone, depth=${this.queue.length})`);
          reject(new ClientGoneError());
        },
      };
      if (signal)
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /**
   * Hand the turn to the next live waiter after the random drain interval, or
   * reopen the gate when the queue is empty. Resolves waiters with
   * `speculative = false`: they re-check CAPTCHA and keep the siege chain.
   */
  private async releaseNext(): Promise<void> {
    for (;;) {
      const next = this.queue.shift();
      if (!next) {
        this.mode = 'open';
        return;
      }
      next.signal?.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        next.reject(new ClientGoneError());
        continue;
      }
      await this.drainDelay();
      if (next.signal?.aborted) {
        next.reject(new ClientGoneError());
        continue;
      }
      logger.info(`CaptchaGate releasing queued request (${this.queue.length} still queued)`);
      next.resolve(false);
      return;
    }
  }

  /** Wake every waiter with `speculative = true` (clean-check fast path). */
  private releaseAll(): void {
    const waiters = this.queue.splice(0, this.queue.length);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal?.aborted)
        waiter.reject(new ClientGoneError());
      else
        waiter.resolve(true);
    }
    if (waiters.length > 0)
      logger.info(`CaptchaGate released ${waiters.length} speculative waiter(s), no CAPTCHA`);
  }

  private drainDelay(): Promise<void> {
    const span = this.drainMaxMs - this.drainMinMs;
    const delay = this.drainMinMs + Math.floor(Math.random() * (span + 1));
    logger.info(`CaptchaGate drain interval: ${delay}ms`);
    return sleepMs(delay);
  }

  private flushQueue(err: Error): void {
    const waiters = this.queue.splice(0, this.queue.length);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(err);
    }
    if (waiters.length > 0)
      logger.info(`CaptchaGate flushed ${waiters.length} queued request(s) after solver failure`);
  }
}
