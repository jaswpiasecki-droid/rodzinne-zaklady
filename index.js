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

// BLOKADA OBSTAWIANIA PO CZASIE (NAPRAWIONA)
app.post('/bet/:id', requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const mid = req.params.id;
  const { home_score, away_score } = req.body;

  const match = await pool.query('SELECT * FROM matches WHERE id=$1', [mid]);
  if (!match.rows.length) return res.send('Brak meczu');

  // POPRAWNE PARSOWANIE DATY
  const matchStart = new Date(match.rows[0].start_time.replace(' ', 'T'));

  if (Date.now() >= matchStart.getTime()) {
    return res.send('Za późno');
  }

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

// FUNKCJA LICZENIA PUNKTÓW
function calcPoints(match, bet) {
  if (match.home
