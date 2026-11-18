// Weekly lessons from the team's approve and reject notes. The optimizer reads the active
// lessons every run, so the "why" box on each card teaches it how this team wants the account run.
import { db, rt } from './runtime.mjs';
import { complete, textOf } from './reasoning.mjs';
import { OPERATING_RULES, LESSONS_RULES } from './prompts.mjs';
import { plural } from './words.mjs';

const MAX_LESSONS = 12;

export async function learningsBlock() {
  const rows = await db().select('learnings', { where: { active: true }, order: 'id desc', limit: MAX_LESSONS }).catch(() => []);
  if (!rows.length) return '';
  return `# LESSONS FROM THE TEAM'S DECISIONS\n${rows.map((r) => `- ${r.lesson}`).join('\n')}`;
}

// Read the last 30 days of decision notes and replace the active lessons with a fresh set.
export async function distillLearnings() {
  const since = new Date(rt.now() - 30 * 864e5).toISOString().slice(0, 10);
  const rows = (await db().select('actions_log', { where: { run_date: { gte: since } }, order: 'id desc', limit: 300 }))
    .filter((r) => r.decision_note && ['applied_by_human', 'skipped'].includes(r.disposition) && r.applied_by !== 'sweep');
  if (rows.length < 3) return { held: true, summary: `only ${rows.length} decision notes in 30 days; lessons unchanged` };
  const notes = rows.map((r) => `${r.close_reason === 'human_reject' ? 'REJECTED' : 'APPROVED'} ${r.action_type} on ${r.target_name || r.target_id}: "${r.decision_note}" (card said: ${String(r.explain || '').slice(0, 160)})`);
  const msg = await complete({
    system: `${OPERATING_RULES}\n\n${LESSONS_RULES}`,
    messages: [{ role: 'user', content: `Decision notes:\n${notes.join('\n')}` }],
    outputConfig: { format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['lessons'], properties: { lessons: { type: 'array', items: { type: 'string' } } } } } },
  });
  let lessons = [];
  try { lessons = JSON.parse(textOf(msg)).lessons || []; } catch { lessons = []; }
  lessons = lessons.map((l) => String(l).trim()).filter(Boolean).slice(0, 10);
  if (!lessons.length) return { held: true, summary: 'no durable lessons in the notes' };
  await db().update('learnings', { active: true }, { active: false });
  await db().insert('learnings', lessons.map((lesson) => ({ lesson, source: `notes to ${rt.now().toISOString().slice(0, 10)}`, active: true })));
  return { summary: plural(lessons.length, 'lesson'), lessons };
}
