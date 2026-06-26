const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
const port = Number(process.env.PORT || 80);
const databaseName = process.env.MYSQL_DATABASE || 'bangbangtang';
const requestTimes = new Map();

app.use(express.json({ limit: '64kb' }));

const pool = mysql.createPool({
  host: (process.env.MYSQL_ADDRESS || '').split(':')[0],
  port: Number((process.env.MYSQL_ADDRESS || '').split(':')[1] || 3306),
  user: process.env.MYSQL_USERNAME,
  password: process.env.MYSQL_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4'
});

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function isContactValid(contact) {
  return /^(1\d{10}|[A-Za-z][A-Za-z0-9_-]{4,31})$/.test(contact);
}

function clientAddress(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
}

function allowRegistration(request) {
  const key = clientAddress(request) || 'unknown';
  const now = Date.now();
  const last = requestTimes.get(key) || 0;
  if (now - last < 15 * 1000) return false;
  requestTimes.set(key, now);
  return true;
}

async function ensureSchema() {
  await pool.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`${databaseName}\`.registrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(60) NOT NULL,
      contact VARCHAR(40) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT '',
      grade VARCHAR(30) NOT NULL DEFAULT '',
      need VARCHAR(80) NOT NULL DEFAULT '',
      note VARCHAR(500) NOT NULL DEFAULT '',
      source VARCHAR(80) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_created_at (created_at),
      KEY idx_contact (contact)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [statusColumns] = await pool.query(`SHOW COLUMNS FROM \`${databaseName}\`.registrations LIKE 'status'`);
  if (!statusColumns.length) {
    await pool.query(`ALTER TABLE \`${databaseName}\`.registrations ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT '待联系' AFTER source`);
  }
}

function requireAdmin(request, response, next) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const header = String(request.headers.authorization || '');
  const encoded = header.startsWith('Basic ') ? header.slice(6) : '';
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  const [user, password] = decoded.split(':');

  if (!expectedUser || !expectedPassword || user !== expectedUser || password !== expectedPassword) {
    response.set('WWW-Authenticate', 'Basic realm="Bangbangtang"');
    response.status(401).send('请使用老师账号登录');
    return;
  }
  next();
}

app.get('/health', (request, response) => {
  response.json({ ok: true, service: 'bangbangtang-api' });
});

app.post('/api/register', async (request, response) => {
  if (!allowRegistration(request)) {
    response.status(429).json({ ok: false, message: '请稍等一会儿再提交。' });
    return;
  }

  const body = request.body || {};
  const record = {
    name: cleanText(body.name, 60),
    contact: cleanText(body.contact, 40),
    role: cleanText(body.role, 30),
    grade: cleanText(body.grade, 30),
    need: cleanText(body.need, 80),
    note: cleanText(body.note, 500),
    source: cleanText(body.source, 80) || '小程序登记'
  };

  if (!record.name) {
    response.status(400).json({ ok: false, message: '请填写称呼。' });
    return;
  }
  if (!isContactValid(record.contact)) {
    response.status(400).json({ ok: false, message: '请填写正确的手机号或微信号。' });
    return;
  }
  if (!record.grade) {
    response.status(400).json({ ok: false, message: '请选择年级。' });
    return;
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO \`${databaseName}\`.registrations (name, contact, role, grade, need, note, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [record.name, record.contact, record.role, record.grade, record.need, record.note, record.source]
    );
    response.status(201).json({ ok: true, id: result.insertId });
  } catch (error) {
    console.error('save registration failed', error.message);
    response.status(500).json({ ok: false, message: '暂时没有保存成功，请稍后再试。' });
  }
});

app.get('/api/teacher/leads', requireAdmin, async (request, response) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, contact, role, grade, need, note, source, status, created_at FROM \`${databaseName}\`.registrations ORDER BY id DESC LIMIT 200`
    );
    response.json({
      ok: true,
      leads: rows.map((row) => ({
        id: String(row.id),
        type: '登记',
        name: row.name,
        contact: row.contact,
        role: row.role,
        grade: row.grade,
        need: row.need,
        note: row.note,
        source: row.source,
        status: row.status || '待联系',
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('load teacher leads failed', error.message);
    response.status(500).json({ ok: false, message: '暂时无法读取资料。' });
  }
});

app.post('/api/teacher/status', requireAdmin, async (request, response) => {
  const id = Number(request.body && request.body.id);
  const status = request.body && request.body.status;
  if (!Number.isInteger(id) || id <= 0 || !['待联系', '已联系'].includes(status)) {
    response.status(400).json({ ok: false, message: '状态更新信息不正确。' });
    return;
  }
  try {
    const [result] = await pool.execute(
      `UPDATE \`${databaseName}\`.registrations SET status = ? WHERE id = ?`,
      [status, id]
    );
    if (!result.affectedRows) {
      response.status(404).json({ ok: false, message: '没有找到这条资料。' });
      return;
    }
    response.json({ ok: true });
  } catch (error) {
    console.error('update teacher lead status failed', error.message);
    response.status(500).json({ ok: false, message: '暂时无法更新状态。' });
  }
});

app.get('/teacher', requireAdmin, async (request, response) => {
  try {
    const [rows] = await pool.query(`SELECT id, name, contact, role, grade, need, note, source, status, created_at FROM \`${databaseName}\`.registrations ORDER BY id DESC LIMIT 200`);
    const body = rows.map((row) => `
      <tr>
        <td>${row.id}</td><td>${row.name}</td><td>${row.contact}</td><td>${row.grade}</td>
        <td>${row.need}</td><td>${row.status}</td><td>${row.note}</td><td>${row.source}</td><td>${row.created_at}</td>
      </tr>`).join('');
    response.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>棒棒堂老师后台</title><style>body{margin:0;padding:24px;background:#f7f1e7;color:#26352f;font:14px/1.5 system-ui,sans-serif}h1{font-size:24px}p{color:#68736b}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:10px;border:1px solid #e9dfce;text-align:left;vertical-align:top}th{background:#294b3e;color:#fff}@media(max-width:700px){body{padding:12px}table{font-size:12px}}</style></head><body><h1>棒棒堂书房｜家长登记</h1><p>共 ${rows.length} 条记录，最新记录在最上面。</p><table><thead><tr><th>编号</th><th>称呼</th><th>电话/微信</th><th>年级</th><th>想了解</th><th>状态</th><th>补充情况</th><th>来源</th><th>提交时间</th></tr></thead><tbody>${body || '<tr><td colspan="9">还没有登记。</td></tr>'}</tbody></table></body></html>`);
  } catch (error) {
    console.error('load registrations failed', error.message);
    response.status(500).send('暂时无法读取资料。');
  }
});

ensureSchema()
  .then(() => app.listen(port, () => console.log(`bangbangtang api listening on ${port}`)))
  .catch((error) => {
    console.error('database initialization failed', error.message);
    process.exit(1);
  });
