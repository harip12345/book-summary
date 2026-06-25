// Folio - Web search proxy (Vercel Serverless Function) using Tavily.
// Keeps the API key hidden on the server side.
//
// GET  /api/web-search  -> { enabled: boolean, provider: 'tavily' }   (health check)
// POST /api/web-search  -> { answer: string, results: [{ title, url, content, score }] }
//   body: { query: string, max_results?: number }
//
// Requires environment variable: TAVILY_API_KEY

const TAVILY_URL = 'https://api.tavily.com/search';

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}

	const hasKey = !!process.env.TAVILY_API_KEY;

	if (req.method === 'GET') {
		res.setHeader('Cache-Control', 'no-store');
		res.status(200).json({ enabled: hasKey, provider: 'tavily' });
		return;
	}

	if (req.method !== 'POST') {
		res.setHeader('Allow', 'GET, POST, OPTIONS');
		res.status(405).json({ error: 'Method not allowed' });
		return;
	}

	if (!hasKey) {
		res.status(500).json({ error: 'TAVILY_API_KEY belum diset di environment variable.' });
		return;
	}

	try {
		let body = req.body;
		if (typeof body === 'string') {
			try { body = JSON.parse(body); } catch (e) { body = {}; }
		}
		body = body || {};

		const query = (body.query || '').toString().trim();
		if (!query) {
			res.status(400).json({ error: 'Missing query' });
			return;
		}

		const maxResults = Math.min(Math.max(parseInt(body.max_results, 10) || 8, 1), 12);

		const tavilyRes = await fetch(TAVILY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				api_key: process.env.TAVILY_API_KEY,
				query: query,
				search_depth: 'advanced',
				topic: 'general',
				max_results: maxResults,
				include_answer: true
			})
		});

		if (!tavilyRes.ok) {
			const txt = await tavilyRes.text().catch(function () { return ''; });
			res.status(tavilyRes.status).json({ error: 'Tavily error', detail: String(txt).slice(0, 300) });
			return;
		}

		const data = await tavilyRes.json();
		const results = (data.results || []).map(function (r) {
			return { title: r.title || '', url: r.url || '', content: r.content || '', score: r.score };
		});

		res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
		res.status(200).json({ answer: data.answer || '', results: results });
	} catch (e) {
		res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
	}
}
