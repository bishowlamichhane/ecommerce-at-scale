import { ipKey } from "./identity.js";
import { rateLimitHeaders, retryAfterSeconds } from "./headers.js";

// Picks the first policy that matches the request, checks all of its limits
// in one atomic Redis call, then lets the request through or answers 429.
//
// failMode decides what happens when Redis is down or slow (the client gives
// up after 100 ms):
//   "open"    serve the request without a limit: an outage of the limiter
//             must not become an outage of the store
//   "closed"  refuse it with 503: for endpoints where abuse costs more than downtime
export function rateLimit({ limiter, policies, failMode = "open", logger = console }) {
  if (limiter.algorithm === "off") return (req, res, next) => next();
  const warn = throttledWarning(logger, 10_000);

  return async (req, res, next) => {
    const policy = policies.find((p) => p.match(req));
    const ids = { user: req.shopperId, ip: ipKey(req.ip) };
    const checks = policy.limits
      .filter((limit) => ids[limit.by])
      .map((limit) => ({ limit, id: ids[limit.by] }));
    if (checks.length === 0) return next();

    let decision;
    try {
      decision = await limiter.check(checks);
    } catch (error) {
      warn(`Rate limiter unavailable (${error.message}), failing ${failMode}`);
      if (failMode === "closed") {
        res.set("Retry-After", "1");
        return res.status(503).json({ message: "Service temporarily unavailable, please retry", success: false });
      }
      return next();
    }

    const headers = rateLimitHeaders(limiter.algorithm, decision.results);
    res.set("RateLimit-Policy", headers.policy);
    res.set("RateLimit", headers.state);

    if (!decision.allowed) {
      const wait = retryAfterSeconds(Math.max(...decision.results.map((result) => result.retryAfterMs)));
      res.set("Retry-After", String(wait));
      return res.status(429).json({
        message: `Too many requests. Try again in ${wait} s.`,
        success: false,
        retryAfter: wait,
      });
    }
    next();
  };
}

// Logs the first failure at once, then at most one line per interval saying
// how many were skipped, so an outage doesn't flood the logs.
function throttledWarning(logger, intervalMs) {
  let last = 0;
  let skipped = 0;
  return (message) => {
    const now = Date.now();
    if (now - last < intervalMs) {
      skipped += 1;
      return;
    }
    logger.warn(skipped > 0 ? `${message} (+${skipped} more since the last warning)` : message);
    last = now;
    skipped = 0;
  };
}
