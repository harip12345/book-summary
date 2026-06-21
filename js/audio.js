// Folio - Audio (Audiobook) module
// Free online narration via Google Translate TTS through the serverless proxy
// at /api/tts. No API key and no credit card required. If the proxy is
// unavailable, the app falls back to the free browser voice.
(function () {
	'use strict';

	var CONFIG = {
		endpoint: '/api/tts',
		lang: 'id',
		maxChars: 600,
		voices: [
			{ id: 'id', name: 'Bahasa Indonesia' },
			{ id: 'en', name: 'English' },
		],
	};
	window.FOLIO_AUDIO_CONFIG = CONFIG;

	// Health check: is the online voice reachable? Returns a Promise<boolean>.
	window.folioAudioHealth = function () {
		return fetch(CONFIG.endpoint, { method: 'GET' })
			.then(function (r) { return r.ok ? r.json() : { enabled: false }; })
			.then(function (j) { return !!(j && j.enabled); })
			.catch(function () { return false; });
	};

	// Synthesize speech for a piece of text.
	// Returns a Promise<Blob> (audio/mpeg). Throws an Error with a .status
	// property on failure so the caller can decide whether to fall back.
	window.folioSynthesizeSpeech = function (text, opts) {
		opts = opts || {};
		// Accept opts.lang; ignore legacy non-language voice ids (e.g. ElevenLabs).
		var lang = opts.lang || (/^[a-z]{2}$/.test(opts.voiceId || '') ? opts.voiceId : CONFIG.lang);
		var src = (text || '').toString();
		var chunk = src.length > CONFIG.maxChars ? src.slice(0, CONFIG.maxChars) + '...' : src;

		return fetch(CONFIG.endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
			body: JSON.stringify({ text: chunk, lang: lang }),
		}).then(function (res) {
			if (!res.ok) {
				return res.json().catch(function () { return {}; }).then(function (j) {
					var err = new Error((j && j.error) || ('TTS error ' + res.status));
					err.status = res.status;
					err.detail = j && (j.detail || j.error);
					try { console.warn('[Folio Audio] /api/tts gagal', res.status, err.detail); } catch (e) {}
					throw err;
				});
			}
			return res.blob();
		});
	};
})();
