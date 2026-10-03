// The RateLimit-Policy and RateLimit fields from the IETF draft
// (draft-ietf-httpapi-ratelimit-headers-11), one list item per limit:
//
//   RateLimit-Policy: "checkout-user";q=3;w=30, "checkout-ip";q=10;w=10
//   RateLimit: "checkout-user";r=2;t=10, "checkout-ip";r=9;t=1
//
// q is a quota and w its window in seconds; r is what's left right now and
// t the seconds until all of it is back. GCRA has no windows, so for it q is
// the burst and w the time a full burst takes to refill. Limit names are
// plain words, so they never need escaping inside the quotes.
//
// 429s also get Retry-After (RFC 9110), which every HTTP client understands.

const seconds = (ms) => Math.ceil(ms / 1000);

export function rateLimitHeaders(algorithm, results) {
  const policy = results
    .map(({ limit }) => {
      const [q, w] = algorithm === "gcra"
        ? [limit.burst, seconds(limit.burst * limit.intervalMs)]
        : [limit.perPeriod, limit.period];
      return `"${limit.name}";q=${q};w=${w}`;
    })
    .join(", ");

  const state = results
    .map(({ limit, remaining, resetAfterMs }) => `"${limit.name}";r=${remaining};t=${seconds(resetAfterMs)}`)
    .join(", ");

  return { policy, state };
}

// Whole seconds, rounded up, so a client that waits this long is never early.
export const retryAfterSeconds = (ms) => Math.max(1, seconds(ms));
