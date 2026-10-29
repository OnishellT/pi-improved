---
name: benchmark-checklist
description: "Use when you run a benchmark or report a speedup or regression you measured: vet the measurement (limiter, tuning, limits, errors, repeatability, relevance)."
---

# Benchmark checklist

Use this when you produce or judge a performance number. Answer each question with evidence from a run, not a guess about the code. For a quick ballpark one run is enough: still check 4 and 7, and say it was one run. A choice between options is never a ballpark.

Before running: write down the claim you expect to make in the words you would ship ("export is 30% faster at p50 on the 60k-row dataset"); read the measurement script (what it times, counts and ignores); check `uptime` and `nproc` and say so if the machine is busy.

1. **Why not double?** Name the limiter from a profile or system counters taken in a run you do not report (CPU per process, a runtime profiler, I/O wait, syscalls), mapped to source. A load generator that saturates first means you measured the load generator.
2. **Was it tuned?** Run every side the way production does (release build, production flags, pools, warm or cold caches as in production, same versions and data). A side on defaults means you compared configurations, not implementations: tune it and measure again.
3. **Did it break limits?** Do the arithmetic: bytes per second against disk and network, operations times cost against your cores. Removing a piece that is 10% of the run makes it at most about 11% faster. A result past a limit measured something other than the work.
4. **Did it error?** Count failures and non-success responses and check that outputs are correct. Rejections are fast, timeouts and retries are slow.
5. **Does it reproduce?** Run each side at least 5 times, flipping the order every pair (A, B, B, A, …) so neither side always runs second, and report the median and range. A gap smaller than the run-to-run spread is no difference.
6. **Does it matter?** Measure the end-to-end path a user waits on and report the micro result as a share of it.
7. **Did it happen?** Confirm the work ran inside the timed region (rows written, bytes read, result used). Lazy code and timeouts give numbers for work that never ran.

Report: the verdict first (faster, slower, no measurable difference, inconclusive), then the number with unit, run count, range and limiter ("p50 41 ms to 33 ms, median of 7 runs per side, range 32 to 35 ms, bound by JSON parsing on one core"). It is inconclusive when you cannot name the limiter, a side ran untuned, or 4 or 7 went unchecked: name the gap.
