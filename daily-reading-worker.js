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
// v261 — HẠN MỨC TÍNH THEO TỪNG MODEL. Đo thật ngày 25/09/2026, chính Google trả về:
//   quotaId:    GenerateRequestsPerDayPerProjectPerModel-FreeTier
//   quotaValue: 20          model: gemini-3.6-flash
// Hai mươi lượt MỘT NGÀY cho model ấy — không phải mỗi phút. App dùng Gemini cho cả soạn
// bài, chấm phát âm lẫn dịch từ vựng, nên hai mươi lượt bay trong chốc lát. Đó là lý do
// "lúc nào cũng hết hạn mức".
//
// Chữ PerModel trong tên hạn mức chính là lối ra: MỖI MODEL MỘT TÚI RIÊNG. Hết túi của
// model này thì chuyển sang model kế, không phải ngồi chờ tới nửa đêm giờ Thái Bình Dương.
// Xếp model nhẹ (flash-lite) lên trước cho việc dịch vặt, để dành model mạnh cho việc khó.
// Danh sách này ĐÃ ĐO trên chính khoá của bạn qua /models, không phải đoán. Mấy tên tôi
// đoán lúc đầu (gemini-2.0-flash, gemini-2.0-flash-lite) trả về 404 — khoá này không có.
const MODELS = [
  'gemini-3.6-flash',        // đo: 200 OK
  'gemini-3.5-flash-lite',   // nhẹ, hạn mức thường rộng hơn
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash'
];
const MODEL = MODELS[0];        // rẻ và nhanh; đổi ở đây nếu muốn dùng model khác
const MAX_WORDS = 24;                    // số từ vựng tối đa nhận từ app, chặn lời nhắc phình to
const MAX_COUNT = 20;                    // số câu tối đa cho một bài
const GOI_LAI = 2;                       // số lần gọi lại khi Gemini báo 503 "đang quá tải"
// v259 — ĐƯỜNG CHẤM GỌI LẠI ÍT HƠN. Đo thật ngày 24/09/2026: gọi /generate (chỉ chữ) ba lần
// liên tiếp đều 200 OK, nhưng /score (kèm âm) thì lần đầu 503 sau ba lượt thử, rồi hai lần
// sau đều 429 "hết hạn mức". Nghĩa là hạn mức cho ÂM eo hẹp hơn hạn mức cho CHỮ rất nhiều,
// và mỗi lượt thử lại cũng ăn một phần hạn mức ấy. Thử ba lượt là tự đốt hạn mức của chính
// mình rồi nhận 429 ngay sau đó.
const GOI_LAI_CHAM = 1;
const MAX_AM_B64 = 9 * 1024 * 1024;      // trần cho một gói âm (base64). 30 giây WAV 16k ≈ 1,3MB
// v257 — đọc CẢ ĐOẠN thì bản ghi dài hơn hẳn một câu. Azure dùng đường "short audio"
// (speech/recognition/conversation/cognitiveservices/v1) — trần CỨNG 60 giây, không có
// cách nào lách. Chặn ngay tại đây và nói rõ, thay vì để người ta đọc xong hai phút rồi
// mới nhận một lỗi Azure khó hiểu.
const AZURE_GIAY_TOI_DA = 58;
const CHAM_HOP_LE = ['azure', 'gemini'];
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
      const az = String((env && env.AZURE_SPEECH_KEY) || '').trim();
      const vung = String((env && env.AZURE_REGION) || '').trim();
      const ra = {
        ok: true,
        module1: true,
        module3: true,
        hasGeminiKey: !!k.trim(),
        model: MODEL,
        // v261 — cả danh sách dự phòng, để nhìn một cái là biết hết model này còn model nào.
        models: MODELS,
        // App dùng ba cờ này để biết lối chấm nào bấm được. Không có chúng thì người học
        // bấm "Chấm" bằng Azure rồi mới biết worker chưa khai khoá Azure — biết muộn.
        cham: {
          gemini: !!k.trim(),
          azure: !!(az && vung),
          azureVung: vung || null
        }
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

    if (path === '/models') {
      return handleModels(request, env);
    }

    if (path === '/generate') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Dùng POST cho /generate.' }, 405, env, request);
      }
      return handleGenerate(request, env);
    }

    if (path === '/score') {
      if (request.method !== 'POST') {
        return json({ ok: false, error: 'Dùng POST cho /score.' }, 405, env, request);
      }
      return handleScore(request, env);
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

  let res, modelDung;
  try {
    const kq0 = await goiCoDuPhong((m) => goiGemini(KEY, prompt, m));
    res = kq0.res; modelDung = kq0.model;
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
    // "User location is not supported" KHÔNG phải lỗi khoá, cũng không phải hết hạn mức.
    // Nó nghĩa là worker đang chạy ở một điểm mạng Cloudflare mà Google không phục vụ.
    // Đã mất hai lượt chẩn đoán vì lời báo cũ chỉ nói "Gemini trả lỗi 400." — nhìn vào
    // không ai đoán ra là chuyện vị trí, chứ đừng nói biết phải sửa ở đâu.
    const saiVung = /User location is not supported|FAILED_PRECONDITION/i.test(raw);
    return json({
      ok: false,
      quota: hetHan,
      khoaSai: khoaSai,
      saiVung: saiVung,
      error: hetHan ? 'Gemini đã hết hạn mức miễn phí lúc này. Thử lại sau ít phút.'
           : khoaSai ? 'Google không nhận khoá này. Lấy khoá mới ở aistudio.google.com/apikey '
                     + 'rồi khai lại GEMINI_API_KEY trong Settings của worker. '
                     + 'Khoá hợp lệ bắt đầu bằng "AQ." (dạng mới) hoặc "AIza" (dạng cũ).'
           : saiVung ? 'Worker đang chạy ở vùng Google không phục vụ. Vào Cloudflare → worker '
                     + 'daily-reading → Settings → Runtime → Placement, chọn Region → '
                     + 'Google Cloud Platform (GCP) → us-central1, rồi bấm Deploy.'
                     : ('Gemini trả lỗi ' + res.status + '.'),
      detail: raw.slice(0, 1500)
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

// ══════════════════════════════════════════════════════════════════════════════════════
//  MODULE 3 — CHẤM PHÁT ÂM
//  Hai lối chấm, MỘT dạng dữ liệu trả về. App chỉ biết dạng chung ấy, không cần biết hôm
//  nay chấm bằng Azure hay Gemini — đổi lối chấm không phải sửa một dòng giao diện nào.
//
//  Dạng chung:
//    { ok, nguon:'azure'|'gemini',
//      diem:{ chung, chuanXac, troiChay, tronVen },   // 0-100, thiếu thì null
//      tu:[ { chu, diem, loi } ],                     // loi: ''|'thieu'|'thua'|'sai'
//      nhanXet:[ '…' ],                               // lời khuyên, tiếng Việt
//      ngheThay }                                     // máy nghe ra bạn đọc gì
// ══════════════════════════════════════════════════════════════════════════════════════
// v261 — /models: hỏi thẳng Google xem khoá này dùng được những model nào, và model nào
// còn hạn mức. Không có đường này thì mỗi lần nghi ngờ lại phải đoán tên model rồi thử mò.
async function handleModels(request, env) {
  const KEY = String((env && env.GEMINI_API_KEY) || '').trim();
  if (!KEY) return json({ ok: false, error: 'Worker chưa có GEMINI_API_KEY.' }, 400, env, request);
  let co = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': KEY } });
    const j = await r.json().catch(() => null);
    co = ((j && j.models) || [])
      .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
      .map(m => String(m.name || '').replace('models/', ''));
  } catch (e) {
    return json({ ok: false, error: 'Không hỏi được danh sách model: ' + (e && e.message || e) },
                502, env, request);
  }
  // Thử từng model trong danh sách dự phòng bằng một lời nhắc CỰC NGẮN, để biết model nào
  // còn hạn mức thật. Mỗi lượt thử cũng ăn một lượt hạn mức, nên lời nhắc phải ngắn nhất có thể.
  const thu = [];
  if (new URL(request.url).searchParams.get('thu') === '1') {
    for (const m of MODELS) {
      try {
        const r = await goiGemini(KEY, 'Say OK.', m);
        let vi = '';
        if (!r.ok) { const t = await r.text().catch(() => ''); vi = t.slice(0, 200); }
        thu.push({ model: m, http: r.status, dung: r.ok, viSao: vi });
      } catch (e) { thu.push({ model: m, loi: String(e && e.message || e).slice(0, 60) }); }
    }
  }
  return json({ ok: true, duPhong: MODELS,
    coTrongTaiKhoan: co.filter(n => /gemini/.test(n)).slice(0, 40), thu }, 200, env, request);
}

async function handleScore(request, env) {
  let body;
  try { body = await request.json(); }
  catch (_) { return json({ ok: false, error: 'Body phải là JSON.' }, 400, env, request); }

  // v257 — đọc cả đoạn thì câu gốc dài hơn một câu rất nhiều. Cắt ở 400 ký tự là cắt cụt
  // đoạn văn, và phần chấm sẽ báo "thiếu" hàng loạt từ mà người học đã đọc đúng.
  const text = cleanLine(body && body.text, 3000);
  const am   = String((body && body.audio) || '');
  const cham = CHAM_HOP_LE.indexOf(String((body && body.cham) || '')) >= 0 ? body.cham : 'azure';

  if (!text) return json({ ok: false, error: 'Thiếu câu gốc để đối chiếu.' }, 400, env, request);
  if (!am)   return json({ ok: false, error: 'Thiếu dữ liệu âm thanh.' }, 400, env, request);
  if (am.length > MAX_AM_B64) {
    return json({ ok: false, error: 'Đoạn ghi âm dài quá. Đọc lại ngắn hơn, mỗi lần một câu thôi.' },
                413, env, request);
  }

  if (cham === 'azure') {
    // Trần 60 giây của đường "short audio" là giới hạn của Azure, không phải của worker.
    // Nói thẳng ra và chỉ đúng hai lối đi tiếp, thay vì chuyển tiếp một lỗi Azure khó hiểu.
    const giay = giayWavB64(am);
    if (giay > AZURE_GIAY_TOI_DA) {
      return json({
        ok: false, quaDai: true, nguon: 'azure',
        error: 'Bản ghi dài ' + Math.round(giay) + ' giây. Azure chỉ chấm được tối đa '
             + AZURE_GIAY_TOI_DA + ' giây một lần. Chấm từng câu, hoặc chuyển công tắc sang Gemini.'
      }, 400, env, request);
    }
    const az = String((env && env.AZURE_SPEECH_KEY) || '').trim();
    const vung = String((env && env.AZURE_REGION) || '').trim();
    if (!az || !vung) {
      // Nói rõ thiếu CÁI GÌ và app nên làm gì tiếp — đừng để người học đoán.
      return json({
        ok: false,
        thieuKhoa: 'azure',
        error: 'Worker chưa khai ' + (!az ? 'AZURE_SPEECH_KEY' : 'AZURE_REGION')
             + '. Chuyển công tắc sang Gemini, hoặc khai biến đó trong Settings của worker.'
      }, 400, env, request);
    }
    return chamAzure(az, vung, am, text, env, request);
  }

  const KEY = String((env && env.GEMINI_API_KEY) || '').trim();
  if (!KEY) {
    return json({ ok: false, thieuKhoa: 'gemini',
      error: 'Worker chưa có GEMINI_API_KEY.' }, 400, env, request);
  }
  return chamGemini(KEY, am, text, env, request);
}

// ── Lối 1: Azure Pronunciation Assessment ────────────────────────────────────────────
// Azure chấm từng từ và cho ba điểm thành phần. Đây là thứ sát nhất với "giáo viên chấm
// phát âm" mà một API có thể làm. Đổi lại: nó KÉN định dạng — WAV 16kHz mono PCM, đúng
// thứ Module 2 đã chuyển sẵn ở trình duyệt.
async function chamAzure(key, vung, amB64, text, env, request) {
  const cauHinh = {
    ReferenceText: text,
    GradingSystem: 'HundredMark',
    Granularity: 'Word',
    // EnableMiscue: Azure đối chiếu câu bạn ĐỌC với câu gốc, nên bắt được cả từ ĐỌC THIẾU
    // và từ ĐỌC THÊM. Tắt nó đi thì đọc sót nửa câu vẫn có thể được điểm cao.
    EnableMiscue: true
  };
  const dc = 'https://' + encodeURIComponent(vung)
    + '.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1'
    + '?language=en-US&format=detailed';
  let res;
  try {
    res = await fetch(dc, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        // Azure đòi cấu hình chấm điểm đi trong HEADER, và phải là base64 của chuỗi JSON.
        'Pronunciation-Assessment': b64Chu(JSON.stringify(cauHinh)),
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Accept': 'application/json'
      },
      body: b64SangByte(amB64)
    });
  } catch (e) {
    return json({ ok: false, error: 'Không gọi được Azure: ' + (e && e.message || e) }, 502, env, request);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const saiKhoa = res.status === 401 || res.status === 403;
    return json({
      ok: false,
      saiKhoa: saiKhoa,
      error: saiKhoa
        ? 'Azure không nhận khoá hoặc vùng. Kiểm tra lại AZURE_SPEECH_KEY và AZURE_REGION.'
        : 'Azure trả lỗi ' + res.status + '.',
      detail: raw.slice(0, 300)
    }, saiKhoa ? 401 : 502, env, request);
  }
  const d = await res.json().catch(() => null);
  return json(chuanHoaAzure(d, text), 200, env, request);
}

function chuanHoaAzure(d, text) {
  const nb = d && Array.isArray(d.NBest) && d.NBest[0] ? d.NBest[0] : null;
  const pa = nb && nb.PronunciationAssessment ? nb.PronunciationAssessment : null;
  if (!pa) {
    // RecognitionStatus 'NoMatch' nghĩa là Azure không nghe ra tiếng nói nào.
    const tt = d && d.RecognitionStatus;
    return {
      ok: false,
      nguon: 'azure',
      error: (tt === 'NoMatch' || tt === 'InitialSilenceTimeout')
        ? 'Azure không nghe ra tiếng nói nào. Thu lại, nói to và gần micro hơn.'
        : 'Azure không trả về điểm phát âm.' + (tt ? ' (' + tt + ')' : '')
    };
  }
  const tu = (nb.Words || []).map(w => ({
    chu: String(w.Word || ''),
    diem: soTron(w.PronunciationAssessment && w.PronunciationAssessment.AccuracyScore),
    loi: doiLoiAzure(w.PronunciationAssessment && w.PronunciationAssessment.ErrorType)
  }));
  return {
    ok: true,
    nguon: 'azure',
    diem: {
      chung:    soTron(pa.PronScore),
      chuanXac: soTron(pa.AccuracyScore),
      troiChay: soTron(pa.FluencyScore),
      tronVen:  soTron(pa.CompletenessScore)
    },
    tu: tu,
    ngheThay: String(nb.Display || nb.Lexical || ''),
    nhanXet: loiKhuyen(tu, pa)
  };
}
// Độ dài bản ghi, suy ra từ kích thước base64. App luôn gửi WAV 16kHz mono 16-bit, nên
// số byte dữ liệu chia cho 32000 là ra số giây — không cần giải mã cả tệp chỉ để đo.
function giayWavB64(b64) {
  const byte = Math.floor(String(b64 || '').length * 3 / 4);
  return Math.max(0, (byte - 44) / (16000 * 2));
}
function doiLoiAzure(t) {
  if (t === 'Omission') return 'thieu';     // bạn bỏ sót từ này
  if (t === 'Insertion') return 'thua';     // bạn đọc thêm từ không có trong câu
  if (t === 'Mispronunciation') return 'sai';
  return '';
}
// Điểm số trần trụi thì khó biết phải làm gì. Đổi ra vài câu nhắc cụ thể.
function loiKhuyen(tu, pa) {
  const ra = [];
  const kem = tu.filter(w => w.loi === 'sai' || (w.diem != null && w.diem < 60));
  if (kem.length) {
    ra.push('Đọc lại kỹ ' + kem.length + ' từ: '
      + kem.slice(0, 6).map(w => w.chu).join(', ') + (kem.length > 6 ? '…' : ''));
  }
  const thieu = tu.filter(w => w.loi === 'thieu');
  if (thieu.length) ra.push('Bạn đọc sót ' + thieu.length + ' từ — đọc chậm lại, đừng nuốt chữ.');
  const thua = tu.filter(w => w.loi === 'thua');
  if (thua.length) ra.push('Có ' + thua.length + ' từ thừa so với câu gốc.');
  const tc = soTron(pa.FluencyScore);
  // Ngưỡng 75 chứ không phải 70: Azure chấm trôi chảy so với người bản ngữ, nên 72 điểm
  // nghe vẫn còn vấp rõ. Dưới 75 là đáng nhắc.
  if (tc != null && tc < 75) ra.push('Nhịp đọc còn ngắt quãng. Thử đọc liền hơi cả câu một lần.');
  const tv = soTron(pa.CompletenessScore);
  if (tv != null && tv < 80) ra.push('Chưa đọc hết câu — kiểm tra lại phần cuối.');
  if (!ra.length) ra.push('Câu này đọc tốt. Giữ nhịp ấy cho câu sau.');
  return ra;
}
function soTron(v) {
  // Number(null) là 0, và isFinite(0) là true — nên bản đầu biến "THIẾU điểm" thành "0 điểm".
  // Trên màn hình, 0 điểm nghĩa là "đọc rất tệ", còn thiếu điểm nghĩa là "chưa chấm được".
  // Hai chuyện khác hẳn nhau. Phép đo bắt đúng chỗ này trước khi nó kịp ra tới người học.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? Math.round(n) : null;
}

// ── Lối 2: Gemini nghe và nhận xét ───────────────────────────────────────────────────
// Dùng khi Azure hết gói miễn phí, hoặc chưa kịp khai khoá Azure. Gemini không cho điểm
// từng từ chính xác như Azure, nhưng nghe được và nhận xét được — và nó dùng chung đúng
// cái khoá Gemini đã khai cho Module 1, nên không phải dựng thêm gì.
async function chamGemini(KEY, amB64, text, env, request) {
  const prompt = [
    'You are an English pronunciation coach for a Vietnamese learner.',
    'The audio is the learner reading this sentence aloud:',
    '"' + text + '"',
    'Listen, then return ONLY JSON in this exact shape:',
    '{"speech":<true if you can hear a human voice speaking English words, false otherwise>,',
    ' "heard":"<what you actually hear them say>",',
    ' "overall":<0-100>,"accuracy":<0-100>,"fluency":<0-100>,"completeness":<0-100>,',
    ' "words":[{"w":"<word from the sentence>","s":<0-100>,"e":"" | "sai" | "thieu"}],',
    ' "tips":["<lời khuyên NGẮN bằng TIẾNG VIỆT>", "..."]}',
    'Rules:',
    '- "words" must list EVERY word of the sentence, in order, even the ones read well.',
    '- "e" is "thieu" if they skipped the word, "sai" if clearly mispronounced, "" otherwise.',
    '- "tips": 1 to 3 items, in VIETNAMESE, each naming a concrete sound or word to fix.',
    '- Be honest but encouraging. Do not invent errors that are not audible.',
    '- CRITICAL: if the audio has NO intelligible human speech (silence, noise, a tone, music),',
    '  set "speech": false, leave "words" empty, and do NOT invent any scores. A score made up',
    '  for audio with no speech is worse than no score at all.',
    '- Do NOT simply echo the sentence above as what you heard. Report what the AUDIO contains.'
  ].join('\n');

  // v258 — ĐƯỜNG NÀY TRƯỚC ĐÂY KHÔNG CÓ GỌI LẠI. Đường sinh bài có, đường chấm điểm thì
  // tôi bỏ sót, nên người dùng đọc xong một câu rồi nhận đúng dòng "Gemini trả lỗi 503."
  // 503 là "đang quá tải" — trạng thái TẠM, chờ một nhịp gọi lại là qua, chẳng có gì hỏng.
  const goi = (model)=>fetch(urlGemini(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { text: prompt },
        // Âm thanh đi kèm ngay trong lời nhắc, dạng base64. WAV 16kHz mono mà Module 2
        // dựng sẵn dùng được luôn, không phải chuyển thêm lần nữa.
        { inline_data: { mime_type: 'audio/wav', data: amB64 } }
      ] }],
      generationConfig: {
        temperature: 0.2,          // chấm điểm thì cần ổn định, không cần sáng tạo
        maxOutputTokens: 1200,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });
  let res, modelDung;
  try {
    const kq0 = await goiCoDuPhong(goi);       // hết hạn mức model này thì sang model kế
    res = kq0.res; modelDung = kq0.model;
    // 503 là "đang quá tải" — khác hẳn hết hạn mức, chờ một nhịp rồi gọi lại chính model ấy.
    for (let lan = 0; lan < GOI_LAI_CHAM && res.status === 503; lan++) {
      await new Promise(r => setTimeout(r, 1500 * (lan + 1)));
      res = await goi(modelDung);
    }
  } catch (e) {
    return json({ ok: false, error: 'Không gọi được Gemini: ' + (e && e.message || e) }, 502, env, request);
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const hetHan = res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(raw);
    const saiVung = /User location is not supported|FAILED_PRECONDITION/i.test(raw);
    // Đã gọi lại GOI_LAI lần mà vẫn 503 thì đó là Google đang quá tải thật. Nói đúng như
    // vậy, kèm việc nên làm — chứ "Gemini trả lỗi 503." không cho người học biết gì cả.
    const quaTai = res.status === 503 || /UNAVAILABLE|overloaded/i.test(raw);
    return json({
      ok: false, quota: hetHan, saiVung: saiVung, quaTai: quaTai,
      error: hetHan ? 'Gemini đã hết hạn mức cho phần CHẤM PHÁT ÂM. Gói miễn phí tính hạn '
                    + 'mức cho âm thanh nặng hơn cho chữ rất nhiều, nên soạn bài vẫn chạy mà '
                    + 'chấm điểm thì hết trước. Chờ ít phút rồi thử lại, hoặc khai khoá Azure '
                    + 'Speech (5 giờ/tháng miễn phí) để phần chấm không phụ thuộc Gemini nữa.'
           : quaTai ? 'Máy chủ Gemini đang quá tải (đã thử lại ' + (GOI_LAI_CHAM + 1)
                    + ' lần). Bấm "Chấm phát âm" lại sau khoảng một phút — bản ghi của bạn '
                    + 'vẫn còn nguyên, không phải đọc lại.'
           : saiVung ? 'Worker đang chạy ở vùng Google không phục vụ. Vào Cloudflare → worker '
                     + 'daily-reading → Settings → Runtime → Placement, chọn Region → '
                     + 'Google Cloud Platform (GCP) → us-central1, rồi bấm Deploy.'
                     : 'Gemini trả lỗi ' + res.status + '.',
      detail: raw.slice(0, 1500)
    }, hetHan ? 429 : 502, env, request);
  }
  const d = await res.json().catch(() => null);
  const p = parseJsonLoose(readGeminiText(d));
  if (!p) return json({ ok: false, error: 'Gemini không trả về kết quả đọc được.' }, 502, env, request);
  const kq = chuanHoaGemini(p, text);
  if (kq && kq.ok) kq.model = modelDung;
  return json(kq, 200, env, request);
}

function chuanHoaGemini(p, text) {
  // ĐO THẬT: gửi một đoạn SÓNG SIN 1,5 giây — không phải tiếng người — kèm câu gốc, thì
  // Gemini chấm 96/100 và "nghe thấy" đúng nguyên câu nằm trong lời nhắc. Tức là nó ĐỌC LẠI
  // câu gốc chứ không nghe. Điểm bịa còn tệ hơn không có điểm: người học tưởng mình đọc tốt.
  // Nên hỏi thẳng nó có nghe ra tiếng người không, và tin câu trả lời ấy TRƯỚC khi tin điểm.
  if (p && p.speech === false) {
    return { ok: false, nguon: 'gemini',
      error: 'Không nghe ra tiếng nói nào trong bản ghi. Thu lại, nói to và gần micro hơn.' };
  }
  const tu = Array.isArray(p.words) ? p.words.map(w => ({
    chu: cleanLine(w && w.w, 40),
    diem: soTron(w && w.s),
    loi: (w && (w.e === 'sai' || w.e === 'thieu' || w.e === 'thua')) ? w.e : ''
  })).filter(w => w.chu) : [];
  const nx = Array.isArray(p.tips) ? p.tips.map(t => cleanLine(t, 160)).filter(Boolean).slice(0, 4) : [];
  return {
    ok: true,
    nguon: 'gemini',
    diem: {
      chung:    soTron(p.overall),
      chuanXac: soTron(p.accuracy),
      troiChay: soTron(p.fluency),
      tronVen:  soTron(p.completeness)
    },
    tu: tu,
    ngheThay: cleanLine(p.heard, 400),
    nhanXet: nx.length ? nx : ['Đã chấm xong.']
  };
}

// ── base64 ───────────────────────────────────────────────────────────────────────────
// atob/btoa có sẵn trong Workers. Viết thành hai hàm nhỏ để chỗ gọi đọc ra ý, và để mọi
// chỗ dùng chung một cách làm.
function b64SangByte(b64) {
  const chuoi = atob(b64);
  const ra = new Uint8Array(chuoi.length);
  for (let i = 0; i < chuoi.length; i++) ra[i] = chuoi.charCodeAt(i);
  return ra;
}
function b64Chu(t) {
  // JSON cấu hình của Azure có thể chứa chữ có dấu (câu gốc là tiếng Anh, nhưng không nên
  // dựa vào đó). btoa chỉ nhận byte 0-255, nên mã hoá UTF-8 trước.
  const b = new TextEncoder().encode(t);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// Một chỗ duy nhất dựng địa chỉ Gemini. Trước đây viết ở hai nơi — đổi model là phải nhớ
// sửa cả hai, mà quên một chỗ thì lỗi chỉ hiện ra ở đúng một đường gọi.
// Model nào nhận thinkingConfig? Đo được: 3.6-flash nhận, 3.5-flash-lite trả 400.
// Quy tắc dè dặt: chỉ gắn cho model KHÔNG phải bản lite.
function nhanThinking(model) { return !/lite/i.test(String(model || MODEL)); }
function urlGemini(model) {
  return 'https://generativelanguage.googleapis.com/v1beta/models/'
       + (model || MODEL) + ':generateContent';
}
// Hết hạn mức của một model thì thử model kế. Trả về {res, model} của lượt gọi cuối cùng.
// KHÔNG chuyển model khi lỗi là 400/403 (khoá sai, vùng sai…) — đổi model không cứu được
// mấy lỗi ấy, chỉ tốn thêm lượt gọi.
async function goiCoDuPhong(goi) {
  let res = null, model = null;
  for (let i = 0; i < MODELS.length; i++) {
    model = MODELS[i];
    res = await goi(model);
    if (res.status !== 429) break;          // chỉ 429 (hết hạn mức) mới đáng đổi model
    if (i < MODELS.length - 1) {
      // Không chờ giữa hai model: hạn mức là theo NGÀY, chờ vài giây không giúp gì.
      continue;
    }
  }
  return { res, model };
}

function goiGemini(KEY, prompt, model) {
  return fetch(
    urlGemini(model),
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
          // Mấy model *-lite KHÔNG nhận tham số này và trả về 400 (đo được qua /models).
          // Chỉ gắn khi model thật sự nhận.
          ...(nhanThinking(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
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
  // v257 — người dùng gõ ý tưởng bằng tiếng Việt là chuyện bình thường; nói rõ cho model
  // biết ý tưởng có thể ở ngôn ngữ nào, nhưng BÀI VIẾT RA vẫn phải là tiếng Anh.
  if (topic) {
    lines.push(`- The student asked for this idea (it may be written in Vietnamese; still write the passage in ENGLISH): "${topic}".`,
               '- Follow that idea closely. It is the subject of the whole passage, not a passing mention.');
  }
  if (words.length) {
    lines.push(`- Weave in as many of these words as fit NATURALLY (do not force all of them, do not list them): ${words.join(', ')}.`);
  }
  lines.push(
    // v257 — người dùng báo: các câu ra rời rạc, mỗi câu một chuyện. Một dòng "nên liền
    // mạch" là quá nhẹ. Nay nói thành YÊU CẦU CỤ THỂ, KIỂM CHỨNG ĐƯỢC: một chủ đề, một
    // mạch thời gian, câu sau nối vào câu trước bằng đại từ hoặc từ nối.
    'COHERENCE — this is the most important requirement:',
    '- All sentences together must form ONE single paragraph about ONE situation, with ONE narrator and ONE continuous timeline.',
    '- Sentence 1 sets the scene. Every later sentence must continue directly from the one before it.',
    '- Bind them together: use pronouns (it, she, that, there) and linking words (then, so, but, after that, meanwhile) that refer back to what was just said.',
    '- A reader must be able to read the sentences straight through, with no gaps, as a normal paragraph.',
    '- FORBIDDEN: unrelated facts, a list of examples, sentences that could be shuffled into any order, or switching topic partway through.',
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
