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
// Google khai tử model khá nhanh: gemini-2.0-flash đã ngừng phục vụ trước tháng 09/2026,
// và lời báo lỗi 404 của họ nói thẳng tên model thay thế. Đổi tên ở đúng một dòng này.
const MODEL = 'gemini-3.6-flash';        // rẻ và nhanh; đổi ở đây nếu muốn dùng model khác
const MAX_WORDS = 24;                    // số từ vựng tối đa nhận từ app, chặn lời nhắc phình to
const MAX_COUNT = 20;                    // số câu tối đa cho một bài
const GOI_LAI = 2;                       // số lần gọi lại khi Gemini báo 503 "đang quá tải"
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
      const k = String((env && env.GEMINI_API_KEY) || '');
      const ra = {
        ok: true,
        module1: true,
        hasGeminiKey: !!k.trim(),
        model: MODEL
      };
      // ?debug=1 — chỉ nói HÌNH DÁNG của khoá, không bao giờ nói chính khoá: dài bao nhiêu,
      // có dính khoảng trắng không, có đúng tiền tố Google không. Ba điều đó tìm ra phần lớn
      // ca "API key not valid" mà không lộ gì. Đã mất một lượt đoán mò vì /health chỉ biết
      // khoá CÓ hay KHÔNG, trong khi lỗi thật nằm ở khoá SAI.
      if (url.searchParams.get('debug')) {
        ra.khoa = {
          dai: k.length,
          dinhKhoangTrang: k !== k.trim(),
          dang: dangKhoa(k.trim())
        };
      }
      return json(ra, 200, env, request);
    }

    if (path === '/generate') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Dùng POST cho /generate.' }, 405, env, request);
      }
      return handleGenerate(request, env);
    }

    // ── LỚP BẢO HIỂM ────────────────────────────────────────────────────────
    // Đã có một lần worker này bị triển khai ĐÈ lên chính worker phục vụ app (vì một tệp
    // wrangler.toml lọt vào thư mục repo của app), và cả trang biến thành một dòng JSON 404.
    // Nếu worker được dựng kèm static assets, trả app về thay vì báo lỗi — mất vài dòng mà
    // đổi lấy việc không bao giờ mất trắng trang nữa.
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      try { return await env.ASSETS.fetch(request); } catch (_) { /* rơi xuống 404 bên dưới */ }
    }
    return json({
      ok: false,
      error: 'Không có đường này. Module 1 chỉ có /generate và /health.',
      luuY: 'Nếu bạn thấy dòng này ở ĐỊA CHỈ CỦA APP, nghĩa là worker daily-reading đã bị '
          + 'triển khai đè lên worker phục vụ app. Xem daily-reading-SETUP.md để lấy lại.'
    }, 404, env, request);
  }
};

// ── Module 1: sinh đoạn văn ─────────────────────────────────────────────────
async function handleGenerate(request, env) {
  // Cắt khoảng trắng: dán khoá từ trang Google rất dễ dính một dấu cách hoặc xuống dòng ở
  // cuối, và Google trả về đúng chữ "API key not valid" — không nói gì về khoảng trắng.
  const KEY = String((env && env.GEMINI_API_KEY) || '').trim();
  if (!KEY) {
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
    res = await goiGemini(KEY, prompt);
    // Gemini trả 503 "high demand" khá thường xuyên — đo thật: 3 trên 4 lượt gọi liên tiếp.
    // Đó là trạng thái TẠM, chờ một nhịp rồi gọi lại là qua. Không thử lại thì người học
    // bấm "Soạn bài" mà chẳng ra gì, trong khi chẳng có gì hỏng cả.
    for (let lan = 0; lan < GOI_LAI && res.status === 503; lan++) {
      await new Promise(r => setTimeout(r, 900 * (lan + 1)));
      res = await goiGemini(KEY, prompt);
    }
  } catch (e) {
    return json({ ok: false, error: 'Không gọi được Gemini: ' + (e && e.message || e) }, 502, env, request);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    // 429 = hết hạn mức trong phút/ngày. Nói thẳng ra để app hiện đúng lời nhắn, đừng để
    // người dùng ngồi đoán vì sao bấm mãi không ra bài.
    const hetHan = res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw);
    // Google nói "API key not valid" bằng một câu tiếng Anh lẫn trong JSON lỗi. Dịch nó ra
    // thành lời nhắc đúng việc phải làm, thay vì để người dùng nhìn "Gemini trả lỗi 400."
    const khoaSai = /API_KEY_INVALID|API key not valid/i.test(raw);
    return json({
      ok: false,
      quota: hetHan,
      khoaSai: khoaSai,
      error: hetHan ? 'Gemini đã hết hạn mức miễn phí lúc này. Thử lại sau ít phút.'
           : khoaSai ? 'Google không nhận khoá này. Lấy khoá mới ở aistudio.google.com/apikey '
                     + 'rồi khai lại GEMINI_API_KEY trong Settings của worker. '
                     + 'Khoá hợp lệ bắt đầu bằng "AQ." (dạng mới) hoặc "AIza" (dạng cũ).'
                     : ('Gemini trả lỗi ' + res.status + '.'),
      detail: raw.slice(0, 400)
    }, hetHan ? 429 : 502, env, request);
  }

  const data = await res.json().catch(() => null);
  const text = readGeminiText(data);
  let parsed = parseJsonLoose(text);
  let sentences = (parsed && Array.isArray(parsed.sentences))
    ? parsed.sentences.map(x => cleanLine(x, 400)).filter(Boolean)
    : [];

  if (!sentences.length) {
    return json({ ok: false, error: 'Gemini không trả về câu nào đọc được.', detail: String(text).slice(0, 400) },
                502, env, request);
  }

  // Gemini đã một lần trả về NGUYÊN BÀI TIẾNG VIỆT (tiêu đề thì tiếng Anh) vì lời nhắc cũ
  // nói "for a Vietnamese learner". Lời nhắc nay đã nói rõ, nhưng lời nhắc chỉ là lời XIN.
  // Đo lại kết quả; sai thì nói thẳng vào mặt model rồi xin lại một lần.
  if (!sentences.every(laTiengAnh)) {
    try {
      const res2 = await goiGemini(KEY, prompt
        + '\n\nYour previous answer was in Vietnamese. That was wrong. '
        + 'Write EVERY sentence in "sentences" in ENGLISH.');
      if (res2.ok) {
        const d2 = await res2.json().catch(() => null);
        const p2 = parseJsonLoose(readGeminiText(d2));
        const s2 = (p2 && Array.isArray(p2.sentences))
          ? p2.sentences.map(x => cleanLine(x, 400)).filter(Boolean) : [];
        if (s2.length && s2.every(laTiengAnh)) { parsed = p2; sentences = s2; }
      }
    } catch (_) { /* giữ nguyên kết quả cũ, để bước dưới chặn lại */ }
  }
  // Xin lại vẫn ra tiếng Việt thì THÀ BÁO LỖI còn hơn bày một bài không đọc được để luyện
  // phát âm tiếng Anh. Bày ra mới là làm mất thời gian của người học.
  if (!sentences.every(laTiengAnh)) {
    return json({
      ok: false,
      saiNgonNgu: true,
      error: 'Gemini soạn bài bằng tiếng Việt thay vì tiếng Anh. Bấm "Bài khác" để soạn lại.',
      detail: String(sentences[0] || '').slice(0, 200)
    }, 502, env, request);
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

function goiGemini(KEY, prompt) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      // Khoá đi trong HEADER, không đi trong URL. Hai lý do, cả hai đều đã trả giá:
      //  1. Đường ?key= chỉ còn nhận khoá chuẩn 'AIza…'. Khoá auth 'AQ.…' (mặc định cho
      //     mọi khoá tạo sau 28/05/2026) bị trả về "API key not valid" — nghe như khoá
      //     hỏng, thật ra là gửi sai đường.
      //  2. Khoá nằm trong URL thì lọt vào nhật ký máy chủ và lịch sử duyệt web.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
          // gemini-3.6-flash là model BIẾT SUY NGHĨ: mặc định nó kèm cả phần lập luận vào
          // lời đáp ("Count = 13. (Range: 8-16) -> PASS" — đo được thật ở lượt gọi đầu).
          // Phần ấy không phải JSON, nên bước bóc JSON hỏng dù Gemini đã trả bài xong.
          // Soạn một đoạn văn ngắn thì chẳng cần suy nghĩ, tắt đi: nhanh hơn, rẻ hơn, sạch hơn.
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    }
  );
}

function buildPrompt(count, level, topic, words) {
  // "for a Vietnamese learner" ở bản đầu bị hiểu thành "viết bằng tiếng Việt" — Gemini trả về
  // nguyên bài tiếng Việt, tiêu đề thì tiếng Anh. Đo được thật trên máy người dùng.
  // Bài học: đừng để ngôn ngữ ĐÍCH phải suy ra từ ngữ cảnh. Nói thẳng, nói trước, nói lại.
  const lines = [
    'Write a short passage in ENGLISH for an English-learning student to READ ALOUD as pronunciation practice.',
    'LANGUAGE: every sentence in "sentences" must be ENGLISH. The student is Vietnamese, but the '
      + 'passage they read is ENGLISH. The ONLY Vietnamese text you produce is the "titleVi" field.',
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
    'Return ONLY JSON: {"title":"<short ENGLISH title>","titleVi":"<tiêu đề tiếng Việt>",'
      + '"sentences":["<ENGLISH sentence 1>","<ENGLISH sentence 2>", ...]}',
    'Reminder: "sentences" must be ENGLISH, not Vietnamese.'
  );
  return lines.join('\n');
}

// Lời nhắc đã nói rõ bằng tiếng Anh, nhưng lời nhắc chỉ là lời XIN — không phải bảo đảm.
// Đây là chốt chặn: câu tiếng Anh gần như toàn ký tự ASCII, còn câu tiếng Việt thì 20-30%
// ký tự có dấu. Đếm là biết, không cần hiểu nghĩa.
const PHI_ASCII = new RegExp('[^\\u0000-\\u007F]', 'g');
function laTiengAnh(cau) {
  const s = String(cau || '');
  if (!s) return false;
  const la = (s.match(PHI_ASCII) || []).length;
  // Ngưỡng 12% chứ không phải 5%: câu tiếng Anh ngắn có hai gạch ngang dài và một dấu nháy
  // cong đã chạm 6,7% — chính ca ấy bị bắt nhầm lúc tôi đo lần đầu. Câu tiếng Việt thì
  // 20-30% ký tự có dấu, nên khoảng cách vẫn rất rộng, không sợ lọt.
  return !(la >= 4 && la / s.length > 0.12);
}

// ── Tiện ích nhỏ ────────────────────────────────────────────────────────────
// Google có HAI dạng khoá, và tôi đã đoán nhầm là chỉ có một:
//   'AIza…' — khoá chuẩn (standard key), dạng cũ, Google sẽ ngừng nhận từ 09/2026
//   'AQ.…'  — auth key, dạng mới, mặc định cho mọi khoá tạo sau 28/05/2026
// Cả hai đều gửi bằng header x-goog-api-key. Bản đầu tôi gắn khoá vào ?key= trong URL —
// đường ấy chỉ còn nhận khoá cũ, nên khoá mới bị trả về đúng chữ "API key not valid",
// và tôi lại đi kết luận là "khoá sai". Ghi ra đây để không đoán lại lần nữa.
function dangKhoa(k) {
  if (!k) return 'trong';
  if (/^AIza/.test(k)) return 'chuan';
  if (/^AQ\./.test(k)) return 'auth';
  return 'la';
}
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
    // Bỏ các phần đánh dấu 'thought' — đó là lập luận của model, không phải lời đáp.
    // Đã tắt suy nghĩ bằng thinkingBudget, nhưng vẫn lọc ở đây: một bản model mới hay một
    // lần Google đổi mặc định là lại dính, mà triệu chứng thì rất khó đoán ra.
    return parts.filter(p => !p.thought).map(p => p.text || '').join('');
  } catch (_) { return ''; }
}
// Model thỉnh thoảng bọc JSON trong ```json … ``` dù đã xin responseMimeType. Bóc cho chắc.
function parseJsonLoose(t) {
  const s = String(t || '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
}
