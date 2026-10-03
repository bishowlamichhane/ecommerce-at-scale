// What gets rate limited, and how hard. Every number here is a product
// decision, so each one carries its reason.
//
// A limit allows `perPeriod` requests per `period` seconds on average, and
// up to `burst` of them back to back. GCRA turns that into one request every
// period / perPeriod seconds plus the burst allowance; the fixed-window
// baseline only uses perPeriod and period.
//
// `by` says what a limit counts:
//   "user"  the X-User-Id header. Clients can make it up or rotate it, so it
//           is never the only limit on a policy.
//   "ip"    the client address (an IPv6 /64), much harder to rotate.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Express routes case-insensitively and ignores a trailing slash, and so do
// the services behind the proxy. Paths are matched the same way here;
// otherwise POST /ORDERS/BUY-NOW/ would reach checkout without its limit.
export const normalizePath = (path) => {
  let normalized = path.toLowerCase().replace(/\/{2,}/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
};

const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

// Any request that changes something under `prefix`, whatever the exact
// route, so new endpoints are covered without touching this file.
const writesUnder = (prefix) => (req) =>
  !SAFE_METHODS.has(req.method) && isUnder(normalizePath(req.path), prefix);

// The first policy that matches a request applies.
export const POLICIES = [
  {
    // Buying. A person clicks Buy once and maybe retries a couple of times.
    name: "checkout",
    match: writesUnder("/orders"),
    limits: [
      // 3 tries at once, then one every 10 seconds
      { by: "user", burst: 3, perPeriod: 6, period: 60 },
      // a shared office or campus IP: 10 buyers at once, then one a second
      { by: "ip", burst: 10, perPeriod: 60, period: 60 },
    ],
  },
  {
    // Changing a cart: cheap, but nobody needs more than one change a second.
    name: "cart",
    match: writesUnder("/cart"),
    limits: [
      { by: "user", burst: 10, perPeriod: 60, period: 60 },
      { by: "ip", burst: 50, perPeriod: 600, period: 60 },
    ],
  },
  {
    // Everything else: browsing, search-as-you-type, order status. This only
    // stops floods; a fast typist sends around 10 searches a second.
    name: "default",
    match: () => true,
    limits: [{ by: "ip", burst: 100, perPeriod: 1200, period: 60 }],
  },
];

// Checks the numbers once at startup and precomputes what the scripts need.
export const compilePolicies = (policies) =>
  policies.map((policy) => ({
    ...policy,
    limits: policy.limits.map((limit) => compileLimit(policy.name, limit)),
  }));

export function compileLimit(policyName, { by, burst, perPeriod, period }) {
  const name = `${policyName}-${by}`;
  for (const [field, value] of Object.entries({ burst, perPeriod, period })) {
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`rate limit ${name}: ${field} must be a positive integer, got ${value}`);
  }
  // The scripts work in whole milliseconds, so the interval is rounded once, here.
  const intervalMs = Math.round((period * 1000) / perPeriod);
  if (intervalMs < 1)
    throw new Error(`rate limit ${name}: more than 1000 requests a second per client isn't supported`);
  return { name, by, burst, perPeriod, period, intervalMs, windowMs: period * 1000 };
}
