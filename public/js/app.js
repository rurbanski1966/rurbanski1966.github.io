// ---------------------------------------------------------------------------
// Boot, auth gate, hash router, nav.
// ---------------------------------------------------------------------------
import { isConfigured, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=50';
import { toast, esc } from './ui.js?v=50';

// Bump when debugging a stale-cache problem: if the browser doesn't show this
// exact string, it is running old code and nothing else you observe is real.
const BUILD = 'build-37';

const el = id => document.getElementById(id);

// Read before db.js creates the Supabase client and consumes these tokens
// from the URL. A recovery-email link lands here as
// "#access_token=...&type=recovery" (or "?code=...&type=recovery" for PKCE);
// checking now, rather than reacting to the auth event later, means there is
// no race against how quickly that event fires.
let isPasswordRecovery = location.hash.includes('type=recovery') || location.search.includes('type=recovery');

// The setup gate runs before db.js is imported at all. db.js constructs a
// Supabase client at module scope, and a placeholder URL throws there — which
// would surface as a blank page instead of a readable "finish setup" message.
if (!isConfigured()) {
  // Print what the gate actually read. "It says finish setup" is the same
  // symptom for a stale cache, a bad paste, and a whitespace-wrapped key —
  // these three lines tell the difference immediately.
  const diag = el('setup-diag');
  if (diag) {
    diag.textContent =
      `BUILD:      ${BUILD}\n` +
      `URL:        ${JSON.stringify(SUPABASE_URL)}\n` +
      `URL ok:     ${SUPABASE_URL.startsWith('https://')}\n` +
      `KEY length: ${SUPABASE_ANON_KEY.length}  (needs > 40)\n` +
      `KEY starts: ${JSON.stringify(SUPABASE_ANON_KEY.slice(0, 18))}`;
  }
  el('setup').hidden = false;
  throw new Error('Supabase not configured — see public/js/config.js');
}

console.info(`Lana ${BUILD} — config loaded, URL ${SUPABASE_URL}`);

const db = await import('./db.js?v=50');
const agentViews = await import('./views-agent.js?v=50');
const adminViews = await import('./views-admin.js?v=50');
const scoringViews = await import('./views-scoring.js?v=50');
const rubricViews = await import('./views-rubric.js?v=50');
const accountViews = await import('./views-account.js?v=50');
const analyticsViews = await import('./views-analytics.js?v=50');

const ctx = { profile: null };

/* --- routes -------------------------------------------------------------- */
// `roles` is the whole access model on the client. It decides what renders and
// what appears in the nav — but it is convenience, not security. The real
// enforcement is the RLS policies; a dialer who types an admin URL gets a
// bounce here and an empty result from Postgres either way.
const ROUTES = {
  '#/dashboard':            { title: 'Dashboard',   render: agentViews.dashboard,    roles: ['agent', 'admin'] },
  '#/my-sales':             { title: 'My sales',    render: agentViews.mySales,      roles: ['agent', 'admin'] },

  '#/reviews':              { title: 'Call reviews', render: scoringViews.reviews, roles: ['agent', 'dialer', 'admin'] },
  // Readable by everyone on purpose — people graded against a standard should
  // be able to see it. Editing is gated inside the view.
  '#/rubric':               { title: 'Scoring rubric', render: rubricViews.rubric, roles: ['agent', 'dialer', 'admin'] },
  '#/leaderboard':          { title: 'Leaderboard', render: scoringViews.agentLeaderboard, roles: ['agent', 'dialer', 'admin'] },

  '#/admin/agents':         { title: 'Agents',      render: adminViews.agents,      roles: ['admin'] },
  '#/admin/scripts':        { title: 'Scripts',     render: adminViews.scripts,     roles: ['admin'] },
  '#/admin/scorecard':      { title: 'Scorecard',   render: scoringViews.scorecard, roles: ['admin'] },
  '#/admin/calibration':    { title: 'Calibration', render: scoringViews.calibration, roles: ['admin'] },
  // Drill-down score history, distinct from Leaderboard's single-period
  // ranking — reviewer-facing, so admin-only like the rest of this section.
  '#/admin/analytics':      { title: 'Analytics',   render: analyticsViews.analytics, roles: ['admin'] },
  '#/admin/reports':        { title: 'Reports',     render: adminViews.reports,     roles: ['admin'] },

  // Not in NAV — reached from the sidebar's whoami link, not the menu, since
  // it applies equally to every role.
  '#/account':              { title: 'Account',     render: accountViews.account,   roles: ['agent', 'dialer', 'admin'] },
};

// Routes carrying an ID. Kept out of ROUTES because they never belong in the
// nav — you reach them from a list, not a menu.
const PARAM_ROUTES = [
  {
    prefix: '#/reviews/',
    title: 'Call review',
    render: scoringViews.reviewDetail,
    roles: ['agent', 'dialer', 'admin'],
  },
];

// Returns the matched route plus its trailing id, or null. Exact matches win,
// so '#/reviews' resolves to the list rather than a detail view with an empty
// id.
function resolve(hash) {
  if (ROUTES[hash]) return { route: ROUTES[hash], param: null, navKey: hash };
  for (const p of PARAM_ROUTES) {
    if (hash.startsWith(p.prefix)) {
      const param = hash.slice(p.prefix.length);
      if (param) return { route: p, param, navKey: p.prefix.replace(/\/$/, '') };
    }
  }
  return null;
}

const NAV = [
  { section: 'Agent',    items: ['#/dashboard', '#/my-sales'] },
  { section: 'Coaching', items: ['#/reviews', '#/rubric', '#/leaderboard'] },
  { section: 'Admin',    items: ['#/admin/agents', '#/admin/scripts', '#/admin/scorecard', '#/admin/calibration', '#/admin/analytics', '#/admin/reports'] },
];

const allowed = href => ROUTES[href].roles.includes(ctx.profile.role);

// Where a role lands on sign-in and after a bad hash. The dialer role has no
// home page of its own anymore (the Dialer section was removed) — send it to
// the one route it's still allowed on, rather than a dashboard it can't see.
const homeFor = role => (role === 'dialer' ? '#/reviews' : '#/dashboard');

function buildNav() {
  el('nav').innerHTML = NAV
    .map(group => {
      const items = group.items.filter(allowed);
      if (items.length === 0) return '';
      return `
        <div class="nav__section">${esc(group.section)}</div>
        ${items.map(href =>
          `<a href="${href}" data-route="${href}">${esc(ROUTES[href].title)}</a>`
        ).join('')}`;
    })
    .join('');
}

function markActive(hash) {
  document.querySelectorAll('#nav a').forEach(a =>
    a.classList.toggle('is-active', a.dataset.route === hash));
}

async function route() {
  const home = homeFor(ctx.profile.role);
  const hash = location.hash || home;
  const resolved = resolve(hash);

  if (!resolved) {
    location.hash = home;
    return;
  }
  if (!resolved.route.roles.includes(ctx.profile.role)) {
    toast(`That area is not open to your role (${ctx.profile.role}).`, 'error');
    location.hash = home;
    return;
  }

  markActive(resolved.navKey);
  const main = el('main');
  main.focus({ preventScroll: true });

  try {
    await resolved.route.render(main, ctx, resolved.param);
  } catch (err) {
    if (err instanceof db.NotSignedIn) return showAuth();
    main.innerHTML = `
      <div class="card">
        <h2>Could not load this page</h2>
        <p class="muted">${esc(err.message)}</p>
        <button class="btn" onclick="location.reload()">Reload</button>
      </div>`;
    console.error(err);
  }
}

/* --- auth screen --------------------------------------------------------- */
let signUpMode = false;

// The three auth cards (sign in/up, forgot-password, set-new-password) share
// the #auth container and are toggled by id rather than laid out as routes —
// none of them need a URL of their own.
function showAuthCard(id) {
  ['auth-form', 'forgot-form', 'recovery-form'].forEach(cardId => {
    el(cardId).hidden = cardId !== id;
  });
}

function showAuth() {
  el('shell').hidden = true;
  el('auth').hidden = false;
  showAuthCard(isPasswordRecovery ? 'recovery-form' : 'auth-form');
  el('auth-error').hidden = true;
}

function authError(msg) {
  const box = el('auth-error');
  box.textContent = msg;
  box.hidden = false;
}

el('auth-forgot-link').addEventListener('click', () => {
  showAuthCard('forgot-form');
  el('forgot-error').hidden = true;
});

el('forgot-back').addEventListener('click', () => showAuthCard('auth-form'));

el('forgot-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = el('forgot-submit');
  const email = el('forgot-email').value.trim();
  const errBox = el('forgot-error');
  errBox.hidden = true;

  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await db.auth.requestPasswordReset(email);
    toast('Check your email for a reset link.', 'ok');
    el('forgot-form').reset();
    showAuthCard('auth-form');
  } catch (err) {
    errBox.textContent = err.message || 'Could not send reset email.';
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send reset link';
  }
});

el('recovery-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = el('recovery-submit');
  const errBox = el('recovery-error');
  errBox.hidden = true;
  const next = el('recovery-password').value;
  const confirm = el('recovery-confirm').value;

  if (next !== confirm) {
    errBox.textContent = 'Passwords do not match.';
    errBox.hidden = false;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    await db.auth.updatePassword(next);
    isPasswordRecovery = false;
    // Drop the recovery tokens from the address bar now that they're spent.
    history.replaceState(null, '', location.pathname);
    el('recovery-form').reset();
    toast('Password updated.', 'ok');
    await start();
  } catch (err) {
    errBox.textContent = err.message || 'Could not update password.';
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set new password';
  }
});

el('auth-toggle').addEventListener('click', () => {
  signUpMode = !signUpMode;
  el('auth-name-field').hidden = !signUpMode;
  el('auth-submit').textContent = signUpMode ? 'Create account' : 'Sign in';
  el('auth-alt-text').textContent = signUpMode ? 'Already have an account?' : 'Need an account?';
  el('auth-toggle').textContent = signUpMode ? 'Sign in' : 'Create one';
  el('auth-password').autocomplete = signUpMode ? 'new-password' : 'current-password';
  el('auth-error').hidden = true;
});

el('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = el('auth-submit');
  const email = el('auth-email').value.trim();
  const password = el('auth-password').value;
  const name = el('auth-name').value.trim();

  btn.disabled = true;
  btn.textContent = signUpMode ? 'Creating…' : 'Signing in…';
  el('auth-error').hidden = true;

  try {
    if (signUpMode) {
      const res = await db.auth.signUp(email, password, name || email.split('@')[0]);
      // With email confirmation enabled, signUp returns no session. Saying so
      // beats a silent no-op that looks like the button did nothing.
      if (!res.session) {
        authError('Account created. Check your email to confirm, then sign in.');
        signUpMode = false;
        el('auth-name-field').hidden = true;
        btn.textContent = 'Sign in';
        btn.disabled = false;
        return;
      }
    } else {
      await db.auth.signIn(email, password);
    }
    await start();
  } catch (err) {
    authError(err.message || 'Sign-in failed.');
    btn.disabled = false;
    btn.textContent = signUpMode ? 'Create account' : 'Sign in';
  }
});

el('signout').addEventListener('click', async () => {
  await db.auth.signOut();
  ctx.profile = null;
  location.hash = '';
  showAuth();
});

/* --- theme --------------------------------------------------------------- */
const savedTheme = localStorage.getItem('lana-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

function syncThemeLabel() {
  el('theme-toggle').textContent =
    document.documentElement.dataset.theme === 'light' ? 'Dark mode' : 'Light mode';
}
syncThemeLabel();

el('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('lana-theme', next);
  syncThemeLabel();
});

/* --- boot ---------------------------------------------------------------- */
async function start() {
  const session = await db.auth.session();
  if (!session) return showAuth();

  // A recovery link's session is only good for setting a new password — land
  // there instead of straight into the dashboard, even though the session
  // itself is technically valid enough to skip it.
  if (isPasswordRecovery) return showAuth();

  try {
    ctx.profile = await db.myProfile();
  } catch (err) {
    await db.auth.signOut();
    showAuth();
    authError(err.message);
    return;
  }

  el('auth').hidden = true;
  el('shell').hidden = false;
  el('whoami-name').textContent = ctx.profile.full_name || ctx.profile.email;
  el('whoami-role').textContent =
    ctx.profile.role + (ctx.profile.teams?.name ? ` · ${ctx.profile.teams.name}` : '');

  buildNav();
  const landing = resolve(location.hash);
  if (!landing || !landing.route.roles.includes(ctx.profile.role)) {
    location.hash = homeFor(ctx.profile.role);
  }
  await route();
}

window.addEventListener('hashchange', () => {
  if (ctx.profile) route();
});

// A token refresh failing in a background tab drops the session. Without this
// the next click would render an empty dashboard rather than a login prompt.
db.auth.onChange(session => {
  if (!session && ctx.profile) {
    ctx.profile = null;
    showAuth();
  }
});

await start();
