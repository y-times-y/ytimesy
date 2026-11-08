/**
 * Browser-side check shared by the evidence capture and browser inspection: a
 * page that loaded but shows a crash (a dev-server error overlay, or a short
 * heading or alert such as "Something went wrong") is not evidence of a change.
 * Only headings, alerts and bold lines are read, so a transcript or article
 * that merely mentions an error does not count.
 *
 * Defines `visibleAppError(page)`: resolves to a short description, or ''.
 */
export const VISIBLE_APP_ERROR_SOURCE = String.raw`
const visibleAppError = page => page.evaluate(() => {
  const overlay = document.querySelector('vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal [data-nextjs-dialog]');
  if (overlay) return 'a dev-server error overlay';
  const lead = /^(something went wrong|application error|unhandled (runtime )?error|internal server error|an (unexpected )?error (has )?occurred|missing or invalid server configuration)/i;
  for (const node of document.querySelectorAll('h1, h2, h3, [role="alert"], strong')) {
    const text = (node.innerText || '').trim().replace(/\s+/g, ' ');
    if (text.length <= 120 && lead.test(text) && node.getClientRects().length) return text;
  }
  return '';
}).catch(() => '');
`;
