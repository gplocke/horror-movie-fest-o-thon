/**
 * Horror Movie Fest-o-thon — Google Apps Script backend
 *
 * Bound to the fest-o-thon Google Spreadsheet. Deployed as a Web App
 * ("Execute as: Me", "Who has access: Anyone") it becomes a tiny JSON API
 * that the static site on GitHub Pages talks to.
 *
 * Script Properties required (Project Settings → Script Properties):
 *   GOOGLE_CLIENT_ID  — OAuth client ID used by the site's Google Sign-In
 *   TMDB_API_KEY      — TMDB v3 API key (kept server-side, never shipped to browsers)
 *   GOAL              — optional, defaults to 31
 *
 * Sheet layout:
 *   "Participants" tab:  email | name
 *   One tab per year, e.g. "2026":
 *     id | email | date | title | year | tmdbId | poster | where | rating | createdAt | updatedAt
 *   "Comments" tab (all years):
 *     id | year | entryId | email | text | createdAt
 */

var HEADERS = ['id', 'email', 'date', 'title', 'year', 'tmdbId', 'poster', 'where', 'rating', 'createdAt', 'updatedAt'];
var PARTICIPANTS_SHEET = 'Participants';
var COMMENTS_SHEET = 'Comments';
var COMMENT_HEADERS = ['id', 'year', 'entryId', 'email', 'text', 'createdAt'];
var COMMENT_MAX = 1000;

// ---------------------------------------------------------------- entry points

function doGet(e) {
  return json_({ ok: true, service: 'fest-o-thon', goal: goal_() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Bad JSON' });
  }

  try {
    var action = req.action || '';
    if (action === 'ping') return json_({ ok: true });

    var user = verifyUser_(req.idToken);
    if (!user) return json_({ ok: false, error: 'unauthorized', code: 401 });

    var allowed = participantInfo_(user.email);
    if (!allowed) return json_({ ok: false, error: 'not_invited', code: 403, email: user.email });
    user.name = allowed.name || user.name || user.email;

    switch (action) {
      case 'me':     return json_({ ok: true, user: user, years: years_(), goal: goal_() });
      case 'list':   return json_(list_(req.year));
      case 'search': return json_(search_(req.query));
      case 'add':    return json_(add_(user, req.year, req.entry));
      case 'update': return json_(update_(user, req.year, req.id, req.entry));
      case 'delete': return json_(remove_(user, req.year, req.id));
      case 'comment':       return json_(addComment_(user, req.year, req.entryId, req.text));
      case 'deleteComment': return json_(removeComment_(user, req.id));
      default:       return json_({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------- auth

/** Verifies a Google ID token and returns { email, name, picture } or null. */
function verifyUser_(idToken) {
  if (!idToken) return null;
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;
  var info = JSON.parse(res.getContentText());

  var clientId = props_().GOOGLE_CLIENT_ID;
  if (!clientId || info.aud !== clientId) return null;
  if (info.email_verified !== 'true' && info.email_verified !== true) return null;
  if (info.iss !== 'https://accounts.google.com' && info.iss !== 'accounts.google.com') return null;

  var user = { email: String(info.email).toLowerCase(), name: info.name || '', picture: info.picture || '' };
  var ttl = Math.max(60, Math.min(1800, Number(info.exp) - Math.floor(Date.now() / 1000)));
  cache.put(key, JSON.stringify(user), ttl);
  return user;
}

/** Returns { email, name } if the email is on the Participants tab, else null. */
function participantInfo_(email) {
  var all = participants_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].email === email) return all[i];
  }
  return null;
}

function participants_() {
  var sheet = ss_().getSheetByName(PARTICIPANTS_SHEET);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var email = String(rows[i][0] || '').trim().toLowerCase();
    if (!email) continue;
    out.push({ email: email, name: String(rows[i][1] || '').trim() });
  }
  return out;
}

// ---------------------------------------------------------------- actions

function list_(year) {
  year = normYear_(year);
  var sheet = ss_().getSheetByName(year);
  var entries = sheet ? readEntries_(sheet) : [];
  var people = participants_();
  var counts = {};
  entries.forEach(function (e) { counts[e.email] = (counts[e.email] || 0) + 1; });

  var participants = people.map(function (p) {
    return { email: p.email, name: p.name || p.email.split('@')[0], count: counts[p.email] || 0 };
  });
  // Anyone with entries but no longer on the allowlist still shows up.
  Object.keys(counts).forEach(function (email) {
    if (!people.some(function (p) { return p.email === email; })) {
      participants.push({ email: email, name: email.split('@')[0], count: counts[email] });
    }
  });
  participants.sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });

  return { ok: true, year: year, goal: goal_(), years: years_(), participants: participants, entries: entries, comments: comments_(year) };
}

// ---------------------------------------------------------------- comments

function comments_(year) {
  var sheet = ss_().getSheetByName(COMMENTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0] || String(r[1]) !== String(year)) continue;
    out.push({ id: String(r[0]), entryId: String(r[2]), email: String(r[3]).toLowerCase(), text: String(r[4] || ''), createdAt: String(r[5] || '') });
  }
  out.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0; });
  return out;
}

function addComment_(user, year, entryId, text) {
  year = normYear_(year);
  text = String(text || '').trim();
  if (!text) return { ok: false, error: 'Say something.' };
  if (text.length > COMMENT_MAX) return { ok: false, error: 'Keep it under ' + COMMENT_MAX + ' characters.' };
  var entrySheet = yearSheet_(year, false);
  if (!entrySheet || findRow_(entrySheet, entryId) < 0) return { ok: false, error: 'That entry no longer exists.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = commentsSheet_();
    var id = Utilities.getUuid();
    sheet.appendRow([id, year, String(entryId), user.email, text, new Date().toISOString()]);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function removeComment_(user, id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = ss_().getSheetByName(COMMENTS_SHEET);
    if (!sheet) return { ok: false, error: 'not_found' };
    var rowIndex = findRow_(sheet, id);
    if (rowIndex < 0) return { ok: false, error: 'not_found' };
    var owner = String(sheet.getRange(rowIndex, 4).getValue()).toLowerCase();
    if (owner !== user.email) return { ok: false, error: 'forbidden', code: 403 };
    sheet.deleteRow(rowIndex);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function commentsSheet_() {
  var ss = ss_();
  var sheet = ss.getSheetByName(COMMENTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(COMMENTS_SHEET);
    sheet.appendRow(COMMENT_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange('B:C').setNumberFormat('@');
  }
  return sheet;
}

function add_(user, year, entry) {
  year = normYear_(year);
  var clean = cleanEntry_(entry);
  if (clean.error) return { ok: false, error: clean.error };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = yearSheet_(year, true);
    var now = new Date().toISOString();
    var id = Utilities.getUuid();
    sheet.appendRow([id, user.email, clean.date, clean.title, clean.year, clean.tmdbId, clean.poster, clean.where, clean.rating, now, now]);
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

function update_(user, year, id, entry) {
  year = normYear_(year);
  var clean = cleanEntry_(entry);
  if (clean.error) return { ok: false, error: clean.error };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = yearSheet_(year, false);
    if (!sheet) return { ok: false, error: 'No sheet for ' + year };
    var rowIndex = findRow_(sheet, id);
    if (rowIndex < 0) return { ok: false, error: 'not_found' };
    var owner = String(sheet.getRange(rowIndex, 2).getValue()).toLowerCase();
    if (owner !== user.email) return { ok: false, error: 'forbidden', code: 403 };
    var createdAt = sheet.getRange(rowIndex, 10).getValue();
    sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([[
      id, user.email, clean.date, clean.title, clean.year, clean.tmdbId, clean.poster, clean.where, clean.rating, createdAt, new Date().toISOString()
    ]]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function remove_(user, year, id) {
  year = normYear_(year);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = yearSheet_(year, false);
    if (!sheet) return { ok: false, error: 'No sheet for ' + year };
    var rowIndex = findRow_(sheet, id);
    if (rowIndex < 0) return { ok: false, error: 'not_found' };
    var owner = String(sheet.getRange(rowIndex, 2).getValue()).toLowerCase();
    if (owner !== user.email) return { ok: false, error: 'forbidden', code: 403 };
    sheet.deleteRow(rowIndex);
    deleteCommentsFor_(id);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** Removes every comment attached to an entry (called when the entry is deleted). */
function deleteCommentsFor_(entryId) {
  var sheet = ss_().getSheetByName(COMMENTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return;
  var ids = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === String(entryId)) sheet.deleteRow(i + 2);
  }
}

/** TMDB movie search proxied so the API key stays server-side. */
function search_(query) {
  query = String(query || '').trim();
  if (query.length < 2) return { ok: true, results: [] };
  var key = props_().TMDB_API_KEY;
  if (!key) return { ok: false, error: 'TMDB_API_KEY not configured' };

  var cache = CacheService.getScriptCache();
  var ck = 'tmdb_' + query.toLowerCase();
  var hit = cache.get(ck);
  if (hit) return { ok: true, results: JSON.parse(hit) };

  var url = 'https://api.themoviedb.org/3/search/movie?include_adult=false&language=en-US&page=1'
    + '&api_key=' + encodeURIComponent(key) + '&query=' + encodeURIComponent(query);
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'TMDB error ' + res.getResponseCode() };
  var data = JSON.parse(res.getContentText());
  var results = (data.results || []).slice(0, 8).map(function (m) {
    return {
      tmdbId: m.id,
      title: m.title,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : '',
      poster: m.poster_path || '',
      overview: (m.overview || '').slice(0, 200)
    };
  });
  cache.put(ck, JSON.stringify(results), 3600);
  return { ok: true, results: results };
}

// ---------------------------------------------------------------- helpers

function cleanEntry_(entry) {
  entry = entry || {};
  var title = String(entry.title || '').trim();
  if (!title) return { error: 'Title is required' };
  var date = String(entry.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Date must be YYYY-MM-DD' };
  var rating = Number(entry.rating);
  if (!(rating >= 0.5 && rating <= 5) || Math.round(rating * 2) !== rating * 2) {
    return { error: 'Rating must be 0.5–5 in half-star steps' };
  }
  return {
    title: title,
    date: date,
    year: entry.year ? Number(entry.year) : '',
    tmdbId: entry.tmdbId ? Number(entry.tmdbId) : '',
    poster: String(entry.poster || '').trim(),
    where: String(entry.where || '').trim(),
    rating: rating
  };
}

function readEntries_(sheet) {
  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    out.push({
      id: String(r[0]),
      email: String(r[1]).toLowerCase(),
      date: toDateString_(r[2]),
      title: String(r[3]),
      year: r[4] === '' ? '' : Number(r[4]),
      tmdbId: r[5] === '' ? '' : Number(r[5]),
      poster: String(r[6] || ''),
      where: String(r[7] || ''),
      rating: Number(r[8]),
      createdAt: String(r[9] || ''),
      updatedAt: String(r[10] || '')
    });
  }
  out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1); });
  return out;
}

/** Sheets may auto-convert "2026-10-03" into a Date; normalize back. */
function toDateString_(v) {
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  return String(v || '');
}

function findRow_(sheet, id) {
  var ids = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 1;
  }
  return -1;
}

function yearSheet_(year, create) {
  var ss = ss_();
  var sheet = ss.getSheetByName(year);
  if (!sheet && create) {
    sheet = ss.insertSheet(year);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    // Keep dates as plain text so they round-trip cleanly.
    sheet.getRange('C:C').setNumberFormat('@');
  }
  return sheet;
}

function years_() {
  return ss_().getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return /^\d{4}$/.test(n); })
    .sort()
    .reverse();
}

function normYear_(year) {
  var y = String(year || new Date().getFullYear()).trim();
  if (!/^\d{4}$/.test(y)) throw new Error('Bad year: ' + y);
  return y;
}

function goal_() {
  return Number(props_().GOAL) || 31;
}

function props_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to create the Participants tab and this year's tab. */
function setup() {
  var ss = ss_();
  if (!ss.getSheetByName(PARTICIPANTS_SHEET)) {
    var p = ss.insertSheet(PARTICIPANTS_SHEET);
    p.appendRow(['email', 'name']);
    p.appendRow([Session.getEffectiveUser().getEmail(), '']);
    p.setFrozenRows(1);
  }
  yearSheet_(String(new Date().getFullYear()), true);
  commentsSheet_();
}
