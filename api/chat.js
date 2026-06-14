/**
 * Folio AI — /api/chat
 * 
 * Endpoint utama untuk AI chat. Key Groq disimpan di Vercel ENV,
 * tidak pernah terekspos ke browser.
 * 
 * Features:
 * - Key Groq tersembunyi di server
 * - Rate limiting per IP (20 req/menit)
 * - Request logging ke console (bisa dilihat di Vercel dashboard)
 * - Input validation & sanitization
 * - CORS untuk domain Folio
 * - Fallback model otomatis
 */

// ── In-memory rate limiter (reset tiap deploy, cukup untuk MVP) ──
const rateLimitMap = new Map();
const RATE_LIMIT    = 20;   // max request per window
const RATE_WINDOW   = 60_000; // 1 menit dalam ms

function checkRateLimit(ip) {
    const now  = Date.now();
    const data = rateLimitMap.get(ip);

    if (!data || now - data.windowStart > RATE_WINDOW) {
        rateLimitMap.set(ip, { count: 1, windowStart: now });
        return { allowed: true, remaining: RATE_LIMIT - 1 };
    }

    if (data.count >= RATE_LIMIT) {
        const resetIn = Math.ceil((RATE_WINDOW - (now - data.windowStart)) / 1000);
        return { allowed: false, remaining: 0, resetIn };
    }

    data.count++;
    return { allowed: true, remaining: RATE_LIMIT - data.count };
}

// ── Bersihkan Map secara berkala agar tidak memory leak ──
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of rateLimitMap.entries()) {
        if (now - data.windowStart > RATE_WINDOW * 2) rateLimitMap.delete(ip);
    }
}, RATE_WINDOW * 2);

// ── CORS headers ──
function setCORSHeaders(res, req) {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);

    const origin = req.headers.origin || '';

    // Jika ALLOWED_ORIGINS kosong → izinkan semua (development)
    // Jika diset → hanya izinkan origin yang terdaftar
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    }

    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

// ── Logger sederhana ──
function log(level, message, meta = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta,
    };
    if (level === 'error') console.error(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
}

// ── Model config ──
const GROQ_MODELS = {
    primary:  'llama-3.3-70b-versatile',   // 1000 req/hari, pintar
    fast:     'llama-3.1-8b-instant',       // 14.400 req/hari, cepat
    fallback: 'gemma2-9b-it',              // backup ketiga
};

// ── Main handler ──
export default async function handler(req, res) {
    setCORSHeaders(res, req);

    // Handle preflight OPTIONS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Hanya terima POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Ambil IP untuk rate limiting
    const ip = (
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.headers['x-real-ip'] ||
        req.socket?.remoteAddress ||
        'unknown'
    ).trim();

    // Rate limit check
    const rateResult = checkRateLimit(ip);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining);

    if (!rateResult.allowed) {
        log('warn', 'Rate limit exceeded', { ip });
        return res.status(429).json({
            error: `Terlalu banyak request. Coba lagi dalam ${rateResult.resetIn} detik.`,
            resetIn: rateResult.resetIn,
        });
    }

    // Validasi API key Groq di ENV
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
        log('error', 'GROQ_API_KEY not set in environment');
        return res.status(500).json({ error: 'Server belum dikonfigurasi. Hubungi admin.' });
    }

    // Parse body
    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'Request body tidak valid (bukan JSON).' });
    }

    const { messages, bookTitle, chapterTitle, model: requestedModel } = body || {};

    // Validasi messages
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Field "messages" wajib diisi dan harus array.' });
    }

    // Validasi isi messages — cegah injeksi role aneh
    const validRoles = new Set(['user', 'assistant', 'system']);
    for (const msg of messages) {
        if (!validRoles.has(msg.role)) {
            return res.status(400).json({ error: `Role tidak valid: ${msg.role}` });
        }
        if (typeof msg.content !== 'string' || msg.content.length > 8000) {
            return res.status(400).json({ error: 'Konten pesan terlalu panjang atau tidak valid.' });
        }
    }

    // Batasi jumlah pesan untuk hemat token
    const trimmedMessages = messages.slice(-12); // maks 12 pesan terakhir

    // Pilih model
    const modelToUse = requestedModel === 'fast'
        ? GROQ_MODELS.fast
        : GROQ_MODELS.primary;

    log('info', 'Chat request', {
        ip,
        bookTitle: bookTitle || 'unknown',
        chapterTitle: chapterTitle || 'unknown',
        messageCount: trimmedMessages.length,
        model: modelToUse,
    });

    // ── Panggil Groq API ──
    const startTime = Date.now();
    let groqRes;

    try {
        groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
            },
            body: JSON.stringify({
                model: modelToUse,
                messages: trimmedMessages,
                max_tokens: 1024,
                temperature: 0.7,
            }),
        });

        // Fallback ke model lebih kecil jika 429 / 503
        if (!groqRes.ok && (groqRes.status === 429 || groqRes.status === 503)) {
            log('warn', 'Primary model failed, trying fallback', { status: groqRes.status });
            groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                },
                body: JSON.stringify({
                    model: GROQ_MODELS.fallback,
                    messages: trimmedMessages,
                    max_tokens: 1024,
                    temperature: 0.7,
                }),
            });
        }

        if (!groqRes.ok) {
            const errBody = await groqRes.json().catch(() => ({}));
            log('error', 'Groq API error', { status: groqRes.status, body: errBody });

            if (groqRes.status === 401) {
                return res.status(502).json({ error: 'Konfigurasi server bermasalah. Hubungi admin.' });
            }
            if (groqRes.status === 429) {
                return res.status(429).json({ error: 'Batas harian Groq tercapai. Coba lagi besok.' });
            }
            return res.status(502).json({ error: `Groq error: ${errBody?.error?.message || groqRes.status}` });
        }

        const data = await groqRes.json();
        const reply = data.choices?.[0]?.message?.content;

        if (!reply) {
            return res.status(502).json({ error: 'Tidak ada respons dari AI.' });
        }

        const duration = Date.now() - startTime;
        log('info', 'Chat success', {
            ip,
            duration_ms: duration,
            model: data.model,
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
        });

        return res.status(200).json({
            reply,
            model: data.model,
            usage: data.usage,
        });

    } catch (err) {
        log('error', 'Unexpected error', { ip, error: err.message });
        return res.status(500).json({ error: 'Terjadi kesalahan di server. Coba lagi.' });
    }
}
