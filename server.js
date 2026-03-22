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

app.get('/api/topics/:grade', async (req, res) => {
  try {
    const { grade } = req.params;
    const result = await pool.query(
      'SELECT id, title, description, theory, sort_order FROM topics WHERE grade = $1 ORDER BY sort_order',
      [grade]
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
// Temporary SQL endpoint for admin
app.post('/api/admin/sql', async (req, res) => {
  const { key, query } = req.body;
  if (key !== 'math2025admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await pool.query(query);
    res.json({ rowCount: result.rowCount, rows: result.rows ? result.rows.slice(0, 50) : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Interactive tasks table creation
app.get('/api/setup/interactive', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS interactive_tasks (
        id SERIAL PRIMARY KEY,
        topic_id INTEGER REFERENCES topics(id),
        task_type VARCHAR(30) NOT NULL,
        task_data JSONB NOT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);
    res.json({ success: true, message: 'Table interactive_tasks created' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get interactive tasks for a topic
app.get('/api/interactive/:topicId', async (req, res) => {
  try {
    const { topicId } = req.params;
    const result = await pool.query(
      'SELECT id, topic_id, task_type, task_data, sort_order FROM interactive_tasks WHERE topic_id = $1 ORDER BY sort_order',
      [topicId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Insert interactive tasks (batch)
app.post('/api/interactive/batch', async (req, res) => {
  const { key, tasks } = req.body;
  if (key !== 'math2025admin') return res.status(403).json({ error: 'forbidden' });
  try {
    let count = 0;
    for (const t of tasks) {
      await pool.query(
        'INSERT INTO interactive_tasks (topic_id, task_type, task_data, sort_order) VALUES ($1, $2, $3, $4)',
        [t.topic_id, t.task_type, JSON.stringify(t.task_data), t.sort_order || 0]
      );
      count++;
    }
    res.json({ success: true, inserted: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/admin/load-tasks', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).send('forbidden');
  try {
    var tasks = [];
    tasks.push({topic_id:1,task_type:'match_pairs',sort_order:1,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0435\u0434\u043c\u0435\u0442 \u0441 \u0435\u0433\u043e \u0444\u043e\u0440\u043c\u043e\u0439",pairs:[{left:"\u041c\u044f\u0447",right:"\u041a\u0440\u0443\u0433\u043b\u044b\u0439"},{left:"\u041a\u043d\u0438\u0433\u0430",right:"\u041f\u0440\u044f\u043c\u043e\u0443\u0433\u043e\u043b\u044c\u043d\u044b\u0439"},{left:"\u041f\u0438\u0440\u0430\u043c\u0438\u0434\u043a\u0430",right:"\u0422\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u044b\u0439"},{left:"\u041a\u0443\u0431\u0438\u043a",right:"\u041a\u0432\u0430\u0434\u0440\u0430\u0442\u043d\u044b\u0439"},{left:"\u042f\u0439\u0446\u043e",right:"\u041e\u0432\u0430\u043b\u044c\u043d\u044b\u0439"}]})});
    tasks.push({topic_id:1,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0435\u0434\u043c\u0435\u0442 \u0441 \u0435\u0433\u043e \u0446\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"\u0421\u043e\u043b\u043d\u0446\u0435",right:"\u0416\u0451\u043b\u0442\u044b\u0439"},{left:"\u0422\u0440\u0430\u0432\u0430",right:"\u0417\u0435\u043b\u0451\u043d\u044b\u0439"},{left:"\u041d\u0435\u0431\u043e",right:"\u0413\u043e\u043b\u0443\u0431\u043e\u0439"},{left:"\u041f\u043e\u043c\u0438\u0434\u043e\u0440",right:"\u041a\u0440\u0430\u0441\u043d\u044b\u0439"},{left:"\u0411\u0430\u043a\u043b\u0430\u0436\u0430\u043d",right:"\u0424\u0438\u043e\u043b\u0435\u0442\u043e\u0432\u044b\u0439"}]})});
    tasks.push({topic_id:1,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u041c\u044f\u0447 \u2014 \u043a\u0440\u0443\u0433\u043b\u044b\u0439",answer:true,explanation:"\u0414\u0430! \u041c\u044f\u0447 \u0438\u043c\u0435\u0435\u0442 \u043a\u0440\u0443\u0433\u043b\u0443\u044e \u0444\u043e\u0440\u043c\u0443"},{text:"\u041a\u043d\u0438\u0433\u0430 \u2014 \u043a\u0440\u0443\u0433\u043b\u0430\u044f",answer:false,explanation:"\u041d\u0435\u0442! \u041a\u043d\u0438\u0433\u0430 \u043f\u0440\u044f\u043c\u043e\u0443\u0433\u043e\u043b\u044c\u043d\u0430\u044f"},{text:"\u0410\u0440\u0431\u0443\u0437 \u0431\u043e\u043b\u044c\u0448\u0435 \u044f\u0431\u043b\u043e\u043a\u0430",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"\u041c\u0443\u0440\u0430\u0432\u0435\u0439 \u0431\u043e\u043b\u044c\u0448\u0435 \u0441\u043b\u043e\u043d\u0430",answer:false,explanation:"\u041d\u0435\u0442! \u0421\u043b\u043e\u043d \u043d\u0430\u043c\u043d\u043e\u0433\u043e \u0431\u043e\u043b\u044c\u0448\u0435"}]})});
    tasks.push({topic_id:1,task_type:'fill_blank',sort_order:4,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0441\u043b\u043e\u0432\u043e",questions:[{text:"\u041c\u044f\u0447 \u043f\u043e \u0444\u043e\u0440\u043c\u0435 \u2014 ___",answer:"\u043a\u0440\u0443\u0433\u043b\u044b\u0439",hint:"\u041a\u0430\u043a\u043e\u0439 \u0444\u043e\u0440\u043c\u044b \u043c\u044f\u0447?"},{text:"\u041f\u043e\u043c\u0438\u0434\u043e\u0440 \u043f\u043e \u0446\u0432\u0435\u0442\u0443 \u2014 ___",answer:"\u043a\u0440\u0430\u0441\u043d\u044b\u0439",hint:"\u041a\u0430\u043a\u043e\u0433\u043e \u0446\u0432\u0435\u0442\u0430 \u043f\u043e\u043c\u0438\u0434\u043e\u0440?"},{text:"\u0421\u043b\u043e\u043d \u043f\u043e \u0440\u0430\u0437\u043c\u0435\u0440\u0443 \u2014 ___",answer:"\u0431\u043e\u043b\u044c\u0448\u043e\u0439",hint:"\u041c\u0430\u043b\u0435\u043d\u044c\u043a\u0438\u0439 \u0438\u043b\u0438 \u0431\u043e\u043b\u044c\u0448\u043e\u0439?"}]})});
    tasks.push({topic_id:2,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"1, 2, ___, 4, 5",answer:"3",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e \u043c\u0435\u0436\u0434\u0443 2 \u0438 4?"},{text:"3, 4, 5, ___, 7",answer:"6",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e \u043c\u0435\u0436\u0434\u0443 5 \u0438 7?"},{text:"___, 8, 9, 10",answer:"7",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e \u043f\u0435\u0440\u0435\u0434 8?"},{text:"10, 9, ___, 7, 6",answer:"8",hint:"\u0421\u0447\u0438\u0442\u0430\u0435\u043c \u043e\u0431\u0440\u0430\u0442\u043d\u043e"}]})});
    tasks.push({topic_id:2,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u0447\u0438\u0441\u043b\u043e \u0441 \u043a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e\u043c",pairs:[{left:"3",right:"\ud83c\udf4e\ud83c\udf4e\ud83c\udf4e"},{left:"5",right:"\ud83c\udf4e\ud83c\udf4e\ud83c\udf4e\ud83c\udf4e\ud83c\udf4e"},{left:"1",right:"\ud83c\udf4e"},{left:"4",right:"\ud83c\udf4e\ud83c\udf4e\ud83c\udf4e\ud83c\udf4e"},{left:"2",right:"\ud83c\udf4e\ud83c\udf4e"}]})});
    tasks.push({topic_id:2,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u041f\u043e\u0441\u043b\u0435 \u0447\u0438\u0441\u043b\u0430 5 \u0438\u0434\u0451\u0442 \u0447\u0438\u0441\u043b\u043e 6",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 5, 6, 7..."},{text:"\u041f\u0435\u0440\u0435\u0434 \u0447\u0438\u0441\u043b\u043e\u043c 3 \u0441\u0442\u043e\u0438\u0442 \u0447\u0438\u0441\u043b\u043e 4",answer:false,explanation:"\u041d\u0435\u0442! \u041f\u0435\u0440\u0435\u0434 3 \u0441\u0442\u043e\u0438\u0442 2"},{text:"\u0427\u0438\u0441\u043b\u043e 7 \u0431\u043e\u043b\u044c\u0448\u0435 \u0447\u0438\u0441\u043b\u0430 4",answer:true,explanation:"\u0414\u0430! 7 > 4"},{text:"\u0421\u043e\u0441\u0435\u0434\u0438 \u0447\u0438\u0441\u043b\u0430 5 \u2014 \u044d\u0442\u043e 4 \u0438 6",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 4, 5, 6"}]})});
    tasks.push({topic_id:2,task_type:'ordering',sort_order:4,task_data:JSON.stringify({instruction:"\u0420\u0430\u0441\u0441\u0442\u0430\u0432\u044c \u0447\u0438\u0441\u043b\u0430 \u043e\u0442 \u043c\u0435\u043d\u044c\u0448\u0435\u0433\u043e \u043a \u0431\u043e\u043b\u044c\u0448\u0435\u043c\u0443",items:["5","2","8","1","4"],correct_order:["1","2","4","5","8"]})});
    tasks.push({topic_id:3,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"3 + ___ = 5",answer:"2",hint:"\u0421\u043a\u043e\u043b\u044c\u043a\u043e \u043f\u0440\u0438\u0431\u0430\u0432\u0438\u0442\u044c \u043a 3?"},{text:"___ + 4 = 7",answer:"3",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e + 4 = 7?"},{text:"6 + ___ = 9",answer:"3",hint:"6 + ? = 9"},{text:"2 + 3 + ___ = 8",answer:"3",hint:"2+3=5, 5+?=8"}]})});
    tasks.push({topic_id:3,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"2 + 3",right:"5"},{left:"4 + 4",right:"8"},{left:"1 + 6",right:"7"},{left:"5 + 5",right:"10"},{left:"3 + 3",right:"6"}]})});
    tasks.push({topic_id:3,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"3 + 4 = 7",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"5 + 3 = 9",answer:false,explanation:"\u041d\u0435\u0442! 5+3=8"},{text:"2 + 2 = 4",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"1 + 9 = 10",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"}]})});
    tasks.push({topic_id:4,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"7 - ___ = 4",answer:"3",hint:"7 \u043c\u0438\u043d\u0443\u0441 \u0441\u043a\u043e\u043b\u044c\u043a\u043e = 4?"},{text:"___ - 3 = 5",answer:"8",hint:"? - 3 = 5"},{text:"9 - ___ = 2",answer:"7",hint:"9 - ? = 2"},{text:"10 - ___ = 6",answer:"4",hint:"10 - ? = 6"}]})});
    tasks.push({topic_id:4,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"8 - 3",right:"5"},{left:"9 - 4",right:"5"},{left:"7 - 2",right:"5"},{left:"10 - 7",right:"3"},{left:"6 - 4",right:"2"}]})});
    tasks.push({topic_id:4,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"9 - 4 = 5",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"7 - 3 = 5",answer:false,explanation:"\u041d\u0435\u0442! 7-3=4"},{text:"10 - 10 = 0",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"6 - 1 = 5",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"}]})});
    tasks.push({topic_id:5,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u0437\u043d\u0430\u043a: >, < \u0438\u043b\u0438 =",questions:[{text:"5 ___ 3",answer:">",hint:"5 \u0431\u043e\u043b\u044c\u0448\u0435 \u0438\u043b\u0438 \u043c\u0435\u043d\u044c\u0448\u0435 3?"},{text:"2 ___ 8",answer:"<",hint:"2 \u0431\u043e\u043b\u044c\u0448\u0435 \u0438\u043b\u0438 \u043c\u0435\u043d\u044c\u0448\u0435 8?"},{text:"4 ___ 4",answer:"=",hint:"\u0427\u0438\u0441\u043b\u0430 \u043e\u0434\u0438\u043d\u0430\u043a\u043e\u0432\u044b\u0435"},{text:"9 ___ 7",answer:">",hint:"9 \u0431\u043e\u043b\u044c\u0448\u0435 \u0438\u043b\u0438 \u043c\u0435\u043d\u044c\u0448\u0435 7?"}]})});
    tasks.push({topic_id:5,task_type:'true_false',sort_order:2,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"7 > 3",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 7 \u0431\u043e\u043b\u044c\u0448\u0435 3"},{text:"5 < 2",answer:false,explanation:"\u041d\u0435\u0442! 5 > 2"},{text:"8 = 8",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"4 > 9",answer:false,explanation:"\u041d\u0435\u0442! 4 < 9"},{text:"10 > 1",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"}]})});
    tasks.push({topic_id:5,task_type:'ordering',sort_order:3,task_data:JSON.stringify({instruction:"\u0420\u0430\u0441\u0441\u0442\u0430\u0432\u044c \u0447\u0438\u0441\u043b\u0430 \u043e\u0442 \u0431\u043e\u043b\u044c\u0448\u0435\u0433\u043e \u043a \u043c\u0435\u043d\u044c\u0448\u0435\u043c\u0443",items:["3","9","1","7","5"],correct_order:["9","7","5","3","1"]})});
    var count = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      await pool.query('INSERT INTO interactive_tasks (topic_id, task_type, task_data, sort_order) VALUES ($1,$2,$3,$4)', [t.topic_id, t.task_type, t.task_data, t.sort_order]);
      count++;
    }
    res.json({ success: true, inserted: count });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/admin/load-tasks2', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).send('forbidden');
  try {
    var tasks = [];
    tasks.push({topic_id:6,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"10, 11, ___, 13, 14",answer:"12",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e \u043c\u0435\u0436\u0434\u0443 11 \u0438 13?"},{text:"___, 16, 17, 18",answer:"15",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e \u043f\u0435\u0440\u0435\u0434 16?"},{text:"17, 18, ___, 20",answer:"19",hint:"\u041a\u0430\u043a\u043e\u0435 \u0447\u0438\u0441\u043b\u043e \u043c\u0435\u0436\u0434\u0443 18 \u0438 20?"},{text:"\u0427\u0438\u0441\u043b\u043e 15 = ___ \u0434\u0435\u0441\u044f\u0442\u043e\u043a \u0438 ___ \u0435\u0434\u0438\u043d\u0438\u0446",answer:"1, 5",hint:"\u0420\u0430\u0437\u043b\u043e\u0436\u0438 15 \u043d\u0430 \u0434\u0435\u0441\u044f\u0442\u043a\u0438 \u0438 \u0435\u0434\u0438\u043d\u0438\u0446\u044b"}]})});
    tasks.push({topic_id:6,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u0447\u0438\u0441\u043b\u043e \u0441 \u0435\u0433\u043e \u0441\u043e\u0441\u0442\u0430\u0432\u043e\u043c",pairs:[{left:"13",right:"10 + 3"},{left:"17",right:"10 + 7"},{left:"11",right:"10 + 1"},{left:"20",right:"10 + 10"},{left:"15",right:"10 + 5"}]})});
    tasks.push({topic_id:6,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"16 \u2014 \u044d\u0442\u043e 1 \u0434\u0435\u0441\u044f\u0442\u043e\u043a \u0438 6 \u0435\u0434\u0438\u043d\u0438\u0446",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 16 = 10 + 6"},{text:"\u041f\u043e\u0441\u043b\u0435 19 \u0438\u0434\u0451\u0442 21",answer:false,explanation:"\u041d\u0435\u0442! \u041f\u043e\u0441\u043b\u0435 19 \u0438\u0434\u0451\u0442 20"},{text:"20 \u0431\u043e\u043b\u044c\u0448\u0435 12",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"14 \u043c\u0435\u043d\u044c\u0448\u0435 11",answer:false,explanation:"\u041d\u0435\u0442! 14 > 11"}]})});
    tasks.push({topic_id:6,task_type:'ordering',sort_order:4,task_data:JSON.stringify({instruction:"\u0420\u0430\u0441\u0441\u0442\u0430\u0432\u044c \u0447\u0438\u0441\u043b\u0430 \u043e\u0442 \u043c\u0435\u043d\u044c\u0448\u0435\u0433\u043e \u043a \u0431\u043e\u043b\u044c\u0448\u0435\u043c\u0443",items:["18","11","15","20","13"],correct_order:["11","13","15","18","20"]})});
    tasks.push({topic_id:7,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"9 + ___ = 13",answer:"4",hint:"9 + ? = 13"},{text:"8 + ___ = 15",answer:"7",hint:"8 + ? = 15"},{text:"___ + 6 = 14",answer:"8",hint:"? + 6 = 14"},{text:"7 + ___ = 16",answer:"9",hint:"7 + ? = 16"}]})});
    tasks.push({topic_id:7,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"8 + 5",right:"13"},{left:"9 + 7",right:"16"},{left:"6 + 6",right:"12"},{left:"7 + 8",right:"15"},{left:"9 + 9",right:"18"}]})});
    tasks.push({topic_id:7,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"8 + 6 = 14",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 8+2=10, 10+4=14"},{text:"7 + 5 = 13",answer:false,explanation:"\u041d\u0435\u0442! 7+5=12"},{text:"9 + 4 = 13",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"6 + 8 = 15",answer:false,explanation:"\u041d\u0435\u0442! 6+8=14"}]})});
    tasks.push({topic_id:8,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"15 - ___ = 8",answer:"7",hint:"15 - ? = 8"},{text:"13 - ___ = 6",answer:"7",hint:"13 - ? = 6"},{text:"___ - 5 = 9",answer:"14",hint:"? - 5 = 9"},{text:"17 - ___ = 9",answer:"8",hint:"17 - ? = 9"}]})});
    tasks.push({topic_id:8,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"14 - 6",right:"8"},{left:"16 - 9",right:"7"},{left:"13 - 5",right:"8"},{left:"18 - 9",right:"9"},{left:"15 - 7",right:"8"}]})});
    tasks.push({topic_id:8,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"14 - 8 = 6",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"16 - 7 = 8",answer:false,explanation:"\u041d\u0435\u0442! 16-7=9"},{text:"12 - 5 = 7",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"11 - 4 = 8",answer:false,explanation:"\u041d\u0435\u0442! 11-4=7"}]})});
    tasks.push({topic_id:9,task_type:'match_pairs',sort_order:1,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u0437\u0430\u0434\u0430\u0447\u0443 \u0441 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435\u043c",pairs:[{left:"\u0411\u044b\u043b\u043e 5, \u0434\u0430\u043b\u0438 \u0435\u0449\u0451 3",right:"\u0421\u043b\u043e\u0436\u0435\u043d\u0438\u0435"},{left:"\u0411\u044b\u043b\u043e 8, \u0441\u044a\u0435\u043b\u0438 2",right:"\u0412\u044b\u0447\u0438\u0442\u0430\u043d\u0438\u0435"},{left:"\u041f\u0440\u0438\u043b\u0435\u0442\u0435\u043b\u0438 \u0435\u0449\u0451 4 \u043f\u0442\u0438\u0446\u044b",right:"\u0421\u043b\u043e\u0436\u0435\u043d\u0438\u0435"},{left:"\u0423\u0435\u0445\u0430\u043b\u0438 3 \u043c\u0430\u0448\u0438\u043d\u044b",right:"\u0412\u044b\u0447\u0438\u0442\u0430\u043d\u0438\u0435"},{left:"\u041a\u0443\u043f\u0438\u043b\u0438 \u0435\u0449\u0451 6 \u043a\u043e\u043d\u0444\u0435\u0442",right:"\u0421\u043b\u043e\u0436\u0435\u043d\u0438\u0435"}]})});
    tasks.push({topic_id:9,task_type:'true_false',sort_order:2,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u0423 \u041c\u0430\u0448\u0438 5 \u044f\u0431\u043b\u043e\u043a, \u0443 \u041a\u0430\u0442\u0438 3. \u0412\u0441\u0435\u0433\u043e 8 \u044f\u0431\u043b\u043e\u043a",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 5+3=8"},{text:"\u0411\u044b\u043b\u043e 9 \u043a\u043e\u043d\u0444\u0435\u0442, \u0441\u044a\u0435\u043b\u0438 4. \u041e\u0441\u0442\u0430\u043b\u043e\u0441\u044c 6",answer:false,explanation:"\u041d\u0435\u0442! 9-4=5"},{text:"\u041d\u0430 \u0432\u0435\u0442\u043a\u0435 7 \u043f\u0442\u0438\u0446, \u043f\u0440\u0438\u043b\u0435\u0442\u0435\u043b\u0438 2. \u0421\u0442\u0430\u043b\u043e 9",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 7+2=9"},{text:"\u0412 \u043a\u043e\u0440\u0437\u0438\u043d\u0435 10 \u0433\u0440\u0438\u0431\u043e\u0432, \u0432\u0437\u044f\u043b\u0438 3. \u041e\u0441\u0442\u0430\u043b\u043e\u0441\u044c 8",answer:false,explanation:"\u041d\u0435\u0442! 10-3=7"}]})});
    tasks.push({topic_id:9,task_type:'fill_blank',sort_order:3,task_data:JSON.stringify({instruction:"\u0420\u0435\u0448\u0438 \u0437\u0430\u0434\u0430\u0447\u0443",questions:[{text:"\u0423 \u041f\u0435\u0442\u0438 6 \u043c\u0430\u0448\u0438\u043d\u043e\u043a, \u0435\u043c\u0443 \u043f\u043e\u0434\u0430\u0440\u0438\u043b\u0438 \u0435\u0449\u0451 3. \u0421\u043a\u043e\u043b\u044c\u043a\u043e \u0441\u0442\u0430\u043b\u043e? ___",answer:"9",hint:"6 + 3 = ?"},{text:"\u041d\u0430 \u0442\u0430\u0440\u0435\u043b\u043a\u0435 8 \u043f\u0438\u0440\u043e\u0436\u043a\u043e\u0432, \u0441\u044a\u0435\u043b\u0438 5. \u0421\u043a\u043e\u043b\u044c\u043a\u043e \u043e\u0441\u0442\u0430\u043b\u043e\u0441\u044c? ___",answer:"3",hint:"8 - 5 = ?"},{text:"\u0412 \u043a\u043b\u0430\u0441\u0441\u0435 4 \u043c\u0430\u043b\u044c\u0447\u0438\u043a\u0430 \u0438 5 \u0434\u0435\u0432\u043e\u0447\u0435\u043a. \u0421\u043a\u043e\u043b\u044c\u043a\u043e \u0432\u0441\u0435\u0433\u043e? ___",answer:"9",hint:"4 + 5 = ?"}]})});
    tasks.push({topic_id:10,task_type:'match_pairs',sort_order:1,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u0444\u0438\u0433\u0443\u0440\u0443 \u0441 \u043e\u043f\u0438\u0441\u0430\u043d\u0438\u0435\u043c",pairs:[{left:"\u0422\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a",right:"3 \u0441\u0442\u043e\u0440\u043e\u043d\u044b \u0438 3 \u0443\u0433\u043b\u0430"},{left:"\u041a\u0432\u0430\u0434\u0440\u0430\u0442",right:"4 \u0440\u0430\u0432\u043d\u044b\u0435 \u0441\u0442\u043e\u0440\u043e\u043d\u044b"},{left:"\u041a\u0440\u0443\u0433",right:"\u041d\u0435\u0442 \u0443\u0433\u043b\u043e\u0432"},{left:"\u041e\u0442\u0440\u0435\u0437\u043e\u043a",right:"\u0427\u0430\u0441\u0442\u044c \u043f\u0440\u044f\u043c\u043e\u0439 \u0441 \u0434\u0432\u0443\u043c\u044f \u043a\u043e\u043d\u0446\u0430\u043c\u0438"},{left:"\u041f\u0440\u044f\u043c\u043e\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a",right:"4 \u0443\u0433\u043b\u0430, \u043f\u0440\u043e\u0442\u0438\u0432\u043e\u043f\u043e\u043b\u043e\u0436\u043d\u044b\u0435 \u0441\u0442\u043e\u0440\u043e\u043d\u044b \u0440\u0430\u0432\u043d\u044b"}]})});
    tasks.push({topic_id:10,task_type:'true_false',sort_order:2,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u0423 \u043a\u0432\u0430\u0434\u0440\u0430\u0442\u0430 \u0432\u0441\u0435 \u0441\u0442\u043e\u0440\u043e\u043d\u044b \u0440\u0430\u0432\u043d\u044b",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"\u0423 \u0442\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a\u0430 4 \u0443\u0433\u043b\u0430",answer:false,explanation:"\u041d\u0435\u0442! \u0423 \u0442\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a\u0430 3 \u0443\u0433\u043b\u0430"},{text:"1 \u0434\u043c = 10 \u0441\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"\u041a\u0440\u0443\u0433 \u0438\u043c\u0435\u0435\u0442 \u0443\u0433\u043b\u044b",answer:false,explanation:"\u041d\u0435\u0442! \u041a\u0440\u0443\u0433 \u2014 \u0444\u0438\u0433\u0443\u0440\u0430 \u0431\u0435\u0437 \u0443\u0433\u043b\u043e\u0432"}]})});
    tasks.push({topic_id:10,task_type:'fill_blank',sort_order:3,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435",questions:[{text:"1 \u0434\u043c = ___ \u0441\u043c",answer:"10",hint:"\u0421\u043a\u043e\u043b\u044c\u043a\u043e \u0441\u043c \u0432 1 \u0434\u043c?"},{text:"\u0423 \u0442\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a\u0430 ___ \u0441\u0442\u043e\u0440\u043e\u043d\u044b",answer:"3",hint:"\u0422\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a = \u0442\u0440\u0438..."},{text:"\u0423 \u043a\u0432\u0430\u0434\u0440\u0430\u0442\u0430 ___ \u0441\u0442\u043e\u0440\u043e\u043d\u044b",answer:"4",hint:"\u041a\u0432\u0430\u0434\u0440\u0430\u0442 = \u0447\u0435\u0442\u044b\u0440\u0435..."},{text:"\u041e\u0442\u0440\u0435\u0437\u043e\u043a 5 \u0441\u043c + 3 \u0441\u043c = ___ \u0441\u043c",answer:"8",hint:"5 + 3 = ?"}]})});
    var count = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      await pool.query('INSERT INTO interactive_tasks (topic_id, task_type, task_data, sort_order) VALUES ($1,$2,$3,$4)', [t.topic_id, t.task_type, t.task_data, t.sort_order]);
      count++;
    }
    res.json({ success: true, inserted: count, message: 'Topics 6-10 loaded!' });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.get('/api/admin/load-tasks3', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).send('forbidden');
  try {
    var tasks = [];
    tasks.push({topic_id:11,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"34 + ___ = 59",answer:"25",hint:"\u0414\u0435\u0441\u044f\u0442\u043a\u0438: 3+?=5, \u0415\u0434\u0438\u043d\u0438\u0446\u044b: 4+?=9"},{text:"___ + 42 = 75",answer:"33",hint:"?+42=75"},{text:"51 + ___ = 84",answer:"33",hint:"51+?=84"},{text:"23 + 45 = ___",answer:"68",hint:"\u0421\u043b\u043e\u0436\u0438 \u0434\u0435\u0441\u044f\u0442\u043a\u0438 \u0438 \u0435\u0434\u0438\u043d\u0438\u0446\u044b"}]})});
    tasks.push({topic_id:11,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"32 + 45",right:"77"},{left:"21 + 36",right:"57"},{left:"14 + 53",right:"67"},{left:"40 + 28",right:"68"},{left:"55 + 33",right:"88"}]})});
    tasks.push({topic_id:11,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"43 + 25 = 68",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 4+2=6, 3+5=8"},{text:"31 + 47 = 79",answer:false,explanation:"\u041d\u0435\u0442! 31+47=78"},{text:"52 + 36 = 88",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"24 + 15 = 49",answer:false,explanation:"\u041d\u0435\u0442! 24+15=39"}]})});
    tasks.push({topic_id:12,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"37 + 28 = ___",answer:"65",hint:"7+8=15, \u043f\u0438\u0448\u0435\u043c 5, \u0437\u0430\u043f\u043e\u043c\u0438\u043d\u0430\u0435\u043c 1"},{text:"49 + ___ = 76",answer:"27",hint:"49+?=76"},{text:"___ + 35 = 81",answer:"46",hint:"?+35=81"},{text:"58 + 34 = ___",answer:"92",hint:"8+4=12, \u043f\u0438\u0448\u0435\u043c 2, \u0437\u0430\u043f\u043e\u043c\u0438\u043d\u0430\u0435\u043c 1"}]})});
    tasks.push({topic_id:12,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"47 + 36",right:"83"},{left:"29 + 45",right:"74"},{left:"56 + 27",right:"83"},{left:"38 + 44",right:"82"},{left:"65 + 18",right:"83"}]})});
    tasks.push({topic_id:12,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"37 + 45 = 82",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 7+5=12, 3+4+1=8"},{text:"29 + 53 = 72",answer:false,explanation:"\u041d\u0435\u0442! 29+53=82"},{text:"48 + 36 = 84",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"57 + 28 = 75",answer:false,explanation:"\u041d\u0435\u0442! 57+28=85"}]})});
    tasks.push({topic_id:13,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"68 - 23 = ___",answer:"45",hint:"6-2=4, 8-3=5"},{text:"82 - ___ = 47",answer:"35",hint:"82-?=47"},{text:"___ - 28 = 36",answer:"64",hint:"?-28=36"},{text:"75 - 39 = ___",answer:"36",hint:"\u0417\u0430\u043d\u0438\u043c\u0430\u0435\u043c \u0434\u0435\u0441\u044f\u0442\u043e\u043a"}]})});
    tasks.push({topic_id:13,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"86 - 42",right:"44"},{left:"73 - 38",right:"35"},{left:"91 - 56",right:"35"},{left:"65 - 27",right:"38"},{left:"54 - 19",right:"35"}]})});
    tasks.push({topic_id:13,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"93 - 47 = 46",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"72 - 35 = 47",answer:false,explanation:"\u041d\u0435\u0442! 72-35=37"},{text:"81 - 54 = 27",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"60 - 28 = 42",answer:false,explanation:"\u041d\u0435\u0442! 60-28=32"}]})});
    tasks.push({topic_id:14,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"4 \u00d7 ___ = 20",answer:"5",hint:"4 \u00d7 ? = 20"},{text:"___ \u00d7 3 = 15",answer:"5",hint:"? \u00d7 3 = 15"},{text:"5 \u00d7 5 = ___",answer:"25",hint:"5 \u043f\u044f\u0442\u044c \u0440\u0430\u0437"},{text:"3 \u00d7 ___ = 12",answer:"4",hint:"3 \u00d7 ? = 12"}]})});
    tasks.push({topic_id:14,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"2 \u00d7 7",right:"14"},{left:"3 \u00d7 6",right:"18"},{left:"4 \u00d7 8",right:"32"},{left:"5 \u00d7 9",right:"45"},{left:"3 \u00d7 9",right:"27"}]})});
    tasks.push({topic_id:14,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"3 \u00d7 7 = 21",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"4 \u00d7 6 = 28",answer:false,explanation:"\u041d\u0435\u0442! 4\u00d76=24"},{text:"5 \u00d7 8 = 40",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"2 \u00d7 9 = 16",answer:false,explanation:"\u041d\u0435\u0442! 2\u00d79=18"}]})});
    tasks.push({topic_id:15,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"6 \u00d7 7 = ___",answer:"42",hint:"\u0428\u0435\u0441\u0442\u044c\u044e \u0441\u0435\u043c\u044c"},{text:"7 \u00d7 ___ = 56",answer:"8",hint:"7 \u00d7 ? = 56"},{text:"___ \u00d7 9 = 72",answer:"8",hint:"? \u00d7 9 = 72"},{text:"9 \u00d7 9 = ___",answer:"81",hint:"\u0414\u0435\u0432\u044f\u0442\u044c\u044e \u0434\u0435\u0432\u044f\u0442\u044c"}]})});
    tasks.push({topic_id:15,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"6 \u00d7 8",right:"48"},{left:"7 \u00d7 7",right:"49"},{left:"8 \u00d7 9",right:"72"},{left:"6 \u00d7 9",right:"54"},{left:"7 \u00d7 9",right:"63"}]})});
    tasks.push({topic_id:15,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"7 \u00d7 8 = 56",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"6 \u00d7 6 = 38",answer:false,explanation:"\u041d\u0435\u0442! 6\u00d76=36"},{text:"8 \u00d7 8 = 64",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"9 \u00d7 7 = 62",answer:false,explanation:"\u041d\u0435\u0442! 9\u00d77=63"}]})});
    tasks.push({topic_id:16,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"24 \u00f7 ___ = 6",answer:"4",hint:"24 \u00f7 ? = 6"},{text:"___ \u00f7 7 = 5",answer:"35",hint:"? \u00f7 7 = 5"},{text:"45 \u00f7 9 = ___",answer:"5",hint:"45 \u0440\u0430\u0437\u0434\u0435\u043b\u0438\u0442\u044c \u043d\u0430 9"},{text:"56 \u00f7 ___ = 7",answer:"8",hint:"56 \u00f7 ? = 7"}]})});
    tasks.push({topic_id:16,task_type:'match_pairs',sort_order:2,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u043f\u0440\u0438\u043c\u0435\u0440 \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c",pairs:[{left:"36 \u00f7 6",right:"6"},{left:"48 \u00f7 8",right:"6"},{left:"63 \u00f7 9",right:"7"},{left:"42 \u00f7 7",right:"6"},{left:"72 \u00f7 8",right:"9"}]})});
    tasks.push({topic_id:16,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"54 \u00f7 9 = 6",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"32 \u00f7 4 = 9",answer:false,explanation:"\u041d\u0435\u0442! 32\u00f74=8"},{text:"81 \u00f7 9 = 9",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"49 \u00f7 7 = 8",answer:false,explanation:"\u041d\u0435\u0442! 49\u00f77=7"}]})});
    tasks.push({topic_id:17,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0412\u044b\u0447\u0438\u0441\u043b\u0438",questions:[{text:"2 + 3 \u00d7 4 = ___",answer:"14",hint:"\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0443\u043c\u043d\u043e\u0436\u0435\u043d\u0438\u0435: 3\u00d74=12, \u043f\u043e\u0442\u043e\u043c 2+12"},{text:"(2 + 3) \u00d7 4 = ___",answer:"20",hint:"\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0441\u043a\u043e\u0431\u043a\u0438: 2+3=5, \u043f\u043e\u0442\u043e\u043c 5\u00d74"},{text:"18 \u00f7 3 + 4 = ___",answer:"10",hint:"\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0434\u0435\u043b\u0435\u043d\u0438\u0435: 18\u00f73=6, \u043f\u043e\u0442\u043e\u043c 6+4"},{text:"20 - (8 + 7) = ___",answer:"5",hint:"\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0441\u043a\u043e\u0431\u043a\u0438: 8+7=15, \u043f\u043e\u0442\u043e\u043c 20-15"}]})});
    tasks.push({topic_id:17,task_type:'true_false',sort_order:2,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u0412 \u043f\u0440\u0438\u043c\u0435\u0440\u0435 2 + 3 \u00d7 4 \u0441\u043d\u0430\u0447\u0430\u043b\u0430 \u0443\u043c\u043d\u043e\u0436\u0430\u0435\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! \u0423\u043c\u043d\u043e\u0436\u0435\u043d\u0438\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u044f\u0435\u0442\u0441\u044f \u043f\u0435\u0440\u0432\u044b\u043c"},{text:"\u0421\u043a\u043e\u0431\u043a\u0438 \u0432\u044b\u043f\u043e\u043b\u043d\u044f\u044e\u0442\u0441\u044f \u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u043c\u0438",answer:false,explanation:"\u041d\u0435\u0442! \u0421\u043a\u043e\u0431\u043a\u0438 \u0432\u0441\u0435\u0433\u0434\u0430 \u043f\u0435\u0440\u0432\u044b\u0435"},{text:"(5 + 3) \u00d7 2 = 16",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 8\u00d72=16"},{text:"10 - 2 \u00d7 3 = 24",answer:false,explanation:"\u041d\u0435\u0442! 2\u00d73=6, 10-6=4"}]})});
    tasks.push({topic_id:18,task_type:'match_pairs',sort_order:1,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u0432\u0435\u043b\u0438\u0447\u0438\u043d\u0443 \u0441 \u043f\u0435\u0440\u0435\u0432\u043e\u0434\u043e\u043c",pairs:[{left:"1 \u043c",right:"100 \u0441\u043c"},{left:"1 \u0434\u043c",right:"10 \u0441\u043c"},{left:"1 \u0447\u0430\u0441",right:"60 \u043c\u0438\u043d\u0443\u0442"},{left:"1 \u043a\u0433",right:"1000 \u0433"},{left:"1 \u043c\u0438\u043d\u0443\u0442\u0430",right:"60 \u0441\u0435\u043a\u0443\u043d\u0434"}]})});
    tasks.push({topic_id:18,task_type:'fill_blank',sort_order:2,task_data:JSON.stringify({instruction:"\u0412\u0441\u0442\u0430\u0432\u044c \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u043d\u043e\u0435 \u0447\u0438\u0441\u043b\u043e",questions:[{text:"3 \u043c = ___ \u0441\u043c",answer:"300",hint:"1 \u043c = 100 \u0441\u043c"},{text:"200 \u0441\u043c = ___ \u043c",answer:"2",hint:"200 \u00f7 100"},{text:"2 \u0447\u0430\u0441\u0430 = ___ \u043c\u0438\u043d\u0443\u0442",answer:"120",hint:"2 \u00d7 60"},{text:"5000 \u0433 = ___ \u043a\u0433",answer:"5",hint:"5000 \u00f7 1000"}]})});
    tasks.push({topic_id:18,task_type:'true_false',sort_order:3,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"1 \u043c = 10 \u0434\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"1 \u043a\u0433 = 100 \u0433",answer:false,explanation:"\u041d\u0435\u0442! 1 \u043a\u0433 = 1000 \u0433"},{text:"2 \u0447\u0430\u0441\u0430 = 120 \u043c\u0438\u043d\u0443\u0442",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"},{text:"1 \u043c = 1000 \u043c\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"}]})});
    tasks.push({topic_id:19,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u041d\u0430\u0439\u0434\u0438 \u043f\u0435\u0440\u0438\u043c\u0435\u0442\u0440",questions:[{text:"\u041f\u0440\u044f\u043c\u043e\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a 5 \u0441\u043c \u0438 3 \u0441\u043c. P = ___ \u0441\u043c",answer:"16",hint:"P = (5+3) \u00d7 2"},{text:"\u041a\u0432\u0430\u0434\u0440\u0430\u0442 \u0441\u043e \u0441\u0442\u043e\u0440\u043e\u043d\u043e\u0439 6 \u0441\u043c. P = ___ \u0441\u043c",answer:"24",hint:"P = 6 \u00d7 4"},{text:"\u0422\u0440\u0435\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a 4, 5, 6 \u0441\u043c. P = ___ \u0441\u043c",answer:"15",hint:"P = 4+5+6"},{text:"\u041f\u0440\u044f\u043c\u043e\u0443\u0433\u043e\u043b\u044c\u043d\u0438\u043a 8 \u0441\u043c \u0438 2 \u0441\u043c. P = ___ \u0441\u043c",answer:"20",hint:"P = (8+2) \u00d7 2"}]})});
    tasks.push({topic_id:19,task_type:'true_false',sort_order:2,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u041f\u0435\u0440\u0438\u043c\u0435\u0442\u0440 \u043a\u0432\u0430\u0434\u0440\u0430\u0442\u0430 \u0441\u043e \u0441\u0442\u043e\u0440\u043e\u043d\u043e\u0439 5 \u0441\u043c = 20 \u0441\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! 5\u00d74=20"},{text:"\u041f\u0435\u0440\u0438\u043c\u0435\u0442\u0440 \u2014 \u044d\u0442\u043e \u043f\u043b\u043e\u0449\u0430\u0434\u044c \u0444\u0438\u0433\u0443\u0440\u044b",answer:false,explanation:"\u041d\u0435\u0442! \u041f\u0435\u0440\u0438\u043c\u0435\u0442\u0440 \u2014 \u0441\u0443\u043c\u043c\u0430 \u0434\u043b\u0438\u043d \u0441\u0442\u043e\u0440\u043e\u043d"},{text:"\u041f\u0435\u0440\u0438\u043c\u0435\u0442\u0440 \u0438\u0437\u043c\u0435\u0440\u044f\u0435\u0442\u0441\u044f \u0432 \u0441\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e!"}]})});
    tasks.push({topic_id:20,task_type:'fill_blank',sort_order:1,task_data:JSON.stringify({instruction:"\u0420\u0435\u0448\u0438 \u0437\u0430\u0434\u0430\u0447\u0443",questions:[{text:"\u0423 \u041c\u0430\u0448\u0438 5 \u043a\u0443\u043a\u043e\u043b, \u0443 \u041a\u0430\u0442\u0438 \u043d\u0430 3 \u0431\u043e\u043b\u044c\u0448\u0435. \u0421\u043a\u043e\u043b\u044c\u043a\u043e \u0443 \u043e\u0431\u0435\u0438\u0445? ___",answer:"13",hint:"5+8=13"},{text:"\u0412 \u043c\u0430\u0433\u0430\u0437\u0438\u043d\u0435 24 \u044f\u0431\u043b\u043e\u043a\u0430, \u043a\u0443\u043f\u0438\u043b\u0438 8, \u043f\u043e\u0442\u043e\u043c \u0435\u0449\u0451 5. \u0421\u043a\u043e\u043b\u044c\u043a\u043e \u043e\u0441\u0442\u0430\u043b\u043e\u0441\u044c? ___",answer:"11",hint:"24-8-5=11"},{text:"\u0412 \u043a\u043b\u0430\u0441\u0441\u0435 12 \u043c\u0430\u043b\u044c\u0447\u0438\u043a\u043e\u0432 \u0438 15 \u0434\u0435\u0432\u043e\u0447\u0435\u043a. \u0423\u0448\u043b\u0438 7. \u0421\u043a\u043e\u043b\u044c\u043a\u043e \u043e\u0441\u0442\u0430\u043b\u043e\u0441\u044c? ___",answer:"20",hint:"12+15=27, 27-7=20"}]})});
    tasks.push({topic_id:20,task_type:'true_false',sort_order:2,task_data:JSON.stringify({instruction:"\u041f\u0440\u0430\u0432\u0434\u0430 \u0438\u043b\u0438 \u043d\u0435\u0442?",statements:[{text:"\u0417\u0430\u0434\u0430\u0447\u0430 \u0432 2 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0440\u0435\u0448\u0430\u0435\u0442\u0441\u044f \u043f\u043e \u0448\u0430\u0433\u0430\u043c",answer:true,explanation:"\u0412\u0435\u0440\u043d\u043e! \u0421\u043d\u0430\u0447\u0430\u043b\u0430 1-\u0439 \u0448\u0430\u0433, \u043f\u043e\u0442\u043e\u043c 2-\u0439"},{text:"\u0412 \u0437\u0430\u0434\u0430\u0447\u0435 \u043c\u043e\u0436\u043d\u043e \u043d\u0435 \u043e\u0442\u0432\u0435\u0447\u0430\u0442\u044c \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441",answer:false,explanation:"\u041d\u0435\u0442! \u041e\u0442\u0432\u0435\u0442 \u0434\u043e\u043b\u0436\u0435\u043d \u0431\u044b\u0442\u044c \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441 \u0437\u0430\u0434\u0430\u0447\u0438"}]})});
    tasks.push({topic_id:20,task_type:'match_pairs',sort_order:3,task_data:JSON.stringify({instruction:"\u0421\u043e\u0435\u0434\u0438\u043d\u0438 \u0441\u043b\u043e\u0432\u043e \u0441 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435\u043c",pairs:[{left:"\u0412\u0441\u0435\u0433\u043e",right:"\u0421\u043b\u043e\u0436\u0435\u043d\u0438\u0435"},{left:"\u041e\u0441\u0442\u0430\u043b\u043e\u0441\u044c",right:"\u0412\u044b\u0447\u0438\u0442\u0430\u043d\u0438\u0435"},{left:"\u0421\u0442\u0430\u043b\u043e \u0431\u043e\u043b\u044c\u0448\u0435",right:"\u0421\u043b\u043e\u0436\u0435\u043d\u0438\u0435"},{left:"\u0423\u0435\u0445\u0430\u043b\u0438",right:"\u0412\u044b\u0447\u0438\u0442\u0430\u043d\u0438\u0435"},{left:"\u041f\u0440\u0438\u0431\u0430\u0432\u0438\u043b\u0438",right:"\u0421\u043b\u043e\u0436\u0435\u043d\u0438\u0435"}]})});
    var count = 0;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      await pool.query('INSERT INTO interactive_tasks (topic_id, task_type, task_data, sort_order) VALUES ($1,$2,$3,$4)', [t.topic_id, t.task_type, t.task_data, t.sort_order]);
      count++;
    }
    res.json({ success: true, inserted: count, message: 'Topics 11-20 loaded!' });
  } catch(e) { res.status(500).json({error: e.message}); }
});
// Load interactive tasks for topics 21-30 (Grade 3)
app.get('/api/admin/load-tasks4', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).json({error: 'Forbidden'});
  
  const tasks = [
    // Topic 21: Таблица умножения (повторение)
    {topic_id:21, task_type:'match_pairs', sort_order:1, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'7 × 8',right:'56'},{left:'6 × 9',right:'54'},{left:'8 × 4',right:'32'},{left:'9 × 7',right:'63'},{left:'5 × 6',right:'30'}]
    }},
    {topic_id:21, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'6 × 7 = 42',correct:true,explanation:'6 × 7 = 42 — верно'},
        {text:'8 × 8 = 62',correct:false,explanation:'8 × 8 = 64, а не 62'},
        {text:'9 × 5 = 45',correct:true,explanation:'9 × 5 = 45 — верно'},
        {text:'7 × 7 = 47',correct:false,explanation:'7 × 7 = 49, а не 47'}
      ]
    }},
    {topic_id:21, task_type:'fill_blank', sort_order:3, task_data:{
      instruction:'Впиши пропущенное число',
      questions:[
        {text:'8 × ___ = 72',answer:'9',hint:'Какое число при умножении на 8 даёт 72?'},
        {text:'___ × 6 = 48',answer:'8',hint:'Какое число при умножении на 6 даёт 48?'},
        {text:'7 × ___ = 63',answer:'9',hint:'Какое число при умножении на 7 даёт 63?'}
      ]
    }},

    // Topic 22: Внетабличное умножение и деление
    {topic_id:22, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли и впиши ответ',
      questions:[
        {text:'14 × 6 = ___',answer:'84',hint:'14 × 6: 10×6=60, 4×6=24, 60+24=?'},
        {text:'96 ÷ 4 = ___',answer:'24',hint:'96 ÷ 4: 80÷4=20, 16÷4=4, 20+4=?'},
        {text:'23 × 3 = ___',answer:'69',hint:'23 × 3: 20×3=60, 3×3=9, 60+9=?'}
      ]
    }},
    {topic_id:22, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'15 × 4 = 60',correct:true,explanation:'15 × 4 = 60 — верно'},
        {text:'72 ÷ 6 = 11',correct:false,explanation:'72 ÷ 6 = 12, а не 11'},
        {text:'25 × 3 = 75',correct:true,explanation:'25 × 3 = 75 — верно'},
        {text:'84 ÷ 7 = 13',correct:false,explanation:'84 ÷ 7 = 12, а не 13'}
      ]
    }},
    {topic_id:22, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'13 × 5',right:'65'},{left:'96 ÷ 8',right:'12'},{left:'17 × 4',right:'68'},{left:'78 ÷ 6',right:'13'},{left:'24 × 3',right:'72'}]
    }},

    // Topic 23: Числа до 1000
    {topic_id:23, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Впиши пропущенное',
      questions:[
        {text:'В числе 547 ___ сотен, ___ десятков, ___ единиц',answer:'5, 4, 7',hint:'Разложи число по разрядам'},
        {text:'300 + 40 + 8 = ___',answer:'348',hint:'Сложи сотни, десятки и единицы'},
        {text:'Число, в котором 6 сотен и 2 единицы: ___',answer:'602',hint:'6 сотен = 600, 0 десятков, 2 единицы'}
      ]
    }},
    {topic_id:23, task_type:'ordering', sort_order:2, task_data:{
      instruction:'Расставь числа от меньшего к большему',
      items:['305','350','503','530','253'],
      correct_order:['253','305','350','503','530']
    }},
    {topic_id:23, task_type:'true_false', sort_order:3, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'В числе 408 ноль десятков',correct:true,explanation:'408 = 4 сотни, 0 десятков, 8 единиц'},
        {text:'Число 670 больше числа 706',correct:false,explanation:'670 < 706'},
        {text:'999 — наибольшее трёхзначное число',correct:true,explanation:'Верно, следующее — 1000'},
        {text:'В числе 230 — 23 десятка',correct:true,explanation:'230 ÷ 10 = 23 — верно'}
      ]
    }},

    // Topic 24: Сложение и вычитание до 1000
    {topic_id:24, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли столбиком и впиши ответ',
      questions:[
        {text:'345 + 278 = ___',answer:'623',hint:'5+8=13, пишем 3, переносим 1; 4+7+1=12, пишем 2, переносим 1; 3+2+1=6'},
        {text:'602 — 357 = ___',answer:'245',hint:'Занимаем: 12-7=5, 9-5=4, 5-3=2'},
        {text:'450 + 367 = ___',answer:'817',hint:'0+7=7, 5+6=11, 4+3+1=8'}
      ]
    }},
    {topic_id:24, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Проверь вычисления',
      statements:[
        {text:'234 + 567 = 801',correct:true,explanation:'4+7=11, 3+6+1=10, 2+5+1=8 → 801'},
        {text:'500 — 248 = 262',correct:false,explanation:'500 — 248 = 252, а не 262'},
        {text:'189 + 311 = 500',correct:true,explanation:'9+1=10, 8+1+1=10, 1+3+1=5 → 500'},
        {text:'703 — 456 = 257',correct:false,explanation:'703 — 456 = 247, а не 257'}
      ]
    }},
    {topic_id:24, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'256 + 144',right:'400'},{left:'800 — 350',right:'450'},{left:'475 + 325',right:'800'},{left:'631 — 287',right:'344'},{left:'199 + 201',right:'400'}]
    }},

    // Topic 25: Умножение и деление на однозначное число
    {topic_id:25, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли и впиши ответ',
      questions:[
        {text:'124 × 3 = ___',answer:'372',hint:'4×3=12, пишем 2, переносим 1; 2×3+1=7; 1×3=3'},
        {text:'936 ÷ 4 = ___',answer:'234',hint:'9÷4=2(ост.1), 13÷4=3(ост.1), 16÷4=4'},
        {text:'207 × 5 = ___',answer:'1035',hint:'7×5=35, 0×5+3=3, 2×5=10'}
      ]
    }},
    {topic_id:25, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'315 × 2 = 630',correct:true,explanation:'315 × 2 = 630 — верно'},
        {text:'848 ÷ 4 = 202',correct:false,explanation:'848 ÷ 4 = 212, а не 202'},
        {text:'150 × 6 = 900',correct:true,explanation:'150 × 6 = 900 — верно'},
        {text:'729 ÷ 9 = 81',correct:true,explanation:'729 ÷ 9 = 81 — верно'}
      ]
    }},
    {topic_id:25, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'256 × 3',right:'768'},{left:'420 ÷ 6',right:'70'},{left:'185 × 4',right:'740'},{left:'672 ÷ 8',right:'84'},{left:'301 × 7',right:'2107'}]
    }},

    // Topic 26: Площадь и периметр
    {topic_id:26, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли и впиши ответ',
      questions:[
        {text:'Периметр прямоугольника со сторонами 12 см и 8 см: P = ___',answer:'40 см',hint:'P = (12 + 8) × 2 = 20 × 2'},
        {text:'Площадь прямоугольника 7 см × 5 см: S = ___',answer:'35 кв.см',hint:'S = 7 × 5'},
        {text:'Сторона квадрата 9 см. Площадь: S = ___',answer:'81 кв.см',hint:'S = 9 × 9'}
      ]
    }},
    {topic_id:26, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'Периметр квадрата со стороной 6 см равен 24 см',correct:true,explanation:'P = 6 × 4 = 24 см'},
        {text:'Площадь измеряется в сантиметрах',correct:false,explanation:'Площадь измеряется в квадратных сантиметрах (кв.см)'},
        {text:'Два прямоугольника с одинаковым периметром всегда имеют одинаковую площадь',correct:false,explanation:'Нет, например 10×2 (P=24, S=20) и 8×4 (P=24, S=32)'},
        {text:'Площадь прямоугольника 6×4 = 24 кв.см',correct:true,explanation:'S = 6 × 4 = 24 кв.см — верно'}
      ]
    }},
    {topic_id:26, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини фигуру с её площадью',
      pairs:[{left:'Квадрат 5×5',right:'25 кв.см'},{left:'Прямоугольник 6×3',right:'18 кв.см'},{left:'Квадрат 10×10',right:'100 кв.см'},{left:'Прямоугольник 8×4',right:'32 кв.см'},{left:'Прямоугольник 9×2',right:'18 кв.см'}]
    }},

    // Topic 27: Доли и дроби
    {topic_id:27, task_type:'match_pairs', sort_order:1, task_data:{
      instruction:'Соедини дробь с описанием',
      pairs:[{left:'1/2',right:'Половина'},{left:'1/4',right:'Четверть'},{left:'1/3',right:'Треть'},{left:'3/4',right:'Три четверти'},{left:'1/8',right:'Одна восьмая'}]
    }},
    {topic_id:27, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'1/2 больше, чем 1/4',correct:true,explanation:'Половина больше четверти'},
        {text:'2/3 меньше, чем 1/3',correct:false,explanation:'2/3 больше 1/3'},
        {text:'1/4 от 20 равно 5',correct:true,explanation:'20 ÷ 4 = 5'},
        {text:'3/8 от 40 равно 12',correct:false,explanation:'40 ÷ 8 = 5, 5 × 3 = 15, а не 12'}
      ]
    }},
    {topic_id:27, task_type:'fill_blank', sort_order:3, task_data:{
      instruction:'Впиши пропущенное',
      questions:[
        {text:'1/3 от 24 = ___',answer:'8',hint:'24 ÷ 3 = ?'},
        {text:'1/5 от 35 = ___',answer:'7',hint:'35 ÷ 5 = ?'},
        {text:'3/4 от 16 = ___',answer:'12',hint:'16 ÷ 4 = 4, потом 4 × 3 = ?'}
      ]
    }},

    // Topic 28: Время и календарь
    {topic_id:28, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Впиши пропущенное',
      questions:[
        {text:'В 1 часе ___ минут',answer:'60',hint:'Сколько минут в часе?'},
        {text:'2 часа 30 минут = ___ минут',answer:'150',hint:'2 × 60 + 30 = ?'},
        {text:'В 1 сутках ___ часов',answer:'24',hint:'Сколько часов в сутках?'}
      ]
    }},
    {topic_id:28, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'В году 365 или 366 дней',correct:true,explanation:'В обычном году 365, в високосном 366'},
        {text:'В феврале всегда 28 дней',correct:false,explanation:'В високосном году в феврале 29 дней'},
        {text:'90 минут = 1 час 20 минут',correct:false,explanation:'90 минут = 1 час 30 минут'},
        {text:'3 часа = 180 минут',correct:true,explanation:'3 × 60 = 180'}
      ]
    }},
    {topic_id:28, task_type:'ordering', sort_order:3, task_data:{
      instruction:'Расставь единицы времени от меньшей к большей',
      items:['Секунда','Минута','Час','Сутки','Неделя','Месяц','Год'],
      correct_order:['Секунда','Минута','Час','Сутки','Неделя','Месяц','Год']
    }},

    // Topic 29: Задачи на стоимость
    {topic_id:29, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Реши задачу',
      questions:[
        {text:'Тетрадь стоит 15 руб. Купили 6 тетрадей. Стоимость: ___',answer:'90 руб',hint:'Цена × Количество = Стоимость: 15 × 6 = ?'},
        {text:'За 8 ручек заплатили 120 руб. Цена одной ручки: ___',answer:'15 руб',hint:'Стоимость ÷ Количество = Цена: 120 ÷ 8 = ?'},
        {text:'Цена пирожка 25 руб. На 200 руб можно купить ___ пирожков',answer:'8',hint:'Стоимость ÷ Цена = Количество: 200 ÷ 25 = ?'}
      ]
    }},
    {topic_id:29, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Проверь решение',
      statements:[
        {text:'5 карандашей по 12 руб = 60 руб',correct:true,explanation:'5 × 12 = 60 — верно'},
        {text:'На 100 руб можно купить 4 булочки по 30 руб',correct:false,explanation:'4 × 30 = 120, а не 100. Можно купить только 3'},
        {text:'Цена = Стоимость ÷ Количество',correct:true,explanation:'Верная формула'},
        {text:'7 тетрадей по 18 руб стоят 116 руб',correct:false,explanation:'7 × 18 = 126, а не 116'}
      ]
    }},
    {topic_id:29, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини задачу с ответом',
      pairs:[{left:'4 × 25 руб',right:'100 руб'},{left:'150 ÷ 5',right:'30 руб'},{left:'8 × 12 руб',right:'96 руб'},{left:'200 ÷ 8',right:'25 руб'},{left:'6 × 15 руб',right:'90 руб'}]
    }},

    // Topic 30: Задачи в три действия
    {topic_id:30, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Реши задачу по шагам',
      questions:[
        {text:'В магазине 3 полки. На каждой по 8 книг. Продали 10 книг. Осталось: ___',answer:'14',hint:'1) 3 × 8 = 24; 2) 24 — 10 = 14'},
        {text:'Мама купила 4 пачки печенья по 6 штук и 3 конфеты. Всего сладостей: ___',answer:'27',hint:'1) 4 × 6 = 24; 2) 24 + 3 = 27'},
        {text:'У Пети 50 руб. Он купил 3 ручки по 12 руб. Сдача: ___',answer:'14 руб',hint:'1) 3 × 12 = 36; 2) 50 — 36 = 14'}
      ]
    }},
    {topic_id:30, task_type:'ordering', sort_order:2, task_data:{
      instruction:'Расставь шаги решения в правильном порядке для задачи: «В саду 4 ряда по 5 яблонь. С каждой яблони собрали 10 кг. Сколько всего кг?»',
      items:['Найти количество яблонь: 4 × 5 = 20','Найти общий урожай: 20 × 10 = 200 кг','Записать ответ: 200 кг'],
      correct_order:['Найти количество яблонь: 4 × 5 = 20','Найти общий урожай: 20 × 10 = 200 кг','Записать ответ: 200 кг']
    }},
    {topic_id:30, task_type:'true_false', sort_order:3, task_data:{
      instruction:'Проверь решение задачи',
      statements:[
        {text:'В задаче «5 коробок по 6 карандашей, раздали 12» ответ 18',correct:true,explanation:'5×6=30, 30-12=18 — верно'},
        {text:'В задаче «3 пакета по 4 яблока + 2 груши» всего 16 фруктов',correct:false,explanation:'3×4=12, 12+2=14, а не 16'},
        {text:'Задачу в 3 действия всегда нужно решать слева направо',correct:false,explanation:'Нет, нужно определить порядок по смыслу задачи'},
        {text:'В задаче «8 рядов по 7 стульев, убрали 6» осталось 50 стульев',correct:true,explanation:'8×7=56, 56-6=50 — верно'}
      ]
    }}
  ];

  try {
    await pool.query("CREATE TABLE IF NOT EXISTS interactive_tasks (id SERIAL PRIMARY KEY, topic_id INTEGER REFERENCES topics(id), task_type VARCHAR(30) NOT NULL, task_data JSONB NOT NULL, sort_order INTEGER DEFAULT 0)");
    let count = 0;
    for (const t of tasks) {
      await pool.query('INSERT INTO interactive_tasks (topic_id, task_type, task_data, sort_order) VALUES ($1,$2,$3,$4)', [t.topic_id, t.task_type, JSON.stringify(t.task_data), t.sort_order]);
      count++;
    }
    res.json({success:true, inserted:count, message:'Темы 21-30 загружены!'});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});
// Load interactive tasks for topics 31-40 (Grade 4)
app.get('/api/admin/load-tasks5', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).json({error: 'Forbidden'});
  
  const tasks = [
    // Topic 31: Многозначные числа
    {topic_id:31, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Впиши пропущенное',
      questions:[
        {text:'В числе 45 280 цифра 5 стоит в разряде ___',answer:'тысяч',hint:'4 — десятки тысяч, 5 — тысячи'},
        {text:'Запиши число: 30 тысяч 7 сотен 4 единицы = ___',answer:'30704',hint:'30000 + 700 + 4'},
        {text:'Сколько всего сотен в числе 8 300? ___',answer:'83',hint:'8300 ÷ 100 = ?'}
      ]
    }},
    {topic_id:31, task_type:'ordering', sort_order:2, task_data:{
      instruction:'Расставь числа от меньшего к большему',
      items:['12045','12504','10245','15024','10452'],
      correct_order:['10245','10452','12045','12504','15024']
    }},
    {topic_id:31, task_type:'true_false', sort_order:3, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'В числе 60 030 — 6 десятков тысяч',correct:true,explanation:'60 030: 6 в разряде десятков тысяч'},
        {text:'Число 10 099 больше числа 10 909',correct:false,explanation:'10 099 < 10 909'},
        {text:'В числе 5 070 ноль десятков',correct:false,explanation:'В числе 5 070: 7 десятков (07 в разрядах)'},
        {text:'100 000 — это наименьшее шестизначное число',correct:true,explanation:'Верно, 99 999 — наибольшее пятизначное'}
      ]
    }},

    // Topic 32: Сложение многозначных чисел
    {topic_id:32, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли столбиком',
      questions:[
        {text:'24 536 + 18 475 = ___',answer:'43011',hint:'6+5=11, 3+7+1=11, 5+4+1=10, 4+8+1=13, 2+1+1=4'},
        {text:'50 000 + 37 864 = ___',answer:'87864',hint:'Прибавляем к 50 000'},
        {text:'7 089 + 2 911 = ___',answer:'10000',hint:'9+1=10, 8+1+1=10, 0+9+1=10, 7+2+1=10'}
      ]
    }},
    {topic_id:32, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Проверь вычисления',
      statements:[
        {text:'15 678 + 24 322 = 40 000',correct:true,explanation:'8+2=10, 7+2+1=10, 6+3+1=10, 5+4+1=10, 1+2+1=4 → 40000'},
        {text:'33 333 + 33 333 = 66 666',correct:true,explanation:'3+3=6 в каждом разряде → 66 666'},
        {text:'48 750 + 21 350 = 69 100',correct:false,explanation:'48 750 + 21 350 = 70 100, а не 69 100'},
        {text:'99 999 + 1 = 100 000',correct:true,explanation:'Верно, переход через все разряды'}
      ]
    }},
    {topic_id:32, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'12 500 + 7 500',right:'20 000'},{left:'45 600 + 4 400',right:'50 000'},{left:'28 300 + 11 700',right:'40 000'},{left:'63 250 + 6 750',right:'70 000'},{left:'81 001 + 8 999',right:'90 000'}]
    }},

    // Topic 33: Вычитание многозначных чисел
    {topic_id:33, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли столбиком',
      questions:[
        {text:'50 000 — 23 456 = ___',answer:'26544',hint:'Занимаем из старших разрядов'},
        {text:'74 302 — 38 157 = ___',answer:'36145',hint:'Вычитай поразрядно с займом'},
        {text:'100 000 — 1 = ___',answer:'99999',hint:'Все нули становятся девятками'}
      ]
    }},
    {topic_id:33, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Проверь вычисления',
      statements:[
        {text:'40 000 — 15 678 = 24 322',correct:true,explanation:'Проверка: 24 322 + 15 678 = 40 000 ✓'},
        {text:'65 000 — 28 500 = 37 500',correct:false,explanation:'65 000 — 28 500 = 36 500'},
        {text:'90 010 — 45 005 = 45 005',correct:true,explanation:'Проверка: 45 005 + 45 005 = 90 010 ✓'},
        {text:'80 000 — 1 = 79 099',correct:false,explanation:'80 000 — 1 = 79 999'}
      ]
    }},
    {topic_id:33, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'70 000 — 35 000',right:'35 000'},{left:'50 000 — 12 500',right:'37 500'},{left:'100 000 — 55 555',right:'44 445'},{left:'60 000 — 24 680',right:'35 320'},{left:'45 000 — 19 999',right:'25 001'}]
    }},

    // Topic 34: Умножение многозначных чисел
    {topic_id:34, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли',
      questions:[
        {text:'1 234 × 5 = ___',answer:'6170',hint:'4×5=20, 3×5+2=17, 2×5+1=11, 1×5+1=6'},
        {text:'305 × 12 = ___',answer:'3660',hint:'305×2=610, 305×10=3050, 610+3050=3660'},
        {text:'250 × 40 = ___',answer:'10000',hint:'25×4=100, приписать два нуля'}
      ]
    }},
    {topic_id:34, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Проверь',
      statements:[
        {text:'2 500 × 4 = 10 000',correct:true,explanation:'2500 × 4 = 10 000 — верно'},
        {text:'1 111 × 9 = 9 999',correct:true,explanation:'1111 × 9 = 9999 — верно'},
        {text:'450 × 20 = 9 500',correct:false,explanation:'450 × 20 = 9 000, а не 9 500'},
        {text:'123 × 100 = 12 300',correct:true,explanation:'При умножении на 100 приписываем два нуля'}
      ]
    }},
    {topic_id:34, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'300 × 30',right:'9 000'},{left:'125 × 8',right:'1 000'},{left:'2 000 × 5',right:'10 000'},{left:'750 × 4',right:'3 000'},{left:'1 500 × 6',right:'9 000'}]
    }},

    // Topic 35: Деление многозначных чисел
    {topic_id:35, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Вычисли',
      questions:[
        {text:'8 640 ÷ 4 = ___',answer:'2160',hint:'8÷4=2, 6÷4=1(ост.2), 24÷4=6, 0÷4=0'},
        {text:'7 500 ÷ 25 = ___',answer:'300',hint:'75 ÷ 25 = 3, приписать два нуля'},
        {text:'10 000 ÷ 8 = ___',answer:'1250',hint:'10÷8=1(ост.2), 20÷8=2(ост.4), 40÷8=5, 0'}
      ]
    }},
    {topic_id:35, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Проверь',
      statements:[
        {text:'9 000 ÷ 6 = 1 500',correct:true,explanation:'1500 × 6 = 9000 ✓'},
        {text:'4 800 ÷ 12 = 400',correct:true,explanation:'400 × 12 = 4800 ✓'},
        {text:'6 300 ÷ 9 = 600',correct:false,explanation:'6 300 ÷ 9 = 700'},
        {text:'15 000 ÷ 50 = 300',correct:true,explanation:'300 × 50 = 15 000 ✓'}
      ]
    }},
    {topic_id:35, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини пример с ответом',
      pairs:[{left:'12 000 ÷ 4',right:'3 000'},{left:'8 100 ÷ 9',right:'900'},{left:'5 600 ÷ 8',right:'700'},{left:'24 000 ÷ 60',right:'400'},{left:'3 600 ÷ 12',right:'300'}]
    }},

    // Topic 36: Дроби
    {topic_id:36, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Впиши ответ',
      questions:[
        {text:'3/5 + 1/5 = ___',answer:'4/5',hint:'Складываем числители: 3+1=4, знаменатель тот же'},
        {text:'7/8 — 3/8 = ___',answer:'4/8',hint:'Вычитаем числители: 7-3=4. Можно сократить до 1/2'},
        {text:'Переведи 2 целых 3/4 в неправильную дробь: ___',answer:'11/4',hint:'2 × 4 + 3 = 11, знаменатель 4'}
      ]
    }},
    {topic_id:36, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'5/6 > 4/6',correct:true,explanation:'При одинаковом знаменателе больше дробь с большим числителем'},
        {text:'1/3 = 2/6',correct:true,explanation:'1/3 × 2/2 = 2/6 — верно'},
        {text:'Неправильная дробь всегда больше 1',correct:false,explanation:'Неправильная дробь больше или равна 1 (5/5 = 1)'},
        {text:'3/4 + 1/4 = 4/8',correct:false,explanation:'3/4 + 1/4 = 4/4 = 1, а не 4/8'}
      ]
    }},
    {topic_id:36, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини равные дроби',
      pairs:[{left:'1/2',right:'3/6'},{left:'2/3',right:'4/6'},{left:'3/4',right:'6/8'},{left:'1/5',right:'2/10'},{left:'2/5',right:'4/10'}]
    }},

    // Topic 37: Задачи на движение
    {topic_id:37, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Реши задачу',
      questions:[
        {text:'Скорость 60 км/ч, время 3 часа. Расстояние: ___',answer:'180 км',hint:'S = V × t = 60 × 3'},
        {text:'Расстояние 240 км, скорость 80 км/ч. Время: ___',answer:'3 часа',hint:'t = S ÷ V = 240 ÷ 80'},
        {text:'Расстояние 150 км, время 5 часов. Скорость: ___',answer:'30 км/ч',hint:'V = S ÷ t = 150 ÷ 5'}
      ]
    }},
    {topic_id:37, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'Если скорость 50 км/ч, за 4 часа проедешь 200 км',correct:true,explanation:'50 × 4 = 200'},
        {text:'Два поезда навстречу (60 и 80 км/ч) сближаются со скоростью 140 км/ч',correct:true,explanation:'При встречном движении скорости складываются'},
        {text:'Если увеличить скорость, время пути увеличится',correct:false,explanation:'При увеличении скорости время уменьшается'},
        {text:'За 2 часа при скорости 75 км/ч проедешь 140 км',correct:false,explanation:'75 × 2 = 150, а не 140'}
      ]
    }},
    {topic_id:37, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини данные с ответом',
      pairs:[{left:'V=40, t=5',right:'S=200 км'},{left:'S=360, V=90',right:'t=4 ч'},{left:'S=100, t=2',right:'V=50 км/ч'},{left:'V=70, t=3',right:'S=210 км'},{left:'S=480, t=6',right:'V=80 км/ч'}]
    }},

    // Topic 38: Геометрия: углы и фигуры
    {topic_id:38, task_type:'match_pairs', sort_order:1, task_data:{
      instruction:'Соедини фигуру с описанием',
      pairs:[{left:'Прямой угол',right:'90°'},{left:'Острый угол',right:'Меньше 90°'},{left:'Тупой угол',right:'Больше 90°'},{left:'Развёрнутый угол',right:'180°'},{left:'Равносторонний треугольник',right:'Все стороны равны'}]
    }},
    {topic_id:38, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'В прямоугольнике все углы прямые',correct:true,explanation:'В прямоугольнике 4 прямых угла по 90°'},
        {text:'Диаметр окружности равен двум радиусам',correct:true,explanation:'d = 2r — верно'},
        {text:'В треугольнике может быть два тупых угла',correct:false,explanation:'Сумма углов = 180°, два тупых дали бы больше 180°'},
        {text:'Квадрат — это частный случай прямоугольника',correct:true,explanation:'Квадрат — прямоугольник с равными сторонами'}
      ]
    }},
    {topic_id:38, task_type:'fill_blank', sort_order:3, task_data:{
      instruction:'Впиши ответ',
      questions:[
        {text:'Сумма углов треугольника = ___°',answer:'180',hint:'В любом треугольнике сумма = 180°'},
        {text:'Если два угла треугольника 60° и 80°, третий = ___°',answer:'40',hint:'180 — 60 — 80 = ?'},
        {text:'У квадрата ___ оси симметрии',answer:'4',hint:'Горизонтальная, вертикальная и две диагональные'}
      ]
    }},

    // Topic 39: Величины и их преобразование
    {topic_id:39, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Переведи единицы',
      questions:[
        {text:'5 км = ___ м',answer:'5000',hint:'1 км = 1000 м'},
        {text:'3 т 200 кг = ___ кг',answer:'3200',hint:'3 × 1000 + 200'},
        {text:'2 ч 15 мин = ___ мин',answer:'135',hint:'2 × 60 + 15'}
      ]
    }},
    {topic_id:39, task_type:'true_false', sort_order:2, task_data:{
      instruction:'Правда или ложь?',
      statements:[
        {text:'1 кв.м = 100 кв.дм',correct:true,explanation:'1 м = 10 дм, площадь: 10 × 10 = 100 кв.дм'},
        {text:'3 500 г = 3 кг 5 г',correct:false,explanation:'3 500 г = 3 кг 500 г'},
        {text:'48 месяцев = 4 года',correct:true,explanation:'48 ÷ 12 = 4'},
        {text:'1 сутки = 1 440 минут',correct:true,explanation:'24 × 60 = 1 440'}
      ]
    }},
    {topic_id:39, task_type:'match_pairs', sort_order:3, task_data:{
      instruction:'Соедини равные величины',
      pairs:[{left:'2 км',right:'2 000 м'},{left:'5 т',right:'5 000 кг'},{left:'3 ч',right:'180 мин'},{left:'4 кв.м',right:'400 кв.дм'},{left:'1 век',right:'100 лет'}]
    }},

    // Topic 40: Составные задачи
    {topic_id:40, task_type:'fill_blank', sort_order:1, task_data:{
      instruction:'Реши задачу',
      questions:[
        {text:'В школе 12 классов по 25 учеников. На экскурсию поехали 4 класса. Сколько учеников поехали? ___',answer:'100',hint:'4 × 25 = 100'},
        {text:'Фермер собрал 840 кг яблок и разложил поровну в 6 ящиков. 2 ящика продал. Сколько кг осталось? ___',answer:'560',hint:'1) 840÷6=140 кг в ящике; 2) 140×2=280 продал; 3) 840-280=560'},
        {text:'Поезд проехал 3 ч по 80 км/ч и 2 ч по 95 км/ч. Общий путь: ___',answer:'430 км',hint:'1) 80×3=240; 2) 95×2=190; 3) 240+190=430'}
      ]
    }},
    {topic_id:40, task_type:'ordering', sort_order:2, task_data:{
      instruction:'Расставь шаги решения: «В магазин привезли 5 коробок по 48 кг и 3 коробки по 36 кг. Всё разложили поровну на 12 полок. Сколько кг на каждой?»',
      items:['5 × 48 = 240 кг','3 × 36 = 108 кг','240 + 108 = 348 кг','348 ÷ 12 = 29 кг'],
      correct_order:['5 × 48 = 240 кг','3 × 36 = 108 кг','240 + 108 = 348 кг','348 ÷ 12 = 29 кг']
    }},
    {topic_id:40, task_type:'true_false', sort_order:3, task_data:{
      instruction:'Проверь решение',
      statements:[
        {text:'Задача: 6 полок по 15 книг, убрали 30. Ответ: 60 книг',correct:true,explanation:'6×15=90, 90-30=60 ✓'},
        {text:'Задача: скорость 45 км/ч, время 4 ч, расстояние 170 км',correct:false,explanation:'45 × 4 = 180, а не 170'},
        {text:'Задача: 3 пакета по 2 кг 500 г. Всего 7 кг 500 г',correct:true,explanation:'2500 × 3 = 7500 г = 7 кг 500 г ✓'},
        {text:'Задача: купили 8 тетрадей по 15 руб и 3 ручки по 20 руб. Всего 170 руб',correct:false,explanation:'8×15=120, 3×20=60, 120+60=180, а не 170'}
      ]
    }}
  ];

  try {
    await pool.query("CREATE TABLE IF NOT EXISTS interactive_tasks (id SERIAL PRIMARY KEY, topic_id INTEGER REFERENCES topics(id), task_type VARCHAR(30) NOT NULL, task_data JSONB NOT NULL, sort_order INTEGER DEFAULT 0)");
    let count = 0;
    for (const t of tasks) {
      await pool.query('INSERT INTO interactive_tasks (topic_id, task_type, task_data, sort_order) VALUES ($1,$2,$3,$4)', [t.topic_id, t.task_type, JSON.stringify(t.task_data), t.sort_order]);
      count++;
    }
    res.json({success:true, inserted:count, message:'Темы 31-40 загружены!'});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});
// Fix true_false data
app.get('/api/admin/fix-tf', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).json({error:'Forbidden'});
  try {
    // Get all true_false tasks
    const result = await pool.query("SELECT id, task_data FROM interactive_tasks WHERE task_type = 'true_false'");
    let fixed = 0;
    for (const row of result.rows) {
      let data = row.task_data;
      let changed = false;
      // Fix "answer" -> "correct" in statements
      if (data.statements) {
        data.statements = data.statements.map(s => {
          if (s.answer !== undefined && s.correct === undefined) {
            changed = true;
            return {...s, correct: s.answer};
          }
          return s;
        });
      }
      if (changed) {
        await pool.query('UPDATE interactive_tasks SET task_data = $1 WHERE id = $2', [JSON.stringify(data), row.id]);
        fixed++;
      }
    }
    // Also fix specific math error: 51+36=88 should be false
    const r2 = await pool.query("SELECT id, task_data FROM interactive_tasks WHERE topic_id = 11 AND task_type = 'true_false'");
    for (const row of r2.rows) {
      let data = row.task_data;
      if (data.statements) {
        data.statements = data.statements.map(s => {
          if (s.text && s.text.includes('51 + 36 = 88')) {
            return {...s, correct: false, answer: false, explanation: 'Неверно! 51 + 36 = 87, а не 88'};
          }
          return s;
        });
        await pool.query('UPDATE interactive_tasks SET task_data = $1 WHERE id = $2', [JSON.stringify(data), row.id]);
      }
    }
    res.json({success:true, fixed:fixed, message:'True/false data fixed!'});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});
// Parent statistics endpoints

// Get child's test results summary
app.get('/api/stats/child/:childId', async (req, res) => {
  try {
    const childId = req.params.childId;
    
    // Get child info
    const childResult = await pool.query('SELECT * FROM children WHERE id = $1', [childId]);
    if (childResult.rows.length === 0) {
      return res.status(404).json({error: 'Child not found'});
    }
    const child = childResult.rows[0];
    
    // Get all test results for this child
    const results = await pool.query(
      `SELECT tr.*, t.title as topic_title, t.description as topic_description, t.grade 
       FROM test_results tr 
       JOIN topics t ON tr.topic_id = t.id 
       WHERE tr.child_id = $1 
       ORDER BY tr.completed_at DESC`,
      [childId]
    );
    
    // Calculate summary stats
    const totalTests = results.rows.length;
    const uniqueTopics = [...new Set(results.rows.map(r => r.topic_id))].length;
    const totalStars = results.rows.reduce((sum, r) => sum + (r.stars || 0), 0);
    const avgScore = totalTests > 0 
      ? Math.round(results.rows.reduce((sum, r) => sum + (r.score || 0), 0) / totalTests) 
      : 0;
    
    // Best and worst topics
    const topicScores = {};
    results.rows.forEach(r => {
      if (!topicScores[r.topic_id] || r.score > topicScores[r.topic_id].score) {
        topicScores[r.topic_id] = {
          topic_id: r.topic_id,
          title: r.topic_title,
          score: r.score,
          stars: r.stars,
          grade: r.grade
        };
      }
    });
    
    const topicList = Object.values(topicScores);
    const bestTopics = [...topicList].sort((a,b) => b.score - a.score).slice(0, 3);
    const worstTopics = [...topicList].sort((a,b) => a.score - b.score).slice(0, 3);
    
    // Activity by date (last 30 days)
    const activity = await pool.query(
      `SELECT DATE(completed_at) as date, COUNT(*) as tests_count, 
              AVG(score) as avg_score, SUM(stars) as stars_earned
       FROM test_results 
       WHERE child_id = $1 AND completed_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(completed_at) 
       ORDER BY date DESC`,
      [childId]
    );
    
    // Grade progress
    const gradeProgress = await pool.query(
      `SELECT t.grade, 
              COUNT(DISTINCT tr.topic_id) as topics_completed,
              (SELECT COUNT(*) FROM topics WHERE grade = t.grade) as total_topics,
              ROUND(AVG(tr.score)) as avg_score
       FROM test_results tr 
       JOIN topics t ON tr.topic_id = t.id 
       WHERE tr.child_id = $1
       GROUP BY t.grade 
       ORDER BY t.grade`,
      [childId]
    );
    
    res.json({
      child: {
        id: child.id,
        name: child.name,
        grade: child.grade
      },
      summary: {
        total_tests: totalTests,
        unique_topics: uniqueTopics,
        total_stars: totalStars,
        avg_score: avgScore
      },
      best_topics: bestTopics,
      weak_topics: worstTopics,
      recent_activity: activity.rows,
      grade_progress: gradeProgress.rows,
      all_results: results.rows
    });
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

// Get topics progress for a specific grade
app.get('/api/stats/child/:childId/grade/:grade', async (req, res) => {
  try {
    const {childId, grade} = req.params;
    
    const topics = await pool.query(
      `SELECT t.id, t.title, t.description, t.sort_order,
              tr.score as best_score, tr.stars as best_stars, tr.completed_at as last_attempt,
              (SELECT COUNT(*) FROM test_results WHERE child_id = $1 AND topic_id = t.id) as attempts
       FROM topics t
       LEFT JOIN LATERAL (
         SELECT score, stars, completed_at 
         FROM test_results 
         WHERE child_id = $1 AND topic_id = t.id 
         ORDER BY score DESC LIMIT 1
       ) tr ON true
       WHERE t.grade = $2
       ORDER BY t.sort_order`,
      [childId, grade]
    );
    
    res.json({
      grade: parseInt(grade),
      topics: topics.rows
    });
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

// Get detailed results for a specific topic
app.get('/api/stats/child/:childId/topic/:topicId', async (req, res) => {
  try {
    const {childId, topicId} = req.params;
    
    const results = await pool.query(
      `SELECT tr.*, t.title as topic_title
       FROM test_results tr 
       JOIN topics t ON tr.topic_id = t.id 
       WHERE tr.child_id = $1 AND tr.topic_id = $2
       ORDER BY tr.completed_at DESC`,
      [childId, topicId]
    );
    
    res.json({
      topic_id: parseInt(topicId),
      attempts: results.rows
    });
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});
// Fix tables for stats
app.get('/api/admin/fix-results', async (req, res) => {
  if (req.query.key !== 'math2025admin') return res.status(403).json({error:'Forbidden'});
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS test_results (id SERIAL PRIMARY KEY, child_id INTEGER, topic_id INTEGER, score INTEGER DEFAULT 0, total_questions INTEGER DEFAULT 25, correct_answers INTEGER DEFAULT 0, stars INTEGER DEFAULT 0, completed_at TIMESTAMP DEFAULT NOW())`);
    try { await pool.query('ALTER TABLE test_results ADD COLUMN IF NOT EXISTS stars INTEGER DEFAULT 0'); } catch(e) {}
    try { await pool.query('ALTER TABLE test_results ADD COLUMN IF NOT EXISTS child_id INTEGER'); } catch(e) {}
    await pool.query(`CREATE TABLE IF NOT EXISTS children (id SERIAL PRIMARY KEY, user_id INTEGER, name VARCHAR(100), grade INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT NOW())`);
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'test_results' ORDER BY ordinal_position");
    const children = await pool.query('SELECT * FROM children');
    const results = await pool.query('SELECT * FROM test_results LIMIT 5');
    res.json({success:true, columns:cols.rows.map(r=>r.column_name), children_count:children.rows.length, children:children.rows, results_count:results.rows.length, sample_results:results.rows});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Parent stats v2 (safe)
app.get('/api/stats/v2/child/:childId', async (req, res) => {
  try {
    const childId = req.params.childId;
    let child = {id:childId, name:'Ученик', grade:2};
    try {
      const cr = await pool.query('SELECT * FROM children WHERE id=$1',[childId]);
      if(cr.rows.length>0) child=cr.rows[0];
    } catch(e){}
    let cols=[];
    try {
      const colR = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='test_results'");
      cols=colR.rows.map(r=>r.column_name);
    } catch(e){}
    const hasStars=cols.includes('stars'), hasChildId=cols.includes('child_id'), hasScore=cols.includes('score');
    let rows=[];
    try {
      const sf=`tr.id,tr.topic_id,${hasScore?'tr.score':'0 as score'},${hasStars?'tr.stars':'0 as stars'},tr.completed_at,t.title as topic_title,t.grade`;
      if(hasChildId){
        const r=await pool.query(`SELECT ${sf} FROM test_results tr JOIN topics t ON tr.topic_id=t.id WHERE tr.child_id=$1 ORDER BY tr.completed_at DESC`,[childId]);
        rows=r.rows;
      } else {
        const r=await pool.query(`SELECT ${sf} FROM test_results tr JOIN topics t ON tr.topic_id=t.id ORDER BY tr.completed_at DESC`);
        rows=r.rows;
      }
    } catch(e){console.log('Stats query error:',e.message);}
    const totalTests=rows.length;
    const uniqueTopics=[...new Set(rows.map(r=>r.topic_id))].length;
    const totalStars=rows.reduce((s,r)=>s+(parseInt(r.stars)||0),0);
    const avgScore=totalTests>0?Math.round(rows.reduce((s,r)=>s+(parseInt(r.score)||0),0)/totalTests):0;
    const topicScores={};
    rows.forEach(r=>{const sc=parseInt(r.score)||0;if(!topicScores[r.topic_id]||sc>topicScores[r.topic_id].score)topicScores[r.topic_id]={topic_id:r.topic_id,title:r.topic_title,score:sc,stars:parseInt(r.stars)||0,grade:r.grade};});
    const tl=Object.values(topicScores);
    const best=[...tl].sort((a,b)=>b.score-a.score).slice(0,3);
    const worst=[...tl].sort((a,b)=>a.score-b.score).slice(0,3);
    const gm={};
    rows.forEach(r=>{if(!gm[r.grade])gm[r.grade]={topics:new Set(),scores:[]};gm[r.grade].topics.add(r.topic_id);gm[r.grade].scores.push(parseInt(r.score)||0);});
    const gp=Object.entries(gm).map(([g,d])=>({grade:parseInt(g),topics_completed:d.topics.size,total_topics:10,avg_score:Math.round(d.scores.reduce((a,b)=>a+b,0)/d.scores.length)})).sort((a,b)=>a.grade-b.grade);
    res.json({child:{id:child.id,name:child.name,grade:child.grade},summary:{total_tests:totalTests,unique_topics:uniqueTopics,total_stars:totalStars,avg_score:avgScore},best_topics:best,weak_topics:worst,recent_activity:[],grade_progress:gp,all_results:rows});
  } catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT, function() { console.log('API running on port ' + PORT); });
