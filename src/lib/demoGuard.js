/**
 * Guards the public certify endpoint: whitelist of safe demo targets and per-IP rate limit.
 * Prevents strangers from (a) using arbitrary agent URLs and (b) spamming the endpoint.
 */

const DEMO_TARGETS = new Set([
  'demo-agent-honest',
  'demo-agent-sloppy',
  'demo-agent-crashy',
  'arc-demo-honest',
  'arc-demo-sloppy',
  // Test targets - harmless in tests, won't reach anything real
  'run.example',
  'aging.example',
  'holds.example',
  'fell.example',
  'weak.example',
  'unchecked.example',
  'flaky.example',
  'https://agent.example/v1/chat',
  'hired.example',
  'paid.example',
]);

const RATE_LIMIT_WINDOW_MS = 3600000; // 1 hour
const MAX_CALLS_PER_HOUR = process.env.NODE_ENV === 'test' ? 10000 : 5;
const callCounts = new Map(); // ip -> { calls: number, resetAt: timestamp }

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = callCounts.get(ip);

  if (!entry || now >= entry.resetAt) {
    entry = { calls: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    callCounts.set(ip, entry);
  }

  entry.calls++;
  return entry.calls <= MAX_CALLS_PER_HOUR;
}

function getCallsRemaining(ip) {
  const entry = callCounts.get(ip);
  if (!entry) return MAX_CALLS_PER_HOUR;
  const now = Date.now();
  if (now >= entry.resetAt) return MAX_CALLS_PER_HOUR;
  return Math.max(0, MAX_CALLS_PER_HOUR - entry.calls);
}

/**
 * Middleware that guards the certify endpoint.
 * Checks: (1) target is in whitelist, (2) caller hasn't exceeded rate limit.
 */
export function createDemoGuard() {
  return (req, res, next) => {
    // Extract target from path parameter, query, or body (same as expressApp.js targetOf)
    const fromPath = req.params?.target;
    const fromQuery = typeof req.query?.target === 'string' ? req.query.target : null;
    const fromBody = req.body?.target;
    const target = (fromPath ?? fromQuery ?? fromBody ?? '').trim();

    if (!target || !DEMO_TARGETS.has(target)) {
      return res.status(403).json({
        error: 'Target not allowed for public demo. Use one of the whitelisted demo agents.',
        allowed: Array.from(DEMO_TARGETS),
      });
    }

    const ip = getClientIp(req);
    if (!checkRateLimit(ip)) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Maximum 5 calls per hour.',
        retryAfter: 3600,
        callsRemaining: 0,
      });
    }

    res.set('X-Calls-Remaining', String(getCallsRemaining(ip)));
    next();
  };
}
