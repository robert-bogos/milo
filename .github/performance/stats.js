export function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Ranks starting at 1; tied values share their average rank.
export function midranks(values) {
  const order = values.map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end + 2) / 2;
    for (let i = start; i <= end; i += 1) ranks[order[i].index] = rank;
    start = end + 1;
  }
  return ranks;
}

/**
 * Exact one-sided Wilcoxon signed-rank test (H1: differences tend to be positive).
 * Zero differences are dropped; ties use midranks. The null distribution is enumerated
 * over all 2^n sign assignments, so small samples get exact p-values.
 */
export function wilcoxonGreater(differences, { zero = 1e-9 } = {}) {
  const nonZero = differences.filter((value) => Number.isFinite(value) && Math.abs(value) > zero);
  const n = nonZero.length;
  if (!n) return { n, wPlus: 0, p: 1 };
  // Midranks are multiples of 0.5; doubling keeps the enumeration in integers.
  const ranks = midranks(nonZero.map(Math.abs)).map((rank) => Math.round(rank * 2));
  const observed = nonZero.reduce((sum, value, i) => sum + (value > 0 ? ranks[i] : 0), 0);
  const total = ranks.reduce((sum, rank) => sum + rank, 0);
  let counts = new Array(total + 1).fill(0);
  counts[0] = 1;
  ranks.forEach((rank) => {
    const next = counts.slice();
    for (let sum = rank; sum <= total; sum += 1) next[sum] += counts[sum - rank];
    counts = next;
  });
  const atLeastObserved = counts.slice(observed).reduce((sum, count) => sum + count, 0);
  return { n, wPlus: observed / 2, p: atLeastObserved / 2 ** n };
}
