import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hodgesLehmann, wilcoxonGreater } from '../stats.js';

describe('hodgesLehmann', () => {
  it('is the median of the pairwise averages, which one outlier barely moves', () => {
    // Averages of every two of 1, 2, 3, 100, each with itself too:
    // 1, 1.5, 2, 2, 2.5, 3, 50.5, 51, 51.5, 100. The mean of the differences is 26.5.
    assert.equal(hodgesLehmann([1, 2, 3, 100]), 2.75);
  });
});

describe('wilcoxonGreater', () => {
  it('matches the exact one-sided p-value from R', () => {
    // R: wilcox.test(x, y, paired = TRUE, alternative = 'greater') gives V = 40, p = 0.01953.
    const x = [1.83, 0.50, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.30];
    const y = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29];
    const result = wilcoxonGreater(x.map((value, i) => value - y[i]));
    assert.equal(result.n, 9);
    assert.equal(result.wPlus, 40);
    assert.equal(result.p, 10 / 512);
  });

  it('needs at least five consistent pairs to reach p < 0.05', () => {
    assert.equal(wilcoxonGreater([1, 2, 3, 4]).p, 1 / 16);
    assert.equal(wilcoxonGreater([1, 2, 3, 4, 5]).p, 1 / 32);
    assert.equal(wilcoxonGreater([1, 2, 3, 4, 5, 6, 7]).p, 1 / 128);
  });

  it('drops zero differences and uses midranks for ties', () => {
    assert.deepEqual(wilcoxonGreater([0, 0]), { n: 0, wPlus: 0, p: 1 });
    // |d| ranks: 2, 2, 2, 4; W+ = 8 and 4 of the 16 sign assignments reach 8.
    assert.deepEqual(wilcoxonGreater([1, 1, -1, 2, 0]), { n: 4, wPlus: 8, p: 0.25 });
  });
});
