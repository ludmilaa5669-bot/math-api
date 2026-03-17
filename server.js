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
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

// Health check
app.get('/', (req, res) => res.json({ status: 'API работает', version: '2.0' }));

// ==================== AUTH ====================

app.post('/api/register', async (req, res) => {
  try {
    const { email, password, child_name, grade } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const parentResult = await pool.query(
      'INSERT INTO parents (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    const parent = parentResult.rows[0];
    const childResult = await pool.query(
      'INSERT INTO children (parent_id, name, grade) VALUES ($1, $2, $3) RETURNING *',
      [parent.id, child_name, grade]
    );
    const child = childResult.rows[0];
    // Create trial subscription (3 days)
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 3);
    await pool.query(
      'INSERT INTO subscriptions (parent_id, plan, status, expires_at) VALUES ($1, $2, $3, $4)',
      [parent.id, 'trial', 'trial', trialEnd]
    );
    const token = jwt.sign({ parentId: parent.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, parent, child });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM parents WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Пользователь не найден' });
    const parent = result.rows[0];
    const valid = await bcrypt.compare(password, parent.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
    const children = await pool.query('SELECT * FROM children WHERE parent_id = $1', [parent.id]);
    const token = jwt.sign({ parentId: parent.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, parent: { id: parent.id, email: parent.email }, children: children.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== CONTENT ====================

app.get('/api/topics/:grade', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, s.name as subject_name, s.icon FROM topics t JOIN subjects s ON t.subject_id = s.id WHERE t.grade = $1 ORDER BY t.sort_order',
      [req.params.grade]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/questions/:topic_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM questions WHERE topic_id = $1 ORDER BY sort_order',
      [req.params.topic_id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== RESULTS ====================

app.post('/api/results', async (req, res) => {
  try {
    const { child_id, topic_id, score, total_questions } = req.body;
    const result = await pool.query(
      'INSERT INTO test_results (child_id, topic_id, score, total_questions) VALUES ($1, $2, $3, $4) RETURNING *',
      [child_id, topic_id, score, total_questions]
    );
    const stars = Math.round((score / total_questions) * 3);
    await pool.query('UPDATE children SET stars = stars + $1 WHERE id = $2', [stars, child_id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/:child_id', async (req, res) => {
  try {
    const child = await pool.query('SELECT * FROM children WHERE id = $1', [req.params.child_id]);
    const results = await pool.query(
      'SELECT tr.*, t.title as topic_title FROM test_results tr JOIN topics t ON tr.topic_id = t.id WHERE tr.child_id = $1 ORDER BY tr.completed_at DESC',
      [req.params.child_id]
    );
    res.json({ child: child.rows[0], results: results.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== SUBSCRIPTIONS ====================

app.get('/api/subscription/:parent_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE parent_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.parent_id]
    );
    if (result.rows.length === 0) return res.json({ status: 'none' });
    const sub = result.rows[0];
    const now = new Date();
    const expired = sub.expires_at && new Date(sub.expires_at) < now;
    res.json({ ...sub, expired });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== YOOKASSA PAYMENT ====================

app.post('/api/payment/create', async (req, res) => {
  try {
    const { parent_id, plan, amount, return_url } = req.body;
    // plan: 'monthly' = 299 руб, 'yearly' = 1990 руб
    const idempotenceKey = `${parent_id}-${plan}-${Date.now()}`;

    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
        'Authorization': 'Basic ' + Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64')
      },
      body: JSON.stringify({
        amount: { value: amount, currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: return_url || 'https://математикапростоматематика.рф/payment-success' },
        capture: true,
        description: plan === 'monthly' ? 'Подписка на 1 месяц' : 'Подписка на 1 год',
        metadata: { parent_id: String(parent_id), plan }
      })
    });

    const payment = await response.json();
    if (payment.id) {
      res.json({
        payment_id: payment.id,
        confirmation_url: payment.confirmation.confirmation_url,
        status: payment.status
      });
    } else {
      res.status(400).json({ error: 'Ошибка создания платежа', details: payment });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// YooKassa webhook — вызывается автоматически после оплаты
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const { event, object } = req.body;
    if (event === 'payment.succeeded') {
      const parentId = object.metadata.parent_id;
      const plan = object.metadata.plan;
      const now = new Date();
      const expiresAt = new Date();
      if (plan === 'monthly') expiresAt.setMonth(expiresAt.getMonth() + 1);
      else if (plan === 'yearly') expiresAt.setFullYear(expiresAt.getFullYear() + 1);

      await pool.query(
        `UPDATE subscriptions SET plan = $1, status = 'active', started_at = $2, expires_at = $3 WHERE parent_id = $4`,
        [plan, now, expiresAt, parentId]
      );
    }
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check payment status manually
app.get('/api/payment/status/:payment_id', async (req, res) => {
  try {
    const response = await fetch(`https://api.yookassa.ru/v3/payments/${req.params.payment_id}`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64')
      }
    });
    const payment = await response.json();
    res.json(payment);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('API running on port ' + PORT));
