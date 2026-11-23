// Short commands that skip the chat model. Returns true when the text was a command.
import { db } from '../runtime.mjs';
import { isOperator, operators, LOCAL_OPERATOR } from '../auth.mjs';
import { ladder, setLadder, undo } from '../optimizer/executor.mjs';
import { listBrain, setBrain, rmBrain, parseContent, setThreshold } from '../brain.mjs';
import { buildScoreboard, scoreboardText } from '../scoreboard.mjs';
import { getState, setState, loopHealth, openIncidents } from '../jobs.mjs';
import { unresolvedWrites, clearWrite } from '../write-journal.mjs';
import { approvalBlocks } from './cards.mjs';
import { metricSpec } from '../metrics.mjs';
import { policy, refreshPolicy, NEVER_AUTO, DEFAULTS, ACTION_WORDS, ACTION_PHRASES, MODE_WORDS, actionTypeFrom, ladderModeFrom } from '../optimizer/policy.mjs';
import { RANGES } from '../optimizer/defaults.mjs';
import { money, currency } from '../money.mjs';
import { getConfig } from '../config.mjs';
import { OPTIMIZER_OFF } from '../scheduled.mjs';
import { plural } from '../words.mjs';
import { recordDecision, reverseDecision, listDecisions, recordHypothesis, gradeHypothesis, listHypotheses, decisionLine, hypothesisLine, recordStatus } from '../record.mjs';

export const HELP = `*Commands* (mention me, DM me, or reply in one of my threads)
• \`report\`: yesterday's report now · \`scoreboard\` or \`scoreboard 14\`: the top ads by spend, ranked against the target
• \`pending\`: every card waiting for approval · \`status\`: what I count, the target, the ceiling, jobs, issues
• \`optimize\`: look for moves now (it files cards; a move whose ladder is on auto happens on its own)
• \`ladder\` · \`ladder set pause auto\` or \`ladder set pause ask\` (raises, trims and turning ads back on always ask)
• \`undo 42\`: reverse the move numbered #42 on its card · \`freeze <why>\` / \`unfreeze\`: hold or resume the optimizer
• \`brain\` · \`brain set business/company <text>\` · \`brain rm business/company\` (a row is named section/name)
• \`decisions\` · \`decision <what> because <why>\` · \`decision 12 reversed because <why>\`
• \`hypotheses\` · \`hypothesis <what you believe works>\` · \`hypothesis 7 confirmed because <the numbers>\`
• \`thresholds\` · \`threshold pause.zeroResultSpend 4\` · \`threshold pause.zeroResultSpend default\`
• \`scan comments\`: run the comment sweep now · \`journal\` · \`journal clear 7\`
Anything else is a question for me. Changes, \`optimize\` and \`scan comments\` need an operator.`;

const fmtNum = (n) => String(Math.round(Number(n) * 1000) / 1000);
// What counts, in plain words: "test rides (the Schedule event)".
const plainEvent = (r, override) => {
  const e = String(r.event || '');
  const how = /^\d+$/.test(e) ? `custom conversion ${e}` : e.includes('.') ? `the action type ${e}` : `the ${e} event`;
  return `${r.label} (${how}${override ? `, counted as ${override}` : ''})`;
};
const getConfigSafe = () => { try { return getConfig(); } catch { return {}; } };

// One more sentence after saving a row the code reads.
const noteFor = (scope, key, content) => {
  if (scope === 'policy' && key === 'target') return ` The target is now ${money(content)}${getConfigSafe().TARGET_COST_PER_RESULT ? `; it overrides TARGET_COST_PER_RESULT (${money(getConfigSafe().TARGET_COST_PER_RESULT)}) while this row exists` : ''}.`;
  if (scope === 'policy' && key === 'thresholds') return ' Send `thresholds` to see every value.';
  if (scope === 'moderation' && key === 'extra_posts') return ` ${content.length} post${content.length === 1 ? '' : 's'} added to the comment sweep.`;
  return '';
};

// jobs: { report, optimize, moderation } run on demand (wired in app.mjs)
export async function handleCommand({ text, user, reply, jobs }) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  const op = isOperator(user);
  const needOp = async () => { await reply(':lock: That needs an operator. To become one, ask whoever set up the agent to add you as an operator.'); return true; };

  if (/^(help|commands|\?)$/.test(t)) { await reply(HELP); return true; }

  if (/^(report|daily report)$/.test(t)) { await jobs.report(); return true; }

  const sb = t.match(/^scoreboard(?:\s+(\d+)\s*(?:d|days?)?)?$/);
  if (sb) {
    const days = Math.min(Math.max(Number(sb[1]) || 7, 1), 90);
    await reply(scoreboardText(await buildScoreboard({ days })));
    return true;
  }

  if (/^(pending|desk)$/.test(t)) {
    const open = await db().select('actions_log', { where: { disposition: { in: ['proposed', 'escalated'] } }, order: 'id', limit: 20 });
    if (!open.length) { await reply('Nothing is waiting for approval.'); return true; }
    await reply(`${open.length} card${open.length === 1 ? '' : 's'} waiting:`);
    for (const a of open) {
      const msg = await reply({ text: `Needs approval: ${a.action_type}`, blocks: approvalBlocks(a) });
      if (msg?.ts) await db().update('actions_log', { id: a.id }, { card_ts: msg.ts, card_channel: msg.channel }).catch(() => {});
    }
    return true;
  }

  if (/^(optimi[sz]e|propose|run the optimi[sz]er)$/.test(t)) {
    if (!op) return needOp();
    if (getConfigSafe().OPTIMIZER_ENABLED === false) { await reply(`:no_entry: ${OPTIMIZER_OFF} Nothing was run.`); return true; }
    await jobs.optimize();
    return true;
  }

  if (/^scan comments$/.test(t)) { if (!op) return needOp(); await jobs.moderation(); return true; }

  const ladderSet = t.match(/^ladder\s+set\s+(.+?)\s+(\S+)$/);
  if (ladderSet) {
    if (!op) return needOp();
    const type = actionTypeFrom(ladderSet[1]);
    const mode = ladderModeFrom(ladderSet[2]);
    if (!type) { await reply(`:warning: "${ladderSet[1]}" is not a kind of move. The kinds: ${Object.values(ACTION_WORDS).join(', ')}. For example \`ladder set pause auto\`.`); return true; }
    if (!mode) { await reply(':warning: The last word is `auto` (it happens on its own) or `ask` (it waits for a person). For example `ladder set pause auto`.'); return true; }
    const r = await setLadder(type, mode, { by: user });
    await reply(r.ok
      ? `:vertical_traffic_light: ${ACTION_PHRASES[type]}: now *${MODE_WORDS[mode]}*.${mode === 'auto' ? ' Each one is posted in the desk thread with its undo command; an undo sends it back to waiting.' : ''}`
      : `:warning: ${r.reason}`);
    return true;
  }
  if (/^ladder$/.test(t)) {
    const rows = await ladder();
    await reply(`:vertical_traffic_light: *Which moves wait for a person*\n${rows.map((r) => `• ${ACTION_PHRASES[r.action_type]} (\`${ACTION_WORDS[r.action_type]}\`): *${MODE_WORDS[r.mode]}*${NEVER_AUTO.has(r.action_type) ? ' (always)' : ''}`).join('\n')}\nChange one with \`ladder set pause auto\` or \`ladder set pause ask\`.`);
    return true;
  }

  if (/^thresholds?$/.test(t)) {
    await refreshPolicy().catch(() => {});
    const p = policy();
    const lines = Object.entries(DEFAULTS).flatMap(([g, vals]) => Object.entries(vals).map(([k, d]) => {
      const v = p.t[g][k];
      return `• \`${g}.${k}\` ${fmtNum(v)}${v !== d ? ` (default ${fmtNum(d)})` : ''}`;
    }));
    await reply(`*Thresholds* (T is the target cost per result; docs/SETTINGS.md says what each one means)\n${lines.join('\n')}\nChange one with \`threshold pause.zeroResultSpend 4\`, or put one back with \`threshold pause.zeroResultSpend default\`.`);
    return true;
  }
  const th = raw.match(/^threshold\s+([A-Za-z]+\.[A-Za-z]+)\s+(\S+)$/i);
  if (th) {
    if (!op) return needOp();
    try {
      const r = await setThreshold(th[1], th[2], user);
      const [min, max] = RANGES[r.group][r.key];
      await reply(`:straight_ruler: \`${r.group}.${r.key}\` is now ${fmtNum(r.value)}${r.isDefault ? ' (the default)' : ` (default ${fmtNum(DEFAULTS[r.group][r.key])}, allowed ${min} to ${max})`}.`);
    } catch (e) { await reply(`:warning: ${e.message}`); }
    return true;
  }
  if (/^threshold\b/.test(t)) {
    await reply(':warning: Write it as `threshold <name> <number>`, for example `threshold pause.zeroResultSpend 4`. Send `thresholds` to see every name.');
    return true;
  }

  const u = t.match(/^undo\s+#?(\d+)$/);
  if (u) {
    if (!op) return needOp();
    try {
      const r = await undo(u[1], { by: user });
      const what = ACTION_PHRASES[r.row?.action_type] || String(r.row?.action_type || '').replace(/_/g, ' ');
      await reply(r.ok ? `:leftwards_arrow_with_hook: Undid #${u[1]} (${what}: ${r.row.target_name || r.row.target_id}).${r.demoted ? ` ${ACTION_PHRASES[r.row.action_type] || what} waits for a person again.` : ''}` : `:warning: ${r.reason}`);
    } catch (e) { await reply(`:warning: Undo failed: ${String(e.message).slice(0, 200)}`); }
    return true;
  }

  const fr = raw.match(/^freeze\b\s*(.*)$/i);
  if (fr) {
    if (!op) return needOp();
    await setState('optimizer/freeze', { on: true, by: user, note: fr[1] || null, at: new Date().toISOString() });
    await reply(':snowflake: The optimizer is frozen. It proposes nothing until someone sends `unfreeze`. Cards already posted still work.');
    return true;
  }
  if (/^unfreeze$/.test(t)) {
    if (!op) return needOp();
    await setState('optimizer/freeze', { on: false, by: user, at: new Date().toISOString() });
    await reply(':white_check_mark: The optimizer is running again.');
    return true;
  }

  if (/^brain\b/.test(t)) {
    const set = raw.match(/^brain\s+set\s+([\w.-]+)\/([\w.-]+)\s+(\S[\s\S]*)$/i);
    const rm = raw.match(/^brain\s+rm\s+([\w.-]+)\/([\w.-]+)\s*$/i);
    if (set || rm) {
      if (!op) return needOp();
      try {
        const r = set ? await setBrain(set[1], set[2], parseContent(set[3]), user) : await rmBrain(rm[1], rm[2], user);
        await reply(r.ok ? `:brain: ${set ? 'Saved' : 'Removed'} \`${r.scope}/${r.key}\`.${set ? noteFor(r.scope, r.key, r.content) : ''}` : `:warning: ${r.error}`);
      } catch (e) { await reply(`:warning: ${e.message}`); }
      return true;
    }
    // A half written brain command is never taken for a list or a save.
    if (!/^brain$/.test(t)) {
      const name = (raw.match(/^brain\s+(?:set|rm)\s+([\w.-]+\/[\w.-]+)\s*$/i) || [])[1];
      const example = 'for example `brain set business/company Northfield Bikes sells city e-bikes online.` (a section, a slash and a name, then the text)';
      await reply(`:warning: ${/^brain\s+set\b/.test(t)
        ? (name ? `There is no text after \`${name}\`. Write it as \`brain set ${name} <text>\`. Nothing was saved.` : `Write it as \`brain set <section>/<name> <text>\`, ${example}. Nothing was saved.`)
        : /^brain\s+rm\b/.test(t) ? 'Write it as `brain rm <section>/<name>`, for example `brain rm business/old_offer`. Nothing was removed.'
          : `The brain commands are \`brain\` (list every row), \`brain set <section>/<name> <text>\` and \`brain rm <section>/<name>\`, ${example}.`}`);
      return true;
    }
    const rows = await listBrain();
    if (!rows.length) { await reply('The brain is empty. Start with `brain set business/company <one paragraph about the company>`; the playbook in the repo lists what to add.'); return true; }
    const show = (c) => { const s = typeof c === 'string' ? c : JSON.stringify(c); return s.length > 140 ? `${s.slice(0, 140)}...` : s; };
    await reply(`:brain: *Brain* (${rows.length} row${rows.length === 1 ? '' : 's'})\n${rows.map((r) => `• \`${r.scope}/${r.key}\`: ${show(r.content)}`).join('\n')}`);
    return true;
  }

  // ── the record: decisions with their reasons, hypotheses graded by the numbers ──
  const author = user === LOCAL_OPERATOR ? 'the terminal' : `<@${user}>`;
  const slackText = (x) => String(x || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  const listDec = t.match(/^decisions(\s+all)?$/);
  if (listDec) {
    const rows = await listDecisions({ all: Boolean(listDec[1]), limit: 30 });
    if (!rows.length) { await reply(listDec[1] ? 'No decisions recorded yet.' : 'No active decisions. Record one with `decision <what> because <why>`.'); return true; }
    await reply(`:memo: *${listDec[1] ? 'Decisions, newest first' : 'Active decisions, newest first'}* (${rows.length})\n${rows.map((d) => `• ${decisionLine(d, { slack: true })}`).join('\n')}`);
    return true;
  }
  // A question ("decision on the budget?") is for the agent, not a command.
  if (/^decision\b/.test(t) && !/\?\s*$/.test(t)) {
    if (!op) return needOp();
    const help = 'Write it as `decision <what> because <why>`, for example `decision budget: no budget changes during the spring launch because we need one clean week to compare` '
      + '(the topic before the colon is optional). Add `(replaces 12)` at the end when it overrides decision 12. To take one back: `decision 12 reversed because <why>`.';
    const rev = raw.match(/^decision\s+#?(\d+)\s+reversed?\b\s*([\s\S]*)$/i);
    if (rev) {
      const why = slackText(rev[2]).replace(/^because\s+/i, '');
      if (!/^because\s+\S/i.test(slackText(rev[2]))) { await reply(`:warning: Reversing a decision needs the reason: \`decision ${rev[1]} reversed because <why>\`. Nothing was changed.`); return true; }
      try { await reverseDecision(rev[1], why, user); await reply(`:leftwards_arrow_with_hook: Decision #${rev[1]} reversed by ${author}. It stays in \`decisions all\` with the reason.`); }
      catch (e) { await reply(`:warning: ${e.message}`); }
      return true;
    }
    let body = slackText(raw.replace(/^decision\s*:?\s*/i, ''));
    let replaces = null, brainKey = null;
    const tail = body.match(/\s*\(([^()]*)\)\s*$/);
    if (tail && /^\s*(replaces|brain)\b/i.test(tail[1])) {
      for (const part of tail[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const r = part.match(/^replaces\s+#?(\d+)$/i), b = part.match(/^brain\s+(\S+)$/i);
        if (r) replaces = r[1];
        else if (b) brainKey = b[1];
        else { await reply(`:warning: "(${part})" is not understood: the end can say \`(replaces 12)\` or \`(brain business/offer)\`. Nothing was saved.`); return true; }
      }
      body = body.slice(0, tail.index);
    }
    let topic = null;
    const tm = body.match(/^([A-Za-z][A-Za-z0-9_-]{0,39}):\s+/);
    if (tm) { topic = tm[1]; body = body.slice(tm[0].length); }
    const i = body.search(/\s+because\s+/i);
    if (!body.trim() || i < 0) { await reply(`:warning: A decision is kept with its reason. ${help} Nothing was saved.`); return true; }
    try {
      const r = await recordDecision({ decision: body.slice(0, i), why: body.slice(i).replace(/^\s+because\s+/i, ''), topic, replaces, brain_key: brainKey, source: user === LOCAL_OPERATOR ? 'terminal command' : 'Slack command' }, user);
      await reply(`:memo: Decision *#${r.id}* recorded by ${author}.${replaces ? ` #${replaces} is now replaced.` : ''} I work within it from now on.`);
    } catch (e) { await reply(`:warning: ${e.message}`); }
    return true;
  }

  const listHyp = t.match(/^hypotheses(\s+all)?$/);
  if (listHyp) {
    const rows = await listHypotheses({ all: Boolean(listHyp[1]), limit: 30 });
    if (!rows.length) { await reply(listHyp[1] ? 'No hypotheses recorded yet.' : 'No open hypotheses. Record one with `hypothesis <what you believe works>`.'); return true; }
    await reply(`:test_tube: *${listHyp[1] ? 'Hypotheses, newest first' : 'Open hypotheses, newest first'}* (${rows.length})\n${rows.map((h) => `• ${hypothesisLine(h, { slack: true })}`).join('\n')}`);
    return true;
  }
  if (/^hypothesis\b/.test(t) && !/\?\s*$/.test(t)) {
    if (!op) return needOp();
    const body = slackText(raw.replace(/^hypothesis\s*:?\s*/i, ''));
    const grade = body.match(/^#?(\d+)\s+(confirmed|refuted)\b\s*([\s\S]*)$/i);
    if (grade) {
      if (!/^because\s+\S/i.test(grade[3])) { await reply(`:warning: A grade needs the reason, with the numbers: \`hypothesis ${grade[1]} ${grade[2].toLowerCase()} because <why>\`. Nothing was saved.`); return true; }
      try {
        const r = await gradeHypothesis({ id: grade[1], verdict: grade[2], why: grade[3].replace(/^because\s+/i, '') }, user);
        await reply(`:straight_ruler: Hypothesis #${grade[1]} graded *${grade[2].toLowerCase()}* by ${author}${r.was !== 'pending' ? ` (it was ${r.was})` : ''}.`);
      } catch (e) { await reply(`:warning: ${e.message}`); }
      return true;
    }
    let claim = body, kind = 'hypothesis', labels = {};
    if (/^test\s+/i.test(claim)) { kind = 'test'; claim = claim.replace(/^test\s+/i, ''); }
    const lab = claim.match(/\s*\[([^\]]*)\]\s*$/);
    if (lab) { labels = lab[1]; claim = claim.slice(0, lab.index); }
    if (!claim.trim()) {
      await reply(':warning: Write it as `hypothesis <what you believe works>`, optionally with labels at the end: `hypothesis Theft angle brings cheaper test rides [audience=commuters, angle=theft]`. '
        + '`hypothesis test <claim>` records a test that starts today. To grade one: `hypothesis 7 confirmed because <the numbers>`. Nothing was saved.');
      return true;
    }
    try {
      const r = await recordHypothesis({ claim, kind, labels }, user);
      await reply(`:test_tube: ${kind === 'test' ? 'Test' : 'Hypothesis'} *#${r.id}* recorded by ${author}. Grade it when the numbers settle it: \`hypothesis ${r.id} confirmed because ...\` or \`refuted\`.`);
    } catch (e) { await reply(`:warning: ${e.message}`); }
    return true;
  }

  if (/^journal\b/.test(t)) {
    const c = t.match(/^journal\s+clear\s+#?(\d+)$/);
    if (c) {
      if (!op) return needOp();
      const r = await clearWrite(c[1], user);
      await reply(r.ok ? `Write #${c[1]} cleared. Writes are no longer held by it.${r.moves ? ` ${plural(r.moves, 'card')} waiting on it now count${r.moves === 1 ? 's' : ''} as applied.` : ''}` : `:warning: ${r.error}`);
      return true;
    }
    const open = await unresolvedWrites();
    await reply(open.length ? `:warning: ${open.length} write${open.length === 1 ? '' : 's'} with an unknown outcome:\n${open.map((w) => `• #${w.id} ${w.state}: ${JSON.stringify(w.operations).slice(0, 160)}`).join('\n')}\nFor each: open what it names in Ads Manager and see whether the change is there (the status, or the budget). If it is, or once you have made it by hand, send \`journal clear <number>\`.` : 'Every write has a clear outcome. Nothing is held.');
    return true;
  }

  if (/^status$/.test(t)) {
    await refreshPolicy().catch(() => {});
    const [health, incidents, freeze, rec] = await Promise.all([loopHealth(), openIncidents(), getState('optimizer/freeze'), recordStatus().catch(() => null)]);
    const p = policy();
    const spec = metricSpec();
    const target = !p.target ? 'not set (the optimizer is off until there is one)'
      : p.targetSource === 'brain policy/target'
        ? `${money(p.target)}, from the brain (policy/target)${p.settingsTarget ? `; it overrides TARGET_COST_PER_RESULT, ${money(p.settingsTarget)}` : ''}`
        : `${money(p.target)}, from TARGET_COST_PER_RESULT`;
    const changed = Object.entries(p.overrides || {}).flatMap(([g, vals]) => Object.entries(vals).map(([k, v]) => `${g}.${k} ${fmtNum(v)} (default ${fmtNum(DEFAULTS[g][k])})`));
    await reply([
      `*Status*`,
      `• Result: ${plainEvent(spec.result, getConfigSafe().RESULT_ACTION_TYPE)}${spec.secondary ? ` · also watched: ${plainEvent(spec.secondary, getConfigSafe().SECONDARY_ACTION_TYPE)}` : ''}`,
      `• Target: ${target}`,
      `• Daily ceiling: ${p.maxDailyBudget ? money(p.maxDailyBudget) : 'not set (every budget change is refused until there is one)'} · currency: ${currency() || 'not read yet'}`,
      `• Thresholds: ${changed.length ? `${changed.length} changed in the brain: ${changed.join(', ')}` : 'the defaults'}`,
      ...(p.ignored?.length ? [`• :warning: Ignored brain rows: ${p.ignored.join('; ')}. Write them again (\`brain set ...\`) or remove them.`] : []),
      `• Operators: ${operators().length ? operators().map((u) => `<@${u}>`).join(', ') : 'none yet (nobody can approve cards or confirm orders)'}`,
      `• Optimizer: ${getConfigSafe().OPTIMIZER_ENABLED === false ? 'off (OPTIMIZER_ENABLED=false in the settings; whoever set up the agent turns it on)' : freeze?.on ? `frozen by ${freeze.by ? `<@${freeze.by}>` : 'an operator'}${freeze.note ? ` (${freeze.note})` : ''}; \`unfreeze\` resumes it` : !p.target ? 'on, but proposing nothing until there is a target' : 'on'}`,
      `• Record: ${rec?.decisions == null ? 'the decisions and hypotheses tables are not there yet (npm start adds them)' : `${plural(rec.decisions, 'active decision')}, ${plural(rec.hypotheses ?? 0, 'open hypothesis', 'open hypotheses')}`}${rec?.views?.length ? ` · result views: ${rec.views.map((v) => (v.ok ? `${v.name} ok` : `${v.name} not set up (${v.problem})`)).join(', ')}` : ''}`,
      `• Jobs: ${health.map((h) => `${h.loop} ${h.consecutive_failures ? `(${plural(h.consecutive_failures, 'failure')})` : 'ok'}`).join(', ') || 'no runs yet'}`,
      `• Open issues: ${incidents.length ? incidents.map((i) => i.text.slice(0, 100)).join('; ') : 'none'}`,
    ].join('\n'));
    return true;
  }
  return false;
}
