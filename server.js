require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const DB_PATH = path.join(__dirname, 'db.json');

function readDB() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ==== AUTH API ====
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email & password wajib' });
  const db = readDB();
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Email sudah terdaftar' });
  }
  const user = {
    id: 'u_' + Date.now(), email, name: name || email.split('@')[0],
    password: await bcrypt.hash(password, 10), balance: 0, createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeDB(db);
  req.session.userId = user.id;
  res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, balance: user.balance } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = readDB().users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Email/password salah' });
  }
  req.session.userId = user.id;
  res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, balance: user.balance } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = readDB().users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not found' });
  res.json({ id: user.id, email: user.email, name: user.name, balance: user.balance || 0 });
});

// ==== API DATA ====
app.get('/api/products', (req, res) => res.json(readDB().products));

// ==== FITUR DEPOSIT SALDO ====
app.post('/api/deposit', requireAuth, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 10000) return res.status(400).json({ error: 'Minimal deposit Rp 10.000' });
  
  const db = readDB();
  const depId = 'DEP-' + Date.now();
  const deposit = {
    id: depId, userId: req.session.userId, amount: Number(amount),
    status: 'pending', createdAt: new Date().toISOString()
  };

  try {
    const qr = await fetch('https://api.buatqris.site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'api_create_qris', account_id: process.env.BUATQRIS_ACCOUNT_ID,
        secret_token: process.env.BUATQRIS_SECRET_TOKEN, amount: String(amount),
        description: `Deposit Saldo #${depId}`, qris_method: 'qris_two', fee_by: 'user'
      })
    });
    const qrData = await qr.json();
    deposit.qris = qrData;
    if (qrData?.data?.transaction_id) deposit.qrisTransactionId = qrData.data.transaction_id;
  } catch (e) { return res.status(500).json({ error: 'Gagal buat QRIS' }); }

  db.deposits.push(deposit);
  writeDB(db);
  res.json({ success: true, deposit });
});

app.get('/api/deposit/:id/status', requireAuth, async (req, res) => {
  const db = readDB();
  const dep = db.deposits.find(d => d.id === req.params.id && d.userId === req.session.userId);
  if (!dep || dep.status === 'success') return res.json({ status: dep?.status || 'error', deposit: dep });

  try {
    const r = await fetch('https://api.buatqris.site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'api_check_status', account_id: process.env.BUATQRIS_ACCOUNT_ID,
        secret_token: process.env.BUATQRIS_SECRET_TOKEN, transaction_id: dep.qrisTransactionId
      })
    });
    const data = await r.json();
    const status = data?.data?.status || 'pending';

    if (status === 'success') {
      dep.status = 'success';
      const user = db.users.find(u => u.id === dep.userId);
      if (user) {
        user.balance = (user.balance || 0) + dep.amount;
      }
      writeDB(db);
    }
    res.json({ status: dep.status, deposit: dep });
  } catch (e) { res.json({ status: 'pending', deposit: dep }); }
});

// ==== CEK USERNAME & BUAT ORDER ====
app.post('/api/check-username', requireAuth, async (req, res) => {
  const { username } = req.body;
  try {
    const r = await fetch(`${process.env.APP_API_BASE}/api/check-username/${encodeURIComponent(username)}`);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const raw = JSON.stringify(data).toLowerCase();
    let available = true;
    if (data.available === false || data.exists === true || data.registered === true) available = false;
    else if (raw.includes('taken') || raw.includes('already') || raw.includes('exist')) available = false;
    res.json({ username, available });
  } catch (e) { res.status(500).json({ error: 'Gagal cek username' }); }
});

app.post('/api/order', requireAuth, async (req, res) => {
  const { productId, username, password, role, method } = req.body;
  const db = readDB();
  const product = db.products.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

  const orderId = 'INV-' + Date.now();
  const order = {
    id: orderId, userId: req.session.userId, productId, productName: product.name,
    amount: product.price, days: product.days, role: role || product.role,
    username, password, method: method || 'qris', status: 'pending', qris: null, createdAt: new Date().toISOString()
  };

  // Metode SALDO
  if (method === 'saldo') {
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user || (user.balance || 0) < product.price) {
      return res.status(400).json({ error: 'Saldo tidak cukup. Silakan deposit.' });
    }
    user.balance -= product.price;
    try {
      const create = await fetch(`${process.env.APP_API_BASE}/createAccount`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role: order.role, day: order.days })
      });
      order.status = create.ok ? 'success' : 'failed_create';
    } catch (e) { order.status = 'failed_create'; }
    
    order.paidAt = new Date().toISOString();
    db.orders.push(order);
    writeDB(db);
    return res.json({ success: true, order });
  }

  // Metode QRIS
  try {
    const qr = await fetch('https://api.buatqris.site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'api_create_qris', account_id: process.env.BUATQRIS_ACCOUNT_ID,
        secret_token: process.env.BUATQRIS_SECRET_TOKEN, amount: String(product.price),
        description: `Order #${orderId}`, qris_method: 'qris_two', fee_by: 'user'
      })
    });
    order.qris = await qr.json();
    if (order.qris?.data?.transaction_id) order.qrisTransactionId = order.qris.data.transaction_id;
  } catch (e) { return res.status(500).json({ error: 'Gagal buat QRIS' }); }

  db.orders.push(order);
  writeDB(db);
  res.json({ success: true, order });
});

app.get('/api/order/:id/status', requireAuth, async (req, res) => {
  const db = readDB();
  const order = db.orders.find(o => o.id === req.params.id && o.userId === req.session.userId);
  if (!order || order.status === 'success') return res.json({ status: order?.status || 'error', order });
  if (!order.qrisTransactionId) return res.json({ status: 'pending', order });

  try {
    const r = await fetch('https://api.buatqris.site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'api_check_status', account_id: process.env.BUATQRIS_ACCOUNT_ID,
        secret_token: process.env.BUATQRIS_SECRET_TOKEN, transaction_id: order.qrisTransactionId
      })
    });
    const data = await r.json();
    const status = data?.data?.status || 'pending';

    if (status === 'success') {
      const create = await fetch(`${process.env.APP_API_BASE}/createAccount`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: order.username, password: order.password, role: order.role, day: order.days })
      });
      order.status = create.ok ? 'success' : 'failed_create';
      order.paidAt = new Date().toISOString();
      writeDB(db);
      return res.json({ status: order.status, order });
    }
    if (status === 'expired' || status === 'failed') { order.status = status; writeDB(db); }
    res.json({ status, order });
  } catch (e) { res.json({ status: 'pending', order }); }
});

app.get('/api/orders', requireAuth, (req, res) => {
  const list = readDB().orders.filter(o => o.userId === req.session.userId).reverse();
  res.json(list.map(o => ({ ...o, password: o.status === 'success' ? o.password : '***' })));
});

app.get('/api/order/:id', requireAuth, (req, res) => {
  const o = readDB().orders.find(x => x.id === req.params.id && x.userId === req.session.userId);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

app.listen(process.env.PORT || 3000, () => console.log(`Server jalan di port ${process.env.PORT || 3000}`));
