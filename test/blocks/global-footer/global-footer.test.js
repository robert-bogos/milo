import { expect } from '@esm-bundle/chai';
import {
  allElementsVisible,
  baseSelectors,
  containerSelector,
  createFullGlobalFooter,
  insertDummyElementOnTop,
  skipTime,
  uglyWaitForAllAsync,
} from './test-utilities';
import baseFooter from './mocks/base-footer';
import sinon from 'sinon';

describe('global footer', () => {
  describe('basic sanity tests', function () {
    let clock = null;
    beforeEach(async () => {
      document.body.innerHTML = '';
      clock = sinon.useFakeTimers({
        toFake: ['setTimeout'],
        shouldAdvanceTime: true,
      });
    });

    afterEach(() => {
      clock.restore();
    });

    it('should render the footer when in viewport', async () => {
      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;

      for (let selectorKey in baseSelectors) {
        const targetEl = document.querySelector(baseSelectors[selectorKey]);
        expect(!!targetEl).to.equal(true);
      }

      const elementsAreVisible = await allElementsVisible(
        baseSelectors,
        document.querySelector(containerSelector)
      );
      expect(elementsAreVisible).to.equal(true);
    });

    it('should render the footer after 3s when outside of the 300px range of the viewport', async function () {
      const viewportHeight = window.innerHeight;
      insertDummyElementOnTop({ height: viewportHeight + 400 });

      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;
      for (let selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          false
        );
      }

      skipTime(clock, 3000);
      await uglyWaitForAllAsync();

      for (let selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          true
        );
      }
    });

    it('should render the footer when outside of the viewport, but within 300px range', async function () {
      const viewportHeight = window.innerHeight;
      insertDummyElementOnTop({ height: viewportHeight + 200 });
      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;
      for (let selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          true
        );
      }
    });

    it('should render the footer when outside of the 300px viewport range, but scrolled into view earlier than 3s', async function () {
      const viewportHeight = window.innerHeight;
      insertDummyElementOnTop({ height: viewportHeight + 400 });

      const footer = await createFullGlobalFooter({ baseFooter });

      expect(footer).to.exist;
      for (let selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          false
        );
      }

      window.scrollBy(0, viewportHeight);
      await uglyWaitForAllAsync();

      for (let selectorKey in baseSelectors) {
        expect(!!document.querySelector(baseSelectors[selectorKey])).to.equal(
          true
        );
      }

      const elementsAreVisible = await allElementsVisible(
        baseSelectors,
        document.querySelector(containerSelector)
      );
      expect(elementsAreVisible).to.equal(true);
    });
  });
});
