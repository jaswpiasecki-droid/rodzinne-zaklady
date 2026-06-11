const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');

const app = express();

// Połączenie z PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tworzenie tabel aplikacji
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      start_time TIMESTAMP NOT NULL,
      home_score INTEGER,
      away_score INTEGER
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      match_id INTEGER REFERENCES matches(id),
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      points INTEGER DEFAULT 0,
      UNIQUE(user_id, match_id)
    );
  `);
}

// Tworzenie tabeli sesji
async function initSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      PRIMARY KEY ("sid")
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire"
    ON "session" ("expire");
  `);
}

initDb();
initSessionTable();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));

// Sesje w PostgreSQL
app.use(
  session({
    store: new PgSession({
      pool: pool,
      tableName: 'session'
    }),
    secret: 'tajny-klucz',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
  })
);

// Middleware
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send('Brak dostępu');
  }
  next();
}

// ROUTES

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/register', (req, res) => res.render('register'));

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  const count = await pool.query('SELECT COUNT(*) FROM users');
  const is_admin = count.rows[0].count === "0";

  try {
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING *',
      [username, hash, is_admin]
    );

    req.session.user = result.rows[0];
    res.redirect('/dashboard');
  } catch {
    res.send('Użytkownik istnieje');
  }
});

app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = result.rows[0];

  if (!user) return res.send('Złe dane');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.send('Złe dane');

  req.session.user = user;
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// DASHBOARD

app.get('/dashboard', requireLogin, async (req, res) => {
  const uid = req.session.user.id;

  const matches = await pool.query(`
    SELECT m.*, b.home_score AS bet_home, b.away_score AS bet_away, b.points
    FROM matches m
    LEFT JOIN bets b ON b.match_id = m.id AND b.user_id = $1
    ORDER BY m.start_time ASC
  `, [uid]);

  res.render('dashboard', { user: req.session.user, matches: matches.rows });
});

app.post('/bet/:id', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const mid = req.params.id;
  const { home_score, away_score } = req.body;

  const match = await pool.query('SELECT * FROM matches WHERE id=$1', [mid]);
  if (!match.rows.length) return res.send('Brak meczu');

  if (new Date() >= new Date(match.rows[0].start_time)) return res.send('Za późno');

  await pool.query(`
    INSERT INTO bets (user_id, match_id, home_score, away_score)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, match_id)
    DO UPDATE SET home_score=EXCLUDED.home_score, away_score=EXCLUDED.away_score
  `, [uid, mid, home_score, away_score]);

  res.redirect('/dashboard');
});

// ADMIN — MECZE

app.get('/admin/matches', requireAdmin, async (req, res) => {
  const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
  res.render('admin-matches', { user: req.session.user, matches: matches.rows });
});

app.post('/admin/matches/add', requireAdmin, async (req, res) => {
  const { home_team, away_team, start_time } = req.body;

  await pool.query(
    'INSERT INTO matches (home_team, away_team, start_time) VALUES ($1, $2, $3)',
    [home_team, away_team, start_time]
  );

  res.redirect('/admin/matches');
});

// USUWANIE MECZU
app.post('/admin/matches/:id/delete', requireAdmin, async (req, res) => {
  const mid = req.params.id;

  await pool.query('DELETE FROM bets WHERE match_id=$1', [mid]);
  await pool.query('DELETE FROM matches WHERE id=$1', [mid]);

  res.redirect('/admin/matches');
});

function calcPoints(match, bet) {
  if (match.home_score === bet.home_score && match.away_score === bet.away_score) return 3;

  const mw = match.home_score > match.away_score ? 'H' :
             match.home_score < match.away_score ? 'A' : 'D';

  const bw = bet.home_score > bet.away_score ? 'H' :
             bet.home_score < bet.away_score ? 'A' : 'D';

  return mw === bw ? 1 : 0;
}

app.post('/admin/matches/:id/result', requireAdmin, async (req, res) => {
  const { home_score, away_score } = req.body;
  const mid = req.params.id;

  await pool.query(
    'UPDATE matches SET home_score=$1, away_score=$2 WHERE id=$3',
    [home_score, away_score, mid]
  );

  const bets = await pool.query('SELECT * FROM bets WHERE match_id=$1', [mid]);
  const match = await pool.query('SELECT * FROM matches WHERE id=$1', [mid]);

  for (const bet of bets.rows) {
    const points = calcPoints(match.rows[0], bet);
    await pool.query('UPDATE bets SET points=$1 WHERE id=$2', [points, bet.id]);
  }

  res.redirect('/admin/matches');
});

// ADMIN — UŻYTKOWNICY

app.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await pool.query(`
    SELECT 
      u.id, 
      u.username, 
      u.is_admin,
      COALESCE(SUM(b.points), 0) AS total_points,
      COUNT(b.id) AS bets_count
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id ASC
  `);

  res.render('admin-users', { user: req.session.user, users: users.rows });
});

// USUWANIE UŻYTKOWNIKA
app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  const uid = req.params.id;

  await pool.query('DELETE FROM bets WHERE user_id=$1', [uid]);
  await pool.query('DELETE FROM users WHERE id=$1', [uid]);

  res.redirect('/admin/users');
});

// RANKING

app.get('/ranking', requireLogin, async (req, res) => {
  const ranking = await pool.query(`
    SELECT u.username, COALESCE(SUM(b.points), 0) AS total
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    GROUP BY u.id
    ORDER BY total DESC
  `);

  res.render('ranking', { user: req.session.user, ranking: ranking.rows });
});

// MOJE WYNIKI

app.get('/my-results', requireLogin, async (req, res) => {
  const uid = req.session.user.id;

  const results = await pool.query(`
    SELECT m.*, b.home_score AS bet_home, b.away_score AS bet_away, b.points
    FROM bets b
    JOIN matches m ON m.id = b.match_id
    WHERE b.user_id = $1
    ORDER BY m.start_time DESC
  `, [uid]);

  res.render('my-results', { user: req.session.user, results: results.rows });
});

// ZMIANA HASŁA

app.get('/change-password', requireLogin, (req, res) => {
  res.render('change-password', { user: req.session.user });
});

app.post('/change-password', requireLogin, async (req, res) => {
  const { old_password, new_password } = req.body;

  const result = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
  const user = result.rows[0];

  const ok = await bcrypt.compare(old_password, user.password_hash);
  if (!ok) return res.send('Złe stare hasło');

  const hash = await bcrypt.hash(new_password, 10);

  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user.id]);

  res.send('Hasło zmienione');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Działa na porcie ' + PORT));
