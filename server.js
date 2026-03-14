const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'math-easy-secret-key-2026';

// Проверка работы
app.get('/', (req, res) => {
  res.json({ status: 'API работает', version: '1.0' });
});

// Регистрация родителя
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, child_name, grade } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const parent = await pool.query(
      'INSERT INTO parents (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    const child = await pool.query(
      'INSERT INTO children (parent_id, name, grade) VALUES ($1, $2, $3) RETURNING id, name, grade',
      [parent.rows[0].id, child_name, grade]
    );
    const token = jwt.sign({ parent_id: parent.rows[0].id }, JWT_SECRET);
    res.json({ token, parent: parent.rows[0], child: child.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email уже зарегистрирован' });
    res.status(500).json({ error: e.message });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM parents WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Неверный email или пароль' });
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });
    const children = await pool.query('SELECT id, name, grade, stars, level FROM children WHERE parent_id = $1', [result.rows[0].id]);
    const token = jwt.sign({ parent_id: result.rows[0].id }, JWT_SECRET);
    res.json({ token, parent: { id: result.rows[0].id, email: result.rows[0].email }, children: children.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить темы по классу
app.get('/api/topics/:grade', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, s.name as subject_name FROM topics t JOIN subjects s ON t.subject_id = s.id WHERE t.grade = $1 ORDER BY t.sort_order',
      [req.params.grade]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить вопросы по теме
app.get('/api/questions/:topic_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE topic_id = $1 ORDER BY sort_order',
      [req.params.topic_id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Сохранить результат теста
app.post('/api/results', async (req, res) => {
  try {
    const { child_id, topic_id, score, total_questions } = req.body;
    const result = await pool.query(
      'INSERT INTO test_results (child_id, topic_id, score, total_questions) VALUES ($1, $2, $3, $4) RETURNING *',
      [child_id, topic_id, score, total_questions]
    );
    await pool.query(
      'UPDATE children SET stars = stars + $1 WHERE id = $2',
      [score, child_id]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Статистика ребёнка (для родительского кабинета)
app.get('/api/stats/:child_id', async (req, res) => {
  try {
    const child = await pool.query('SELECT * FROM children WHERE id = $1', [req.params.child_id]);
    const results = await pool.query(
      'SELECT tr.*, t.title as topic_title FROM test_results tr JOIN topics t ON tr.topic_id = t.id WHERE tr.child_id = $1 ORDER BY tr.completed_at DESC',
      [req.params.child_id]
    );
    const summary = await pool.query(
      'SELECT COUNT(*) as total_tests, COALESCE(AVG(score * 100.0 / total_questions), 0) as avg_score FROM test_results WHERE child_id = $1',
      [req.params.child_id]
    );
    res.json({ child: child.rows[0], results: results.rows, summary: summary.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API running on port ' + PORT));
