import { expect } from '@esm-bundle/chai';
import { readFile } from '@web/test-runner-commands';
import { createFullGlobalFooter, selectors } from './test-utilities';

describe('global footer', () => {
  describe('basic sanity tests', () => {
    it('should render the footer', async () => {
      const footer = await createFullGlobalFooter();
      expect(footer).to.exist;
      for (let key in selectors) {
        expect(!!document.querySelector(selectors[key])).to.equal(true);
      }
    });
  });
});
