module.exports = function(app) {

  var express = require('express');
  app.use('/api/homework', express.json({ limit: '50mb' }));

  // === HOMEWORK PHOTO ANALYSIS ===
  app.post('/api/homework/analyze', async (req, res) => {
    try {
      const { image, childGrade } = req.body;
      if (!image) return res.status(400).json({ error: 'No image provided' });
      console.log('Photo received, grade:', childGrade, 'length:', image.length);

      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'Ты Мудрик - дружелюбный репетитор по математике для ребёнка ' + (childGrade || 2) + ' класса. Когда ребёнок присылает фото задания, ты ОБЯЗАТЕЛЬНО: 1) Распознаёшь ВСЕ задания на фото. 2) Решаешь КАЖДОЕ задание подробно по шагам. Формат: 📝 Задача: (условие). 📖 Решение по шагам: Шаг 1: ... Шаг 2: ... ✅ Ответ: ... ✏️ ЗАПИШИ В ТЕТРАДЬ: Задача: ... Решение: 1) ... 2) ... Ответ: ... 💡 Запомни: (правило). НИКОГДА не спрашивай ребёнка - сразу давай полное решение. Отвечай на русском.' },
            { role: 'user', content: [{ type: 'text', text: 'Реши все задания на этом фото. Отвечай на русском.' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] }
          ],
          max_tokens: 4000,
          temperature: 0.3
        })
      });

      const data = await openaiResponse.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      var answer = data.choices && data.choices[0] ? data.choices[0].message.content : 'Не удалось распознать.';
      res.json({ success: true, answer: answer });
    } catch (error) {
      console.error('Homework error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/homework/test', function(req, res) {
    res.json({ status: 'ok', message: 'Homework route is loaded v3', hasOpenAIKey: !!process.env.OPENAI_API_KEY });
  });

  // === ADMIN PANEL API ===
  app.get('/api/admin/db', async function(req, res) {
    if (req.query.key !== 'math2025admin') return res.status(403).json({ error: 'Forbidden' });
    
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 5432,
        ssl: { rejectUnauthorized: false }
      });

      var action = req.query.action || 'overview';

      if (action === 'overview') {
        var children = await pool.query('SELECT * FROM children ORDER BY id');
        var results = await pool.query('SELECT * FROM test_results ORDER BY id DESC LIMIT 50');
        var tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
        res.json({
          tables: tables.rows.map(function(r) { return r.table_name; }),
          children: children.rows,
          children_count: children.rowCount,
          recent_results: results.rows,
          results_count: results.rowCount
        });
      }
      else if (action === 'query') {
        var q = req.query.q;
        if (!q) return res.json({ error: 'No query provided. Use &q=SELECT...' });
        if (q.trim().toUpperCase().startsWith('DROP') || q.trim().toUpperCase().startsWith('DELETE') || q.trim().toUpperCase().startsWith('TRUNCATE')) {
          return res.json({ error: 'Dangerous query blocked' });
        }
        var result = await pool.query(q);
        res.json({ rows: result.rows, count: result.rowCount });
      }
      else if (action === 'children') {
        var children = await pool.query('SELECT c.*, p.email as parent_email FROM children c LEFT JOIN users p ON c.parent_id = p.id ORDER BY c.id');
        res.json({ children: children.rows, count: children.rowCount });
      }
      else if (action === 'users') {
        var users = await pool.query('SELECT id, email, created_at FROM users ORDER BY id');
        res.json({ users: users.rows, count: users.rowCount });
      }
      else if (action === 'results') {
        var results = await pool.query('SELECT tr.*, c.name as child_name, t.title as topic_title FROM test_results tr LEFT JOIN children c ON tr.child_id = c.id LEFT JOIN topics t ON tr.topic_id = t.id ORDER BY tr.id DESC LIMIT 100');
        res.json({ results: results.rows, count: results.rowCount });
      }
      else if (action === 'payments') {
        try {
          var payments = await pool.query('SELECT * FROM payments ORDER BY id DESC LIMIT 50');
          res.json({ payments: payments.rows, count: payments.rowCount });
        } catch(e) {
          res.json({ payments: [], message: 'No payments table: ' + e.message });
        }
      }
      else {
        res.json({ error: 'Unknown action. Use: overview, children, users, results, payments, query' });
      }

      await pool.end();
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
// ===== PAYMENTS =====
  
  // Создание таблицы payments при старте
  const createPaymentsTable = async () => {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER REFERENCES parents(id),
          yookassa_id VARCHAR(255),
          amount DECIMAL(10,2),
          currency VARCHAR(10) DEFAULT 'RUB',
          status VARCHAR(50) DEFAULT 'pending',
          plan VARCHAR(50),
          description TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          paid_at TIMESTAMP,
          metadata JSONB
        )
      `);
      console.log('✅ Payments table ready');
    } catch(e) { console.error('payments table error:', e.message); }
  };
  createPaymentsTable();

  // Создание платежа
  app.post('/api/payments/create', async (req, res) => {
    try {
      const { plan, parentId, email, returnUrl } = req.body;
      const plans = {
        monthly: { amount: '990.00', description: 'Подписка на 1 месяц' },
        halfyear: { amount: '1990.00', description: 'Подписка на 6 месяцев' },
        family: { amount: '1490.00', description: 'Семейный план на 1 месяц' }
      };
      const selectedPlan = plans[plan];
      if (!selectedPlan) return res.status(400).json({ error: 'Invalid plan' });

      const shopId = process.env.YOOKASSA_SHOP_ID;
      const secretKey = process.env.YOOKASSA_SECRET_KEY;
      
      if (!shopId || !secretKey) return res.status(500).json({ error: 'YooKassa not configured' });

      const idempotenceKey = `${parentId}-${plan}-${Date.now()}`;
      
      const response = await fetch('https://api.yookassa.ru/v3/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(shopId + ':' + secretKey).toString('base64'),
          'Idempotence-Key': idempotenceKey
        },
        body: JSON.stringify({
          amount: { value: selectedPlan.amount, currency: 'RUB' },
          capture: true,
          confirmation: { type: 'redirect', return_url: returnUrl || 'https://math-explorer.lovable.app/payment-success' },
          description: selectedPlan.description,
          metadata: { parent_id: parentId, plan: plan, email: email }
        })
      });

      const payment = await response.json();
      console.log('💳 Payment FULL response:', JSON.stringify(payment));

      // Сохраняем в БД
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query(
        'INSERT INTO payments (parent_id, yookassa_id, amount, plan, status, description) VALUES ($1,$2,$3,$4,$5,$6)',
        [parentId, payment.id, selectedPlan.amount, plan, payment.status, selectedPlan.description]
      );

      res.json({ success: true, confirmationUrl: payment.confirmation?.confirmation_url, paymentId: payment.id });
    } catch(error) {
      console.error('❌ Payment create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Webhook от YooKassa
  app.post('/api/payments/webhook', async (req, res) => {
    try {
      const { event, object } = req.body;
      console.log('🔔 YooKassa webhook:', event, object?.id);

      if (event === 'payment.succeeded') {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        
        // Обновляем статус платежа
        await pool.query(
          'UPDATE payments SET status=$1, paid_at=NOW() WHERE yookassa_id=$2',
          ['succeeded', object.id]
        );

        // Получаем данные платежа
        const parentId = object.metadata?.parent_id;
        const plan = object.metadata?.plan;
        
        if (parentId) {
          // Определяем срок подписки
          let months = 1;
          if (plan === 'halfyear') months = 6;
          
          // Обновляем подписку
          await pool.query(
            `UPDATE subscriptions SET status='active', plan=$1, 
             started_at=NOW(), expires_at=NOW() + INTERVAL '${months} months'
             WHERE parent_id=$2`,
            [plan, parentId]
          );
          console.log('✅ Subscription activated for parent:', parentId, 'plan:', plan, 'months:', months);
        }
      }

      res.json({ success: true });
    } catch(error) {
      console.error('❌ Webhook error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Проверка статуса платежа
  app.get('/api/payments/status/:paymentId', async (req, res) => {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const result = await pool.query('SELECT * FROM payments WHERE yookassa_id=$1', [req.params.paymentId]);
      res.json(result.rows[0] || { error: 'Payment not found' });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });

  // Тест платежей
  app.get('/api/payments/test', (req, res) => {
    res.json({ 
      status: 'ok', 
      hasShopId: !!process.env.YOOKASSA_SHOP_ID,
      hasSecretKey: !!process.env.YOOKASSA_SECRET_KEY,
      message: 'Payment routes loaded'
    });
  });
  
};
