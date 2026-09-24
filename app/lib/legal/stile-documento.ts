/**
 * La veste del documento, presa da `docs/legal/privacy-policy.html`.
 *
 * PERCHE' COPIATA E NON INVENTATA. Perche' una veste per l'informativa esiste
 * gia', e' stata curata a mano, ed e' quella che il documento ha sempre avuto:
 * rifarne una diversa avrebbe voluto dire che la stessa informativa si presenta
 * in due modi a seconda di dove la si legge.
 *
 * COSA NON E' STATO COPIATO, e non per svista: le due riscritture per il tema
 * scuro. In questo repository il tema chiaro non e' una preferenza — ci sono
 * un foglio di stile e un blocco in linea che lo impongono in tutta l'app — e
 * una pagina che seguisse il tema del sistema sarebbe l'unica a non farlo.
 *
 * NEMMENO I FONT DI GOOGLE. Il documento originale li carica da
 * `fonts.googleapis.com`, e caricarli vuol dire che l'indirizzo IP di chi legge
 * arriva a un terzo. Farlo accadere sulla PAGINA DELL'INFORMATIVA SULLA PRIVACY,
 * a un lettore che non ha ancora letto una riga, e' la contraddizione piu' netta
 * che questa pagina possa contenere — e ogni famiglia ha gia' le sue alternative
 * di sistema dichiarate nella stessa riga.
 */

export const STILE_DOCUMENTO = `
  :root {
    --paper:      #FAFBFC;
    --surface:    #F1F4F3;
    --ink:        #16202B;
    --ink-soft:   #4E5F6E;
    --hairline:   #DFE5E9;
    --accent:     #0F6E4E;
    --accent-dim: #6E8C81;

    --serif: "Newsreader", "Iowan Old Style", Georgia, serif;
    --sans:  "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --mono:  "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;

    --measure: 68ch;
  }

  * { box-sizing: border-box; }

  body {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 17px;
    line-height: 1.65;
    margin: 0;
    -webkit-font-smoothing: antialiased;
  }

  .shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 clamp(20px, 5vw, 56px);
  }

  @media (min-width: 1000px) {
    .shell {
      grid-template-columns: 216px minmax(0, 1fr);
      gap: clamp(40px, 6vw, 88px);
    }
  }

  /* ── Masthead ───────────────────────────────────────── */

  .masthead {
    grid-column: 1 / -1;
    border-bottom: 1px solid var(--hairline);
    padding: clamp(48px, 9vw, 96px) 0 clamp(28px, 4vw, 44px);
  }

  .wordmark {
    font-family: var(--mono);
    font-size: 0.8rem;
    font-weight: 500;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 clamp(20px, 4vw, 34px);
  }

  h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: clamp(2.4rem, 6vw, 3.6rem);
    line-height: 1.08;
    letter-spacing: -0.015em;
    text-wrap: balance;
    margin: 0 0 0.5em;
    max-width: 15ch;
  }

  .standfirst {
    font-family: var(--serif);
    font-size: clamp(1.05rem, 2.2vw, 1.3rem);
    line-height: 1.5;
    color: var(--ink-soft);
    max-width: 54ch;
    margin: 0 0 clamp(24px, 4vw, 36px);
  }

  .stamp {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 28px;
    font-family: var(--mono);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    color: var(--ink-soft);
  }

  .stamp b {
    font-weight: 500;
    color: var(--ink);
  }

  /* ── Contents rail ──────────────────────────────────── */

  .rail { display: none; }

  @media (min-width: 1000px) {
    .rail {
      display: block;
      padding-top: clamp(48px, 6vw, 72px);
    }

    .rail-inner {
      position: sticky;
      top: 40px;
    }

    .rail h2 {
      font-family: var(--mono);
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--ink-soft);
      margin: 0 0 16px;
    }

    .rail ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 9px;
      counter-reset: toc;
    }

    .rail a {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 8px;
      font-size: 0.86rem;
      line-height: 1.35;
      color: var(--ink-soft);
      text-decoration: none;
      border-left: 2px solid transparent;
      padding-left: 10px;
      margin-left: -12px;
      transition: color 120ms ease, border-color 120ms ease;
    }

    .rail a::before {
      counter-increment: toc;
      content: counter(toc, decimal-leading-zero);
      font-family: var(--mono);
      font-size: 0.72rem;
      color: var(--accent-dim);
      padding-top: 1px;
    }

    .rail a:hover,
    .rail a:focus-visible {
      color: var(--ink);
    }

    .rail a[aria-current="true"] {
      color: var(--ink);
      border-left-color: var(--accent);
    }

    .rail a[aria-current="true"]::before { color: var(--accent); }
  }

  /* ── Body ───────────────────────────────────────────── */

  main {
    padding: clamp(40px, 6vw, 64px) 0 clamp(64px, 9vw, 112px);
    max-width: var(--measure);
  }

  section + section { margin-top: clamp(44px, 6vw, 68px); }

  section > h2 {
    font-family: var(--serif);
    font-size: clamp(1.5rem, 3vw, 1.85rem);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
    text-wrap: balance;
    margin: 0 0 0.7em;
    padding-top: 4px;
    scroll-margin-top: 28px;
  }

  section > h2 .num {
    font-family: var(--mono);
    font-size: 0.72em;
    font-weight: 400;
    color: var(--accent);
    margin-right: 0.7em;
    letter-spacing: 0.02em;
  }

  h3 {
    font-family: var(--sans);
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-soft);
    margin: 2.1em 0 0.7em;
  }

  p { margin: 0 0 1.1em; }
  p:last-child { margin-bottom: 0; }

  /* Lists inside the prose column; the contents rail styles its own. */
  main ul {
    margin: 0 0 1.1em;
    padding-left: 1.15em;
    list-style: none;
  }

  main ul li {
    position: relative;
    margin: 0 0 0.6em;
  }

  main ul li::before {
    content: "—";
    position: absolute;
    left: -1.15em;
    color: var(--accent-dim);
  }

  strong { font-weight: 600; }

  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }

  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 2px;
  }

  /* A pull-quote for the sentences that carry the whole document. */
  .keystone {
    font-family: var(--serif);
    font-size: 1.18rem;
    line-height: 1.5;
    border-left: 2px solid var(--accent);
    padding: 2px 0 2px 20px;
    margin: 1.6em 0;
    color: var(--ink);
  }

  .table-wrap {
    overflow-x: auto;
    margin: 1.5em 0;
    border-top: 1px solid var(--hairline);
    border-bottom: 1px solid var(--hairline);
  }

  table {
    border-collapse: collapse;
    width: 100%;
    min-width: 460px;
    font-size: 0.92rem;
  }

  th, td {
    text-align: left;
    padding: 11px 20px 11px 0;
    vertical-align: top;
  }

  th {
    font-family: var(--mono);
    font-size: 0.7rem;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-soft);
    border-bottom: 1px solid var(--hairline);
    padding-top: 14px;
  }

  tbody tr + tr td { border-top: 1px solid var(--hairline); }
  tbody td:first-child { font-weight: 500; white-space: nowrap; }

  /* ── Footer ─────────────────────────────────────────── */

  footer {
    grid-column: 1 / -1;
    border-top: 1px solid var(--hairline);
    padding: clamp(32px, 5vw, 48px) 0 clamp(48px, 7vw, 80px);
    font-size: 0.9rem;
    color: var(--ink-soft);
    max-width: var(--measure);
  }

  footer p { margin-bottom: 0.8em; }
  footer .imprint {
    font-family: var(--mono);
    font-size: 0.78rem;
    line-height: 1.7;
    margin-top: 1.6em;
  }

  @media print {
    :root { --paper: #fff; --ink: #000; --ink-soft: #333; --hairline: #bbb; --accent: #000; }
    .rail { display: none; }
    body { font-size: 11pt; }
    section { break-inside: avoid-page; }
    .shell { max-width: none; padding: 0; }
  }
`;
