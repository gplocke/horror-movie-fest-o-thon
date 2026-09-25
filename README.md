# 🎃 Horror Movie Fest-o-thon

Watch at least 31 new-to-you horror movies in October. Log them. Haunt your friends' progress bars.

**Stack (all free):**

| Piece | What | Cost |
|---|---|---|
| Site | Static HTML/CSS/JS on **GitHub Pages** | $0 |
| Auth | **Google Sign-In** (Google Identity Services) | $0 |
| API + DB | **Google Apps Script** web app bound to a **Google Sheet** | $0 |
| Movie search | **TMDB**, proxied through Apps Script so the key never ships to browsers | $0 |

```
browser ──(Google ID token + JSON)──▶ Apps Script /exec ──▶ Google Sheet
                                          │
                                          └──▶ TMDB search API
```

The sheet has a `Participants` tab (the allowlist) and one tab per year (`2026`, `2027`, …), created automatically the first time someone logs a movie that year.

---

## Setup (≈20 minutes, once)

### 1. The spreadsheet

1. Create a Google Sheet (or open the one you already have).
2. **Extensions → Apps Script.** Delete the sample code, paste in `apps-script/Code.gs`, save.
3. In the editor, pick the `setup` function from the dropdown and hit **Run**. Approve the permissions. This creates the `Participants` tab (with your email on it) and this year's tab.
4. Add friends' Google emails to the `Participants` tab, column A. Column B is an optional display name — leave it blank to use their Google name.

> The script runs as *you*, so the sheet doesn't technically need to be link-shared for the site to work. Sharing it "anyone with the link can edit" is fine if you want participants to poke at the raw data.

### 2. Google Sign-In client ID

1. Go to <https://console.cloud.google.com/> → create a project (e.g. "fest-o-thon").
2. **APIs & Services → OAuth consent screen.** External, app name "Horror Movie Fest-o-thon", your email as support/developer contact. No scopes needed beyond the defaults. You can leave it in "Testing" mode — sign-in only asks for basic profile/email, which needs no verification. *(In Testing mode you must add each participant as a test user; switching to "In production" removes that limit and still needs no verification for these scopes.)*
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
   - **Authorized JavaScript origins:** add
     - `https://YOUR-GITHUB-USERNAME.github.io`
     - `http://localhost:8000` (for local previews)
   - No redirect URIs needed.
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### 3. TMDB key

1. Make a free account at <https://www.themoviedb.org/>, then **Settings → API → Create → Developer**. Fill in the form (personal / hobby is fine).
2. Copy the **API Key (v3 auth)**.

### 4. Script properties + deploy

Back in the Apps Script editor:

1. **Project Settings (gear) → Script Properties → Add:**
   - `GOOGLE_CLIENT_ID` = the client ID from step 2
   - `TMDB_API_KEY` = the key from step 3
   - `GOAL` = `31` (optional)
2. **Deploy → New deployment → type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, approve permissions, copy the **Web app URL** (ends in `/exec`).

Whenever you change `Code.gs` later: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The URL stays the same.

### 5. Configure the site

Edit `config.js`:

```js
APPS_SCRIPT_URL: 'https://script.google.com/macros/s/…/exec',
GOOGLE_CLIENT_ID: '…apps.googleusercontent.com',
```

### 6. Publish on GitHub Pages

```bash
cd ~/dev/code/fest-o-thon
git init
git add .
git commit -m "Fest-o-thon site"
gh repo create fest-o-thon --public --source=. --push   # or create the repo on github.com and push
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)` → Save.** A minute later the site is live at `https://YOUR-GITHUB-USERNAME.github.io/fest-o-thon/`.

Make sure that origin (`https://YOUR-GITHUB-USERNAME.github.io`) is in the OAuth client's authorized JavaScript origins (step 2).

---

## Local preview

```bash
python3 -m http.server 8000
```

- <http://localhost:8000/?mock=1> — fake data, no sign-in, no backend. Good for tweaking the look.
- <http://localhost:8000/> — real sign-in and real sheet (needs `http://localhost:8000` in the OAuth origins).

## How it works

- **Auth:** the site gets a Google ID token from Google Identity Services and sends it with every request. Apps Script verifies it against Google's `tokeninfo` endpoint, checks the `aud` matches your client ID, and checks the email is on the `Participants` tab. Tokens are cached server-side for up to 30 minutes.
- **Data:** each year tab has columns `id | email | date | title | year | tmdbId | poster | where | rating | createdAt | updatedAt`. Users can only edit/delete rows where `email` is theirs.
- **Privacy:** anyone on the allowlist can see everyone's lists for the year (that's the point). Nobody off the allowlist can read anything.
- **Rating:** 0.5–5 in half-star steps, Letterboxd style.
- **Year picker:** lists every `YYYY` tab in the sheet plus the current year; defaults to the current year.

## Adding a new year

Nothing to do — the first movie logged in a new year creates its tab. Or run `setup` again in Apps Script on Jan 1 if you like tidy sheets.

## Files

```
index.html          markup
styles.css          the spooky bits
app.js              sign-in, API calls, rendering, mock backend
config.js           your URLs/IDs (the only file you must edit)
apps-script/Code.gs paste into the sheet's Apps Script project
```
