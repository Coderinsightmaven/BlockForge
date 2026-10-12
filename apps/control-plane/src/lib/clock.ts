/** Source of "now" for everything time-dependent (sessions, tokens, sweepers) so tests can control time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
