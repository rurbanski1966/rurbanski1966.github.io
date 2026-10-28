// ---------------------------------------------------------------------------
// admin-users — Supabase Edge Function (Deno)
//
// Creates, edits and removes login accounts. This has to run server-side:
// setting an admin-chosen password, changing a login email and deleting a
// user all go through the Auth Admin
// API, which only works with the service role key — the anon key the browser
// holds can never do either.
//
// Authorization is a two-step check, same shape as score-call: read the
// caller's own profile through a JWT-scoped client (RLS decides what that
// returns), and only switch to the service client — which bypasses RLS
// entirely — once that read proves the caller is an active admin. Trusting a
// role field the client sent in the request body would let anyone with a
// valid login create more admin accounts for themselves.
// ---------------------------------------------------------------------------
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const ROLES = ['agent', 'dialer', 'admin', 'demo'];

// "demo" isn't a database role: a demo (test) login is stored as a dialer,
// the role with the least access, with is_demo set (migration 049), which
// makes the API refuse it everything but its own profile.
const profileRole = (role: string) =>
  role === 'demo' ? { role: 'dialer', is_demo: true } : { role, is_demo: false };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return json({ error: 'Not signed in' }, 401);

  const { data: caller, error: callerError } = await userClient
    .from('profiles')
    .select('role, active')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (callerError) return json({ error: callerError.message }, 400);
  if (!caller?.active || caller.role !== 'admin') {
    return json({ error: 'Admin access required.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (body.action === 'create') {
    const firstName = String(body.first_name ?? '').trim();
    const lastName = String(body.last_name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const role = String(body.role ?? 'agent');

    if (!firstName || !lastName) return json({ error: 'First and last name are required.' }, 400);
    if (!email.includes('@')) return json({ error: 'A valid email is required.' }, 400);
    if (password.length < 8) return json({ error: 'Temporary password must be at least 8 characters.' }, 400);
    if (!ROLES.includes(role)) return json({ error: `Role must be one of: ${ROLES.join(', ')}` }, 400);

    const fullName = `${firstName} ${lastName}`;

    const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // admin is handing them the password directly — no confirmation email needed
      user_metadata: { full_name: fullName },
    });
    if (createError) return json({ error: createError.message }, 400);

    // handle_new_user's trigger always inserts the row as 'agent' (except the
    // very first signup ever). Bring the role in line with what the admin
    // actually picked.
    if (role !== 'agent') {
      const { error: roleError } = await serviceClient
        .from('profiles')
        .update(profileRole(role))
        .eq('id', created.user.id);
      if (roleError) return json({ error: roleError.message }, 400);
    }

    return json({
      ok: true,
      user: { id: created.user.id, email: created.user.email, full_name: fullName, role },
    });
  }

  if (body.action === 'delete') {
    const userId = String(body.user_id ?? '');
    if (!userId) return json({ error: 'user_id is required.' }, 400);
    if (userId === userData.user.id) return json({ error: 'You cannot remove your own account.' }, 400);

    // Deletes the auth.users row. profiles.id references it ON DELETE CASCADE,
    // so the profile — and everything that cascades from it — goes with it.
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
    if (deleteError) return json({ error: deleteError.message }, 400);

    return json({ ok: true });
  }

  if (body.action === 'update') {
    const userId = String(body.user_id ?? '');
    if (!userId) return json({ error: 'user_id is required.' }, 400);

    const fullName = String(body.full_name ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const role = String(body.role ?? '');
    const teamId = body.team_id ? String(body.team_id) : null;
    // Optional: blank means "leave the password alone".
    const password = body.password ? String(body.password) : '';

    if (!fullName) return json({ error: 'Name is required.' }, 400);
    if (!email.includes('@')) return json({ error: 'A valid email is required.' }, 400);
    if (!ROLES.includes(role)) return json({ error: `Role must be one of: ${ROLES.join(', ')}` }, 400);
    if (password && password.length < 8) return json({ error: 'New password must be at least 8 characters.' }, 400);

    const { data: current, error: currentError } = await serviceClient
      .from('profiles')
      .select('id, email, role')
      .eq('id', userId)
      .maybeSingle();
    if (currentError) return json({ error: currentError.message }, 400);
    if (!current) return json({ error: 'Account not found.' }, 404);

    // An admin demoting themselves could leave the agency with no admin.
    if (userId === userData.user.id && role !== 'admin') {
      return json({ error: 'You cannot change your own role.' }, 400);
    }

    if (teamId) {
      const { data: team, error: teamError } = await serviceClient
        .from('teams').select('id').eq('id', teamId).maybeSingle();
      if (teamError) return json({ error: teamError.message }, 400);
      if (!team) return json({ error: 'That team no longer exists.' }, 400);
    }

    // Login side first: if Auth rejects the email (already taken, say), the
    // profile is left untouched instead of showing an email they can't sign
    // in with.
    const authPatch: Record<string, unknown> = { user_metadata: { full_name: fullName } };
    if (email !== current.email) {
      authPatch.email = email;
      authPatch.email_confirm = true; // admin is setting it directly — no confirmation email
    }
    if (password) authPatch.password = password;

    const { error: authError } = await serviceClient.auth.admin.updateUserById(userId, authPatch);
    if (authError) return json({ error: authError.message }, 400);

    const { error: profileError } = await serviceClient
      .from('profiles')
      .update({ full_name: fullName, email, ...profileRole(role), team_id: teamId })
      .eq('id', userId);
    if (profileError) return json({ error: profileError.message }, 400);

    return json({ ok: true, password_reset: Boolean(password) });
  }

  return json({ error: `Unknown action "${body.action}". Use "create", "update" or "delete".` }, 400);
});
