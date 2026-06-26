// Folio - Google Books proxy (Vercel Serverless Function).
// Fetches Google Books server-side to avoid browser rate-limit / CORS issues.
//
// GET/POST /api/books -> { items: [...], totalItems }
//   params: q (required), max?, newest? (1), lang? (1)
// Optional environment variable: GOOGLE_BOOKS_API_KEY (improves quota/reliability)

const GB_URL = 'https://www.googleapis.com/books/v1/volumes';

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}

	let src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
	if (typeof src === 'string') {
		try { src = JSON.parse(src); } catch (e) { src = {}; }
	}

	const q = String(src.q || '').trim();
	if (!q) {
		res.status(400).json({ error: 'Missing q', items: [] });
		return;
	}

	const max = Math.min(Math.max(parseInt(src.max, 10) || 20, 1), 40);
	const newest = src.newest === '1' || src.newest === 1 || src.newest === true;
	const lang = src.lang === '1' || src.lang === 1 || src.lang === true;

	let url = GB_URL + '?q=' + encodeURIComponent(q) + '&maxResults=' + max + '&printType=books&country=ID';
	if (lang) url += '&langRestrict=id';
	if (newest) url += '&orderBy=newest';
	if (process.env.GOOGLE_BOOKS_API_KEY) url += '&key=' + encodeURIComponent(process.env.GOOGLE_BOOKS_API_KEY);

	const controller = new AbortController();
	const timer = setTimeout(function () { controller.abort(); }, 9000);
	try {
		let r;
		try {
			r = await fetch(url, { signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}

		if (!r.ok) {
			const txt = await r.text().catch(function () { return ''; });
			res.status(r.status).json({ error: 'Google Books error', detail: String(txt).slice(0, 300), items: [] });
			return;
		}

		const data = await r.json();
		const items = (data.items || []).map(function (it) {
			const v = it.volumeInfo || {};
			return {
				id: it.id,
				title: v.title,
				authors: v.authors,
				publisher: v.publisher,
				publishedDate: v.publishedDate,
				description: v.description,
				imageLinks: v.imageLinks,
				infoLink: v.infoLink,
				categories: v.categories
			};
		});

		res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');
		res.status(200).json({ items: items, totalItems: data.totalItems || 0 });
	} catch (e) {
		res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300), items: [] });
	}
}
