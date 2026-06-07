require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = globalThis.fetch
  ? globalThis.fetch.bind(globalThis)
  : (() => { const f = require('node-fetch'); return f.default || f; })();

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

// === КЛЮЧИ ===
const FAL_KEY = process.env.FAL_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'vizual-admin-secret'; // секрет для защиты admin-эндпоинтов

// === FIREBASE ADMIN ===
let adminAuth = null, adminDb = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SA || '{}');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  adminAuth = admin.auth();
  adminDb = admin.firestore();
  console.log('✅ Firebase Admin: OK');
} catch(e) { console.log('⚠️ Firebase Admin не настроен:', e.message); }


const FAL_SYNC = 'https://fal.run';        // быстрые модели (картинки) — ждём ответ сразу
const FAL_QUEUE = 'https://queue.fal.run'; // долгие модели (видео) — очередь + поллинг

// === МОДЕЛИ (меняешь стек здесь, остальной код трогать не надо) ===
const MODELS = {
  cutout:     'fal-ai/birefnet/v2',                      // вырез фона → прозрачный PNG
  scene:      'fal-ai/bytedance/seedream/v4.5/edit',     // КРЕАТИВ: вся карточка с текстом (Seedream ~$0.04, дёшево; текст иногда кривой)
  sceneCheap: 'fal-ai/bytedance/seedream/v5/lite/edit',  // СЦЕНА: только фон+товар (~$0.035), текст рисует Canvas
  sceneGen:   'fal-ai/nano-banana-2',                    // сцена БЕЗ товара (чистый фон)
  video:      'fal-ai/vidu/q3/image-to-video'            // видео (опция убрана из UI)
  // Ещё дешевле для scene: 'fal-ai/bytedance/seedream/v4.5/edit' (качественнее, ~$0.04)
};

// Разрешение для Nano Banana (КРЕАТИВ). '1K'=$0.08, '2K'=$0.12, '0.5K'=$0.06.
const SCENE_RES = '1K';

function headers() {
  return { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
}

// Быстрый синхронный вызов (картинки готовы за секунды)
async function falSync(model, input) {
  const r = await fetch(`${FAL_SYNC}/${model}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(input)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${model} ${r.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

// Очередь + поллинг (для видео — рендер до нескольких минут)
async function falQueue(model, input, { tries = 90, delay = 4000 } = {}) {
  const sub = await fetch(`${FAL_QUEUE}/${model}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(input)
  });
  const subTxt = await sub.text();
  if (!sub.ok) throw new Error(`${model} submit ${sub.status}: ${subTxt.slice(0, 300)}`);
  const { status_url, response_url } = JSON.parse(subTxt);

  for (let i = 0; i < tries; i++) {
    await new Promise(res => setTimeout(res, delay));
    const st = await fetch(status_url, { headers: headers() });
    const sj = await st.json();
    console.log('  poll', i + 1, sj.status);
    if (sj.status === 'COMPLETED') {
      const res = await fetch(response_url, { headers: headers() });
      return res.json();
    }
    if (['FAILED', 'ERROR', 'CANCELLED'].includes(sj.status)) {
      throw new Error(`${model}: ${sj.status}`);
    }
  }
  throw new Error('Timeout');
}

// ── 1) ВЫРЕЗ ФОНА ────────────────────────────────────────────────
// Вход:  { image }  — data URI (data:image/...;base64,...) ИЛИ обычный URL
// Выход: { url }    — твоя банка на прозрачном PNG (товар не меняется!)
app.post('/api/cutout', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) throw new Error('Нет image');
    const data = await falSync(MODELS.cutout, { image_url: image });
    const url = data.image?.url || data.images?.[0]?.url;
    if (!url) throw new Error('Нет url: ' + JSON.stringify(data).slice(0, 200));
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 2) СЦЕНА (Nano Banana 2) ─────────────────────────────────────
// Вход:  { prompt, images? }
//   - images передан (массив data URI/URL) → режим EDIT: рисуем сцену ВОКРУГ товара,
//     банку держим как референс (Nano Banana сохраняет её намного лучше flux-kontext)
//   - images нет → генерим чистый фон/сцену БЕЗ товара (потом банку кладём на Canvas)
// Выход: { url }
app.post('/api/scene', async (req, res) => {
  try {
    const { prompt, images, cheap } = req.body;
    if (!prompt) throw new Error('Нет prompt');
    const list = images ? (Array.isArray(images) ? images : [images]) : [];

    let data;
    if (list.length) {
      if (cheap) {
        // СЦЕНА: только фон+товар, Seedream Lite (текст потом на Canvas)
        data = await falSync(MODELS.sceneCheap, { prompt, image_urls: list });
      } else {
        // КРЕАТИВ: вся карточка целиком (Seedream 4.5). resolution не передаём — Seedream его не принимает.
        data = await falSync(MODELS.scene, { prompt, image_urls: list });
      }
    } else {
      data = await falSync(MODELS.sceneGen, { prompt });
    }
    const url = data.images?.[0]?.url;
    if (!url) throw new Error('Нет url: ' + JSON.stringify(data).slice(0, 200));
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 3) ВИДЕО (Vidu Q3) ───────────────────────────────────────────
// Вход:  { imageUrl, prompt? }  imageUrl = готовая карточка (URL или data URI)
// Выход: { url } — 5-секундный ролик
app.post('/api/video', async (req, res) => {
  try {
    const { imageUrl, prompt } = req.body;
    if (!imageUrl) throw new Error('Нет imageUrl');
    const data = await falQueue(MODELS.video, {
      prompt: prompt || 'Cinematic slow zoom on the product, subtle sparkle, gentle light shimmer, premium ad',
      image_url: imageUrl,
      duration: 5,          // фиксированно 5 секунд
      resolution: '540p',   // дёшево (~$0.035/сек ≈ $0.18 за ролик). Дороже/чётче: '720p' или '1080p'
      audio: false          // без звука — дешевле
    });
    const url = data.video?.url;
    if (!url) throw new Error('Нет url: ' + JSON.stringify(data).slice(0, 200));
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, models: MODELS }));

// ── 4) CLAUDE (Haiku) — прокси, ключ хранится на сервере ────────────
app.post('/api/claude', async (req, res) => {
  try {
    const CLAUDE_KEY = process.env.CLAUDE_KEY;
    if (!CLAUDE_KEY) throw new Error('CLAUDE_KEY не задан в переменных окружения Render');
    const { model, max_tokens, messages, system } = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: model||'claude-haiku-4-5-20251001', max_tokens: max_tokens||1500, messages, system })
    });
    if (!r.ok) throw new Error(await r.text());
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── 5) ADMIN: Создать пользователя ──────────────────────────────────
app.post('/api/admin/create-user', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) throw new Error('Firebase Admin не настроен');
    const { email, password, sparks, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
    if (!email || !password) throw new Error('Email и пароль обязательны');
    // Создаём пользователя в Firebase Auth
    const user = await adminAuth.createUser({ email, password });
    // Создаём документ в Firestore
    await adminDb.collection('users').doc(user.uid).set({
      email, name: email.split('@')[0], sparks: parseInt(sparks)||0,
      plan: '', createdAt: new Date()
    });
    res.json({ ok: true, uid: user.uid, email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 6) ADMIN: Изменить пароль пользователя ──────────────────────────
app.post('/api/admin/update-password', async (req, res) => {
  try {
    if (!adminAuth) throw new Error('Firebase Admin не настроен');
    const { uid, password, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
    await adminAuth.updateUser(uid, { password });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── 7) ADMIN: Удалить пользователя ──────────────────────────────────
app.post('/api/admin/delete-user', async (req, res) => {
  try {
    if (!adminAuth || !adminDb) throw new Error('Firebase Admin не настроен');
    const { uid, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Нет доступа' });
    await adminAuth.deleteUser(uid);
    await adminDb.collection('users').doc(uid).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(3001, () => {
  console.log('✅ Proxy (fal.ai) запущен: http://localhost:3001');
  console.log(FAL_KEY ? '✅ FAL_KEY: OK' : '⚠️ FAL_KEY не задан — положи в .env');
});