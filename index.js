const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const db = new sqlite3.Database('./db.sqlite');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'tajny-klucz',
  resave: false,
  saveUninitialized: false
}));

// Tworzenie tabel jeśli nie istnieją
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    start_time DATETIME NOT NULL,
    home_score INTEGER,
    away_score INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    home_score INTEGER NOT NULL,
    away_score INTEGER NOT NULL,
    points INTEGER DEFAULT 0,
    UNIQUE(user_id, match_id)
  )`);
});

// Middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Brak dostępu');
  next();
}

// ROUTES

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  db.get('SELECT COUNT(*) AS cnt FROM users', (err, row) => {
    const is_admin = row.cnt === 0 ? 1 : 0;

    db.run(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)',
      [username, hash, is_admin],
      function (err2) {
        if (err2) return res.send('Użytkownik istnieje');
        req.session.user = { id: this.lastID, username, is_admin };
        res.redirect('/dashboard');
      }
    );
  });
});

app.get('/login', (req, res) => res.render('login'));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (!user) return res.send('Złe dane');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.send('Złe dane');
    req.session.user = { id: user.id, username: user.username, is_admin: user.is_admin };
    res.redirect('/dashboard');
  });
});

app.get('/dashboard', requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const sql = `
    SELECT m.*, b.home_score AS bet_home, b.away_score AS bet_away, b.points
    FROM matches m
    LEFT JOIN bets b ON b.match_id = m.id AND b.user_id = ?
    ORDER BY m.start_time ASC
  `;
  db.all(sql, [uid], (err, matches) => {
    res.render('dashboard', { user: req.session.user, matches });
  });
});

app.post('/bet/:id', requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const mid = req.params.id;
  const { home_score, away_score } = req.body;

  db.get('SELECT * FROM matches WHERE id = ?', [mid], (err, match) => {
    if (!match) return res.send('Brak meczu');
    if (new Date() >= new Date(match.start_time)) return res.send('Za późno');

    db.run(
      `INSERT INTO bets (user_id, match_id, home_score, away_score)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, match_id)
       DO UPDATE SET home_score=excluded.home_score, away_score=excluded.away_score`,
      [uid, mid, home_score, away_score],
      () => res.redirect('/dashboard')
    );
  });
});

// ADMIN

app.get('/admin/matches', requireAdmin, (req, res) => {
  db.all('SELECT * FROM matches ORDER BY start_time DESC', [], (err, matches) => {
    res.render('admin-matches', { user: req.session.user, matches });
  });
});

app.post('/admin/matches/add', requireAdmin, (req, res) => {
  const { home_team, away_team, start_time } = req.body;
  db.run(
    'INSERT INTO matches (home_team, away_team, start_time) VALUES (?, ?, ?)',
    [home_team, away_team, start_time],
    () => res.redirect('/admin/matches')
  );
});

app.post('/admin/matches/:id/result', requireAdmin, (req, res) => {
  const { home_score, away_score } = req.body;
  const mid = req.params.id;

  db.run(
    'UPDATE matches SET home_score=?, away_score=? WHERE id=?',
    [home_score, away_score, mid],
    () => {
      db.all('SELECT * FROM bets WHERE match_id=?', [mid], (err, bets) => {
        db.get('SELECT * FROM matches WHERE id=?', [mid], (err2, match) => {
          bets.forEach(bet => {
            const points = calcPoints(match, bet);
            db.run('UPDATE bets SET points=? WHERE id=?', [points, bet.id]);
          });
        });
      });
      res.redirect('/admin/matches');
    }
  );
});

function calcPoints(match, bet) {
  if (match.home_score === bet.home_score && match.away_score === bet.away_score) return 3;

  const mw = match.home_score > match.away_score ? 'H' :
             match.home_score < match.away_score ? 'A' : 'D';

  const bw = bet.home_score > bet.away_score ? 'H' :
             bet.home_score < bet.away_score ? 'A' : 'D';

  return mw === bw ? 1 : 0;
}

app.get('/ranking', requireLogin, (req, res) => {
  const sql = `
    SELECT u.username, COALESCE(SUM(b.points), 0) AS total
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    GROUP BY u.id
    ORDER BY total DESC
  `;
  db.all(sql, [], (err, ranking) => {
    res.render('ranking', { user: req.session.user, ranking });
  });
});

app.get('/my-results', requireLogin, (req, res) => {
  const uid = req.session.user.id;
  const sql = `
    SELECT m.*, b.home_score AS bet_home, b.away_score AS bet_away, b.points
    FROM bets b
    JOIN matches m ON m.id = b.match_id
    WHERE b.user_id = ?
    ORDER BY m.start_time DESC
  `;
  db.all(sql, [uid], (err, results) => {
    res.render('my-results', { user: req.session.user, results });
  });
});

app.get('/change-password', requireLogin, (req, res) => {
  res.render('change-password', { user: req.session.user });
});

app.post('/change-password', requireLogin, async (req, res) => {
  const { old_password, new_password } = req.body;
  db.get('SELECT * FROM users WHERE id=?', [req.session.user.id], async (err, user) => {
    const ok = await bcrypt.compare(old_password, user.password_hash);
    if (!ok) return res.send('Złe stare hasło');
    const hash = await bcrypt.hash(new_password, 10);
    db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, user.id], () => {
      res.send('Hasło zmienione');
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Działa na porcie ' + PORT));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Działa na porcie ' + PORT));
