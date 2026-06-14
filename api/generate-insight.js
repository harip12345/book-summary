/**
 * Folio AI — /api/generate-insight
 *
 * Generate Kesimpulan, Key Points, dan Langkah Aksi otomatis
 * dari seluruh isi buku menggunakan Groq.
 * 
 * Rate limit lebih ketat (5 req/menit) karena endpoint ini
 * mengkonsumsi jauh lebih banyak token.
 */

const insightRateLimitMap = new Map();
const INSIGHT_RATE_LIMIT  = 5;
const INSIGHT_RATE_WINDOW = 60_000;

function checkInsightRateLimit(ip) {
    const now  = Date.now();
    const data = insightRateLimitMap.get(ip);
    if (!data || now - data.windowStart > INSIGHT_RATE_WINDOW) {
        insightRateLimitMap.set(ip, { count: 1, windowStart: now });
        return { allowed: true, remaining: INSIGHT_RATE_LIMIT - 1 };
    }
    if (data.count >= INSIGHT_RATE_LIMIT) {
        const resetIn = Math.ceil((INSIGHT_RATE_WINDOW - (now - data.windowStart)) / 1000);
        return { allowed: false, remaining: 0, resetIn };
    }
    data.count++;
    return { allowed: true, remaining: INSIGHT_RATE_LIMIT - data.count };
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of insightRateLimitMap.entries()) {
        if (now - data.windowStart > INSIGHT_RATE_WINDOW * 2) insightRateLimitMap.delete(ip);
    }
}, INSIGHT_RATE_WINDOW * 2);

function setCORSHeaders(res, req) {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    const origin = req.headers.origin || '';
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function log(level, message, meta = {}) {
    const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

export default async function handler(req, res) {
    setCORSHeaders(res, req);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const ip = (
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.headers['x-real-ip'] ||
        req.socket?.remoteAddress ||
        'unknown'
    ).trim();

    const rateResult = checkInsightRateLimit(ip);
    res.setHeader('X-RateLimit-Limit', INSIGHT_RATE_LIMIT);
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining);

    if (!rateResult.allowed) {
        log('warn', 'Insight rate limit exceeded', { ip });
        return res.status(429).json({
            error: `Terlalu banyak generate. Coba lagi dalam ${rateResult.resetIn} detik.`,
            resetIn: rateResult.resetIn,
        });
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        log('error', 'GROQ_API_KEY not set');
        return res.status(500).json({ error: 'Server belum dikonfigurasi. Hubungi admin.' });
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Request body tidak valid.' });
    }

    const { title, author, category, chapters, kesimpulan: existingKesimpulan } = body || {};

    if (!title || !Array.isArray(chapters) || chapters.length === 0) {
        return res.status(400).json({ error: 'Field "title" dan "chapters" wajib diisi.' });
    }

    // Validasi & batasi ukuran chapters
    if (chapters.some(c => typeof c.content !== 'string')) {
        return res.status(400).json({ error: 'Setiap chapter harus memiliki field "content" berupa string.' });
    }

    // Ringkas konten per chapter — ambil 600 char saja per bab agar hemat token
    const chapterSummary = chapters
        .slice(0, 15) // maks 15 bab
        .map((c, i) => `BAB ${i + 1} — ${c.title || 'Tanpa Judul'}:\n${(c.content || '').substring(0, 600)}`)
        .join('\n\n');

    if (chapterSummary.length > 8000) {
        return res.status(400).json({ error: 'Konten buku terlalu panjang untuk diproses.' });
    }

    log('info', 'Generate insight request', { ip, title, chapterCount: chapters.length });

    const prompt = `Kamu adalah analis buku profesional. Analisis buku berikut dan buat insight berkualitas tinggi.

BUKU: "${title}" oleh ${author || 'Penulis tidak diketahui'}
KATEGORI: ${category || 'Umum'}
${existingKesimpulan ? `\nKESIMPULAN YANG ADA (perbaiki jika perlu):\n${existingKesimpulan}\n` : ''}
ISI BUKU (ringkasan per bab):
${chapterSummary}

Balas HANYA dengan JSON valid berikut, tanpa teks tambahan, tanpa markdown:
{
  "kesimpulan": "2-3 kalimat mendalam tentang inti pesan buku dalam Bahasa Indonesia",
  "keyPoints": [
    "Poin penting 1 yang spesifik dan actionable",
    "Poin penting 2 yang spesifik dan actionable",
    "Poin penting 3 yang spesifik dan actionable",
    "Poin penting 4 yang spesifik dan actionable",
    "Poin penting 5 yang spesifik dan actionable"
  ],
  "langkahAksi": [
    "Langkah konkret 1 yang bisa dilakukan hari ini",
    "Langkah konkret 2 yang bisa dilakukan minggu ini",
    "Langkah konkret 3 yang bisa dilakukan bulan ini",
    "Langkah konkret 4 untuk jangka panjang"
  ]
}`;

    const startTime = Date.now();

    try {
        // Gunakan model yang lebih cepat untuk generate insight
        // karena payload besar, fast model lebih efisien
        let groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    {
                        role: 'system',
                        content: 'Kamu adalah analis buku profesional. Selalu balas HANYA dalam format JSON yang valid, tanpa markdown, tanpa komentar, tanpa teks apapun di luar JSON.',
                    },
                    { role: 'user', content: prompt },
                ],
                max_tokens: 1200,
                temperature: 0.5, // lebih rendah untuk output terstruktur
            }),
        });

        // Fallback ke model besar jika perlu
        if (!groqRes.ok && (groqRes.status === 429 || groqRes.status === 503)) {
            log('warn', 'Fast model failed, trying primary', { status: groqRes.status });
            groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [
                        { role: 'system', content: 'Balas HANYA dalam format JSON valid.' },
                        { role: 'user', content: prompt },
                    ],
                    max_tokens: 1200,
                    temperature: 0.5,
                }),
            });
        }

        if (!groqRes.ok) {
            const errBody = await groqRes.json().catch(() => ({}));
            log('error', 'Groq API error on generate', { status: groqRes.status, body: errBody });
            if (groqRes.status === 429) {
                return res.status(429).json({ error: 'Batas harian Groq tercapai. Coba lagi besok.' });
            }
            return res.status(502).json({ error: `Groq error: ${errBody?.error?.message || groqRes.status}` });
        }

        const data   = await groqRes.json();
        const raw    = data.choices?.[0]?.message?.content || '';
        const duration = Date.now() - startTime;

        // Parse JSON — bersihkan markdown jika ada
        let parsed;
        try {
            const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            parsed = JSON.parse(clean);
        } catch {
            log('error', 'JSON parse failed', { ip, raw: raw.substring(0, 200) });
            return res.status(502).json({ error: 'Respons AI tidak valid. Coba generate ulang.' });
        }

        // Validasi struktur response
        if (!parsed.kesimpulan || !Array.isArray(parsed.keyPoints) || !Array.isArray(parsed.langkahAksi)) {
            return res.status(502).json({ error: 'Struktur respons AI tidak lengkap. Coba generate ulang.' });
        }

        log('info', 'Generate insight success', {
            ip,
            title,
            duration_ms: duration,
            model: data.model,
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
        });

        return res.status(200).json({
            kesimpulan:   parsed.kesimpulan,
            keyPoints:    parsed.keyPoints,
            langkahAksi:  parsed.langkahAksi,
            model:        data.model,
            usage:        data.usage,
        });

    } catch (err) {
        log('error', 'Unexpected error on generate', { ip, error: err.message });
        return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
    }
}
