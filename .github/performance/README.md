# Per-PR performance checks

Measures the [MVP pages](config.json) and demo pages that load the code a pull request changes,
before and after the change, and comments the result on the pull request. Design:
[discussion #393](https://github.com/orgs/adobecom/discussions/393) (MWPW-213684). The pages are
measured with [adobecom/perf-tools](https://github.com/adobecom/perf-tools) (perf-ab) at the commit
pinned in the workflow (`PERF_TOOLS_REF`).

## How a check runs

| Job | What it does |
| --- | --- |
| Find affected pages | Lists the `libs/` files the pull request changes since it branched from the base branch, reads demo pages from the description and loads every MVP and demo page once (production, `martech=off`) to record the `/libs/` files it requests. Pages that request a changed file are measured. Saves the before and after versions of the files to swap. |
| Measure (one job per page) | perf-tools loads the production page with `martech=off` in 10 counterbalanced cold pairs (AB, BA…): Lighthouse 13.6.0 mobile defaults with real DevTools throttling (Slow 4G, 4× CPU), a fresh Chrome and profile per load, and invalid loads retried. One unmeasured load first absorbs the slower first load of a fresh runner. Its proxy replaces the page's Milo files with the before or after versions, served from the runner. |
| Pick pages to re-measure | Pages that fail are measured again on a new runner. |
| Re-measure | Same as Measure. |
| Report | One pull request comment, updated in place, and the job summary. |

- Both sides run the pull request's base code, not production's: files that differ between
  production (`adobecom/milo` `main`) and the merge base are swapped in at their merge-base version
  on both sides, and the changed files at their merge-base (before) and pull request (after)
  versions. Content, other sites' code and third parties are production.
- Lighthouse reports of pages that do not pass are kept as `perf-traces-*` artifacts for 7 days,
  with the traces of the first two pairs (one in each order), so custom performance marks and the
  LCP element can be checked.
- The tooling, thresholds and perf-tools version come from the base branch, so a pull request
  cannot change its own check. The check uses the base branch as it is when the check starts.
- Changes outside `libs/` (tests, docs, Nala, tooling) skip the check.
- Nothing is deployed: the files are read from git, so no branch needs to be served on aem.live.

## When a page fails

A gated metric regresses when **both** are true for the valid pairs:

1. the mean got worse by more than `max(relative × before, absolute)`;
2. a one-sided [Wilcoxon signed-rank test](https://en.wikipedia.org/wiki/Wilcoxon_signed-rank_test)
   on the paired differences gives p < 0.05 (exact distribution, tied ranks averaged).

| Metric | Gates | Limit |
| --- | --- | --- |
| LCP | yes | +10% |
| CLS | yes | +0.005 |
| TBT | no, shown only | +20% and at least +50 ms |
| FCP | no, shown only | +10% |

- A page fails only when the same metric regresses in the first round **and** in the re-run.
- **Runner calibration:** a pair is dropped when either run's Lighthouse `benchmarkIndex` is below
  80% of the job's median, meaning the runner was unusually slow. With fewer than 7 valid pairs the
  page is inconclusive (with 7 pairs the smallest possible p is 1/128).
- **Inconclusive never fails the check.** Causes: too few valid pairs, perf-tools errors, a missing
  or inconclusive re-run, a page that could not be loaded to check which files it uses, or a page
  that loads Milo from another host.

## Demo pages

Add a page with real content that uses the changed code to the pull request description:

    - Demo: https://www.adobe.com/<page>.html

- Production `*.adobe.com` pages, or published Milo pages on `https://main--milo--adobecom.aem.live`
  (for example under `/drafts/`). perf-tools swaps files only on the page's own host: other
  aem.live sites and stage hosts load Milo from another host, and `.aem.page` drafts are not
  published.
- Up to two demo pages. Editing the description re-runs the check.
- Demo pages decide the result only when no MVP page loads the changed code; otherwise they are
  shown for reference.
- If `libs/` changed, no MVP page loads the changed files and there is no demo page, the check fails
  with *Demo page needed*.
- Production only shows files that are released. When the pull request changes files that are not
  on production yet, demo pages are measured even if they do not request them.
- **New blocks** have no "before": publish a Milo page that uses the block. It is checked against
  the green Core Web Vitals bands (median of the runs). CLS above 0.1 fails. LCP above 2.5 s and
  TBT above 200 ms are shown only, because throttled mobile LCP is above 2.5 s on most Adobe pages.

## Configuration

`config.json` holds the pages, `martechOff`, metric limits, green bands, pair counts (`pairs`, `minPairs`),
runner calibration and the production repository.

| Repository variable | Effect |
| --- | --- |
| `PERF_CHECKS` | `on` enables the workflow. |
| `PERF_RUNNER` | Runner label, default `gh-hosted`. |
| `PERF_ENFORCE` | `true` fails the check on a confirmed regression or a missing demo page. Otherwise the check only reports. |

## Requirements

- Runner access to `github.com` (git and perf-tools), `registry.npmjs.org`, the Chrome download
  (unless Chrome is installed), the measured pages and the third-party hosts they load.
- US runners. perf-tools warns when the page reports a non-US visitor (for example a cookie banner
  as LCP); the report shows the warning.
- Up to 17 page jobs per round (15 MVP pages and 2 demo pages), each about 7–25 minutes. A check
  takes about 30 minutes, or about an hour when a page is re-measured.
- Pull requests from forks get a read-only token, so their report is only in the job summary.

## Limitations

- Lab data, not field data.
- Only text files (`.js`, `.css`, `.json`, `.html`, `.svg`, `.txt`) are swapped; changed images and
  fonts are listed but not measured. Deleted files are not removed from the page.
- Discovery does not scroll or click, so code that loads only on interaction is not detected.
- perf-tools measures at most 10 pairs per page.
- CLS is the page's largest burst of layout shifts. A new shift that lands outside that burst
  and is smaller than it leaves CLS unchanged, so it does not fail the check.
- Speed Index does not gate, so the workflow makes it optional in perf-tools, which otherwise
  rejects a load without one. On US runners, `acrobat.html` is covered by a near-white layer about
  20 seconds into the load, which makes its Speed Index 0. LCP and CLS are not affected.
- Lighthouse 13 can raise a protocol error from its CPU-idle wait after the page closed or
  navigated, outside the load it belongs to. The measure job ignores these errors, which would
  otherwise stop perf-tools and lose the page's finished pairs.

## Local use

```sh
cd .github/performance
npm ci --ignore-scripts
npm test
```

`node cli.js measure` needs a perf-tools checkout (`PERF_TOOLS_DIR`, with
`npm ci --omit=dev --ignore-scripts`), a sources directory from `node cli.js plan`
(`PERF_SOURCES_DIR`) and the page (`PERF_PAGE`, a matrix entry from the plan). Results are written
to `perf-output/`, or to `PERF_OUT_DIR`. Outside the US, pages may show a cookie banner, which
changes LCP.
