/* Horror Movie Fest-o-thon — front end */
(function () {
  'use strict';

  var CONFIG = window.FEST_CONFIG || {};
  var MOCK = !!CONFIG.MOCK || /[?&]mock=1/.test(location.search);
  var POSTER = 'https://image.tmdb.org/t/p/w185';
  var TOKEN_KEY = 'festothon.idToken';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    idToken: null,
    user: null,          // { email, name, picture }
    year: String(new Date().getFullYear()),
    years: [],
    goal: CONFIG.GOAL || 31,
    entries: [],         // every entry for the year (all participants)
    participants: [],    // [{ email, name, count }]
    viewing: null,       // email whose list is shown (null = me)
    editingId: null,
    search: { timer: null, seq: 0, results: [], active: -1 },
    rating: 0,
    hoverRating: 0
  };

  // ------------------------------------------------------------ API

  function api(action, payload) {
    if (MOCK) return mockApi(action, payload || {});
    var body = Object.assign({ action: action, idToken: state.idToken }, payload || {});
    return fetch(CONFIG.APPS_SCRIPT_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script can't answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data.ok) {
        if (data.code === 401) { signOut(true); throw new Error('Your session expired — please sign in again.'); }
        if (data.error === 'not_invited') { showNotInvited(data.email); throw new Error('not_invited'); }
        throw new Error(data.error || 'Something went wrong');
      }
      return data;
    });
  }

  // ------------------------------------------------------------ auth

  function initAuth() {
    $('heroGoal').textContent = state.goal;
    if (MOCK) {
      $('signInNote').textContent = 'Mock mode — no Google sign-in needed.';
      var b = document.createElement('button');
      b.className = 'btn btn-primary'; b.type = 'button'; b.textContent = 'Enter as Demo Ghoul';
      b.onclick = function () { onSignedIn('mock-token'); };
      $('googleSignIn').appendChild(b);
      return;
    }
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null'); } catch (e) {}
    if (saved && saved.exp > Date.now() / 1000 + 60) {
      onSignedIn(saved.token);
    }
    waitFor(function () { return window.google && google.accounts && google.accounts.id; }, function () {
      google.accounts.id.initialize({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        callback: function (resp) { onSignedIn(resp.credential); },
        auto_select: true,
        itp_support: true
      });
      google.accounts.id.renderButton($('googleSignIn'), {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 260
      });
      if (!state.idToken) google.accounts.id.prompt();
    });
  }

  function onSignedIn(token) {
    state.idToken = token;
    if (!MOCK) {
      try {
        var payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: token, exp: payload.exp }));
      } catch (e) {}
    }
    setStatus('Checking the guest list…');
    api('me').then(function (data) {
      state.user = data.user;
      state.goal = data.goal || state.goal;
      state.years = data.years || [];
      showApp();
      return loadYear(state.year);
    }).catch(function (err) {
      if (err.message !== 'not_invited') toast(err.message, true);
    }).finally(function () { setStatus(''); });
  }

  function signOut(silent) {
    state.idToken = null; state.user = null; state.entries = []; state.participants = [];
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    show('viewSignedOut');
    if (!silent) toast('Signed out. Sleep tight.');
  }

  // ------------------------------------------------------------ views

  function show(id) {
    ['viewSignedOut', 'viewNotInvited', 'viewApp'].forEach(function (v) { $(v).hidden = v !== id; });
    $('topbarRight').hidden = id !== 'viewApp';
  }

  function showNotInvited(email) {
    $('notInvitedEmail').textContent = email || 'That account';
    show('viewNotInvited');
  }

  function showApp() {
    show('viewApp');
    $('userName').textContent = state.user.name;
    $('userAvatar').src = state.user.picture || '';
    $('userAvatar').referrerPolicy = 'no-referrer';
    renderYears();
    $('fDate').value = todayISO();
    if (!$('fDate').max) $('fDate').max = todayISO();
  }

  function renderYears() {
    var sel = $('yearSelect');
    var years = state.years.slice();
    var thisYear = String(new Date().getFullYear());
    if (years.indexOf(thisYear) < 0) years.unshift(thisYear);
    if (years.indexOf(state.year) < 0) years.push(state.year);
    years = years.map(String).sort().reverse();
    sel.innerHTML = '';
    years.forEach(function (y) {
      var o = document.createElement('option'); o.value = y; o.textContent = y; sel.appendChild(o);
    });
    sel.value = state.year;
  }

  function loadYear(year) {
    state.year = String(year);
    state.viewing = null;
    cancelEdit();
    setStatus('Summoning ' + year + '…');
    return api('list', { year: state.year }).then(function (data) {
      state.entries = data.entries || [];
      state.participants = data.participants || [];
      state.goal = data.goal || state.goal;
      if (data.years) state.years = data.years;
      renderYears();
      renderAll();
    }).catch(function (err) { if (err.message !== 'not_invited') toast(err.message, true); })
      .finally(function () { setStatus(''); });
  }

  function renderAll() {
    $('yearLabel').textContent = state.year;
    renderProgress();
    renderList();
    renderParticipants();
    renderWhereList();
  }

  // ------------------------------------------------------------ progress

  function myEntries() { return state.entries.filter(function (e) { return e.email === state.user.email; }); }
  function entriesFor(email) { return state.entries.filter(function (e) { return e.email === email; }); }

  var EVERYONE = '*';
  function viewingEveryone() { return state.viewing === EVERYONE; }

  function renderProgress() {
    if (viewingEveryone()) return renderGroupProgress();
    var viewingMe = !state.viewing || state.viewing === state.user.email;
    var email = viewingMe ? state.user.email : state.viewing;
    var who = viewingMe ? 'Your' : (displayName(email) + "'s");
    var count = entriesFor(email).length;
    var goal = state.goal;
    var pct = Math.min(100, Math.round(count / goal * 100));

    $('progressTitle').textContent = who + ' progress';
    $('progressCount').textContent = count;
    $('progressGoal').textContent = goal;
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', count);
    $('progressBar').setAttribute('aria-valuemax', goal);
    $('progressBar').classList.toggle('done', count >= goal);

    var ticks = $('progressTicks');
    if (ticks.childElementCount !== goal) {
      ticks.innerHTML = '';
      for (var i = 0; i < goal; i++) ticks.appendChild(document.createElement('i'));
    }

    $('progressCountdown').textContent = countdownText();
    $('progressMsg').textContent = progressMessage(count, goal, viewingMe);
  }

  function renderGroupProgress() {
    var count = state.entries.length;
    var n = state.participants.length || 1;
    var goal = state.goal * n;
    var finished = state.participants.filter(function (p) { return p.count >= state.goal; }).length;
    var pct = Math.min(100, Math.round(count / goal * 100));

    $('progressTitle').textContent = "The coven's progress";
    $('progressCount').textContent = count;
    $('progressGoal').textContent = goal;
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', count);
    $('progressBar').setAttribute('aria-valuemax', goal);
    $('progressBar').classList.toggle('done', finished === n && n > 0);
    var ticks = $('progressTicks');
    if (ticks.childElementCount !== n) {
      ticks.innerHTML = '';
      for (var i = 0; i < n; i++) ticks.appendChild(document.createElement('i'));
    }
    $('progressCountdown').textContent = countdownText();
    var avg = n ? (count / n).toFixed(1) : '0';
    $('progressMsg').textContent =
      count === 0 ? 'Nobody has pressed play yet.' :
      finished === n ? '🏆 Everyone survived. ' + count + ' movies between you.' :
      finished + ' of ' + n + ' finished · ' + avg + ' movies each on average.';
  }

  function countdownText() {
    var now = new Date();
    var y = Number(state.year);
    if (y !== now.getFullYear()) return y < now.getFullYear() ? 'A fest of Octobers past.' : 'A fest yet to come.';
    var start = new Date(y, 9, 1), end = new Date(y, 10, 1);
    if (now < start) {
      var d = Math.ceil((start - now) / 864e5);
      return 'October begins in ' + d + ' day' + (d === 1 ? '' : 's') + '.';
    }
    if (now >= end) return 'October is over. Rest… for now.';
    var left = Math.ceil((end - now) / 864e5);
    return left + ' night' + (left === 1 ? '' : 's') + ' left in October.';
  }

  function progressMessage(count, goal, me) {
    var left = goal - count;
    if (count === 0) return me ? 'The screen is dark. Press play.' : 'Hasn\'t started yet…';
    if (left <= 0) return count === goal ? '🏆 Goal reached! Survivor.' : '🏆 Goal smashed — ' + (count - goal) + ' over!';
    if (left <= 5) return 'So close. ' + left + ' to go.';
    if (count >= goal / 2) return 'Past the halfway mark. ' + left + ' to go.';
    return left + ' to go.';
  }

  // ------------------------------------------------------------ list

  function renderList() {
    var everyone = viewingEveryone();
    var viewingMe = !everyone && (!state.viewing || state.viewing === state.user.email);
    var email = viewingMe ? state.user.email : state.viewing;
    var list = everyone ? state.entries : entriesFor(email);
    $('listTitle').textContent = everyone ? 'Everyone\'s activity' : viewingMe ? 'Your watchlist' : displayName(email) + "'s watchlist";
    $('backToMine').hidden = viewingMe;
    $('formCard').hidden = !viewingMe;
    $('listEmpty').hidden = list.length > 0;

    var ol = $('movieList');
    ol.innerHTML = '';
    var lastDay = null;
    // Show newest first but number from oldest → #1 is the first movie of the month.
    list.forEach(function (e, idx) {
      if (everyone && e.date !== lastDay) {
        lastDay = e.date;
        var sep = document.createElement('li');
        sep.className = 'day-sep';
        sep.textContent = prettyDate(e.date);
        ol.appendChild(sep);
      }
      var n = list.length - idx;
      var li = document.createElement('li');
      li.className = 'movie';
      li.innerHTML =
        (everyone
          ? '<div class="who" title="' + esc(displayName(e.email)) + '"><span class="avatar">' + esc(initials(displayName(e.email))) + '</span></div>'
          : '<div class="n">' + n + '</div>') +
        (e.poster ? '<img alt="" loading="lazy" src="' + POSTER + esc(e.poster) + '">' : '<div class="no-poster">🎬</div>') +
        '<div class="info">' +
          '<div class="title">' + esc(e.title) + (e.year ? ' <span class="y">(' + esc(e.year) + ')</span>' : '') + '</div>' +
          '<div class="meta">' +
            (everyone ? '<span class="by">' + esc(displayName(e.email)) + (e.email === state.user.email ? ' (you)' : '') + '</span><span>·</span>' : '') +
            '<span>' + esc(prettyDate(e.date)) + '</span>' + (e.where ? '<span>·</span><span>' + esc(e.where) + '</span>' : '') +
          '</div>' +
          '<div class="stars-ro" title="' + e.rating + ' / 5">' + starsRO(e.rating) + '</div>' +
        '</div>' +
        (viewingMe ? '<div class="actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-edit="' + esc(e.id) + '">Edit</button>' +
          '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-del="' + esc(e.id) + '">Delete</button>' +
        '</div>' : '');
      ol.appendChild(li);
    });
  }

  function starsRO(r) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      if (r >= i) out += '★';
      else if (r >= i - 0.5) out += '<span style="position:relative;display:inline-block"><span class="dim">★</span><span style="position:absolute;left:0;top:0;width:50%;overflow:hidden">★</span></span>';
      else out += '<span class="dim">★</span>';
    }
    return out;
  }

  // ------------------------------------------------------------ participants

  function displayName(email) {
    var p = state.participants.filter(function (x) { return x.email === email; })[0];
    return p ? p.name : email.split('@')[0];
  }

  function renderParticipants() {
    var ul = $('participantList');
    ul.innerHTML = '';
    var goal = state.goal;
    var ev = $('everyoneBtn');
    ev.classList.toggle('active', viewingEveryone());
    ev.setAttribute('aria-pressed', viewingEveryone());
    $('everyoneCount').textContent = state.entries.length;
    state.participants.forEach(function (p) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      var isMe = p.email === state.user.email;
      var active = (state.viewing || state.user.email) === p.email;
      btn.type = 'button';
      btn.className = 'participant' + (p.count >= goal ? ' done' : '') + (active ? ' active' : '');
      btn.setAttribute('aria-pressed', active);
      btn.innerHTML =
        '<div class="row">' +
          '<span class="avatar">' + esc(initials(p.name)) + '</span>' +
          '<span class="name">' + esc(p.name) + (isMe ? '<span class="you">you</span>' : '') + '</span>' +
          '<span class="count' + (p.count ? '' : ' zero') + '">' + p.count + '<span class="muted small">/' + goal + '</span></span>' +
        '</div>' +
        '<div class="mini"><i style="width:' + Math.min(100, p.count / goal * 100) + '%"></i></div>';
      btn.onclick = function () {
        state.viewing = isMe ? null : p.email;
        cancelEdit();
        renderAll();
        if (window.innerWidth < 860) $('listTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------ form

  function renderWhereList() {
    var dl = $('whereList');
    var seen = {};
    var opts = ['Theater', 'Netflix', 'Shudder', 'Tubi', 'Max', 'Hulu', 'Prime Video', 'Peacock', 'Paramount+', 'Blu-ray', 'DVD', 'Kanopy'];
    state.entries.forEach(function (e) { if (e.where) opts.unshift(e.where); });
    dl.innerHTML = '';
    opts.forEach(function (w) {
      var k = w.toLowerCase();
      if (seen[k]) return; seen[k] = 1;
      var o = document.createElement('option'); o.value = w; dl.appendChild(o);
    });
  }

  function buildStars() {
    var wrap = $('starInput');
    wrap.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      var s = document.createElement('span');
      s.className = 'star';
      s.dataset.i = i;
      ['l', 'r'].forEach(function (side) {
        var b = document.createElement('button');
        var v = side === 'l' ? i - 0.5 : i;
        b.type = 'button'; b.className = 'star-half ' + side; b.dataset.v = v;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', v + (v === 1 ? ' star' : ' stars'));
        b.onmouseenter = function () { state.hoverRating = v; paintStars(); };
        b.onmouseleave = function () { state.hoverRating = 0; paintStars(); };
        b.onclick = function () { setRating(v); };
        s.appendChild(b);
      });
      wrap.appendChild(s);
    }
    paintStars();
  }

  function setRating(v) {
    state.rating = v;
    $('fRating').value = v;
    paintStars();
  }

  function paintStars() {
    var r = state.hoverRating || state.rating;
    Array.prototype.forEach.call($('starInput').children, function (s) {
      var i = Number(s.dataset.i);
      var fill = r >= i ? 100 : r >= i - 0.5 ? 50 : 0;
      s.style.setProperty('--fill', fill + '%');
      Array.prototype.forEach.call(s.children, function (b) {
        b.setAttribute('aria-checked', Number(b.dataset.v) === state.rating);
      });
    });
    $('ratingText').textContent = r ? r + ' / 5' : 'Pick a rating';
  }

  function pickMovie(m) {
    $('fTitle').value = m.title;
    $('fTmdbId').value = m.tmdbId || '';
    $('fPoster').value = m.poster || '';
    $('fYear').value = m.year || '';
    $('pickedPoster').src = m.poster ? POSTER + m.poster : '';
    $('pickedPoster').hidden = !m.poster;
    $('pickedLabel').textContent = m.title + (m.year ? ' (' + m.year + ')' : '');
    $('pickedMovie').hidden = false;
    hideSearch();
  }

  function clearPick() {
    ['fTmdbId', 'fPoster', 'fYear'].forEach(function (id) { $(id).value = ''; });
    $('pickedMovie').hidden = true;
  }

  function onTitleInput() {
    var q = $('fTitle').value.trim();
    clearPick();
    clearTimeout(state.search.timer);
    if (q.length < 2) { hideSearch(); return; }
    state.search.timer = setTimeout(function () {
      var seq = ++state.search.seq;
      api('search', { query: q }).then(function (data) {
        if (seq !== state.search.seq) return;
        state.search.results = data.results || [];
        state.search.active = -1;
        renderSearch(q);
      }).catch(function (err) { if (seq === state.search.seq) renderSearch(q, err.message); });
    }, 280);
  }

  function renderSearch(q, error) {
    var box = $('searchResults');
    box.innerHTML = '';
    if (error) {
      box.innerHTML = '<div class="search-hint">Search failed: ' + esc(error) + '. You can still type the title manually.</div>';
    } else if (!state.search.results.length) {
      box.innerHTML = '<div class="search-hint">No matches for “' + esc(q) + '”. Type it in manually.</div>';
    } else {
      state.search.results.forEach(function (m, i) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'search-item' + (i === state.search.active ? ' active' : '');
        b.innerHTML =
          (m.poster ? '<img alt="" src="' + POSTER + esc(m.poster) + '">' : '<div class="no-poster">🎬</div>') +
          '<div><div class="t">' + esc(m.title) + ' <span class="y">' + (m.year ? '(' + m.year + ')' : '') + '</span></div>' +
          '<div class="o">' + esc(m.overview || '') + '</div></div>';
        b.onmousedown = function (ev) { ev.preventDefault(); pickMovie(m); };
        box.appendChild(b);
      });
    }
    box.hidden = false;
  }

  function hideSearch() { $('searchResults').hidden = true; }

  function onTitleKey(ev) {
    var box = $('searchResults');
    if (box.hidden || !state.search.results.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      var n = state.search.results.length;
      state.search.active = (state.search.active + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
      Array.prototype.forEach.call(box.children, function (c, i) { c.classList.toggle('active', i === state.search.active); });
    } else if (ev.key === 'Enter' && state.search.active >= 0) {
      ev.preventDefault();
      pickMovie(state.search.results[state.search.active]);
    } else if (ev.key === 'Escape') {
      hideSearch();
    }
  }

  function startEdit(id) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    state.editingId = id;
    $('formTitle').textContent = 'Edit movie';
    $('submitBtn').textContent = 'Save changes';
    $('cancelEditBtn').hidden = false;
    $('fId').value = id;
    $('fTitle').value = e.title;
    $('fDate').value = e.date;
    $('fWhere').value = e.where || '';
    setRating(e.rating);
    if (e.tmdbId || e.poster) pickMovie(e); else clearPick();
    $('formCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    state.editingId = null;
    $('formTitle').textContent = 'Log a movie';
    $('submitBtn').textContent = 'Add to my list';
    $('cancelEditBtn').hidden = true;
    $('movieForm').reset();
    $('fDate').value = todayISO();
    $('formError').textContent = '';
    clearPick();
    setRating(0);
    hideSearch();
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var entry = {
      title: $('fTitle').value.trim(),
      date: $('fDate').value,
      where: $('fWhere').value.trim(),
      rating: Number($('fRating').value),
      tmdbId: $('fTmdbId').value,
      poster: $('fPoster').value,
      year: $('fYear').value
    };
    var err = $('formError');
    err.textContent = '';
    if (!entry.title) return err.textContent = 'Which movie?';
    if (!entry.date) return err.textContent = 'When did you watch it?';
    if (!entry.rating) return err.textContent = 'Give it a rating.';
    if (!state.editingId && myEntries().some(function (e) { return e.title.toLowerCase() === entry.title.toLowerCase(); })) {
      if (!confirm('You already logged "' + entry.title + '" this year. Add it again?')) return;
    }

    var btn = $('submitBtn');
    btn.disabled = true;
    var isEdit = !!state.editingId;
    var p = isEdit
      ? api('update', { year: state.year, id: state.editingId, entry: entry })
      : api('add', { year: state.year, entry: entry });
    p.then(function () {
      toast(isEdit ? 'Updated.' : '🎃 ' + entry.title + ' logged!');
      cancelEdit();
      return loadYear(state.year);
    }).catch(function (e) { err.textContent = e.message; })
      .finally(function () { btn.disabled = false; });
  }

  function onDelete(id) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e || !confirm('Remove "' + e.title + '" from your list?')) return;
    api('delete', { year: state.year, id: id }).then(function () {
      toast('Removed.');
      return loadYear(state.year);
    }).catch(function (err) { toast(err.message, true); });
  }

  // ------------------------------------------------------------ utils

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function prettyDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return iso || '';
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function initials(name) {
    return String(name || '?').split(/[\s._-]+/).slice(0, 2).map(function (s) { return s[0] || ''; }).join('').toUpperCase() || '?';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(t) { $('statusText').textContent = t; }
  var toastTimer;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg; t.className = 'toast' + (isError ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 5000 : 2600);
  }
  function waitFor(test, cb, tries) {
    tries = tries || 0;
    if (test()) return cb();
    if (tries > 200) return toast('Google Sign-In failed to load. Refresh?', true);
    setTimeout(function () { waitFor(test, cb, tries + 1); }, 50);
  }

  // ------------------------------------------------------------ mock backend (for local previews)

  var mock = {
    user: { email: 'you@example.com', name: 'Demo Ghoul', picture: '' },
    goal: CONFIG.GOAL || 31,
    participants: [
      { email: 'you@example.com', name: 'Demo Ghoul' },
      { email: 'ash@example.com', name: 'Ash' },
      { email: 'laurie@example.com', name: 'Laurie' },
      { email: 'sidney@example.com', name: 'Sidney' }
    ],
    entries: {},
    films: [
      { tmdbId: 1, title: 'The Thing', year: 1982, poster: '', overview: 'Antarctic research station. Something is not what it seems.' },
      { tmdbId: 2, title: 'Hereditary', year: 2018, poster: '', overview: 'A family unravels after the death of its secretive grandmother.' },
      { tmdbId: 3, title: 'Suspiria', year: 1977, poster: '', overview: 'A dance academy hides a sinister secret.' },
      { tmdbId: 4, title: 'The Descent', year: 2005, poster: '', overview: 'Cavers. Darkness. Things in the dark.' },
      { tmdbId: 5, title: 'Possession', year: 1981, poster: '', overview: 'A marriage falls apart in extraordinary fashion.' }
    ]
  };
  (function seed() {
    var y = String(new Date().getFullYear());
    var rows = [];
    var add = function (email, title, i) {
      rows.push({ id: email + i, email: email, date: y + '-10-' + pad(1 + (i % 28)), title: title, year: 1980 + i, tmdbId: '', poster: '', where: ['Shudder', 'Theater', 'Tubi'][i % 3], rating: 0.5 * (1 + (i * 7) % 10), createdAt: '' + i });
    };
    for (var i = 0; i < 6; i++) add('you@example.com', 'Demo Movie ' + (i + 1), i);
    for (var j = 0; j < 31; j++) add('ash@example.com', 'Ash Movie ' + (j + 1), j);
    for (var k = 0; k < 14; k++) add('laurie@example.com', 'Laurie Movie ' + (k + 1), k);
    mock.entries[y] = rows;
  })();

  function mockApi(action, p) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var y = String(p.year || new Date().getFullYear());
        var rows = mock.entries[y] || (mock.entries[y] = []);
        var years = Object.keys(mock.entries).sort().reverse();
        switch (action) {
          case 'me': return resolve({ ok: true, user: mock.user, years: years, goal: mock.goal });
          case 'list': {
            var counts = {};
            rows.forEach(function (e) { counts[e.email] = (counts[e.email] || 0) + 1; });
            var parts = mock.participants.map(function (q) { return { email: q.email, name: q.name, count: counts[q.email] || 0 }; })
              .sort(function (a, b) { return b.count - a.count; });
            var sorted = rows.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1); });
            return resolve({ ok: true, year: y, goal: mock.goal, years: years, participants: parts, entries: sorted });
          }
          case 'search': {
            var q = String(p.query || '').toLowerCase();
            return resolve({ ok: true, results: mock.films.filter(function (f) { return f.title.toLowerCase().indexOf(q) >= 0; }) });
          }
          case 'add': {
            var e = Object.assign({}, p.entry, { id: 'm' + Date.now(), email: mock.user.email, createdAt: new Date().toISOString() });
            rows.push(e); return resolve({ ok: true, id: e.id });
          }
          case 'update': {
            var idx = rows.findIndex(function (r) { return r.id === p.id; });
            if (idx >= 0) rows[idx] = Object.assign({}, rows[idx], p.entry);
            return resolve({ ok: true });
          }
          case 'delete': {
            mock.entries[y] = rows.filter(function (r) { return r.id !== p.id; });
            return resolve({ ok: true });
          }
          default: return resolve({ ok: false, error: 'unknown' });
        }
      }, 150);
    });
  }

  // ------------------------------------------------------------ wire up

  document.addEventListener('DOMContentLoaded', function () {
    buildStars();
    $('yearSelect').addEventListener('change', function () { loadYear(this.value); });
    $('signOutBtn').addEventListener('click', function () { signOut(false); });
    $('notInvitedSignOut').addEventListener('click', function () { signOut(true); });
    $('backToMine').addEventListener('click', function () { state.viewing = null; renderAll(); });
    $('everyoneBtn').addEventListener('click', function () {
      state.viewing = viewingEveryone() ? null : EVERYONE;
      cancelEdit();
      renderAll();
      if (window.innerWidth < 860) $('listTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('movieForm').addEventListener('submit', onSubmit);
    $('cancelEditBtn').addEventListener('click', cancelEdit);
    $('pickedClear').addEventListener('click', function () { clearPick(); $('fTitle').focus(); });
    $('fTitle').addEventListener('input', onTitleInput);
    $('fTitle').addEventListener('keydown', onTitleKey);
    $('fTitle').addEventListener('blur', function () { setTimeout(hideSearch, 150); });
    $('fTitle').addEventListener('focus', function () { if (state.search.results.length && !$('fTmdbId').value) $('searchResults').hidden = false; });
    $('movieList').addEventListener('click', function (ev) {
      var t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.edit) startEdit(t.dataset.edit);
      if (t.dataset.del) onDelete(t.dataset.del);
    });
    initAuth();
  });
})();
