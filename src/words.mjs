// Small wording helpers for messages people read.

// "1 table", "2 tables".
export const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;

// chat.update refuses text over 4,000 characters (msg_too_long,
// docs.slack.dev/reference/methods/chat.update), and Slack advises the same length for
// chat.postMessage. Long text is split into parts of at most `max`, at paragraph breaks first,
// then at line breaks, then at spaces.
export function splitForSlack(text, max = 3800) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.3) cut = window.lastIndexOf('\n');
    if (cut < max * 0.3) cut = window.lastIndexOf(' ');
    if (cut < max * 0.3) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}
