import type { BoardData, Bout, BoutRanking } from './data'

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// Numeric BoardData fields are typed `number`, but — like mode/outcome above —
// that guarantee is compile-time only: they originate from JSON.parse() on
// trace JSONL files read from disk, so a corrupted/tampered trace line can put
// a non-number where a number is expected. safeNumber is the render-boundary
// guard: anything that isn't actually a finite number renders as 0 instead of
// passing through raw (XSS) or throwing (e.g. `.toFixed` on a string, DoS).
function safeNumber(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

const fmt = (n: unknown) => safeNumber(n).toLocaleString('en-US')
const usd = (n: unknown) => `$${safeNumber(n).toFixed(2)}`

function deltaHtml(r: BoutRanking): string {
  if (r.delta === undefined || r.delta === 0) return '<span class="delta flat">±0</span>'
  const cls = r.delta > 0 ? 'up' : 'down'
  const sign = r.delta > 0 ? '+' : '−'
  return `<span class="delta ${cls}">${sign}${Math.round(Math.abs(r.delta))}</span>`
}

function rowHtml(r: BoutRanking, champ: boolean): string {
  const tale = r.forfeit
    ? `<span class="tale forfeit">${escapeHtml(r.forfeit)} — ${escapeHtml(r.forfeitReason ?? '')}</span>`
    : '<span class="tale"></span>'
  return `<div class="row${champ ? ' champ' : ''}"><span class="seed">${r.place ?? '–'}</span>`
    + `<span class="fighter">${escapeHtml(r.model)}</span>${tale}${deltaHtml(r)}</div>`
}

function agreementBadge(b: Bout): string {
  if (b.agreement === true) return '<span class="badge unan">Unanimous</span>'
  if (b.agreement === false) return '<span class="badge split">Split</span>'
  return '<span class="badge solo">Solo panel</span>'
}

function boutHtml(b: Bout): string {
  const dq = b.outcome === 'rejected'
  const oc = b.outcome ? escapeHtml(b.outcome) : ''
  const outcomePill = b.outcome
    ? `<span class="badge outcome-${oc}">${oc}</span>`
    : '<span class="badge solo">unreported</span>'
  const learning = b.learning
    ? `<p class="learning-note">Learning: ${escapeHtml(b.learning)}</p>`
    : ''
  return `<div class="bout${dq ? ' inquiry' : ''}">
  <div class="bout-head"><span>${escapeHtml(b.mode)} · <b>${escapeHtml(b.taskProfile.join(', '))}</b></span>`
    + `<span>${escapeHtml(b.runId)}${dq ? " — <b>Stewards' inquiry</b>" : ''}</span></div>
  <div class="card">
    ${b.ranking.map((r, i) => rowHtml(r, i === 0 && !r.forfeit)).join('\n    ')}
    <div class="judges">JUDGES&nbsp; ${b.judges.map(escapeHtml).join(' · ')} ${agreementBadge(b)} ${outcomePill}</div>
    ${learning}
  </div>
</div>`
}

export function renderBoardHtml(d: BoardData): string {
  const judgeAgree = safeNumber(d.judgeAgreement.agree)
  const judgeTotal = safeNumber(d.judgeAgreement.total)
  const agreementLine = judgeTotal > 0
    ? `Judge agreement: ${Math.round((judgeAgree / judgeTotal) * 100)}% (${judgeAgree}/${judgeTotal} panels)`
    : ''
  const corruptLines = safeNumber(d.corruptLines)
  const corrupt = corruptLines > 0
    ? ` <b>${corruptLines} corrupt trace line(s) skipped.</b>`
    : ''
  const ladders = d.ladders.map((l) => `
    <div class="ladder"><h3>${escapeHtml(l.tag)}</h3>
      ${l.rows.map((r) => `<div class="lrow"><span class="r">${safeNumber(r.rank)}</span><span class="name">${escapeHtml(r.id)}</span><span class="elo">${Math.round(safeNumber(r.elo))}</span></div>`).join('\n      ')}
    </div>`).join('\n')
  const scouting = d.scouting.length > 0 ? `
  <section class="scouting"><h2>Scouting report</h2>
    ${d.scouting.map((s) => `<div class="scout"><span class="fighter">${escapeHtml(s.model)}</span><span class="note">${escapeHtml(s.note)}</span></div>`).join('\n    ')}
  </section>` : ''
  return `<title>NV-AGENTS ARENA — ${escapeHtml(d.repo)}</title>
<!-- ReshapeX app-ui tokens — DS bundle snapshot 2026-07-03 -->
<style>
${TOKEN_CSS}
</style>
<div class="hall">
<header>
  <p class="eyebrow">nv-agents · blind model tournaments · NVIDIA NIM free endpoints</p>
  <h1>Arena <span class="accent">/</span> Match Board</h1>
  <div class="venue">
    <span>VENUE <b>${escapeHtml(d.repo)}</b></span>
    <span>GENERATED <b>${escapeHtml(d.generatedAt.slice(0, 10))}</b></span>
    <span>PURSE <b>$0.00</b></span>
  </div>
</header>
<div class="floor">
<div class="col">
  <section><h2>Recent bouts</h2>
  ${d.bouts.map(boutHtml).join('\n  ')}
  </section>
  <section><h2>Season record — orchestrator verdicts</h2>
    <div class="record">
      <span class="w">${safeNumber(d.record.accepted)} accepted</span>
      <span class="rw">${safeNumber(d.record.reworked)} reworked</span>
      <span class="l">${safeNumber(d.record.rejected)} rejected</span>
      <span>${safeNumber(d.counters.aborted)} no-contest</span>
    </div>
  </section>
  ${scouting}
</div>
<div class="col">
  <section><h2>Frontier tokens not spent</h2>
    <div class="counter-grid">
      <div class="counter wide"><div class="num accent">${fmt(d.counters.promptTokens + d.counters.completionTokens)}</div>
        <div class="lbl">NIM tokens across ${safeNumber(d.counters.runs)} runs (all-time) · ${fmt(d.counters.promptTokens)} in / ${fmt(d.counters.completionTokens)} out</div></div>
      <div class="counter"><div class="num">${usd(d.counters.sonnetEquivUsd)}</div><div class="lbl">Sonnet-equivalent saved</div></div>
      <div class="counter"><div class="num">${usd(d.counters.opusEquivUsd)}</div><div class="lbl">Opus-equivalent saved</div></div>
      <div class="counter"><div class="num">${fmt(d.counters.requests)}</div><div class="lbl">API requests</div></div>
      <div class="counter"><div class="num accent">$0.00</div><div class="lbl">Actually paid</div></div>
    </div>
  </section>
  <section><h2>Elo ladders</h2>
  ${ladders}
  </section>
</div>
</div>
<footer>
  <b>Provenance.</b> Elo ladders come from state (authoritative); bouts and counters come
  from trace files (reporting) — they can legitimately disagree when a trace line is
  corrupt.${corrupt} ${agreementLine}
</footer>
</div>`
}

const TOKEN_CSS = `
  :root {
    /* ReshapeX app-ui tokens — dark values (dark-first board) */
    --ui-colors-surface-base: #0D1117;
    --ui-colors-surface-raised: #1C2128;
    --ui-colors-surface-inset: #161B22;
    --ui-colors-text-primary: #FFFFFF;
    --ui-colors-text-secondary: #8B9AAD;
    --ui-colors-border-default: #1C2128;
    --ui-colors-border-subtle: #161B22;
    --ui-colors-border-strong: #8B9AAD;
    --ui-colors-accent: #73B400;              /* electric green */
    --ui-colors-accent-rgb: 115,180,0;
    --ui-colors-semantic-success: #73B400;
    --ui-colors-semantic-error: #FF006E;      /* magenta */
    --ui-colors-semantic-info: #00D9FF;       /* cyan */
    --ui-colors-semantic-warning: #FFE500;
    --ui-effects-radius-md: 8px;
    --ui-effects-radius-lg: 12px;
    --ui-effects-radius-panel: 16px;
    --ui-effects-shadow-card: 0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1);
    --ui-effects-transition-base: 200ms cubic-bezier(.4,0,.2,1);
    --ui-typography-heading: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --ui-typography-body: Switzer, "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --ui-typography-mono: "JetBrains Mono", "SF Mono", "Cascadia Code", ui-monospace, monospace;
    --ls-eyebrow: 0.12em;
    --ls-stat: -0.03em;
    --ls-stat-label: 0.06em;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --ui-colors-surface-base: #FFFFFF;
      --ui-colors-surface-raised: #F5F7FA;
      --ui-colors-surface-inset: #F0F2F5;
      --ui-colors-text-primary: #0D1117;
      --ui-colors-text-secondary: #8494A8;
      --ui-colors-border-default: #E5E9EC;
      --ui-colors-border-subtle: #F0F2F5;
      --ui-colors-border-strong: #8494A8;
      --ui-colors-accent: #5C9000;
      --ui-colors-accent-rgb: 92,144,0;
      --ui-colors-semantic-success: #5C9000;
      --ui-colors-semantic-error: #90005C;
      --ui-colors-semantic-info: #005C90;
      --ui-colors-semantic-warning: #9A8500;
      --ui-effects-shadow-card: 0 2px 4px -1px rgba(13,17,23,.06), 0 4px 8px -2px rgba(13,17,23,.08);
    }
  }
  :root[data-theme="dark"] {
    --ui-colors-surface-base: #0D1117; --ui-colors-surface-raised: #1C2128;
    --ui-colors-surface-inset: #161B22; --ui-colors-text-primary: #FFFFFF;
    --ui-colors-text-secondary: #8B9AAD; --ui-colors-border-default: #1C2128;
    --ui-colors-border-subtle: #161B22; --ui-colors-border-strong: #8B9AAD;
    --ui-colors-accent: #73B400; --ui-colors-accent-rgb: 115,180,0;
    --ui-colors-semantic-success: #73B400; --ui-colors-semantic-error: #FF006E;
    --ui-colors-semantic-info: #00D9FF; --ui-colors-semantic-warning: #FFE500;
    --ui-effects-shadow-card: 0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1);
  }
  :root[data-theme="light"] {
    --ui-colors-surface-base: #FFFFFF; --ui-colors-surface-raised: #F5F7FA;
    --ui-colors-surface-inset: #F0F2F5; --ui-colors-text-primary: #0D1117;
    --ui-colors-text-secondary: #8494A8; --ui-colors-border-default: #E5E9EC;
    --ui-colors-border-subtle: #F0F2F5; --ui-colors-border-strong: #8494A8;
    --ui-colors-accent: #5C9000; --ui-colors-accent-rgb: 92,144,0;
    --ui-colors-semantic-success: #5C9000; --ui-colors-semantic-error: #90005C;
    --ui-colors-semantic-info: #005C90; --ui-colors-semantic-warning: #9A8500;
    --ui-effects-shadow-card: 0 2px 4px -1px rgba(13,17,23,.06), 0 4px 8px -2px rgba(13,17,23,.08);
  }

  * { box-sizing: border-box; }
  body {
    background: var(--ui-colors-surface-base);
    color: var(--ui-colors-text-primary);
    font-family: var(--ui-typography-body);
    margin: 0; padding: 40px 20px 64px; line-height: 1.5;
  }
  .hall { max-width: 1080px; margin: 0 auto; }

  header { padding-bottom: 20px; margin-bottom: 26px; border-bottom: 1px solid var(--ui-colors-border-default); position: relative; }
  header::after {
    content: ""; position: absolute; left: 0; bottom: -1px; width: 96px; height: 2px;
    background: var(--ui-colors-accent);
  }
  .eyebrow {
    font-family: var(--ui-typography-mono); font-size: 11px; letter-spacing: var(--ls-eyebrow);
    text-transform: uppercase; color: var(--ui-colors-accent); margin: 0 0 8px; font-weight: 600;
  }
  h1 {
    font-family: var(--ui-typography-heading); font-weight: 800;
    font-size: clamp(34px, 5.4vw, 56px); letter-spacing: -0.02em; line-height: 1.02;
    margin: 0; text-wrap: balance;
  }
  h1 .accent { color: var(--ui-colors-accent); }
  .venue {
    display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 12px;
    font-family: var(--ui-typography-mono); font-size: 12px; color: var(--ui-colors-text-secondary);
  }
  .venue b { color: var(--ui-colors-text-primary); font-weight: 600; }

  .floor { display: grid; grid-template-columns: 3fr 2fr; gap: 22px; align-items: start; }
  @media (max-width: 820px) { .floor { grid-template-columns: 1fr; } }

  section h2 {
    font-family: var(--ui-typography-heading); text-transform: uppercase;
    letter-spacing: var(--ls-stat-label); font-size: 13px; font-weight: 700;
    color: var(--ui-colors-text-secondary); margin: 26px 0 10px;
    display: flex; align-items: baseline; gap: 10px;
  }
  section h2::after { content: ""; flex: 1; border-top: 1px solid var(--ui-colors-border-default); transform: translateY(-3px); }
  .col > section:first-child h2 { margin-top: 0; }

  .bout {
    background: var(--ui-colors-surface-raised);
    border: 1px solid var(--ui-colors-border-default);
    border-radius: var(--ui-effects-radius-lg);
    box-shadow: var(--ui-effects-shadow-card);
    margin-bottom: 14px; overflow: hidden;
    transition: border-color var(--ui-effects-transition-base);
  }
  .bout-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--ui-colors-border-subtle);
    font-family: var(--ui-typography-mono); font-size: 11px;
    letter-spacing: var(--ls-eyebrow); text-transform: uppercase;
    color: var(--ui-colors-text-secondary);
  }
  .bout-head b { color: var(--ui-colors-text-primary); }
  .card { padding: 12px 16px 14px; }

  .row { display: grid; grid-template-columns: 22px 1fr auto auto; gap: 10px; align-items: center; padding: 7px 0; }
  .row + .row { border-top: 1px solid var(--ui-colors-border-subtle); }
  .seed { font-family: var(--ui-typography-mono); font-size: 11px; color: var(--ui-colors-text-secondary); text-align: right; }
  .fighter { font-family: var(--ui-typography-mono); font-size: 13px; overflow-wrap: anywhere; }
  .row.champ .fighter { color: var(--ui-colors-accent); font-weight: 700; }
  .row.champ .fighter::after { content: " ▲"; font-size: 10px; }
  .tale { font-family: var(--ui-typography-mono); font-size: 11px; color: var(--ui-colors-text-secondary); white-space: nowrap; }
  .delta { font-family: var(--ui-typography-mono); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; min-width: 44px; }
  .delta.up { color: var(--ui-colors-semantic-success); }
  .delta.down { color: var(--ui-colors-semantic-error); }
  .delta.flat { color: var(--ui-colors-text-secondary); }
  .forfeit { color: var(--ui-colors-semantic-error); }

  .judges {
    margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--ui-colors-border-subtle);
    display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center;
    font-family: var(--ui-typography-mono); font-size: 11px; color: var(--ui-colors-text-secondary);
  }
  .badge {
    display: inline-block; padding: 2px 9px; border-radius: 9999px; font-size: 10px;
    letter-spacing: var(--ls-stat-label); text-transform: uppercase; font-weight: 700;
    font-family: var(--ui-typography-body);
  }
  .badge.unan { background: rgba(var(--ui-colors-accent-rgb), .12); color: var(--ui-colors-accent); border: 1px solid rgba(var(--ui-colors-accent-rgb), .35); }
  .badge.solo { border: 1px solid var(--ui-colors-border-strong); color: var(--ui-colors-text-secondary); }
  .badge.dq { background: color-mix(in srgb, var(--ui-colors-semantic-error) 12%, transparent); color: var(--ui-colors-semantic-error); border: 1px solid var(--ui-colors-semantic-error); }
  .badge.clean { border: 1px solid var(--ui-colors-semantic-success); color: var(--ui-colors-semantic-success); }
  .badge.split { background: color-mix(in srgb, var(--ui-colors-semantic-warning) 14%, transparent); color: var(--ui-colors-semantic-warning); border: 1px solid var(--ui-colors-semantic-warning); }
  .badge.outcome-accepted { border: 1px solid var(--ui-colors-semantic-success); color: var(--ui-colors-semantic-success); }
  .badge.outcome-reworked { border: 1px solid var(--ui-colors-semantic-warning); color: var(--ui-colors-semantic-warning); }
  .badge.outcome-rejected { border: 1px solid var(--ui-colors-semantic-error); color: var(--ui-colors-semantic-error); }

  .inquiry { border-color: color-mix(in srgb, var(--ui-colors-semantic-error) 45%, transparent); }
  .inquiry .bout-head { color: var(--ui-colors-semantic-error); border-bottom-color: color-mix(in srgb, var(--ui-colors-semantic-error) 30%, transparent); }
  .inquiry .bout-head b { color: var(--ui-colors-semantic-error); }
  .inquiry p { margin: 8px 0 0; font-size: 13.5px; max-width: 62ch; }
  .evidence { font-family: var(--ui-typography-mono); font-size: 11.5px; color: var(--ui-colors-text-secondary); }
  .learning-note { font-family: var(--ui-typography-mono); font-size: 11.5px; color: var(--ui-colors-text-secondary); margin: 8px 0 0; border-left: 2px solid var(--ui-colors-accent); padding-left: 10px; }

  .counter-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .counter {
    background: var(--ui-colors-surface-inset);
    border: 1px solid var(--ui-colors-border-default);
    border-radius: var(--ui-effects-radius-md);
    padding: 14px 16px 12px;
  }
  .counter .num {
    font-family: var(--ui-typography-heading); font-size: clamp(26px, 3.2vw, 34px);
    font-weight: 800; font-variant-numeric: tabular-nums;
    letter-spacing: var(--ls-stat); line-height: 1;
  }
  .counter .num.accent { color: var(--ui-colors-accent); }
  .counter .lbl {
    font-family: var(--ui-typography-mono); font-size: 10px;
    letter-spacing: var(--ls-stat-label); text-transform: uppercase;
    color: var(--ui-colors-text-secondary); margin-top: 7px;
  }
  .counter.wide { grid-column: 1 / -1; }

  .ladder {
    background: var(--ui-colors-surface-raised);
    border: 1px solid var(--ui-colors-border-default);
    border-radius: var(--ui-effects-radius-lg);
    padding: 13px 16px; margin-bottom: 12px;
  }
  .ladder h3 {
    margin: 0 0 8px; font-family: var(--ui-typography-mono); font-size: 11px;
    letter-spacing: var(--ls-eyebrow); text-transform: uppercase;
    color: var(--ui-colors-text-secondary); font-weight: 600;
  }
  .lrow { display: grid; grid-template-columns: 16px 1fr 52px; gap: 8px; align-items: center; padding: 4px 0; font-family: var(--ui-typography-mono); font-size: 12px; }
  .lrow .r { color: var(--ui-colors-text-secondary); font-size: 11px; }
  .lrow .elo { text-align: right; font-variant-numeric: tabular-nums; }
  .lrow:first-of-type .name, .lrow:first-of-type .elo { color: var(--ui-colors-accent); font-weight: 700; }
  .bar { grid-column: 2 / 4; height: 4px; background: var(--ui-colors-surface-inset); border-radius: 9999px; overflow: hidden; margin-bottom: 3px; }
  .bar i { display: block; height: 100%; background: var(--ui-colors-accent); opacity: .55; }
  .lrow:first-of-type + .bar i { opacity: 1; }

  .record { display: flex; gap: 10px; font-family: var(--ui-typography-mono); font-size: 12px; flex-wrap: wrap; }
  .record span {
    padding: 5px 12px; border: 1px solid var(--ui-colors-border-default);
    border-radius: 9999px; background: var(--ui-colors-surface-inset);
  }
  .record .w { color: var(--ui-colors-semantic-success); }
  .record .rw { color: var(--ui-colors-semantic-warning); }
  .record .l { color: var(--ui-colors-semantic-error); }

  .scout { display: grid; grid-template-columns: auto 1fr; gap: 12px; padding: 6px 0; font-family: var(--ui-typography-mono); font-size: 12px; }
  .scout .note { color: var(--ui-colors-text-secondary); }

  footer {
    margin-top: 34px; padding-top: 14px; border-top: 1px solid var(--ui-colors-border-default);
    font-family: var(--ui-typography-mono); font-size: 11px;
    color: var(--ui-colors-text-secondary); max-width: 78ch;
  }
  footer b { color: var(--ui-colors-text-primary); font-weight: 600; }
  @media (prefers-reduced-motion: no-preference) {
    .bout, .counter, .ladder { animation: rise .45s cubic-bezier(.4,0,.2,1) both; }
    .bout:nth-child(3) { animation-delay: .06s; } .bout:nth-child(4) { animation-delay: .12s; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  }
`
