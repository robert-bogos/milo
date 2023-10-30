import { expect } from '@esm-bundle/chai';
import sinon, { stub } from 'sinon';
import {
  allElementsVisible,
  baseSelectors,
  containerSelector,
  createFullGlobalFooter,
  insertDummyElementOnTop,
  uglyWaitForAllAsync,
} from './test-utilities.js';
import baseFooter from './mocks/base-footer.js';
import icons from './mocks/icons.js';
import { mockRes } from '../global-navigation/test-utilities.js';

const originalFetch = window.fetch;
const baseSelectorsKeys = Object.keys(baseSelectors);

describe('global footer', () => {
  describe('basic sanity tests', () => {
    let clock = null;
    beforeEach(async () => {
      document.body.innerHTML = '';
      clock = sinon.useFakeTimers({
        toFake: ['setTimeout'],
        shouldAdvanceTime: true,
      });

      window.fetch = stub().callsFake((url) => {
        if (url.includes('/footer')) {
          return mockRes({ payload: baseFooter });
        }

        if (url.includes('icons.svg')) {
          return mockRes({ payload: icons });
        }

        return null;
      });
    });

    afterEach(() => {
      clock.restore();
      window.fetch = originalFetch;
    });

    it('should render the footer when in viewport', async () => {
      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;

      for (const selectorKey of baseSelectorsKeys) {
        const targetEl = document.querySelector(baseSelectors[selectorKey]);
        expect(!!targetEl).to.equal(true);
      }

      const elementsAreVisible = await allElementsVisible(
        baseSelectors,
        document.querySelector(containerSelector),
      );
      expect(elementsAreVisible).to.equal(true);
    });

    it('should render the footer after 3s when outside of the 300px range of the viewport', async () => {
      const viewportHeight = window.innerHeight;
      insertDummyElementOnTop({ height: viewportHeight + 400 });

      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;
      for (const selectorKey of baseSelectorsKeys) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          false,
        );
      }

      clock.tick(3000);
      await uglyWaitForAllAsync();

      for (const selectorKey of baseSelectorsKeys) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          true,
        );
      }
    });

    it('should render the footer when outside of the viewport, but within 300px range', async () => {
      const viewportHeight = window.innerHeight;
      insertDummyElementOnTop({ height: viewportHeight + 200 });
      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;
      for (const selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          true,
        );
      }
    });

    it('should render the footer when outside of the 300px viewport range, but scrolled into view earlier than 3s', async () => {
      const viewportHeight = window.innerHeight;
      insertDummyElementOnTop({ height: viewportHeight + 400 });

      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;
      for (const selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          false,
        );
      }

      window.scrollBy(0, viewportHeight);
      await uglyWaitForAllAsync();

      for (const selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          true,
        );
      }

      const elementsAreVisible = await allElementsVisible(
        baseSelectors,
        document.querySelector(containerSelector),
      );
      expect(elementsAreVisible).to.equal(true);
    });
  });
});
