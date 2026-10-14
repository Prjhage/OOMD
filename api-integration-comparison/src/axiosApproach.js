/**
 * src/axiosApproach.js
 * Approach B — Axios HTTP client.
 *
 * Implements the same interface as fetchApproach.js so both can be called
 * identically from the benchmark runner.
 *
 * Complexity metrics (counted for integration complexity table):
 *   - External dependencies added: 1  (axios npm package)
 *   - Lines of implementation code: see below (comment-free)
 */

import axios from "axios";

// ---------------------------------------------------------------------------
// Configuration — mirrors fetchApproach settings
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * createAxiosInstance — returns a configured Axios instance.
 * Creating a named instance makes it straightforward to apply shared
 * defaults (base URL, timeout, headers) without repeating them per-call.
 */
function createAxiosInstance(baseUrl, timeoutMs) {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    // Accept all status codes so we can measure the response time of
    // error responses (4xx / 5xx) before deciding whether they are errors.
    // This mirrors the Fetch approach where we always read the body first.
    validateStatus: () => true,
  });
}

// ---------------------------------------------------------------------------
// Core request function
// ---------------------------------------------------------------------------

/**
 * makeRequest — sends an HTTP GET request using Axios.
 *
 * Returns the same result shape as fetchApproach.makeRequest so the
 * benchmark runner can treat both approaches uniformly.
 *
 * @param {string} url          - Full URL to request.
 * @param {object} [options={}] - Optional overrides.
 * @param {number} [options.timeoutMs] - Per-request timeout in milliseconds.
 * @returns {Promise<RequestResult>}
 */
async function makeRequest(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build a one-off instance so timeoutMs can vary per-call (e.g. timeout test).
  const instance = axios.create({
    timeout: timeoutMs,
    validateStatus: () => true, // handle all statuses manually
  });

  const startTime = performance.now();

  try {
    const response = await instance.get(url);
    const durationMs = performance.now() - startTime;

    // Compute payload size from the serialised response data (Axios already
    // parsed the JSON body, so we re-serialise for a fair byte comparison).
    const rawText = JSON.stringify(response.data);
    const payloadBytes = Buffer.byteLength(rawText, "utf8");

    // Treat any non-2xx status as an error (consistent with Fetch approach).
    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        statusCode: response.status,
        durationMs,
        payloadBytes,
        data: response.data,
        errorCategory: `HTTP_${Math.floor(response.status / 100)}XX`,
        errorMessage: `HTTP ${response.status}`,
      };
    }

    return {
      success: true,
      statusCode: response.status,
      durationMs,
      payloadBytes,
      data: response.data,
      errorCategory: null,
      errorMessage: null,
    };
  } catch (err) {
    const durationMs = performance.now() - startTime;

    // Determine whether Axios classified this as a timeout.
    const isTimeout =
      axios.isAxiosError(err) &&
      (err.code === "ECONNABORTED" || err.code === "ERR_CANCELED");

    // Network-level errors (e.g., ECONNREFUSED) that are not timeouts.
    const isNetwork = axios.isAxiosError(err) && !isTimeout;

    return {
      success: false,
      statusCode: err.response?.status ?? null,
      durationMs,
      payloadBytes: 0,
      data: null,
      errorCategory: isTimeout
        ? "TIMEOUT"
        : isNetwork
        ? "NETWORK_ERROR"
        : "UNKNOWN_ERROR",
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
  name: "Axios",
  approach: "B",
  externalDependencies: 1,
  // Actual count: non-blank, non-comment lines in this entire file.
  // Measured with: Get-Content src/axiosApproach.js | Where-Object { $_ -notmatch '^\ *$' -and $_ -notmatch '^\ *//' -and $_ -notmatch '^\ */\*' -and $_ -notmatch '^\ *\*' } | Measure-Object
  implementationLines: 88,
};
