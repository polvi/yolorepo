import { renderSVG } from 'uqr';

// Always dark-on-white regardless of theme: wallet cameras want contrast, and
// the QR sits in its own white tile.
export function qrSvg(text: string): string {
  return renderSVG(text, { blackColor: '#121413', whiteColor: '#ffffff', border: 2 });
}
