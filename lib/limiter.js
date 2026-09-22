// Counts failed password attempts per client IP within a time window
function createFailureLimiter({ maxFailures, windowMs }) {
  const failures = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of failures) {
      if (entry.resetAt <= now) failures.delete(ip);
    }
  }, windowMs).unref();

  return {
    isBlocked(ip) {
      const entry = failures.get(ip);
      return Boolean(entry && entry.resetAt > Date.now() && entry.count >= maxFailures);
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = failures.get(ip);
      if (!entry || entry.resetAt <= now) {
        failures.set(ip, { count: 1, resetAt: now + windowMs });
      } else {
        entry.count++;
      }
    }
  };
}

module.exports = { createFailureLimiter };
