// Folio - Free online Text-to-Speech proxy (Vercel Serverless Function)
// Uses Google Translate TTS: free, no API key, no credit card, generous limits.
// The browser voice remains the final fallback on the client side.
//
// GET  /api/tts   -> { enabled: true, provider: 'google' }   (health check)
// POST /api/tts   -> audio/mpeg                               (text-to-speech)
//   body: { text: string, lang?: string }

const TTS_BASE = 'https://translate.google.com/translate_tts';
const DEFAULT_LANG = 'id';
const MAX_TOTAL = 900;   // total characters synthesized per request
const MAX_CHUNK = 190;   // Google TTS hard limit is ~200 chars per request
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Split text into <= max-char chunks on word boundaries.
function chunkText(text, max) {
	var words = text.split(/\s+/);
	var chunks = [];
	var cur = '';
	for (var i = 0; i < words.length; i++) {
		var w = words[i];
		if ((cur ? cur + ' ' + w : w).length > max) {
			if (cur) { chunks.push(cur); cur = ''; }
			if (w.length > max) {
				for (var j = 0; j < w.length; j += max) chunks.push(w.slice(j, j + max));
			} else {
				cur = w;
			}
		} else {
			cur = cur ? cur + ' ' + w : w;
		}
	}
	if (cur) chunks.push(cur);
	return chunks;
}

export default async function handler(req, res) {
	// Health check - no quota, always available (no key needed).
	if (req.method === 'GET') {
		res.setHeader('Cache-Control', 'no-store');
		res.status(200).json({ enabled: true, provider: 'google' });
		return;
	}

	if (req.method !== 'POST') {
		res.setHeader('Allow', 'GET, POST');
		res.status(405).json({ error: 'Method not allowed' });
		return;
	}

	try {
		let body = req.body;
		if (typeof body === 'string') {
			try { body = JSON.parse(body); } catch (e) { body = {}; }
		}
		body = body || {};

		const rawText = (body.text || '').toString().trim();
		if (!rawText) {
			res.status(400).json({ error: 'Missing text' });
			return;
		}
		const text = rawText.length > MAX_TOTAL ? rawText.slice(0, MAX_TOTAL) : rawText;
		const lang = (body.lang || DEFAULT_LANG).toString().slice(0, 5);

		const chunks = chunkText(text, MAX_CHUNK);
		const buffers = [];
		for (let i = 0; i < chunks.length; i++) {
			const part = chunks[i];
			const url = TTS_BASE +
				'?ie=UTF-8&client=tw-ob&ttsspeed=1' +
				'&tl=' + encodeURIComponent(lang) +
				'&q=' + encodeURIComponent(part) +
				'&textlen=' + part.length +
				'&idx=' + i + '&total=' + chunks.length;
			const r = await fetch(url, {
				headers: {
					'User-Agent': UA,
					'Referer': 'https://translate.google.com/',
					'Accept': '*/*',
				},
			});
			if (!r.ok) {
				let detail = '';
				try { detail = (await r.text()).slice(0, 200); } catch (e) {}
				res.status(r.status || 502).json({ error: 'TTS upstream error', status: r.status, detail: detail });
				return;
			}
			const ab = await r.arrayBuffer();
			buffers.push(Buffer.from(ab));
		}

		const audio = Buffer.concat(buffers);
		res.setHeader('Content-Type', 'audio/mpeg');
		res.setHeader('Cache-Control', 'no-store');
		res.status(200).send(audio);
	} catch (err) {
		res.status(500).json({ error: 'Proxy failure', detail: String(err && err.message ? err.message : err) });
	}
}
