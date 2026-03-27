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

};
