import { getLocale, setConfig, loadStyle } from '../../../libs/utils/utils.js';
import sinon, { stub } from 'sinon';
import icons from './mocks/icons.js';
const locales = { '': { ietf: 'en-US', tk: 'hah7vzn.css' } };
const parser = new DOMParser();
export const containerSelector = '.global-footer';
export const baseSelectors = {
  fedsFooterIcons: '.feds-footer-icons',
  fedsFooterWrapper: '.feds-footer-wrapper',
  fedsFooterOptions: '.feds-footer-options',
  fedsFooterMiscLinks: '.feds-footer-miscLinks',
};
export const selectors = {
  ...baseSelectors,

  fedsMenuHeadline: '.feds-menu-headline',
  fedsRegionPicker: '.feds-regionPicker',
  fedsRegionPickerGlobe: '.feds-regionPicker-globe',
  fedsRegionPickerWrapper: '.feds-regionPicker-wrapper',
  fedsSocial: '.feds-social',
  fedsSocialLink: '.feds-social-link',
  fedsSocialIcon: '.feds-social-icon',
  fedsFooterLegalWrapper: '.feds-footer-legalWrapper',
  fedsFooterPrivacySection: '.feds-footer-privacySection',
  fedsFooterPrivacyLink: '.feds-footer-privacyLink',
  fedsAdChoicesIcon: '.feds-adChoices-icon',
};
export const loadStyles = (path) =>
  new Promise((resolve) => loadStyle(path, resolve));

export const config = {
  imsClientId: 'milo',
  codeRoot: '/libs',
  contentRoot: `${window.location.origin}${getLocale(locales).prefix}`,
  locales,
};

export const waitForElement = (selector, parent) =>
  new Promise((resolve, reject) => {
    if (parent.querySelector(selector)) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(
      () => reject(new Error(`waitForElement took too long for: ${selector}`)),
      1500
    );

    new MutationObserver((mutationRecords, observer) => {
      clearTimeout(timeout);
      resolve(true);
      observer.disconnect();
    }).observe(parent, { childList: true, subtree: true });
  });

export const allElementsVisible = async (selectors, parentEl) => {
  const waitForElements = [];

  for (let selectorKey in selectors) {
    const targetEl = document.querySelector(selectors[selectorKey]);
    if (targetEl) {
      waitForElements.push(waitForElement(selectors[selectorKey], parentEl));
    }
  }
  const visibleElements = await Promise.all(waitForElements);
  const allVisible = visibleElements.every((i) => i);
  return allVisible;
};

export const mockRes = ({ payload, status = 200, ok = true } = {}) =>
  new Promise((resolve) => {
    resolve({
      status,
      ok,
      json: () => payload,
      text: () => payload,
    });
  });

// TODO -> find a way to wait for all the async to be resolved
export const uglyWaitForAllAsync = async () => {
  return await new Promise((resolve) => setTimeout(resolve, 300));
};
//

export const createFullGlobalFooter = async ({ baseFooter }) => {
  document.body.appendChild(
    parser.parseFromString(baseFooter, 'text/html').body.firstChild
  );

  window.fetch = stub().callsFake((url) => {
    if (url.includes('/footer')) {
      return mockRes({ payload: baseFooter });
    }

    if (url.includes('icons.svg')) {
      return mockRes({ payload: icons });
    }

    return null;
  });

  setConfig(config);
  //we need to import the footer class in here so it can use the config we have set above
  //if we import it at the top of the file, an empty config will be defined and used by the footer
  const { default: initFooter } = await import(
    '../../../libs/blocks/global-footer/global-footer.js'
  );

  await Promise.all([
    loadStyles('../../../../libs/styles/styles.css'),
    loadStyles('../../../../libs/blocks/global-footer/global-footer.css'),
  ]);

  const instance = initFooter(document.querySelector('footer'));
  await uglyWaitForAllAsync();
  return instance;
};

export const insertDummyElementOnTop = ({ height }) => {
  const firstChild = document.body.firstChild;
  const dummyElement = document.createElement('div');
  dummyElement.style.height = `${height}px`;
  document.body.insertBefore(dummyElement, firstChild);
};

export const skipTime = (clock, ms) => {
  setTimeout(() => console.log(`${ms}ms have passed`), ms);
  clock.tick(ms);
  return;
};
