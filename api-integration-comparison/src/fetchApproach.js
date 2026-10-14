/**
 * src/fetchApproach.js
 * Approach A — Native Fetch API HTTP client.
 *
 * Implements the same interface as axiosApproach.js so both can be called
 * identically from the benchmark runner.
 *
 * Complexity metrics (counted for integration complexity table):
 *   - External dependencies added: 0  (Fetch is built-in since Node 18)
 *   - Lines of implementation code: see below (comment-free)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 2000; // request-level abort timeout

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

/**
 * makeRequest — sends an HTTP GET request using the native Fetch API.
 *
 * Returns a result object with a consistent shape regardless of success or
 * failure so the benchmark runner can treat both approaches uniformly.
 *
 * @param {string} url          - Full URL to request.
 * @param {object} [options={}] - Optional overrides.
 * @param {number} [options.timeoutMs] - Per-request timeout in milliseconds.
 * @returns {Promise<RequestResult>}
 */
async function makeRequest(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startTime = performance.now();

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    // Always read the body so that body-parsing time is included in the
    // measured duration and the comparison is fair.
    let data = null;
    let parseError = null;
    const rawText = await response.text();
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      parseError = err.message;
    }

    const durationMs = performance.now() - startTime;
    const payloadBytes = Buffer.byteLength(rawText, "utf8");

    // Treat any non-2xx status as an error (mirrors Axios default behaviour).
    if (!response.ok) {
      return {
        success: false,
        statusCode: response.status,
        durationMs,
        payloadBytes,
        data,
        errorCategory: `HTTP_${Math.floor(response.status / 100)}XX`,
        errorMessage: `HTTP ${response.status}`,
      };
    }

    if (parseError) {
      return {
        success: false,
        statusCode: response.status,
        durationMs,
        payloadBytes,
        data: null,
        errorCategory: "PARSE_ERROR",
        errorMessage: parseError,
      };
    }

    return {
      success: true,
      statusCode: response.status,
      durationMs,
      payloadBytes,
      data,
      errorCategory: null,
      errorMessage: null,
    };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = performance.now() - startTime;

    // AbortError means the timeout fired before the response arrived.
    const isTimeout =
      err.name === "AbortError" || err.message?.includes("aborted");

    return {
      success: false,
      statusCode: null,
      durationMs,
      payloadBytes: 0,
      data: null,
      errorCategory: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      errorMessage: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Named test-case helpers (called by benchmark.js)
// ---------------------------------------------------------------------------

export async function testSuccess(baseUrl, opts) {
  return makeRequest(`${baseUrl}/api/success`, opts);
}

export async function testLarge(baseUrl, opts) {
  return makeRequest(`${baseUrl}/api/large`, opts);
}

export async function testNotFound(baseUrl, opts) {
  return makeRequest(`${baseUrl}/api/not-found`, opts);
}

export async function testServerError(baseUrl, opts) {
  return makeRequest(`${baseUrl}/api/server-error`, opts);
}

/**
 * testDelay — requests the /api/delay endpoint with a delay that exceeds
 * the client timeout so that the timeout code-path is reliably exercised.
 */
export async function testDelay(baseUrl, opts = {}) {
  // Server delays 3 s; client timeout is 2 s → timeout always fires.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const serverDelayMs = timeoutMs + 1000;
  return makeRequest(`${baseUrl}/api/delay?ms=${serverDelayMs}`, {
    ...opts,
    timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Metadata used by the integration-complexity table
// ---------------------------------------------------------------------------
export const metadata = {
  name: "Fetch API",
  approach: "A",
  externalDependencies: 0,
  // Actual count: non-blank, non-comment lines in this entire file.
  // Measured with: Get-Content src/fetchApproach.js | Where-Object { $_ -notmatch '^\ *$' -and $_ -notmatch '^\ *//' -and $_ -notmatch '^\ */\*' -and $_ -notmatch '^\ *\*' } | Measure-Object
  implementationLines: 92,
};
