// Folio — Audio (Audiobook) module
// Handles premium narration via ElevenLabs through the serverless proxy at
// /api/tts. The API key lives ONLY on the server (Vercel env var
// ELEVENLABS_API_KEY) and is never entered in the UI or stored in the browser.
// If the proxy is unavailable, the app falls back to the free browser voice.
(function () {
	'use strict';

	var CONFIG = {
		endpoint: '/api/tts',
		modelId: 'eleven_multilingual_v2',
		defaultVoiceId: 'pFZP5JQG7iQjIQuC4Bku', // Lilly
		maxChars: 600,
		voices: [
			{ id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lilly (perempuan, natural)' },
			{ id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel (laki-laki, tegas)' },
			{ id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte (perempuan, hangat)' },
			{ id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum (laki-laki, santai)' },
		],
	};
	window.FOLIO_AUDIO_CONFIG = CONFIG;

	// Health check: is the premium voice configured on the server?
	// Returns a Promise<boolean>. Uses no TTS quota.
	window.folioAudioHealth = function () {
		return fetch(CONFIG.endpoint, { method: 'GET' })
			.then(function (r) { return r.ok ? r.json() : { enabled: false }; })
			.then(function (j) { return !!(j && j.enabled); })
			.catch(function () { return false; });
	};

	// Synthesize speech for a piece of text.
	// Returns a Promise<Blob> (audio/mpeg). Throws an Error with a `.status`
	// property on failure so the caller can decide whether to fall back.
	window.folioSynthesizeSpeech = function (text, opts) {
		opts = opts || {};
		var voiceId = opts.voiceId || CONFIG.defaultVoiceId;
		var src = (text || '').toString();
		var chunk = src.length > CONFIG.maxChars ? src.slice(0, CONFIG.maxChars) + '...' : src;

		return fetch(CONFIG.endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
			body: JSON.stringify({ text: chunk, voiceId: voiceId, modelId: CONFIG.modelId }),
		}).then(function (res) {
			if (!res.ok) {
				return res.json().catch(function () { return {}; }).then(function (j) {
					var err = new Error((j && j.error) || ('TTS error ' + res.status));
					err.status = res.status;
					throw err;
				});
			}
			return res.blob();
		});
	};
})();
