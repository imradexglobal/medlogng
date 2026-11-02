# Online transcription workload validation

The Host no longer loads a local speech model. A 4 GB Host therefore avoids Whisper model RAM/CPU load, but internet throughput, browser memory, simultaneous audio uploads, Firebase limits and Deepgram account concurrency/cost still require hospital validation. No 4 GB / 6–10 client result has been measured.

## Procedure

Use a test project, synthetic recordings and the exact candidate Host/client versions. Record Windows edition, CPU, physical/free RAM, disk, network topology and internet uplink. Use 6–10 separate authenticated client computers if available; if simulating clients, label the results and machine limits clearly. Keep Host API concurrency capped at ten; Firebase Functions are configured for a maximum of ten simultaneous calls across five instances.

Run a baseline, then concurrent bursts with realistic 1-, 3- and 5-minute audio. Capture request/response times, upload time, transcription time, p50/p95, errors, queue/busy responses, CPU, RAM, network throughput and provider usage/cost. Repeat with normal Hub/Firestore synchronization active and after Host restart. Confirm overlapping requests do not lose ownership/audit bindings and that retry uses a new request ID.

Audio remains encrypted locally until the clinician asks to transcribe. Reconnection alone must not create an upload. During provider/network outage, confirm pending recordings remain locally available and the Host/EMR remains usable. Do not use production patient audio for load testing.

Report results in [`performance-results-template.csv`](./performance-results-template.csv). Development-machine tests and mock provider tests are not substitutes for the target Host/hospital network run.
