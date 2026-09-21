// ---------------------------------------------------------------------------
// Account: the one page every role can reach, for managing your own login.
// ---------------------------------------------------------------------------
import * as db from './db.js?v=47';
import { esc, toast } from './ui.js?v=47';

export async function account(main, ctx) {
  main.innerHTML = `
    <div class="page__head"><div>
      <h1>Account</h1>
      <div class="page__sub">${esc(ctx.profile.email)}</div>
    </div></div>

    <div class="card" style="max-width:480px">
      <h2>Change password</h2>
      <form id="password-form">
        <label class="field">
          <span>New password</span>
          <input type="password" id="new_password" autocomplete="new-password" minlength="8" required>
        </label>
        <label class="field">
          <span>Confirm new password</span>
          <input type="password" id="confirm_password" autocomplete="new-password" minlength="8" required>
        </label>
        <button class="btn btn--primary" type="submit" id="password-submit">Update password</button>
      </form>
    </div>`;

  main.querySelector('#password-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = main.querySelector('#password-submit');
    const next = main.querySelector('#new_password').value;
    const confirm = main.querySelector('#confirm_password').value;

    if (next !== confirm) return toast('Passwords do not match.', 'error');
    if (next.length < 8) return toast('Password must be at least 8 characters.', 'error');

    btn.disabled = true;
    btn.textContent = 'Updating…';
    try {
      await db.auth.updatePassword(next);
      toast('Password updated.', 'ok');
      main.querySelector('#password-form').reset();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Update password';
    }
  });
}
