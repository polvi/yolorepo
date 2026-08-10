import { renderSVG } from 'uqr';

export function qrSvg(text: string): string {
  return renderSVG(text, { blackColor: '#1c150f', whiteColor: '#ffffff', border: 2 });
}
