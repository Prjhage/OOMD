/**
 * src/server.js
 * Express test API server for the benchmark.
 *
 * Endpoints:
 *   GET /api/success      — small JSON response (200)
 *   GET /api/large        — large JSON response (200)
 *   GET /api/not-found    — HTTP 404
 *   GET /api/server-error — HTTP 500
 *   GET /api/delay?ms=N   — delayed response (configurable milliseconds)
 *
 * When executed directly (`node src/server.js`) the server starts listening.
 * When imported by benchmark.js, only the `app` and `PORT` exports are used;
 * the listener is managed by the benchmark runner to avoid port conflicts.
 */

import express from "express";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Helper — build a large payload deterministically
// ---------------------------------------------------------------------------
function buildLargePayload() {
  const items = [];
  for (let i = 0; i < 500; i++) {
    items.push({
      id: i,
      name: `Item ${i}`,
      value: Math.round(Math.sin(i) * 1000) / 10,
      description: `Description for item ${i}. This text adds bulk to the payload so that response-size effects are measurable.`,
      tags: ["alpha", "beta", "gamma"].slice(0, (i % 3) + 1),
      active: i % 2 === 0,
    });
  }
  return { count: items.length, items };
}

const LARGE_PAYLOAD = buildLargePayload();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/success
 * Returns a small JSON object — baseline for median response-time measurement.
 */
app.get("/api/success", (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Request successful",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/large
 * Returns a pre-built large JSON payload — tests throughput with bigger bodies.
 */
app.get("/api/large", (_req, res) => {
  res.status(200).json(LARGE_PAYLOAD);
});

/**
 * GET /api/not-found
 * Always returns HTTP 404 — used to verify correct 4xx error handling.
 */
app.get("/api/not-found", (_req, res) => {
  res.status(404).json({
    status: "error",
    error: "Not Found",
    message: "The requested resource does not exist.",
  });
});

/**
 * GET /api/server-error
 * Always returns HTTP 500 — used to verify correct 5xx error handling.
 */
app.get("/api/server-error", (_req, res) => {
  res.status(500).json({
    status: "error",
    error: "Internal Server Error",
    message: "Simulated server-side error for testing purposes.",
  });
});

/**
 * GET /api/delay?ms=N
 * Delays the response by `ms` milliseconds (default 300).
 * Used to verify timeout-handling behaviour.
 */
app.get("/api/delay", (req, res) => {
  const ms = Math.max(0, parseInt(req.query.ms, 10) || 300);
  setTimeout(() => {
    res.status(200).json({
      status: "ok",
      message: `Response delayed by ${ms} ms`,
      delayMs: ms,
    });
  }, ms);
});

// ---------------------------------------------------------------------------
// Start — only when executed directly, not when imported
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] === __filename) {
  app.listen(PORT, () => {
    console.log(`[server] Test API server listening on http://localhost:${PORT}`);
  });
}

// Export for programmatic use by the benchmark runner
export { app, PORT };
