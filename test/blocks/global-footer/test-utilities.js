import { setConfig } from '../../../libs/utils/utils.js';
import { config, loadStyles, waitForElement } from '../global-navigation/test-utilities.js';

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

export const allElementsVisible = async (givenSelectors, parentEl) => {
  const waitForElements = [];

  const selectorsKeys = Object.keys(givenSelectors);
  for (const selectorKey of selectorsKeys) {
    const targetEl = document.querySelector(givenSelectors[selectorKey]);
    if (targetEl) {
      waitForElements.push(waitForElement(givenSelectors[selectorKey], parentEl));
    }
  }
  const visibleElements = await Promise.all(waitForElements);
  return !!visibleElements;
};

// TODO -> find a way to wait for all the async to be resolved
export const uglyWaitForAllAsync = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  // await waitForElement('.feds-footer-wrapper');
};

export const createFullGlobalFooter = async ({ baseFooter }) => {
  document.body.appendChild(
    parser.parseFromString(baseFooter, 'text/html').body.firstChild,
  );

  setConfig(config);
  // we need to import the footer class in here so it can use the config we have set above
  // if we import it at the top of the file, an empty config will be defined and used by the footer
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
  const { firstChild } = document.body;
  const dummyElement = document.createElement('div');
  dummyElement.style.height = `${height}px`;
  document.body.insertBefore(dummyElement, firstChild);
};
