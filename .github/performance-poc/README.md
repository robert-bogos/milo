# Performance check proof of concept (robert-bogos/milo only)

Not part of the Milo change. This fork's branches are served on aem.live without the
`access-control-allow-origin` header that adobecom/milo's site configuration adds, so consumer pages
cannot import their code (`?milolibs=` fails with a CORS error) and the real check
(`.github/workflows/performance-check.yaml`) stops with a CORS message. Two workflows exercise the
unchanged `.github/performance` tooling instead:

- `perf-poc-replay.yaml`: a pull request against `perf-poc` whose description contains
  `Replay: adobecom/milo#<number>` runs the same jobs as the real check on that upstream pull
  request (its branch is served by Code Sync on adobecom/milo), measured against upstream `stage`.
  `Replay: adobecom/milo@<branch>` does the same for an adobecom/milo branch that has no pull
  request, as if one were opened against `stage`, so test changes stay out of the milo PR list.
  The report is commented on the fork pull request. Only the "base moved during the measurement"
  safeguard is not exercised, because it reads the fork's branches.
- `perf-poc-accuracy.yaml`: on push to `perf-poc-accuracy`, measures stage against itself (A/A) and
  against injected regressions in the "after" variant (250 ms of main-thread work at page start, a
  150 px layout shift after the first content), each twice on separate runners, and summarizes
  false failures and detections in the run summary. On the `perf-poc-accuracy` branch it runs
  `accuracy2.mjs` instead: small regressions (`cpuN` = N ms of work, `clsN` = an N px shift), 15
  pairs and 2 warm-ups per variant, optional longer quiet windows (`quiet`), and every run re-audited
  with pinned network latencies and with CPU slowdown normalised by benchmarkIndex, so decision
  rules can be compared offline from the uploaded JSONL artifacts.
