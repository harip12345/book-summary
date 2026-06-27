/**
 * Folio AI - /api/generate-book
 *
 * Satu endpoint untuk dua aksi:
 *   action: "outline"  -> generate daftar bab + sinopsis (JSON mode, andal)
 *   action: "chapter"  -> generate isi 1 bab on-demand (panjang & detail)
 *
 * Key Groq tersimpan di Vercel ENV, tidak pernah ke browser.
 */

// Beri waktu lebih lama karena generate bab kini lebih panjang/detail.
export const config = { maxDuration: 60 };

const rateLimitMap = new Map();
const RATE_LIMIT   = 10;       // max 10 req/menit per IP
const RATE_WINDOW  = 60_000;

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

setInterval(() => {
	const now = Date.now();
	for (const [ip, data] of rateLimitMap.entries()) {
		if (now - data.windowStart > RATE_WINDOW * 2) rateLimitMap.delete(ip);
	}
}, RATE_WINDOW * 2);

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

function log(level, msg, meta = {}) {
	const entry = { timestamp: new Date().toISOString(), level, message: msg, ...meta };
	if (level === 'error') console.error(JSON.stringify(entry));
	else console.log(JSON.stringify(entry));
}

// extra: field tambahan untuk body (mis. response_format, temperature)
async function callGroq(messages, maxTokens, model = 'llama-3.3-70b-versatile', extra = {}) {
	const GROQ_API_KEY = process.env.GROQ_API_KEY;
	const buildBody = (m) => JSON.stringify({ model: m, messages, max_tokens: maxTokens, temperature: 0.7, ...extra });

	let res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type':  'application/json',
			'Authorization': `Bearer ${GROQ_API_KEY}`,
		},
		body: buildBody(model),
	});

	// Fallback ke model lebih kecil jika overloaded
	if (!res.ok && (res.status === 429 || res.status === 503)) {
		res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
			body: buildBody('llama-3.1-8b-instant'),
		});
	}

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		if (res.status === 429) throw { status: 429, message: 'Batas request Groq tercapai. Tunggu 1 menit.' };
		throw { status: res.status, message: err?.error?.message || `Groq error ${res.status}` };
	}

	const data = await res.json();
	return {
		content: data.choices?.[0]?.message?.content || '',
		usage:   data.usage,
		model:   data.model,
	};
}

// Ekstraksi JSON tahan banting: buang markdown fence lalu ambil dari { pertama sampai } terakhir.
function safeParseJson(text) {
	let raw = String(text || '').replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
	const first = raw.indexOf('{');
	const last  = raw.lastIndexOf('}');
	if (first !== -1 && last !== -1 && last > first) raw = raw.slice(first, last + 1);
	try { return JSON.parse(raw); } catch { return null; }
}

export default async function handler(req, res) {
	setCORSHeaders(res, req);
	if (req.method === 'OPTIONS') return res.status(200).end();
	if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

	const GROQ_API_KEY = process.env.GROQ_API_KEY;
	if (!GROQ_API_KEY) {
		log('error', 'GROQ_API_KEY not set');
		return res.status(500).json({ error: 'Server belum dikonfigurasi. Hubungi admin.' });
	}

	const ip = (
		req.headers['x-forwarded-for']?.split(',')[0] ||
		req.headers['x-real-ip'] ||
		'unknown'
	).trim();

	const rateResult = checkRateLimit(ip);
	res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
	res.setHeader('X-RateLimit-Remaining', rateResult.remaining);

	if (!rateResult.allowed) {
		return res.status(429).json({
			error: `Terlalu banyak request. Coba lagi dalam ${rateResult.resetIn} detik.`,
		});
	}

	let body;
	try {
		body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
	} catch {
		return res.status(400).json({ error: 'Request body tidak valid.' });
	}

	const { action, title, author, category, jumlahBab, chapterTitle, chapterSinopsis, chapterIdx } = body || {};

	if (!action) return res.status(400).json({ error: 'Field "action" wajib diisi ("outline" atau "chapter").' });
	if (!title)  return res.status(400).json({ error: 'Field "title" wajib diisi.' });

	const startTime = Date.now();

	// ---------------------------------------------
	// ACTION: outline - generate daftar bab
	// ---------------------------------------------
	if (action === 'outline') {
		log('info', 'Generate outline', { ip, title, jumlahBab });

		const prompt = `Bertindaklah sebagai ahli analisis literatur profesional. Tugasmu menyusun kerangka (outline) untuk ringkasan komprehensif tingkat tinggi dari sebuah buku, sehingga pembaca nantinya merasa seperti telah membaca buku aslinya secara utuh.

Aturan:
- Komprehensif: petakan SEMUA bagian/argumen penting buku ke dalam bab-bab. Jangan lewatkan model berpikir, kerangka, atau konsep kunci.
- Akurat: kerangka harus setia pada isi buku asli. Jangan mengarang bab yang tidak ada di buku.
- Sinopsis tiap bab cukup 1 kalimat padat yang menggambarkan inti bab.
- Bahasa Indonesia profesional.

Buat outline untuk buku berikut:
- Judul: "${title}"
- Penulis: ${author || 'Tidak diketahui'}
- Kategori: ${category || 'Umum'}
- Jumlah bab: ${jumlahBab || 7}

Balas HANYA dengan objek JSON valid berstruktur persis seperti ini (tanpa teks lain):
{
  "kesimpulan": "2-3 kalimat tentang inti pesan buku ini (untuk halaman kesimpulan khusus, BUKAN diletakkan di tiap bab)",
  "keyPoints": ["poin 1", "poin 2", "poin 3", "poin 4", "poin 5"],
  "langkahAksi": ["langkah 1", "langkah 2", "langkah 3"],
  "bab": [
    {"judul": "Judul Bab 1", "sinopsis": "1 kalimat isi bab ini"},
    {"judul": "Judul Bab 2", "sinopsis": "1 kalimat isi bab ini"}
  ]
}`;

		try {
			const result = await callGroq([
				{ role: 'system', content: 'Kamu asisten yang SELALU membalas dengan satu objek JSON valid sesuai skema yang diminta, tanpa teks atau markdown tambahan.' },
				{ role: 'user',   content: prompt },
			], 2000, 'llama-3.3-70b-versatile', { response_format: { type: 'json_object' }, temperature: 0.3 });

			const parsed = safeParseJson(result.content);
			if (!parsed || !Array.isArray(parsed.bab) || parsed.bab.length === 0) {
				log('error', 'Outline parse/empty', { ip, title, sample: String(result.content || '').slice(0, 200) });
				return res.status(502).json({ error: 'Format respons AI tidak valid. Coba lagi.' });
			}

			log('info', 'Outline success', { ip, title, duration_ms: Date.now()-startTime, ...result.usage });

			return res.status(200).json({
				kesimpulan:  parsed.kesimpulan  || '',
				keyPoints:   Array.isArray(parsed.keyPoints)   ? parsed.keyPoints   : [],
				langkahAksi: Array.isArray(parsed.langkahAksi) ? parsed.langkahAksi : [],
				bab:         parsed.bab,
				usage:       result.usage,
				model:       result.model,
			});

		} catch(e) {
			log('error', 'Outline failed', { ip, error: e.message || e });
			return res.status(e.status || 500).json({ error: e.message || 'Terjadi kesalahan.' });
		}
	}

	// ---------------------------------------------
	// ACTION: chapter - generate isi 1 bab
	// ---------------------------------------------
	if (action === 'chapter') {
		if (!chapterTitle) return res.status(400).json({ error: 'Field "chapterTitle" wajib diisi.' });

		log('info', 'Generate chapter', { ip, title, chapterIdx, chapterTitle });

		const prompt = `Kamu adalah penulis ringkasan buku profesional berbahasa Indonesia. Tugasmu menulis isi bab yang sedetail dan sesetia mungkin dengan buku aslinya, sehingga pembaca merasa benar-benar sedang membaca isi bab tersebut secara lengkap.

DATA BAB:
- Buku: "${title}" oleh ${author || 'penulis'}
- Nama Bab: "${chapterTitle}"
- Sinopsis bab: ${chapterSinopsis || chapterTitle}

INSTRUKSI ISI (WAJIB):
- Tulis pembahasan yang PANJANG dan MENDALAM: minimal 8 paragraf utuh (sekitar 800-1100 kata). Jangan ringkas atau dangkal.
- Setia pada isi buku asli (high-fidelity). Uraikan gagasan, argumen, kerangka berpikir, model, formula, atau langkah yang dibahas pada bab ini secara rinci dan akurat. Jangan mengarang fakta, data, nama, atau kutipan yang tidak ada di buku.
- Jelaskan bukan hanya "APA" idenya, tapi juga "MENGAPA" ide itu benar dan "BAGAIMANA" cara kerjanya. Uraikan sebab-akibat dan logika di baliknya selangkah demi selangkah.
- Sertakan contoh, kisah, studi kasus, eksperimen, atau analogi penting yang dipakai pada bab ini (jika ada di buku) untuk memperjelas konsep.
- Pertahankan istilah kunci dan konsep orisinal dari buku.

GAYA BAHASA (WAJIB):
- Gunakan Bahasa Indonesia yang profesional, jelas, dan mengalir.
- Tulis sebagai NARATOR PIHAK KETIGA yang menjelaskan isi buku. JANGAN menulis seolah-olah kamu adalah penulis bukunya. JANGAN memakai frasa seperti "menurut penulis", "penulis berpendapat", "penulis mengatakan", "sang penulis", "saya", atau "dalam bab ini penulis...". Sampaikan gagasannya langsung sebagai penjelasan.
- Tulis dalam bentuk paragraf yang mengalir, dipisahkan baris kosong antar paragraf. JANGAN memakai list, bullet, penomoran, atau heading.

LARANGAN PENTING:
- JANGAN menulis kesimpulan, rangkuman, penutup, "intinya", atau kalimat yang merangkum ulang di akhir bab. Kesimpulan keseluruhan buku disimpan di halaman khusus tersendiri, jadi tiap bab TIDAK boleh punya kesimpulan sendiri. Akhiri bab pada gagasan terakhirnya secara alami.
- JANGAN menambahkan kalimat pengantar meta seperti "Dalam bab ini akan dibahas...". Langsung masuk ke isi.

Tulis HANYA isi bab dalam bentuk paragraf.`;

		try {
			const result = await callGroq([
				{ role: 'system', content: 'Kamu penulis ringkasan buku profesional berbahasa Indonesia. Tulis isi bab yang panjang, detail, dan setia pada buku asli sebagai narator pihak ketiga (bukan suara penulis buku). Jangan pakai list/heading, dan jangan menulis kesimpulan di akhir bab.' },
				{ role: 'user',   content: prompt },
			], 3000, 'llama-3.3-70b-versatile'); // Model 70b + token besar untuk kualitas & panjang

			log('info', 'Chapter success', { ip, title, chapterIdx, duration_ms: Date.now()-startTime, ...result.usage });

			return res.status(200).json({
				content:     result.content.trim(),
				chapterIdx:  chapterIdx,
				usage:       result.usage,
				model:       result.model,
			});

		} catch(e) {
			log('error', 'Chapter failed', { ip, error: e.message || e });
			return res.status(e.status || 500).json({ error: e.message || 'Terjadi kesalahan.' });
		}
	}

	// ---------------------------------------------
	// ACTION: expand - perdalam/perpanjang isi bab yang sudah ada
	// ---------------------------------------------
	if (action === 'expand') {
		if (!chapterTitle) return res.status(400).json({ error: 'Field "chapterTitle" wajib diisi.' });
		const existingContent = (body && body.existingContent) || '';
		log('info', 'Expand chapter', { ip, title, chapterIdx, chapterTitle });

		const prompt = `Kamu adalah penulis ringkasan buku profesional berbahasa Indonesia. Di bawah ada isi bab yang sudah ada. Tugasmu MEMPERDALAM dan MEMPERPANJANG isi tersebut tanpa mengubah makna atau menghapus informasi yang sudah ada.

DATA BAB:
- Buku: "${title}" oleh ${author || 'penulis'}
- Nama Bab: "${chapterTitle}"

ISI BAB SAAT INI:
"""
${(existingContent || chapterSinopsis || '').slice(0, 6000)}
"""

INSTRUKSI (WAJIB):
- Pertahankan semua poin dan urutan gagasan yang sudah ada, lalu kembangkan menjadi lebih panjang dan detail (target minimal 10 paragraf / sekitar 1000-1300 kata).
- Tambahkan penjelasan "mengapa" dan "bagaimana", contoh, analogi, atau elaborasi konsep yang relevan dengan buku. Jangan mengarang fakta, data, atau kutipan yang tidak ada di buku.
- Tulis sebagai NARATOR PIHAK KETIGA. JANGAN memakai frasa "menurut penulis", "penulis berpendapat", "saya", atau menulis seolah kamu penulis bukunya.
- Paragraf mengalir dipisahkan baris kosong. JANGAN pakai list, bullet, penomoran, atau heading.
- JANGAN menulis kesimpulan, rangkuman, atau penutup di akhir bab. Kesimpulan disimpan di halaman khusus.
- JANGAN menambah kalimat pengantar meta. Langsung tulis isi bab versi yang sudah diperdalam.

Tulis HANYA isi bab final (versi yang lebih panjang) dalam bentuk paragraf.`;

		try {
			const result = await callGroq([
				{ role: 'system', content: 'Kamu penulis ringkasan buku profesional berbahasa Indonesia. Perdalam isi bab menjadi lebih panjang dan detail sebagai narator pihak ketiga, tanpa list/heading, tanpa kesimpulan di akhir bab.' },
				{ role: 'user',   content: prompt },
			], 3500, 'llama-3.3-70b-versatile');

			log('info', 'Expand success', { ip, title, chapterIdx, duration_ms: Date.now()-startTime, ...result.usage });

			return res.status(200).json({
				content:    result.content.trim(),
				chapterIdx: chapterIdx,
				usage:      result.usage,
				model:      result.model,
			});
		} catch(e) {
			log('error', 'Expand failed', { ip, error: e.message || e });
			return res.status(e.status || 500).json({ error: e.message || 'Terjadi kesalahan.' });
		}
	}

	// ---------------------------------------------
	// ACTION: quiz - kuis pilihan ganda + flashcard
	// ---------------------------------------------
	if (action === 'quiz') {
		const context = (body && body.context) || '';
		log('info', 'Generate quiz', { ip, title });

		const prompt = `Bertindaklah sebagai pembuat materi belajar. Berdasarkan buku berikut, buat materi untuk menguji dan memperkuat pemahaman pembaca.

DATA BUKU:
- Judul: "${title}"
- Penulis: ${author || 'Tidak diketahui'}
- Kategori: ${category || 'Umum'}
${context ? 'Ringkasan/poin isi buku:\n' + String(context).slice(0, 4000) : ''}

Buat:
1) 5 soal PILIHAN GANDA tentang gagasan inti buku. Tiap soal punya 4 opsi, tepat satu jawaban benar, plus penjelasan singkat 1 kalimat.
2) 5 FLASHCARD konsep/istilah penting. "depan" = istilah atau pertanyaan singkat, "belakang" = penjelasan padat.

Gunakan Bahasa Indonesia. Soal harus menguji pemahaman, bukan sekadar hafalan judul.

Balas HANYA dengan objek JSON valid persis struktur ini (indeks "jawaban" 0-3):
{
  "quiz": [
    {"pertanyaan": "...", "opsi": ["...", "...", "...", "..."], "jawaban": 0, "penjelasan": "..."}
  ],
  "flashcards": [
    {"depan": "...", "belakang": "..."}
  ]
}`;

		try {
			const result = await callGroq([
				{ role: 'system', content: 'Kamu asisten yang SELALU membalas dengan satu objek JSON valid sesuai skema yang diminta, tanpa teks atau markdown tambahan.' },
				{ role: 'user',   content: prompt },
			], 2500, 'llama-3.3-70b-versatile', { response_format: { type: 'json_object' }, temperature: 0.4 });

			const parsed = safeParseJson(result.content);
			if (!parsed || !Array.isArray(parsed.quiz) || parsed.quiz.length === 0) {
				log('error', 'Quiz parse/empty', { ip, title, sample: String(result.content || '').slice(0, 200) });
				return res.status(502).json({ error: 'Format respons AI tidak valid. Coba lagi.' });
			}

			log('info', 'Quiz success', { ip, title, duration_ms: Date.now()-startTime, ...result.usage });

			return res.status(200).json({
				quiz:       parsed.quiz,
				flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards : [],
				usage:      result.usage,
				model:      result.model,
			});
		} catch(e) {
			log('error', 'Quiz failed', { ip, error: e.message || e });
			return res.status(e.status || 500).json({ error: e.message || 'Terjadi kesalahan.' });
		}
	}

	return res.status(400).json({ error: `Action tidak dikenal: "${action}". Gunakan "outline", "chapter", "expand", atau "quiz".` });
}
