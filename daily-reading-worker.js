/**
 * ════════════════════════════════════════════════════════════════════════════
 *  DAILY READING PRACTICE — Cloudflare Worker
 *  MODULE 1: sinh đoạn văn bằng Gemini (khoá API nằm hẳn ở phía máy chủ)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  VÌ SAO CẦN WORKER, TRONG KHI APP VẪN GỌI GEMINI ĐƯỢC
 *  App là trang tĩnh, nên khoá Gemini hiện đang nằm trong localStorage của
 *  trình duyệt: bất kỳ tiện ích mở rộng nào, hay chính bạn mở DevTools, đều đọc
 *  được. Với khoá miễn phí thì rủi ro nhỏ, nhưng nguyên tắc vẫn sai. Worker này
 *  đứng giữa: app gửi YÊU CẦU (mấy câu, trình độ nào, những từ nào), worker giữ
 *  khoá và gọi Gemini. Khoá không bao giờ rời khỏi máy chủ Cloudflare.
 *
 *  ĐƯA LÊN (một lần, miễn phí)
 *   1. https://dash.cloudflare.com → Compute (Workers) → Create → Hello World → Deploy
 *   2. Edit code → xoá mã mẫu → dán TOÀN BỘ tệp này → Deploy
 *   3. Settings → Variables and Secrets → Add:
 *        GEMINI_API_KEY   (kiểu Secret)  — lấy miễn phí ở https://aistudio.google.com/apikey
 *        ALLOW_ORIGIN     (kiểu Text)    — địa chỉ app của bạn, ví dụ
 *                                          https://ethannguyen.chinhnguyen1990cr.workers.dev
 *      Module 3 sẽ cần thêm AZURE_SPEECH_KEY và AZURE_REGION — chưa cần lúc này.
 *   4. Copy địa chỉ worker → mở app → Daily Reading Practice → dán vào ô "Địa chỉ Worker".
 *
 *  Muốn triển khai bằng dòng lệnh thì xem wrangler.toml đi kèm.
 *
 *  ĐƯỜNG ĐI (Module 1)
 *   POST /generate
 *     body: { "count": 5, "level": "B1", "words": ["bag","assume", ...], "topic": "" }
 *     trả:  { "ok": true, "title": "...", "titleVi": "...", "sentences": ["...", ...] }
 *
 *   GET /health → { ok:true, module1:true, hasGeminiKey:true|false }
 *     Dùng để app kiểm tra worker đã dựng đúng chưa, KHÔNG lộ khoá.
 */

// ── Cấu hình chung ──────────────────────────────────────────────────────────
const MODEL = 'gemini-2.0-flash';        // rẻ và nhanh; đổi ở đây nếu muốn dùng model khác
const MAX_WORDS = 24;                    // số từ vựng tối đa nhận từ app, chặn lời nhắc phình to
const MAX_COUNT = 20;                    // số câu tối đa cho một bài
const LEVELS = {
  A2: 'CEFR A2: short simple sentences, very common everyday words',
  B1: 'CEFR B1: everyday topics, some linking words, moderate sentence length',
  B2: 'CEFR B2: natural connected prose, varied structures, some idiomatic phrasing',
  C1: 'CEFR C1: fluent, nuanced, varied register and rhythm'
};

// ── CORS ────────────────────────────────────────────────────────────────────
// ALLOW_ORIGIN để trống thì mở cho mọi nguồn — tiện lúc thử, nhưng ĐẶT ĐÚNG địa chỉ app
// của bạn là điều nên làm: nếu không, bất kỳ trang nào cũng gọi được worker này và tiêu
// hạn mức Gemini của bạn.
function corsHeaders(env, request) {
  const allow = (env && env.ALLOW_ORIGIN || '').trim();
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allow ? (origin === allow ? allow : allow) : '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
function json(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env, request) }
  });
}

// ── Vào cửa ─────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env, request) });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      return json({
        ok: true,
        module1: true,
        hasGeminiKey: !!(env && env.GEMINI_API_KEY),
        model: MODEL
      }, 200, env, request);
    }

    if (path === '/generate') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Dùng POST cho /generate.' }, 405, env, request);
      }
      return handleGenerate(request, env);
    }

    return json({ ok: false, error: 'Không có đường này. Module 1 chỉ có /generate và /health.' },
                404, env, request);
  }
};

// ── Module 1: sinh đoạn văn ─────────────────────────────────────────────────
async function handleGenerate(request, env) {
  if (!env || !env.GEMINI_API_KEY) {
    return json({ ok: false, error: 'Worker chưa có GEMINI_API_KEY. Vào Settings → Variables and Secrets để thêm.' },
                500, env, request);
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return json({ ok: false, error: 'Body phải là JSON.' }, 400, env, request); }

  // Làm sạch đầu vào TRƯỚC khi ghép vào lời nhắc. Đây là chỗ duy nhất dữ liệu ngoài chui
  // vào prompt, nên cũng là chỗ duy nhất cần canh.
  const count = clampInt(body && body.count, 3, MAX_COUNT, 5);
  const level = LEVELS[String(body && body.level || '').toUpperCase()] ? String(body.level).toUpperCase() : 'B1';
  const topic = cleanLine(body && body.topic, 90);
  const words = Array.isArray(body && body.words)
    ? body.words.map(w => cleanLine(w, 40)).filter(Boolean).slice(0, MAX_WORDS)
    : [];

  const prompt = buildPrompt(count, level, topic, words);

  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 1200,
            responseMimeType: 'application/json'
          }
        })
      }
    );
  } catch (e) {
    return json({ ok: false, error: 'Không gọi được Gemini: ' + (e && e.message || e) }, 502, env, request);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    // 429 = hết hạn mức trong phút/ngày. Nói thẳng ra để app hiện đúng lời nhắn, đừng để
    // người dùng ngồi đoán vì sao bấm mãi không ra bài.
    const hetHan = res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw);
    return json({
      ok: false,
      quota: hetHan,
      error: hetHan ? 'Gemini đã hết hạn mức miễn phí lúc này. Thử lại sau ít phút.'
                    : ('Gemini trả lỗi ' + res.status + '.'),
      detail: raw.slice(0, 400)
    }, hetHan ? 429 : 502, env, request);
  }

  const data = await res.json().catch(() => null);
  const text = readGeminiText(data);
  const parsed = parseJsonLoose(text);
  const sentences = (parsed && Array.isArray(parsed.sentences))
    ? parsed.sentences.map(x => cleanLine(x, 400)).filter(Boolean)
    : [];

  if (!sentences.length) {
    return json({ ok: false, error: 'Gemini không trả về câu nào đọc được.', detail: String(text).slice(0, 400) },
                502, env, request);
  }

  // Những từ thật sự được dùng — app dùng con số này để biết bài có bám vốn từ của bạn không.
  const joined = sentences.join(' ').toLowerCase();
  const used = words.filter(w => joined.includes(String(w).toLowerCase()));

  return json({
    ok: true,
    title: cleanLine(parsed.title, 120) || 'Reading practice',
    titleVi: cleanLine(parsed.titleVi, 160),
    sentences: sentences.slice(0, count),
    level,
    wordsAsked: words.length,
    wordsUsed: used
  }, 200, env, request);
}

function buildPrompt(count, level, topic, words) {
  const lines = [
    'Write a short passage for a Vietnamese learner to READ ALOUD as pronunciation practice.',
    `- Exactly ${count} sentences. Each sentence 8-16 words — long enough to need real phrasing, short enough to say in one breath.`,
    `- Level: ${LEVELS[level]}.`
  ];
  if (topic) lines.push(`- Topic: ${topic}.`);
  if (words.length) {
    lines.push(`- Weave in as many of these words as fit NATURALLY (do not force all of them, do not list them): ${words.join(', ')}.`);
  }
  lines.push(
    '- It must read like one connected little story or reflection, NOT a list of unrelated sentences.',
    '- Use natural spoken rhythm: contractions, a question or an exclamation somewhere, varied sentence openings.',
    '- No headings, no bullet points, no emoji, no quotation marks around the whole thing.',
    'Return ONLY JSON: {"title":"<short English title>","titleVi":"<tiêu đề tiếng Việt>","sentences":["<sentence 1>", ...]}'
  );
  return lines.join('\n');
}

// ── Tiện ích nhỏ ────────────────────────────────────────────────────────────
function clampInt(v, min, max, mac) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return mac;
  return Math.max(min, Math.min(max, n));
}
// Một dòng chữ an toàn để ghép vào lời nhắc: bỏ xuống dòng và ký tự điều khiển, cắt độ dài.
// Không có bước này thì người ta dán được cả một đoạn "quên hết lời dặn trên" vào ô chủ đề.
// Ky tu dieu khien dung tu CHUOI chu khong viet thang vao bieu thuc: viet thang thi chinh
// tep ma nguon chua byte dieu khien that, va lan dau toi viet thang, tep da thanh binary that.
const DIEU_KHIEN = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');
function cleanLine(v, max) {
  return String(v == null ? '' : v)
    .replace(DIEU_KHIEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}
function readGeminiText(data) {
  try {
    const parts = data.candidates[0].content.parts || [];
    return parts.map(p => p.text || '').join('');
  } catch (_) { return ''; }
}
// Model thỉnh thoảng bọc JSON trong ```json … ``` dù đã xin responseMimeType. Bóc cho chắc.
function parseJsonLoose(t) {
  const s = String(t || '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
}
