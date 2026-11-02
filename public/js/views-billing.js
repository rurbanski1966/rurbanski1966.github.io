// ---------------------------------------------------------------------------
// Billing: each agency's AI grading balance, paid by card through Stripe.
//
// The balance is the agency's billed AI cost (the same figure as the
// Dashboard, SBA markup included) minus what has been paid. "Pay" asks the
// create-checkout Edge Function for a Stripe-hosted payment page and goes
// there; Stripe sends the person back here, and the payment shows up once
// Stripe's webhook has recorded it (normally a few seconds).
// ---------------------------------------------------------------------------
import * as db from './db.js?v=83';
import { esc, toast, fmtMoneyExact, fmtDate, empty, spinner, agencyColor } from './ui.js?v=83';

// Stripe's smallest card charge in USD.
const MIN_PAYMENT = 0.5;

// Agencies whose balance can be charged automatically each month
// (migration 058). An admin saves the card.
const AUTOPAY_AGENCIES = ['SBA', 'SMC'];

// EWSS owns the platform and already pays the AI bill directly, so its
// balance is never paid by card: an admin zeroes it out instead
// (migration 048).
const OWNER_AGENCY = 'EWSS';

// A payment timestamp as the viewer's own calendar day (a UTC slice would
// show an evening payment as the next day).
const localDay = ts => new Date(ts).toLocaleDateString('en-CA');

export async function billing(main, ctx) {
  // Coming back from Stripe: say what happened, then drop the marker from the
  // address bar so a refresh doesn't repeat it.
  const checkout = new URLSearchParams(location.search).get('checkout');
  if (checkout) {
    history.replaceState(null, '', location.pathname + location.hash);
    if (checkout === 'success') toast('Payment received. Thank you!', 'ok');
    else toast('Payment cancelled. Nothing was charged.', 'error');
  }
  const autopay = new URLSearchParams(location.search).get('autopay');
  if (autopay) {
    history.replaceState(null, '', location.pathname + location.hash);
    if (autopay === 'success') toast('Card saved. Autopay is on.', 'ok');
    else toast('Card setup cancelled. Nothing was saved.', 'error');
  }

  const isAdmin = ctx.profile.role === 'admin';
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Billing</h1>
      <div class="page__sub">${isAdmin ? 'AI call grading balance for every agency' : 'Your agency’s AI call grading balance'}</div>
    </div></div>
    <div id="bill-cards">${spinner()}</div>
    <div class="card" id="bill-history" style="margin-top:16px"></div>`;

  await draw(main, ctx);

  // The webhook usually lands within a second or two of Stripe redirecting
  // back; look again shortly so the new payment appears without a refresh.
  if (checkout === 'success' || autopay === 'success') setTimeout(() => draw(main, ctx), 4000);
}

async function draw(main, ctx) {
  const cardsHost = main.querySelector('#bill-cards');
  const historyHost = main.querySelector('#bill-history');
  if (!cardsHost) return; // navigated away

  const [balances, payments, autopay] = await Promise.all([db.agencyBalances(), db.agencyPayments(), db.agencyAutopay()]);

  if (balances === null) {
    cardsHost.innerHTML = `<div class="card">${empty('Billing isn’t set up yet. An admin needs to run migration 046.')}</div>`;
    historyHost.hidden = true;
    return;
  }
  if (balances.length === 0) {
    cardsHost.innerHTML = `<div class="card">${empty('Your login isn’t in an agency yet, so there’s no balance to show. Ask an admin to set your team.')}</div>`;
    historyHost.hidden = true;
    return;
  }

  const myTeam = ctx.profile.team_id;
  const isAdmin = ctx.profile.role === 'admin';
  const autopayOf = teamId => autopay && {
    card: autopay.cards.find(c => c.team_id === teamId),
    // Newest first, so this is the latest month billed.
    month: autopay.months.find(m => m.team_id === teamId),
  };
  cardsHost.innerHTML = `<div class="agency-grid">${balances.map(b => balanceCardHtml(b, b.team_id === myTeam, isAdmin, autopayOf(b.team_id))).join('')}</div>`;
  cardsHost.querySelectorAll('[data-pay]').forEach(btn => btn.addEventListener('click', () => pay(btn)));
  cardsHost.querySelectorAll('[data-autopay-setup]').forEach(btn => btn.addEventListener('click', () => setupAutopay(btn)));
  cardsHost.querySelectorAll('[data-autopay-off]').forEach(btn => btn.addEventListener('click', () => autopayOff(btn, main, ctx)));
  cardsHost.querySelectorAll('[data-zero]').forEach(btn => btn.addEventListener('click', () => zeroOut(btn, main, ctx)));

  historyHost.hidden = false;
  historyHost.innerHTML = `
    <h2>Payment history</h2>
    ${payments.length === 0 ? empty('No payments yet.') : `
      <div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Agency</th><th>Type</th><th>By</th><th class="num">Amount</th><th class="num">Sales tax</th><th class="num">Total charged</th></tr></thead>
        <tbody>
          ${payments.map(p => `
            <tr>
              <td>${esc(fmtDate(localDay(p.paid_at)))}</td>
              <td><span class="legend__swatch legend__swatch--inline" style="background:${agencyColor(p.team?.name)}"></span>${esc(p.team?.name ?? '—')}</td>
              <td>${p.kind === 'write_off' ? 'Paid' : p.kind === 'autopay' ? 'Autopay' : 'Card payment'}</td>
              <td>${esc(p.payer?.full_name || p.paid_by_email || (p.kind === 'autopay' ? 'Card on file' : '—'))}</td>
              <td class="num">${esc(fmtMoneyExact(p.amount_usd))}</td>
              <td class="num">${p.kind === 'write_off' ? '—' : esc(fmtMoneyExact(p.tax_usd ?? 0))}</td>
              <td class="num">${esc(fmtMoneyExact(Number(p.amount_usd) + Number(p.tax_usd ?? 0)))}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>`}`;
}

function balanceCardHtml(b, isMine, isAdmin, auto) {
  const balance = Number(b.balance_usd);
  const inProgress = auto?.month && ['creating', 'open'].includes(auto.month.status);
  let action;
  if (inProgress) {
    action = `<p class="muted bill-note">Autopay charge of ${esc(fmtMoneyExact(auto.month.amount_usd))} + tax for ${esc(monthLabel(auto.month.period))} is in progress.${isAdmin && auto.month.error ? ` ${esc(auto.month.error)}` : ''}</p>`;
  } else if (b.team_name === OWNER_AGENCY && balance > 0) {
    action = isAdmin
      ? `<button class="btn bill-pay" type="button" data-zero="${esc(b.team_id)}" data-amount="${esc(fmtMoneyExact(balance))}">Zero out balance</button>
         <p class="muted bill-note">EWSS’s AI usage is already paid through the Claude API bill.</p>`
      : `<p class="muted bill-note">Covered by EWSS. An admin clears this balance.</p>`;
  } else if (balance >= MIN_PAYMENT && isMine) {
    action = `<button class="btn btn--primary bill-pay" type="button" data-pay="${esc(b.team_id)}">Pay ${esc(fmtMoneyExact(balance))} + tax</button>
              <p class="muted bill-note">Sales tax is added at checkout, based on your billing address.</p>`;
  } else if (balance >= MIN_PAYMENT) {
    action = `<p class="muted bill-note">Waiting on ${esc(b.team_name)} to pay.</p>`;
  } else if (balance > 0) {
    action = `<p class="muted bill-note">Under the $0.50 card minimum. It carries over to the next payment.</p>`;
  } else {
    action = `<p class="bill-note"><span class="chip chip--good"><span aria-hidden="true">✓</span>${balance < 0 ? `Credit of ${esc(fmtMoneyExact(-balance))}` : 'Paid up'}</span></p>`;
  }
  return `
    <section class="agency-card" style="--agency:${agencyColor(b.team_name)}">
      <header class="agency-card__head">
        <span class="agency-card__swatch" aria-hidden="true"></span>
        <h3>${esc(b.team_name)}</h3>
        ${isMine ? '<span class="agency-card__share">Your agency</span>' : ''}
      </header>
      <div class="agency-card__label">Balance due</div>
      <div class="agency-card__value">${esc(fmtMoneyExact(Math.max(0, balance)))}</div>
      <dl class="agency-card__periods">
        <div><dt>AI grading</dt><dd>${esc(fmtMoneyExact(b.charges_usd))}</dd></div>
        <div><dt>Paid</dt><dd>${esc(fmtMoneyExact(b.paid_usd))}</dd></div>
        <div><dt>Last payment</dt><dd>${b.last_paid_at ? esc(fmtDate(localDay(b.last_paid_at))) : '—'}</dd></div>
      </dl>
      ${action}
      ${autopayHtml(b, isAdmin, auto)}
    </section>`;
}

const monthLabel = period => {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 15).toLocaleString('en-US', { month: 'long', year: 'numeric' });
};

// The autopay line on SBA's and SMC's cards. Left out entirely when
// migration 058 hasn't been run (auto is null).
function autopayHtml(b, isAdmin, auto) {
  if (!auto || !AUTOPAY_AGENCIES.includes(b.team_name)) return '';
  const card = auto.card;
  const on = card?.enabled && card.card_label;
  const failed = isAdmin && auto.month?.status === 'failed'
    ? `<p class="bill-note"><span class="chip chip--critical"><span aria-hidden="true">!</span>Autopay failed for ${esc(monthLabel(auto.month.period))}</span> <span class="muted">${esc(auto.month.error ?? '')}</span></p>`
    : '';
  if (!isAdmin) {
    return on
      ? `<p class="muted bill-note">Autopay is on: ${esc(card.card_label)} is charged on the last day of each month.</p>`
      : '';
  }
  return `
    <div class="bill-autopay">
      ${on
        ? `<p class="bill-note"><span class="chip chip--good"><span aria-hidden="true">✓</span>Autopay on</span> <span class="muted">${esc(card.card_label)} · charged the last day of each month</span></p>
           <div class="bill-autopay__actions">
             <button class="btn btn--ghost btn--sm" type="button" data-autopay-setup="${esc(b.team_id)}">Change card</button>
             <button class="btn btn--ghost btn--sm" type="button" data-autopay-off="${esc(b.team_id)}" data-name="${esc(b.team_name)}">Turn off autopay</button>
           </div>`
        : `<button class="btn btn--ghost btn--sm" type="button" data-autopay-setup="${esc(b.team_id)}">${card?.card_label ? 'Turn autopay back on' : 'Set up autopay'}</button>
           <p class="muted bill-note">Saves ${esc(b.team_name)}’s card and charges its balance + tax on the last day of each month.</p>`}
      ${failed}
    </div>`;
}

async function setupAutopay(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening secure card setup…';
  try {
    const { url } = await db.setupAutopay(btn.dataset.autopaySetup);
    location.href = url;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function autopayOff(btn, main, ctx) {
  if (!confirm(`Turn off autopay for ${btn.dataset.name}?

The card stays saved at Stripe, and the balance can still be paid with the Pay button.`)) return;
  btn.disabled = true;
  try {
    await db.disableAutopay(btn.dataset.autopayOff);
    toast(`Autopay is off for ${btn.dataset.name}.`, 'ok');
    await draw(main, ctx);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

async function zeroOut(btn, main, ctx) {
  if (!confirm(`Zero out EWSS's balance of ${btn.dataset.amount}?

It's recorded in the history as zeroed out by you. Nothing is charged.`)) return;
  btn.disabled = true;
  btn.textContent = 'Zeroing out…';
  try {
    const cleared = await db.zeroOutBalance(btn.dataset.zero);
    toast(Number(cleared) > 0 ? `EWSS balance of ${fmtMoneyExact(cleared)} zeroed out.` : 'EWSS had nothing to clear.', 'ok');
    await draw(main, ctx);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Zero out balance';
  }
}

async function pay(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Opening secure checkout…';
  try {
    const { url } = await db.startCheckout(btn.dataset.pay);
    location.href = url;
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = label;
  }
}
