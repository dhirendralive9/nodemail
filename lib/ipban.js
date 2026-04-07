const LoginLog = require("../models/LoginLog");

// Configurable via env
const MAX_FAILURES      = parseInt(process.env.LOGIN_MAX_FAILURES) || 5;   // failures before ban
const BAN_WINDOW_MIN    = parseInt(process.env.LOGIN_BAN_WINDOW)  || 15;   // time window in minutes
const BAN_DURATION_MIN  = parseInt(process.env.LOGIN_BAN_DURATION)|| 30;   // ban duration in minutes

// In-memory ban cache (backed by DB lookups)
const banCache = new Map(); // ip -> { bannedUntil: Date }

/**
 * Check if an IP is currently banned.
 * Returns { banned: true, remainingMin: N } or { banned: false }
 */
async function checkBan(ip) {
  // Check in-memory cache first
  const cached = banCache.get(ip);
  if (cached && cached.bannedUntil > new Date()) {
    const remainingMin = Math.ceil((cached.bannedUntil - new Date()) / 60000);
    return { banned: true, remainingMin };
  }

  // Check DB: count recent failures for this IP
  const windowStart = new Date(Date.now() - BAN_WINDOW_MIN * 60 * 1000);
  const failCount = await LoginLog.countDocuments({
    ip,
    success: false,
    date: { $gte: windowStart },
  });

  if (failCount >= MAX_FAILURES) {
    // Find the last failure to calculate ban end
    const lastFail = await LoginLog.findOne({ ip, success: false })
      .sort({ date: -1 }).lean();

    if (lastFail) {
      const bannedUntil = new Date(lastFail.date.getTime() + BAN_DURATION_MIN * 60 * 1000);
      if (bannedUntil > new Date()) {
        banCache.set(ip, { bannedUntil });
        const remainingMin = Math.ceil((bannedUntil - new Date()) / 60000);
        return { banned: true, remainingMin };
      }
    }
  }

  // Not banned — clear cache if exists
  banCache.delete(ip);
  return { banned: false };
}

/**
 * Record a login attempt.
 */
async function recordAttempt({ email, userId, ip, userAgent, success, reason }) {
  await LoginLog.create({ email, userId, ip, userAgent, success, reason });

  // If failed, check if this triggers a ban
  if (!success) {
    const windowStart = new Date(Date.now() - BAN_WINDOW_MIN * 60 * 1000);
    const failCount = await LoginLog.countDocuments({
      ip,
      success: false,
      date: { $gte: windowStart },
    });

    if (failCount >= MAX_FAILURES) {
      const bannedUntil = new Date(Date.now() + BAN_DURATION_MIN * 60 * 1000);
      banCache.set(ip, { bannedUntil });
      console.log(`IP BANNED: ${ip} — ${failCount} failures in ${BAN_WINDOW_MIN}min — banned until ${bannedUntil.toISOString()}`);
    }
  } else {
    // Successful login clears ban cache for this IP
    banCache.delete(ip);
  }
}

/**
 * Get client IP, respecting X-Forwarded-For from Nginx/Cloudflare.
 */
function getClientIP(req) {
  const cfIP = req.headers["cf-connecting-ip"];
  if (cfIP) return cfIP;

  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();

  const realIP = req.headers["x-real-ip"];
  if (realIP) return realIP;

  return req.ip || req.connection?.remoteAddress || "unknown";
}

module.exports = { checkBan, recordAttempt, getClientIP, MAX_FAILURES, BAN_WINDOW_MIN, BAN_DURATION_MIN };
