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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MathAdmin2026!';

app.get('/', function(req, res) { res.json({ status: 'API works', version: '6.0' }); });

// ==================== AUTH ====================

app.post('/api/register', async function(req, res) {
  try {
    var email = req.body.email;
    var password = req.body.password;
    var child_name = req.body.child_name;
    var grade = req.body.grade;
    var hash = await bcrypt.hash(password, 10);
    var parentResult = await pool.query(
      'INSERT INTO parents (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    );
    var parent = parentResult.rows[0];
    var childResult = await pool.query(
      'INSERT INTO children (parent_id, name, grade) VALUES ($1, $2, $3) RETURNING *',
      [parent.id, child_name, grade]
    );
    var child = childResult.rows[0];
    var trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 5);
    await pool.query(
      'INSERT INTO subscriptions (parent_id, plan, status, expires_at) VALUES ($1, $2, $3, $4)',
      [parent.id, 'trial', 'trial', trialEnd]
    );
    var token = jwt.sign({ parentId: parent.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, parent: parent, child: child });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', async function(req, res) {
  try {
    var email = req.body.email;
    var password = req.body.password;
    var result = await pool.query('SELECT * FROM parents WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    var parent = result.rows[0];
    var valid = await bcrypt.compare(password, parent.password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });
    var children = await pool.query('SELECT * FROM children WHERE parent_id = $1', [parent.id]);
    var token = jwt.sign({ parentId: parent.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, parent: { id: parent.id, email: parent.email }, children: children.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== CONTENT ====================

app.get('/api/topics/:grade', async function(req, res) {
  try {
    var result = await pool.query(
      'SELECT t.*, s.name as subject_name, s.icon FROM topics t JOIN subjects s ON t.subject_id = s.id WHERE t.grade = $1 ORDER BY t.sort_order',
      [req.params.grade]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/questions/:topic_id', async function(req, res) {
  try {
    var result = await pool.query(
      'SELECT * FROM questions WHERE topic_id = $1 ORDER BY sort_order',
      [req.params.topic_id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== RESULTS ====================

app.post('/api/results', async function(req, res) {
  try {
    var child_id = req.body.child_id;
    var topic_id = req.body.topic_id;
    var score = req.body.score;
    var total_questions = req.body.total_questions;
    var result = await pool.query(
      'INSERT INTO test_results (child_id, topic_id, score, total_questions) VALUES ($1, $2, $3, $4) RETURNING *',
      [child_id, topic_id, score, total_questions]
    );
    var stars = Math.round((score / total_questions) * 3);
    await pool.query('UPDATE children SET stars = stars + $1 WHERE id = $2', [stars, child_id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stats/:child_id', async function(req, res) {
  try {
    var child = await pool.query('SELECT * FROM children WHERE id = $1', [req.params.child_id]);
    var results = await pool.query(
      'SELECT tr.*, t.title as topic_title FROM test_results tr JOIN topics t ON tr.topic_id = t.id WHERE tr.child_id = $1 ORDER BY tr.completed_at DESC',
      [req.params.child_id]
    );
    res.json({ child: child.rows[0], results: results.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== SUBSCRIPTIONS ====================

app.get('/api/subscription/:parent_id', async function(req, res) {
  try {
    var result = await pool.query(
      'SELECT * FROM subscriptions WHERE parent_id = $1 ORDER BY started_at DESC LIMIT 1',
      [req.params.parent_id]
    );
    if (result.rows.length === 0) return res.json({ status: 'none', expired: true });
    var sub = result.rows[0];
    var now = new Date();
    var expired = sub.expires_at && new Date(sub.expires_at) < now;
    var daysLeft = sub.expires_at ? Math.max(0, Math.ceil((new Date(sub.expires_at) - now) / (1000 * 60 * 60 * 24))) : 0;
    res.json({ id: sub.id, parent_id: sub.parent_id, plan: sub.plan, status: sub.status, started_at: sub.started_at, expires_at: sub.expires_at, expired: expired, days_left: daysLeft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== YOOKASSA PAYMENT ====================

app.post('/api/payment/create', async function(req, res) {
  try {
    var parent_id = req.body.parent_id;
    var plan = req.body.plan;
    var amount = req.body.amount;
    var return_url = req.body.return_url;
    var email = req.body.email || 'customer@example.com';

    console.log('Payment request:', JSON.stringify(req.body));

    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
      console.log('ERROR: YooKassa credentials missing');
      return res.status(500).json({ error: 'YooKassa credentials not configured' });
    }

    var idempotenceKey = parent_id + '-' + plan + '-' + Date.now();

    var itemDescription = 'Podpiska na 1 mesyats';
    if (plan === 'halfyear') itemDescription = 'Podpiska na 6 mesyatsev';

    var requestBody = {
      amount: {
        value: amount,
        currency: 'RUB'
      },
      confirmation: {
        type: 'redirect',
        return_url: return_url || 'https://xn--80aafbgfceijfjhfadim5ae4akh0ag5e.xn--p1ai/payment-success'
      },
      capture: true,
      description: itemDescription,
      metadata: {
        parent_id: String(parent_id),
        plan: plan
      },
      receipt: {
        customer: {
          email: email
        },
        items: [
          {
            description: itemDescription,
            quantity: '1.00',
            amount: {
              value: amount,
              currency: 'RUB'
            },
            vat_code: 1,
            payment_subject: 'service',
            payment_mode: 'full_payment'
          }
        ]
      }
    };

    console.log('YooKassa request body:', JSON.stringify(requestBody));

    var response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
        'Authorization': 'Basic ' + Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64')
      },
      body: JSON.stringify(requestBody)
    });

    var responseText = await response.text();
    console.log('YooKassa response status:', response.status);
    console.log('YooKassa response body:', responseText);

    var payment;
    try {
      payment = JSON.parse(responseText);
    } catch (e) {
      return res.status(500).json({ error: 'Invalid response from YooKassa', raw: responseText });
    }

    if (payment.id && payment.confirmation) {
      res.json({
        payment_id: payment.id,
        confirmation_url: payment.confirmation.confirmation_url,
        status: payment.status
      });
    } else {
      res.status(400).json({ error: 'Payment creation failed', details: payment });
    }
  } catch (e) {
    console.log('Payment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// YooKassa webhook
app.post('/api/payment/webhook', async function(req, res) {
  try {
    console.log('Webhook received:', JSON.stringify(req.body));
    var event = req.body.event;
    var object = req.body.object;
    if (event === 'payment.succeeded') {
      var parentId = object.metadata.parent_id;
      var plan = object.metadata.plan;
      var now = new Date();
      var expiresAt = new Date();

      if (plan === 'monthly') {
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      } else if (plan === 'halfyear') {
        expiresAt.setMonth(expiresAt.getMonth() + 6);
      }

      var existing = await pool.query(
        'SELECT id FROM subscriptions WHERE parent_id = $1',
        [parentId]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          "UPDATE subscriptions SET plan = $1, status = 'active', started_at = $2, expires_at = $3 WHERE parent_id = $4",
          [plan, now, expiresAt, parentId]
        );
      } else {
        await pool.query(
          "INSERT INTO subscriptions (parent_id, plan, status, started_at, expires_at) VALUES ($1, $2, 'active', $3, $4)",
          [parentId, plan, now, expiresAt]
        );
      }
      console.log('Subscription activated for parent:', parentId, 'plan:', plan);
    }
    res.json({ status: 'ok' });
  } catch (e) {
    console.log('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Check payment status
app.get('/api/payment/status/:payment_id', async function(req, res) {
  try {
    var response = await fetch('https://api.yookassa.ru/v3/payments/' + req.params.payment_id, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(YOOKASSA_SHOP_ID + ':' + YOOKASSA_SECRET_KEY).toString('base64')
      }
    });
    var payment = await response.json();

    if (payment.status === 'succeeded' && payment.metadata) {
      var parentId = payment.metadata.parent_id;
      var plan = payment.metadata.plan;
      var now = new Date();
      var expiresAt = new Date();

      if (plan === 'monthly') {
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      } else if (plan === 'halfyear') {
        expiresAt.setMonth(expiresAt.getMonth() + 6);
      }

      var existing = await pool.query(
        'SELECT id, status FROM subscriptions WHERE parent_id = $1',
        [parentId]
      );

      if (existing.rows.length > 0 && existing.rows[0].status !== 'active') {
        await pool.query(
          "UPDATE subscriptions SET plan = $1, status = 'active', started_at = $2, expires_at = $3 WHERE parent_id = $4",
          [plan, now, expiresAt, parentId]
        );
      }
    }

    res.json(payment);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== ADMIN ====================

app.post('/api/admin/login', function(req, res) {
  var password = req.body.password;
  if (password === ADMIN_PASSWORD) {
    var token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token: token, success: true });
  } else {
    res.status(401).json({ error: 'Wrong admin password' });
  }
});

app.get('/api/admin/users', async function(req, res) {
  try {
    var authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    var token = authHeader.replace('Bearer ', '');
    var decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Not admin' });

    var result = await pool.query(
      "SELECT p.id, p.email, p.created_at as registered, c.name as child_name, c.grade, c.stars, s.plan, s.status as sub_status, s.started_at as sub_start, s.expires_at as sub_end FROM parents p LEFT JOIN children c ON c.parent_id = p.id LEFT JOIN subscriptions s ON s.parent_id = p.id ORDER BY p.created_at DESC"
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', async function(req, res) {
  try {
    var authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    var token = authHeader.replace('Bearer ', '');
    var decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Not admin' });

    var totalUsers = await pool.query('SELECT COUNT(*) as count FROM parents');
    var activeSubscriptions = await pool.query("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'active' AND expires_at > NOW()");
    var trialUsers = await pool.query("SELECT COUNT(*) as count FROM subscriptions WHERE status = 'trial' AND expires_at > NOW()");
    var expiredUsers = await pool.query("SELECT COUNT(*) as count FROM subscriptions WHERE expires_at < NOW()");
    var totalTests = await pool.query('SELECT COUNT(*) as count FROM test_results');
    var todayRegistrations = await pool.query("SELECT COUNT(*) as count FROM parents WHERE created_at >= CURRENT_DATE");

    res.json({
      total_users: parseInt(totalUsers.rows[0].count),
      active_subscriptions: parseInt(activeSubscriptions.rows[0].count),
      trial_users: parseInt(trialUsers.rows[0].count),
      expired_users: parseInt(expiredUsers.rows[0].count),
      total_tests: parseInt(totalTests.rows[0].count),
      today_registrations: parseInt(todayRegistrations.rows[0].count)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/test-results', async function(req, res) {
  try {
    var authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    var token = authHeader.replace('Bearer ', '');
    var decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Not admin' });

    var result = await pool.query(
      "SELECT tr.id, tr.score, tr.total_questions, tr.completed_at, c.name as child_name, c.grade, t.title as topic_title, p.email FROM test_results tr JOIN children c ON tr.child_id = c.id JOIN topics t ON tr.topic_id = t.id JOIN parents p ON c.parent_id = p.id ORDER BY tr.completed_at DESC LIMIT 100"
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('API running on port ' + PORT); });
