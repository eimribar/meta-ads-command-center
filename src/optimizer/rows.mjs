// Stored performance rows with fresh ones laid over them, by (date, level, entity). A dry run
// reads fresh numbers from Meta but stores nothing, so every check reads through this.
export function rowsWith(stored, fresh) {
  if (!fresh?.length) return stored;
  const key = (r) => `${r.date}|${r.level}|${r.entity_id}`;
  const map = new Map(stored.map((r) => [key(r), r]));
  for (const r of fresh) map.set(key(r), { ...map.get(key(r)), ...r });
  return [...map.values()];
}
