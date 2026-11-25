# Performance check proof of concept (robert-bogos/milo only)

Not part of the Milo change. This fork has no AEM Code Sync, so its own branches are not served on
aem.live and the real check (`.github/workflows/performance-check.yaml`) stops with an
"Install the AEM Code Sync GitHub app" message. Two workflows exercise the unchanged
`.github/performance` tooling instead:

- `perf-poc-replay.yaml`: a pull request against `perf-poc` whose description contains
  `Replay: adobecom/milo#<number>` runs the same jobs as the real check on that upstream pull
  request (its branch is served by Code Sync on adobecom/milo), measured against upstream `stage`.
  The report is commented on the fork pull request. Only the "base moved during the measurement"
  safeguard is not exercised, because it reads the fork's branches.
- `perf-poc-accuracy.yaml`: on push to `perf-poc-accuracy`, measures stage against itself (A/A) and
  against injected regressions in the "after" variant (250 ms of main-thread work at page start, a
  150 px layout shift after the first content), each twice on separate runners, and summarizes
  false failures and detections in the run summary.
