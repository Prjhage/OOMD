/**
 * benchmark.js
 * Benchmark runner — compares the Native Fetch API (Approach A) vs Axios
 * (Approach B) under controlled experimental conditions.
 *
 * Methodology
 * -----------
 * 1. Starts the Express test server in-process.
 * 2. Performs warm-up requests (WARMUP_ITERATIONS) to prime V8 JIT and any
 *    OS-level TCP connection caching before collecting measurements.
 * 3. For each test case, alternates between Fetch and Axios on every
 *    iteration to reduce order bias.
 * 4. Measures wall-clock duration from the first byte sent to the last byte
 *    of the response body parsed (both approaches read the full body).
 * 5. Writes every raw measurement to results/results.csv.
 * 6. Computes per-approach per-test-case aggregates and writes
 *    results/summary.csv.
 */

import { app, PORT } from "./src/server.js";
import * as fetchClient from "./src/fetchApproach.js";
import * as axiosClient from "./src/axiosApproach.js";
import { createObjectCsvWriter } from "csv-writer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Experiment parameters
// ---------------------------------------------------------------------------
const BASE_URL = `http://localhost:${PORT}`;
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 30;
/**
 * CLIENT_TIMEOUT_MS — the timeout the HTTP client will abort at (2 000 ms).
 * For the timeout test case, the server is told to delay by
 * CLIENT_TIMEOUT_MS + 1 000 ms (3 000 ms), so the client always fires first.
 * The ~2 000 ms median recorded for the timeout test is the expected result:
 * it is exactly the duration the client waited before aborting.
 */
const CLIENT_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Test-case definitions
// ---------------------------------------------------------------------------
// Each test case has:
//   key         — identifier used in CSV and summaries
//   label       — human-readable label
//   fetchFn     — function from fetchClient to call
//   axiosFn     — function from axiosClient to call
//   successFn   — predicate: is a result "correctly handled"?
const TEST_CASES = [
  {
    key: "success_small",
    label: "Successful small response",
    fetchFn: (url) => fetchClient.testSuccess(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    axiosFn: (url) => axiosClient.testSuccess(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    // Correct handling = 200 received and body parsed successfully
    successFn: (r) => r.success && r.statusCode === 200,
  },
  {
    key: "success_large",
    label: "Successful large response",
    fetchFn: (url) => fetchClient.testLarge(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    axiosFn: (url) => axiosClient.testLarge(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    successFn: (r) => r.success && r.statusCode === 200,
  },
  {
    key: "http_404",
    label: "HTTP 404 response",
    fetchFn: (url) => fetchClient.testNotFound(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    axiosFn: (url) => axiosClient.testNotFound(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    // Correct handling = client returned success:false with HTTP_4XX category
    successFn: (r) => !r.success && r.errorCategory === "HTTP_4XX",
  },
  {
    key: "http_500",
    label: "HTTP 500 response",
    fetchFn: (url) => fetchClient.testServerError(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    axiosFn: (url) => axiosClient.testServerError(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    successFn: (r) => !r.success && r.errorCategory === "HTTP_5XX",
  },
  {
    key: "timeout",
    label: "Timeout scenario",
    fetchFn: (url) => fetchClient.testDelay(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    axiosFn: (url) => axiosClient.testDelay(url, { timeoutMs: CLIENT_TIMEOUT_MS }),
    // Correct handling = client aborted the request and returned TIMEOUT
    successFn: (r) => !r.success && r.errorCategory === "TIMEOUT",
  },
];

// ---------------------------------------------------------------------------
// CSV output paths
// ---------------------------------------------------------------------------
const RESULTS_DIR = path.join(__dirname, "results");
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const RAW_CSV_PATH = path.join(RESULTS_DIR, "results.csv");
const SUMMARY_CSV_PATH = path.join(RESULTS_DIR, "summary.csv");

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/** Sort array numerically and return the value at a given percentile [0–100]. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 95);
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values) {
  const avg = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

// ---------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------
async function warmUp(label) {
  process.stdout.write(`  Warming up (${WARMUP_ITERATIONS} reqs each) …`);
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await fetchClient.testSuccess(BASE_URL, { timeoutMs: CLIENT_TIMEOUT_MS });
    await axiosClient.testSuccess(BASE_URL, { timeoutMs: CLIENT_TIMEOUT_MS });
  }
  console.log(" done.");
}

// ---------------------------------------------------------------------------
// Main benchmark loop
// ---------------------------------------------------------------------------
async function runBenchmark() {
  const allRows = []; // raw measurements written to results.csv
  const summaryRows = []; // aggregated metrics written to summary.csv

  console.log("\n=== API Integration Comparison Benchmark ===");
  console.log(`Base URL       : ${BASE_URL}`);
  console.log(`Warm-up rounds : ${WARMUP_ITERATIONS}`);
  console.log(`Measured iters : ${MEASURED_ITERATIONS}`);
  console.log(`Client timeout : ${CLIENT_TIMEOUT_MS} ms\n`);

  await warmUp();

  let globalIteration = 0;

  for (const tc of TEST_CASES) {
    console.log(`\n[Test case] ${tc.label}`);

    const fetchResults = [];
    const axiosResults = [];

    for (let i = 0; i < MEASURED_ITERATIONS; i++) {
      globalIteration++;

      // Alternate order on each iteration to reduce bias.
      const fetchFirst = i % 2 === 0;

      const runAndRecord = async (approach, fn, store) => {
        const result = await fn(BASE_URL);
        const correctlyHandled = tc.successFn(result) ? 1 : 0;

        const row = {
          approach,
          testCase: tc.key,
          iteration: i + 1,
          responseTimeMs: result.durationMs.toFixed(3),
          // For the timeout test, record the configured threshold so readers
          // understand that ~2 000 ms is the expected abort duration, not
          // a performance problem.
          timeoutThresholdMs: tc.key === "timeout" ? CLIENT_TIMEOUT_MS : "",
          httpStatus: result.statusCode ?? "N/A",
          success: result.success ? "true" : "false",
          errorCategory: result.errorCategory ?? "",
          payloadBytes: result.payloadBytes,
          correctlyHandled,
        };

        allRows.push(row);
        store.push({ ...result, correctlyHandled });
      };

      if (fetchFirst) {
        await runAndRecord("Fetch", tc.fetchFn, fetchResults);
        await runAndRecord("Axios", tc.axiosFn, axiosResults);
      } else {
        await runAndRecord("Axios", tc.axiosFn, axiosResults);
        await runAndRecord("Fetch", tc.fetchFn, fetchResults);
      }

      process.stdout.write(
        `\r  Iteration ${String(i + 1).padStart(2)} / ${MEASURED_ITERATIONS} complete`
      );
    }

    console.log(); // newline after progress indicator

    // Compute aggregates for this test case
    for (const [approach, results] of [
      ["Fetch", fetchResults],
      ["Axios", axiosResults],
    ]) {
      const times = results.map((r) => r.durationMs);
      const handled = results.filter((r) => r.correctlyHandled).length;
      const handlingRate = (handled / results.length) * 100;

      const row = {
        approach,
        testCase: tc.key,
        testLabel: tc.label,
        iterations: results.length,
        medianResponseTimeMs: median(times).toFixed(3),
        p95ResponseTimeMs: p95(times).toFixed(3),
        meanResponseTimeMs: mean(times).toFixed(3),
        stddevMs: stddev(times).toFixed(3),
        correctHandlingRate: handlingRate.toFixed(1),
        correctlyHandledCount: handled,
        totalCount: results.length,
      };

      summaryRows.push(row);

      console.log(
        `  [${approach}] median=${row.medianResponseTimeMs} ms  p95=${row.p95ResponseTimeMs} ms  handling=${row.correctHandlingRate}%`
      );
    }
  }

  return { allRows, summaryRows };
}

// ---------------------------------------------------------------------------
// CSV writers
// ---------------------------------------------------------------------------
async function writeRawCsv(rows) {
  const writer = createObjectCsvWriter({
    path: RAW_CSV_PATH,
    header: [
      { id: "approach", title: "Approach" },
      { id: "testCase", title: "Test Case" },
      { id: "iteration", title: "Iteration" },
      { id: "responseTimeMs", title: "Response Time (ms)" },
      { id: "timeoutThresholdMs", title: "Timeout Threshold (ms)" },
      { id: "httpStatus", title: "HTTP Status" },
      { id: "success", title: "Success" },
      { id: "errorCategory", title: "Error Category" },
      { id: "payloadBytes", title: "Payload Size (bytes)" },
      { id: "correctlyHandled", title: "Correctly Handled" },
    ],
  });
  await writer.writeRecords(rows);
  console.log(`\nRaw results   -> ${RAW_CSV_PATH}`);
}

async function writeSummaryCsv(rows) {
  const writer = createObjectCsvWriter({
    path: SUMMARY_CSV_PATH,
    header: [
      { id: "approach", title: "Approach" },
      { id: "testCase", title: "Test Case" },
      { id: "testLabel", title: "Test Label" },
      { id: "iterations", title: "Iterations" },
      { id: "medianResponseTimeMs", title: "Median Response Time (ms)" },
      { id: "p95ResponseTimeMs", title: "P95 Response Time (ms)" },
      { id: "meanResponseTimeMs", title: "Mean Response Time (ms)" },
      { id: "stddevMs", title: "Std Dev (ms)" },
      { id: "correctHandlingRate", title: "Correct Handling Rate (%)" },
      { id: "correctlyHandledCount", title: "Correctly Handled Count" },
      { id: "totalCount", title: "Total Count" },
    ],
  });
  await writer.writeRecords(rows);
  console.log(`Summary       -> ${SUMMARY_CSV_PATH}`);
}

// ---------------------------------------------------------------------------
// Integration complexity measurements
// ---------------------------------------------------------------------------

/**
 * COMPLEXITY_ROWS - source-of-truth for the integration complexity table.
 *
 * Line counts measured with PowerShell (run from project root):
 * Results: fetchApproach.js = 92, axiosApproach.js = 88.
 */
const COMPLEXITY_ROWS = [
  {
    metric: "External npm dependencies (HTTP client only)",
    fetchValue: "0",
    axiosValue: "1 (axios)",
    notes: "Fetch is built-in since Node 18; Axios requires npm install",
  },
  {
    metric: "Implementation lines (non-blank, non-comment)",
    fetchValue: "92",
    axiosValue: "88",
    notes: "Counted with PowerShell Where-Object filter on each client file",
  },
  {
    metric: "Total file lines (including docs)",
    fetchValue: "159",
    axiosValue: "166",
    notes: "Raw wc -l equivalent",
  },
  {
    metric: "Timeout mechanism",
    fetchValue: "AbortController + clearTimeout",
    axiosValue: "axios.create({ timeout })",
    notes: "Fetch requires manual wiring; Axios integrates natively",
  },
  {
    metric: "HTTP error detection",
    fetchValue: "Manual (!response.ok)",
    axiosValue: "Manual (status range check)",
    notes: "Both require explicit status checks because validateStatus:()=>true",
  },
  {
    metric: "JSON body parsing",
    fetchValue: "Manual (response.text + JSON.parse)",
    axiosValue: "Automatic",
    notes: "Axios parses JSON automatically; Fetch requires two async steps",
  },
  {
    metric: "Instance / config mechanism",
    fetchValue: "Per-call options object",
    axiosValue: "axios.create() named instance",
    notes: "Axios supports reusable configured instances",
  },
  {
    metric: "Payload byte measurement",
    fetchValue: "Buffer.byteLength(rawText)",
    axiosValue: "Buffer.byteLength(JSON.stringify(data))",
    notes: "Slight re-serialisation overhead in Axios path; negligible",
  },
];

const COMPLEXITY_CSV_PATH = path.join(RESULTS_DIR, "complexity.csv");

async function writeComplexityCsv() {
  const writer = createObjectCsvWriter({
    path: COMPLEXITY_CSV_PATH,
    header: [
      { id: "metric", title: "Metric" },
      { id: "fetchValue", title: "Fetch API (A)" },
      { id: "axiosValue", title: "Axios (B)" },
      { id: "notes", title: "Notes" },
    ],
  });
  await writer.writeRecords(COMPLEXITY_ROWS);
  console.log(`Complexity    -> ${COMPLEXITY_CSV_PATH}`);
}

function printComplexityTable() {
  console.log("\n=== Integration Complexity Measurements ===");
  console.log(
    "Metric".padEnd(46) + "Fetch API".padEnd(36) + "Axios"
  );
  console.log("-".repeat(100));
  for (const { metric, fetchValue, axiosValue } of COMPLEXITY_ROWS) {
    console.log(metric.padEnd(46) + fetchValue.padEnd(36) + axiosValue);
  }
  console.log(
    "\nNote: Line counts are non-blank, non-comment lines measured with PowerShell."
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  // Start the Express server
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(PORT, () => resolve(s));
    s.on("error", reject);
  });
  console.log(`[benchmark] Server started on port ${PORT}`);

  try {
    const { allRows, summaryRows } = await runBenchmark();
    await writeRawCsv(allRows);
    await writeSummaryCsv(summaryRows);
    await writeComplexityCsv();
    printComplexityTable();

    console.log("\nBenchmark complete.");
    console.log(
      "  Next step: run  python analysis/generate_graphs.py  to generate graphs."
    );
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("[benchmark] Fatal error:", err);
  process.exit(1);
});
