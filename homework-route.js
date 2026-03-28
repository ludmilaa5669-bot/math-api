module.exports = function(app) {

  // ===== HOMEWORK ANALYZE =====
  app.use('/api/homework', require('express').json({ limit: '50mb' }));

  app.post('/api/homework/analyze', async (req, res) => {
    try {
      const { image, childGrade } = req.body;
      if (!image) return res.status(400).json({ error: 'No image provided' });
      console.log('📸 Получено фото, grade:', childGrade);
      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'Ты — Мудрик, дружелюбный репетитор по математике для ребёнка ' + (childGrade || 2) + ' класса. Объясняй просто и подробно.' },
            { role: 'user', content: [{ type: 'text', text: 'Реши все задания на этом фото домашней работы. Дай подробное решение каждого задания.' }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] }
          ],
          max_tokens: 4000,
          temperature: 0.3
        })
      });
      var data = await openaiResponse.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      var answer = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : 'Не удалось распознать задание.';
      res.json({ success: true, answer: answer });
    } catch (error) {
      console.error('❌ Homework error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/homework/test', function(req, res) {
    res.json({ status: 'ok', message: 'Homework route is loaded v3', hasOpenAIKey: !!process.env.OPENAI_API_KEY });
  });

  // ===== EMAIL VERIFICATION =====
  var createVerificationTable = async function() {
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query("CREATE TABLE IF NOT EXISTS email_verifications (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, code VARCHAR(6) NOT NULL, created_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '10 minutes', verified BOOLEAN DEFAULT false)");
      await pool.query("ALTER TABLE parents ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false");
      console.log('✅ Email verification table ready');
    } catch(e) { console.error('verification table error:', e.message); }
  };
  createVerificationTable();

  app.post('/api/auth/send-code', async function(req, res) {
    try {
      var email = req.body.email;
      if (!email) return res.status(400).json({ error: 'Email required' });

      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

      var existing = await pool.query("SELECT id FROM parents WHERE email=$1 AND email_verified=true", [email]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Этот email уже зарегистрирован. Используйте вход.' });
      }

      var code = String(Math.floor(100000 + Math.random() * 900000));
      await pool.query("DELETE FROM email_verifications WHERE email=$1", [email]);
      await pool.query("INSERT INTO email_verifications (email, code) VALUES ($1, $2)", [email, code]);

      var resendKey = process.env.RESEND_API_KEY;
      if (!resendKey) return res.status(500).json({ error: 'Email service not configured' });

      var emailResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + resendKey
        },
        body: JSON.stringify({
          from: 'Математика <onboarding@resend.dev>',
          to: [email],
          subject: 'Код подтверждения — Математика',
          html: '<div style="font-family:Arial;max-width:400px;margin:0 auto;text-align:center;padding:20px"><h2 style="color:#f97316">МатЛегко</h2><p>Ваш код подтверждения:</p><div style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#fff3e0;padding:16px;border-radius:12px;margin:16px 0">' + code + '</div><p style="color:#888;font-size:14px">Код действителен 10 минут</p></div>'
        })
      });

      var emailResult = await emailResponse.json();
      console.log('📧 Email sent to:', email, 'status:', emailResponse.status, 'result:', JSON.stringify(emailResult));

      if (emailResponse.ok) {
        res.json({ success: true, message: 'Код отправлен на ' + email });
      } else {
        res.status(500).json({ error: 'Не удалось отправить письмо: ' + (emailResult.message || 'unknown') });
      }
    } catch(error) {
      console.error('❌ Send code error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/auth/verify-code', async function(req, res) {
    try {
      var email = req.body.email;
      var code = req.body.code;
      if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

      var result = await pool.query(
        "SELECT * FROM email_verifications WHERE email=$1 AND code=$2 AND verified=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
        [email, code]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Неверный или просроченный код' });
      }

      await pool.query("UPDATE email_verifications SET verified=true WHERE email=$1", [email]);
      res.json({ success: true, verified: true });
    } catch(error) {
      console.error('❌ Verify code error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/auth/test', function(req, res) {
    res.json({ status: 'ok', hasResendKey: !!process.env.RESEND_API_KEY, message: 'Email verification routes loaded' });
  });
  
 // ===== REGISTRATION CHECK =====
  app.post('/api/check-child', async function(req, res) {
    try {
      var parentId = req.body.parentId;
      if (!parentId) return res.status(400).json({ error: 'parentId required' });
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      var existing = await pool.query('SELECT id, name FROM children WHERE parent_id=$1', [parentId]);
      if (existing.rows.length > 0) {
        return res.json({ hasChild: true, child: existing.rows[0] });
      }
      res.json({ hasChild: false });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });
  
  // ===== ADMIN =====
  app.get('/api/admin/db', async function(req, res) {
    if (req.query.key !== 'math2025admin') return res.status(403).json({ error: 'Forbidden' });
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      var action = req.query.action;

      if (action === 'overview') {
        var tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
        var children = await pool.query('SELECT * FROM children ORDER BY id DESC');
        var results = await pool.query('SELECT * FROM test_results ORDER BY id DESC LIMIT 10');
        res.json({
          tables: tables.rows.map(function(r) { return r.table_name; }),
          children: children.rows,
          recent_results: results.rows,
          children_count: children.rows.length,
          results_count: results.rows.length
        });
      } else if (action === 'query') {
        var result = await pool.query(req.query.q);
        res.json({ rows: result.rows, count: result.rows.length });
      } else if (action === 'results') {
        var r = await pool.query('SELECT * FROM test_results ORDER BY id DESC');
        res.json({ results: r.rows });
      } else {
        res.json({ error: 'Unknown action' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===== PAYMENTS =====
  var createPaymentsTable = async function() {
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query("CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, parent_id INTEGER, yookassa_id VARCHAR(255), amount DECIMAL(10,2), currency VARCHAR(10) DEFAULT 'RUB', status VARCHAR(50) DEFAULT 'pending', plan VARCHAR(50), description TEXT, created_at TIMESTAMP DEFAULT NOW(), paid_at TIMESTAMP, metadata JSONB)");
      console.log('✅ Payments table ready');
    } catch(e) { console.error('payments table error:', e.message); }
  };
  createPaymentsTable();

  app.post('/api/payments/create', async function(req, res) {
    try {
      var body = req.body;
      var plan = body.plan;
      var parentId = body.parentId;
      var email = body.email;
      var returnUrl = body.returnUrl;

      var plans = {
        monthly: { amount: '990.00', description: 'Подписка на 1 месяц' },
        halfyear: { amount: '1990.00', description: 'Подписка на 6 месяцев' },
        family: { amount: '1490.00', description: 'Семейный план на 1 месяц' }
      };
      var selectedPlan = plans[plan];
      if (!selectedPlan) return res.status(400).json({ error: 'Invalid plan' });

      var shopId = process.env.YOOKASSA_SHOP_ID;
      var secretKey = process.env.YOOKASSA_SECRET_KEY;
      if (!shopId || !secretKey) return res.status(500).json({ error: 'YooKassa not configured' });

      var idempotenceKey = parentId + '-' + plan + '-' + Date.now();
      var customerEmail = email || 'noreply@math-easy.ru';

      var response = await fetch('https://api.yookassa.ru/v3/payments', {
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
          metadata: { parent_id: parentId, plan: plan, email: customerEmail },
          receipt: {
            customer: { email: customerEmail },
            items: [{
              description: selectedPlan.description,
              quantity: '1.00',
              amount: { value: selectedPlan.amount, currency: 'RUB' },
              vat_code: 1,
              payment_mode: 'full_payment',
              payment_subject: 'service'
            }]
          }
        })
      });

      var payment = await response.json();
      console.log('💳 Payment FULL response:', JSON.stringify(payment));

      if (payment.type === 'error') {
        return res.status(400).json({ error: payment.description || 'YooKassa error' });
      }

      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query(
        'INSERT INTO payments (parent_id, yookassa_id, amount, plan, status, description) VALUES ($1,$2,$3,$4,$5,$6)',
        [parentId, payment.id, selectedPlan.amount, plan, payment.status, selectedPlan.description]
      );

      var confirmUrl = payment.confirmation ? payment.confirmation.confirmation_url : null;
      res.json({ success: true, confirmationUrl: confirmUrl, paymentId: payment.id });
    } catch(error) {
      console.error('❌ Payment create error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/payments/webhook', async function(req, res) {
    try {
      var event = req.body.event;
      var object = req.body.object;
      console.log('🔔 YooKassa webhook:', event, object ? object.id : 'no object');

      if (event === 'payment.succeeded' && object) {
        var Pool = require('pg').Pool;
        var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await pool.query('UPDATE payments SET status=$1, paid_at=NOW() WHERE yookassa_id=$2', ['succeeded', object.id]);

        var parentId = object.metadata ? object.metadata.parent_id : null;
        var plan = object.metadata ? object.metadata.plan : 'monthly';

        if (parentId) {
          var months = plan === 'halfyear' ? 6 : 1;
          await pool.query(
            "UPDATE subscriptions SET status='active', plan=$1, started_at=NOW(), expires_at=NOW() + INTERVAL '" + months + " months' WHERE parent_id=$2",
            [plan, parentId]
          );
          console.log('✅ Subscription activated for parent:', parentId);
       // Проверить реферала и начислить бонус
          try {
            var refCheck = await pool.query("SELECT referrer_parent_id FROM referrals WHERE referred_parent_id=$1 AND status='registered'", [parentId]);
            if (refCheck.rows.length > 0) {
              var referrerId = refCheck.rows[0].referrer_parent_id;
              await pool.query("UPDATE referrals SET status='paid', paid_at=NOW() WHERE referred_parent_id=$1", [parentId]);
              
              var paidCount = await pool.query("SELECT COUNT(*) as count FROM referrals WHERE referrer_parent_id=$1 AND status='paid'", [referrerId]);
              var paidFriends = parseInt(paidCount.rows[0].count);
              
              if (paidFriends === 5) {
                await pool.query('UPDATE parents SET bonus_days = bonus_days + 30 WHERE id=$1', [referrerId]);
                await pool.query("UPDATE subscriptions SET expires_at = expires_at + INTERVAL '30 days' WHERE parent_id=$1", [referrerId]);
              }
              if (paidFriends === 10) {
                await pool.query('UPDATE parents SET bonus_days = bonus_days + 90 WHERE id=$1', [referrerId]);
                await pool.query("UPDATE subscriptions SET expires_at = expires_at + INTERVAL '90 days' WHERE parent_id=$1", [referrerId]);
              }
              console.log('🎁 Referral bonus from webhook: referrer=' + referrerId + ', paidFriends=' + paidFriends);
            }
          } catch(refErr) { console.error('Referral webhook error:', refErr.message); }
        }
      }
      res.json({ success: true });
    } catch(error) {
      console.error('❌ Webhook error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/payments/status/:paymentId', async function(req, res) {
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      var result = await pool.query('SELECT * FROM payments WHERE yookassa_id=$1', [req.params.paymentId]);
      res.json(result.rows[0] || { error: 'Payment not found' });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/payments/test', function(req, res) {
    res.json({
      status: 'ok',
      hasShopId: !!process.env.YOOKASSA_SHOP_ID,
      hasSecretKey: !!process.env.YOOKASSA_SECRET_KEY,
      message: 'Payment routes loaded v2'
    });
  });
// ===== REFERRALS =====
  var createReferralsTable = async function() {
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query("CREATE TABLE IF NOT EXISTS referrals (id SERIAL PRIMARY KEY, referrer_parent_id INTEGER, referred_parent_id INTEGER, referred_email VARCHAR(255), status VARCHAR(50) DEFAULT 'registered', bonus_days_given INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), paid_at TIMESTAMP)");
      await pool.query("ALTER TABLE parents ADD COLUMN IF NOT EXISTS ref_code VARCHAR(50)");
      await pool.query("ALTER TABLE parents ADD COLUMN IF NOT EXISTS referred_by INTEGER");
      await pool.query("ALTER TABLE parents ADD COLUMN IF NOT EXISTS bonus_days INTEGER DEFAULT 0");
      console.log('✅ Referrals table ready');
    } catch(e) { console.error('referrals table error:', e.message); }
  };
  createReferralsTable();

  // Получить или создать реф-код
  // Таблица лидеров рефералов
  app.get('/api/referral/leaderboard', async function(req, res) {
    try {
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      var result = await pool.query(
        "SELECT p.id, p.email, p.ref_code, p.bonus_days, " +
        "(SELECT COUNT(*) FROM referrals r WHERE r.referrer_parent_id = p.id) as invited_count, " +
        "(SELECT COUNT(*) FROM referrals r WHERE r.referrer_parent_id = p.id AND r.status = 'paid') as paid_count " +
        "FROM parents p WHERE p.ref_code IS NOT NULL " +
        "ORDER BY invited_count DESC LIMIT 20"
      );
      var leaders = result.rows.map(function(row, index) {
        var emailParts = row.email ? row.email.split('@') : ['***'];
        var maskedEmail = emailParts[0].substring(0, 3) + '***@' + (emailParts[1] || '');
        return {
          rank: index + 1,
          maskedEmail: maskedEmail,
          invitedCount: parseInt(row.invited_count),
          paidCount: parseInt(row.paid_count),
          bonusDays: row.bonus_days || 0
        };
      });
      res.json({ leaders: leaders });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });
  app.get('/api/referral/code', async function(req, res) {
    try {
      var parentId = req.query.parentId;
      if (!parentId) return res.status(400).json({ error: 'parentId required' });
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      var result = await pool.query('SELECT ref_code FROM parents WHERE id=$1', [parentId]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Parent not found' });
      var refCode = result.rows[0].ref_code;
      if (!refCode) {
        refCode = 'MF' + parentId + Math.random().toString(36).substring(2, 6).toUpperCase();
        await pool.query('UPDATE parents SET ref_code=$1 WHERE id=$2', [refCode, parentId]);
      }
      res.json({ refCode: refCode });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });

  // Статистика рефералов
  app.get('/api/referral/stats', async function(req, res) {
    try {
      var parentId = req.query.parentId;
      if (!parentId) return res.status(400).json({ error: 'parentId required' });
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      var registered = await pool.query("SELECT COUNT(*) as count FROM referrals WHERE referrer_parent_id=$1", [parentId]);
      var paid = await pool.query("SELECT COUNT(*) as count FROM referrals WHERE referrer_parent_id=$1 AND status='paid'", [parentId]);
      var bonus = await pool.query("SELECT bonus_days FROM parents WHERE id=$1", [parentId]);
      var refCode = await pool.query("SELECT ref_code FROM parents WHERE id=$1", [parentId]);
      res.json({
        registeredCount: parseInt(registered.rows[0].count),
        paidCount: parseInt(paid.rows[0].count),
        bonusDays: bonus.rows[0] ? bonus.rows[0].bonus_days : 0,
        refCode: refCode.rows[0] ? refCode.rows[0].ref_code : null
      });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });

  // Регистрация реферала (вызывается при регистрации нового пользователя)
  app.post('/api/referral/register', async function(req, res) {
    try {
      var refCode = req.body.refCode;
      var newParentId = req.body.newParentId;
      var email = req.body.email;
      if (!refCode || !newParentId) return res.status(400).json({ error: 'refCode and newParentId required' });
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      
      // Найти кто пригласил
      var referrer = await pool.query('SELECT id FROM parents WHERE ref_code=$1', [refCode]);
      if (referrer.rows.length === 0) return res.status(404).json({ error: 'Invalid ref code' });
      var referrerId = referrer.rows[0].id;
      
      // Сохранить связь
      await pool.query('INSERT INTO referrals (referrer_parent_id, referred_parent_id, referred_email) VALUES ($1,$2,$3)', [referrerId, newParentId, email]);
      await pool.query('UPDATE parents SET referred_by=$1 WHERE id=$2', [referrerId, newParentId]);
      
      // Бонус приглашающему: +7 дней за регистрацию
      await pool.query('UPDATE parents SET bonus_days = bonus_days + 7 WHERE id=$1', [referrerId]);
      
      // Продлить подписку приглашающему на 7 дней
      await pool.query("UPDATE subscriptions SET expires_at = expires_at + INTERVAL '7 days' WHERE parent_id=$1", [referrerId]);
      
      // Дать приглашённому 7 дней вместо 5
      await pool.query("UPDATE subscriptions SET expires_at = started_at + INTERVAL '7 days' WHERE parent_id=$1", [newParentId]);
      
      // Проверить уровни бонусов
      var totalRegistered = await pool.query("SELECT COUNT(*) as count FROM referrals WHERE referrer_parent_id=$1", [referrerId]);
      var count = parseInt(totalRegistered.rows[0].count);
      
      // 3 друга зарегистрировались → ещё +14 дней
      if (count === 3) {
        await pool.query('UPDATE parents SET bonus_days = bonus_days + 14 WHERE id=$1', [referrerId]);
        await pool.query("UPDATE subscriptions SET expires_at = expires_at + INTERVAL '14 days' WHERE parent_id=$1", [referrerId]);
      }
      
      console.log('🎁 Referral registered: ' + referrerId + ' invited ' + newParentId + ' (total: ' + count + ')');
      res.json({ success: true, referrerId: referrerId, totalReferred: count });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });

  // Отметить реферала как оплатившего (вызывается из webhook при оплате)
  app.post('/api/referral/mark-paid', async function(req, res) {
    try {
      var paidParentId = req.body.parentId;
      if (!paidParentId) return res.status(400).json({ error: 'parentId required' });
      var Pool = require('pg').Pool;
      var pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      
      // Найти кто пригласил этого пользователя
      var ref = await pool.query("SELECT referrer_parent_id FROM referrals WHERE referred_parent_id=$1 AND status='registered'", [paidParentId]);
      if (ref.rows.length === 0) return res.json({ success: true, message: 'No referrer found' });
      
      var referrerId = ref.rows[0].referrer_parent_id;
      
      // Обновить статус
      await pool.query("UPDATE referrals SET status='paid', paid_at=NOW() WHERE referred_parent_id=$1", [paidParentId]);
      
      // Проверить сколько оплативших друзей
      var paidCount = await pool.query("SELECT COUNT(*) as count FROM referrals WHERE referrer_parent_id=$1 AND status='paid'", [referrerId]);
      var count = parseInt(paidCount.rows[0].count);
      
      // 5 друзей оплатили → +30 дней
      if (count === 5) {
        await pool.query('UPDATE parents SET bonus_days = bonus_days + 30 WHERE id=$1', [referrerId]);
        await pool.query("UPDATE subscriptions SET expires_at = expires_at + INTERVAL '30 days' WHERE parent_id=$1", [referrerId]);
      }
      // 10 друзей оплатили → +90 дней
      if (count === 10) {
        await pool.query('UPDATE parents SET bonus_days = bonus_days + 90 WHERE id=$1', [referrerId]);
        await pool.query("UPDATE subscriptions SET expires_at = expires_at + INTERVAL '90 days' WHERE parent_id=$1", [referrerId]);
      }
      
      console.log('💰 Referral paid: parent ' + paidParentId + ', referrer ' + referrerId + ' (paid friends: ' + count + ')');
      res.json({ success: true, referrerId: referrerId, paidFriends: count });
    } catch(error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/referral/test', function(req, res) {
    res.json({ status: 'ok', message: 'Referral routes loaded' });
  });
  
};
