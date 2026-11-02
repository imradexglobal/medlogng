# Windows Host speech performance benchmark

Target: the hospital Host's supported Windows edition, 4 GB RAM, and 6–10 client computers. Run this only on a dedicated test installation with synthetic or consented/de-identified recordings. Never use identifiable patient audio for the benchmark.

## Capture setup

1. Record the Windows edition/build, CPU model/core count, physical RAM, storage type/free space, power plan, Host version, installer SHA-256, asset manifest hash, worker/model/FFmpeg hashes, and network topology.
2. Close unrelated applications. Start the Host and allow 10 minutes of idle time. Record Host-process and worker-process working set, total system committed/available memory and CPU once per second for the final five idle minutes.
3. Use known, non-clinical recordings of exactly 1, 3 and 5 minutes in WAV, MP3, M4A, AAC, WebM and OGG as applicable. Freeze inputs and record their SHA-256, codec, sample rate, channels and duration. Do not use text as an accuracy reference for medical claims.
4. For every duration/format, run 3 single-client trials. Record upload start/finish, job accepted, processing start, completion, errors, Host/worker peak RAM, average/peak CPU and queue depth. Separate upload, queue wait, conversion, inference and total end-to-end time where timestamps are available.
5. Run synchronized uploads from 6 clients, then 10 clients. Use 1-minute recordings first; repeat 3- and 5-minute inputs only if the Host remains stable. The production worker is intentionally single-inference; measure queue wait and completion spread rather than expecting parallel CPU inference.
6. Repeat a 10-client burst three times. Verify every accepted job has one owner, one final result, and one preserved/recoverable audio file until completion. Test an interrupted upload and worker restart in the dedicated test environment; record recovery and failed-job behavior.
7. Run the longest 5-minute case for 30 minutes of repeated queue load only after the burst tests pass. Record thermal throttling, disk growth, failures and effect on ordinary Host responsiveness.
8. Fill [`performance-results-template.csv`](./performance-results-template.csv) one row per job and attach a separate one-second system/process counter log. Keep real audio outside Git and store it in the approved restricted location.

## Measurements and acceptance

- **Idle memory:** Host + worker working set and total system available memory after the idle period.
- **Peak memory:** maximum one-second sample for Host, worker and total system during the test; also record committed memory.
- **CPU:** per-process and total utilization, accounting for the number of logical processors used by Windows' performance counters.
- **Inference duration:** worker processing start through completion, excluding upload and queue wait.
- **Queue wait:** accepted timestamp through worker processing start.
- **Reliability:** submitted, accepted, completed, failed, cancelled, timed out, recovered, duplicate and lost jobs; include audio preservation and owner verification.
- **Concurrent clients:** client count, burst interval, number of outstanding jobs and throughput over wall-clock time.

Phase 1 target-hardware performance remains unverified until the measurements are collected on an actual 4 GB Host. Do not extrapolate the 8 GB development machine's short-sample worker memory/time result to this target.
