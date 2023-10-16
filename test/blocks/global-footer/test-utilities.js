import {
  getLocale,
  setConfig,
  getConfig,
  loadStyle,
} from '../../../libs/utils/utils.js';

const locales = { '': { ietf: 'en-US', tk: 'hah7vzn.css' } };

export const selectors = {
  globalFooter: '.global-footer',
  fedsFooterWrapper: '.feds-footer-wrapper',
  fedsFooterIcons: '.feds-footer-icons',
  fedsMenuHeadline: '.feds-menu-headline',
  fedsFooterWrapper: '.feds-footer-wrapper',
  fedsFooterMiscLinks: '.feds-footer-miscLinks',
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

export const createFullGlobalFooter = async () => {
  setConfig(config);
  const { default: initFooter } = await import(
    '../../../libs/blocks/global-footer/global-footer.js'
  );

  await Promise.all([
    loadStyles('../../../../libs/styles/styles.css'),
    loadStyles('../../../../libs/blocks/global-footer/global-footer.css'),
  ]);

  const parser = new DOMParser();
  const skinnyFooter = `
  <body>
  <header class="global-navigation has-breadcrumbs" daa-im="true" daa-lh="gnav|milo"></header>
  <footer class="global-footer"></footer>
  </body>
  `;
  const skinnyFooterDom = parser
    .parseFromString(skinnyFooter, 'text/html')
    .querySelector('footer');
  const instance = await initFooter(skinnyFooterDom);
  return instance;
};
