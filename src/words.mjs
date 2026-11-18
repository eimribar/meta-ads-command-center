// Small wording helpers for messages people read.

// "1 table", "2 tables".
export const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
