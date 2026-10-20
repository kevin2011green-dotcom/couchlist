# Couchlist

A personal TV and movie tracker: what you're watching, where it streams, and what's up next.
Plain HTML/JS PWA (no build step), Supabase for accounts and storage, TMDB for title lookup.

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Your Supabase URL and publishable key |
| `supabase-setup.sql` | Creates the database tables and privacy rules |
| `manifest.webmanifest`, `sw.js`, `icons/` | Makes it installable and able to open offline |

## One-time setup

### 1. Supabase (accounts and storage)
1. Sign in to your existing Supabase account (the one used for qr-ordering) and click **New project**.
   Name it `couchlist`. Keep it separate from the QR project so the two apps never share users or data.
2. **SQL Editor > New query**: paste all of `supabase-setup.sql` and click **Run**.
3. **Project Settings > API Keys**: copy the **Project URL** and the **publishable** key into `config.js`.
   Never use the secret / service_role key.
4. **Authentication > Sign In / Providers > Email**: for a household app, turn **off** "Confirm email"
   so new accounts work immediately.
5. After everyone in the house has made an account, turn **off** "Allow new users to sign up"
   (Authentication > Sign In / Providers) so strangers can't create accounts.
6. **Authentication > URL Configuration**: set Site URL to the live app URL.

### 2. TMDB (title search, posters, where-to-watch)
1. Create a free account at https://www.themoviedb.org, then **Settings > API** and request a developer key.
2. Copy the **API Read Access Token** (the long one).
3. In Supabase SQL Editor run:
   ```sql
   insert into public.app_config (key, value) values ('tmdb_token', 'PASTE-TOKEN-HERE')
     on conflict (key) do update set value = excluded.value;
   ```
   The token stays in the database, readable only by signed-in users, not in the public repo.

### 3. Run it
- Locally: `python -m http.server 8080` in this folder, then open http://localhost:8080
- Live: push to GitHub and enable Pages from `main` (same as Skyglance).
- On the phone: open the live URL in Chrome, menu > **Add to Home screen**.

## Updating the app
When changing `app.js`, `styles.css` or `index.html`, bump `CACHE` in `sw.js` (e.g. `couchlist-shell-v2`)
so phones pick up the new version.
