// Folio — ElevenLabs Text-to-Speech proxy (Vercel Serverless Function)
// The API key is read from the ELEVENLABS_API_KEY environment variable and
// NEVER exposed to the browser. Set it in Vercel: Project Settings ->
// Environment Variables -> ELEVENLABS_API_KEY.
//
// GET  /api/tts            -> { enabled: true|false }   (health check, no quota used)
// POST /api/tts            -> audio/mpeg stream          (text-to-speech)
//   body: { text: string, voiceId?: string, modelId?: string }

const EL_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE = 'pFZP5JQG7iQjIQuC4Bku'; // Lilly
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const MAX_CHARS = 600;

export default async function handler(req, res) {
	const key = process.env.ELEVENLABS_API_KEY;

	// ── Health check ──
	if (req.method === 'GET') {
		res.setHeader('Cache-Control', 'no-store');
		res.status(200).json({ enabled: !!key });
		return;
	}

	if (req.method !== 'POST') {
		res.setHeader('Allow', 'GET, POST');
		res.status(405).json({ error: 'Method not allowed' });
		return;
	}

	if (!key) {
		res.status(503).json({ error: 'ELEVENLABS_API_KEY not configured' });
		return;
	}

	try {
		// Vercel auto-parses JSON bodies, but guard for string bodies too.
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
		const text = rawText.length > MAX_CHARS ? rawText.slice(0, MAX_CHARS) + '...' : rawText;
		const voiceId = (body.voiceId || DEFAULT_VOICE).toString();
		const modelId = (body.modelId || DEFAULT_MODEL).toString();

		const elRes = await fetch(`${EL_BASE}/${encodeURIComponent(voiceId)}`, {
			method: 'POST',
			headers: {
				'xi-api-key': key,
				'Content-Type': 'application/json',
				'Accept': 'audio/mpeg',
			},
			body: JSON.stringify({
				text,
				model_id: modelId,
				voice_settings: { stability: 0.5, similarity_boost: 0.75 },
			}),
		});

		if (!elRes.ok) {
			let detail = '';
			try { detail = await elRes.text(); } catch (e) {}
			res.status(elRes.status).json({ error: 'ElevenLabs error', status: elRes.status, detail });
			return;
		}

		const arrayBuf = await elRes.arrayBuffer();
		const buf = Buffer.from(arrayBuf);
		res.setHeader('Content-Type', 'audio/mpeg');
		res.setHeader('Cache-Control', 'no-store');
		res.status(200).send(buf);
	} catch (err) {
		res.status(500).json({ error: 'Proxy failure', detail: String(err && err.message ? err.message : err) });
	}
}
