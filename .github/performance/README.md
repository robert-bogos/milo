# Per-PR performance checks

Measures the [MVP pages](config.json) that load the code a pull request changes, before and after
the change, and comments the result on the pull request. Design:
[discussion #393](https://github.com/orgs/adobecom/discussions/393) (MWPW-213684).

## How a check runs

| Job | What it does |
| --- | --- |
| Find affected pages | Lists the changed `libs/` files, checks that both branches are served on aem.live, reads demo pages from the description and loads every MVP and demo page once per variant to record the `/libs/` files it requests. Pages that load a changed file are measured. |
| Measure (one job per page) | One warm-up per variant, then 7 interleaved pairs (AB, BA, AB…). Every run uses a fresh Chrome with a cold cache, Lighthouse mobile with simulated throttling (the PageSpeed Insights defaults) and `martech=off`. |
| Pick pages to re-measure | Pages that fail are measured again on a new runner. |
| Re-measure | Same as Measure. |
| Report | One pull request comment, updated in place, and the job summary. |

- **Before** loads Milo from the base branch (`stage--milo--adobecom.aem.live`), **after** from the
  pull request branch (`<branch>--milo--<owner>.aem.live`). Consumer pages get `?milolibs=`; Milo
  pages are loaded from the branch host.
- The tooling and thresholds always come from the base branch, so a pull request cannot change its
  own check.
- Changes outside `libs/` (tests, docs, Nala, tooling) skip the check.

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
  80% of the job's median, meaning the runner was unusually slow. Up to 3 extra pairs replace dropped
  or failed pairs. With fewer than 5 valid pairs the page is inconclusive (with 5 pairs the
  smallest possible p is 1/32, with 7 it is 1/128).
- **Inconclusive never fails the check.** Causes: too few valid pairs, a missing or inconclusive
  re-run, a page that could not be loaded to check which files it uses, or the base branch changing
  files the page loads. If the base branch changed them after the pull request branched, the page
  is not measured; update the branch.

## Demo pages

Add a published page with real content that uses the changed code to the pull request description:

    - Demo: https://main--<site>--adobecom.aem.live/<page>

- Up to two demo pages. Editing the description re-runs the check.
- Only `.aem.live` pages; drafts are not representative. Production `adobe.com` pages cannot load
  branch code, so use their aem.live mirror.
- Demo pages are always measured. They decide the result only when no MVP page loads the changed
  code; otherwise they are shown for reference.
- If `libs/` changed, no MVP page loads the changed files and there is no demo page, the check fails
  with *Demo page needed*.
- **New blocks** have no "before": a `.aem.page` draft is accepted and the page is checked against
  the green Core Web Vitals bands (median of the runs). CLS above 0.1 fails. LCP above 2.5 s and
  TBT above 200 ms are shown only, because simulated mobile LCP is above 2.5 s on most Adobe pages.

## Configuration

`config.json` holds the pages, metric limits, green bands, pair counts and runner calibration.
`throttlingMethod` (`simulate`, `devtools` or `provided`) and an optional Lighthouse `throttling`
object can be changed for experiments.

| Repository variable | Effect |
| --- | --- |
| `PERF_CHECKS` | `on` enables the workflow. |
| `PERF_RUNNER` | Runner label, default `gh-hosted`. |
| `PERF_ENFORCE` | `true` fails the check on a confirmed regression or a missing demo page. Otherwise the check only reports. |

## Requirements

- AEM Code Sync on the repository, so every branch is served at `<branch>--milo--<owner>.aem.live`.
  `<branch>--milo--<owner>` must be at most 63 characters.
- Runner access to `registry.npmjs.org`, the Chrome download (unless Chrome is installed),
  `*.aem.live` and the third-party hosts the pages load.
- Up to 17 page jobs per round (15 MVP pages and 2 demo pages).
- Pull requests from forks get a read-only token, so their report is only in the job summary.

## Limitations

- Lab data, not field data. Pages with a late LCP need a large regression to exceed +10%: Photoshop
  has a simulated LCP of about 37 s because its LCP text appears about 5 s after navigation.
- Discovery does not scroll or click, so code that loads only on interaction is not detected.
- Simulated throttling models network and main-thread work; a pure timer delay counts less than it
  would on a real device.

## Local use

```sh
cd .github/performance
npm ci --ignore-scripts
npm test
PERF_PAGE='{"id":"homepage","kind":"compare","gate":true,"round":1,
  "a":"https://main--da-homepage--adobecom.aem.live/homepage/index-loggedout?milolibs=stage--milo--adobecom&martech=off",
  "b":"https://main--da-homepage--adobecom.aem.live/homepage/index-loggedout?milolibs=<branch>--milo--adobecom&martech=off",
  "aLibs":"https://stage--milo--adobecom.aem.live","bLibs":"https://<branch>--milo--adobecom.aem.live"}' \
  node cli.js measure
```

Results are written to `perf-output/`, or to `PERF_OUT_DIR`.
