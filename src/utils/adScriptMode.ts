// Ad-network <script> mode for the "Voir une pub" button popup (normal mode).
//
// When enabled, the normal-mode popup loads this ad-network script instead of
// opening the direct link (utils/adAdultMode). The script is pre-configured on
// the ad-network side to deliver the ad on the button click, so the button only
// advances the popup flow — it does not open the direct link. The other popup
// modes (auto / click-anywhere) keep using the direct link.
//
// This is a build-time switch (code constant), not a user setting. Flip
// SCRIPT_AD_MODE_ENABLED to false to revert the button to direct-link behaviour.

export const SCRIPT_AD_MODE_ENABLED = false;

// Ad-network script src, protocol-relative as delivered by the network.
export const AD_SCRIPT_SRC = '//endedstrung.com/92/93/15/92931582a515c4ab9a953e76e3a6cadd.js';

// Marker attribute used to keep injection idempotent.
const AD_SCRIPT_MARKER = 'data-movix-ad-script';

export const isScriptAdModeEnabled = (): boolean => SCRIPT_AD_MODE_ENABLED;

// Inject the ad-network script once. Idempotent: re-calls are no-ops while the
// tag is present in the document. data-cfasync="false" keeps Cloudflare Rocket
// Loader from deferring it; async lets it load without blocking the popup.
export const loadAdScript = (): void => {
  if (!SCRIPT_AD_MODE_ENABLED) return;
  try {
    if (document.querySelector(`script[${AD_SCRIPT_MARKER}]`)) return;
    const s = document.createElement('script');
    s.src = AD_SCRIPT_SRC;
    s.async = true;
    s.type = 'text/javascript';
    s.setAttribute('data-cfasync', 'false');
    s.setAttribute(AD_SCRIPT_MARKER, '');
    document.body.appendChild(s);
  } catch {
    /* document unavailable (SSR / privacy) */
  }
};
