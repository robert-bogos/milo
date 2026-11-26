# Replay of adobecom/milo@perf-check-test-lcp

plans-hero.js busy-waits 400 ms before rendering the hero. Local run: LCP +4.4% (p 0.016) stays under the 10% gate, so the check passes; TBT +1,556 ms is reported as informational. See perf-check-test-lcp-big for the failing case.

https://github.com/adobecom/milo/tree/perf-check-test-lcp
