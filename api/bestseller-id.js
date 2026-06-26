// Folio - GPU (gpu.id) Best Seller scraper proxy.
// GET /api/bestseller-id?page=N  ->  { page, count, items: [ { id, rank, title, ... } ] }
// Books appear in rank order on the page; 20 books per page.

const SRC = 'https://gpu.id/book/best-seller';
const PER_PAGE = 20;

function decodeEntities(s) {
	return String(s || '')
		.replace(/&amp;/g, '&')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x27;/gi, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#0?34;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function firstMatch(re, str) {
	const m = re.exec(str);
	return m ? m[1] : '';
}

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	if (req.method === 'OPTIONS') { res.status(204).end(); return; }

	const q = req.query || {};
	let page = parseInt(q.page, 10);
	if (!page || page < 1) page = 1;

	const url = SRC + (page > 1 ? ('?page=' + page) : '');

	const controller = new AbortController();
	const timer = setTimeout(function () { controller.abort(); }, 9000);
	try {
		let r;
		try {
			r = await fetch(url, {
				signal: controller.signal,
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Language': 'id,en;q=0.8'
				}
			});
		} finally { clearTimeout(timer); }

		if (!r.ok) {
			res.status(r.status).json({ error: 'gpu.id error', detail: 'HTTP ' + r.status, page: page, items: [] });
			return;
		}

		const html = await r.text();

		// Each book card opens with this bootstrap column class on the best-seller list.
		const parts = html.split('col-lg-3 col-md-6 col-sm-12');
		const items = [];
		for (let i = 1; i < parts.length; i++) {
			const chunk = parts[i];

			const title = decodeEntities(firstMatch(/carousel__title">([\s\S]*?)<\/div>/, chunk));
			if (!title) continue;

			const author = decodeEntities(firstMatch(/carousel__author">([\s\S]*?)<\/span>/, chunk));
			const cover = firstMatch(/<img[^>]+src="([^"]+)"/, chunk);

			const linkM = /\/book\/(\d+)\/([^"]+)"/.exec(chunk);
			const bookId = linkM ? linkM[1] : '';
			const bookUrl = linkM ? ('https://gpu.id/book/' + linkM[1] + '/' + linkM[2]) : '';

			const cats = [];
			const catRe = /carousel__category">([\s\S]*?)<\/span>/g;
			let cm;
			while ((cm = catRe.exec(chunk)) !== null) {
				const c = decodeEntities(cm[1]).replace(/[\s,]+$/, '').trim();
				if (c) cats.push(c);
			}

			items.push({
				id: 'gpu-' + (bookId || (((page - 1) * PER_PAGE) + i)),
				rank: ((page - 1) * PER_PAGE) + items.length + 1,
				title: title,
				authors: author ? [author] : [],
				author: author,
				publisher: 'Gramedia Pustaka Utama',
				publishedDate: '',
				description: '',
				imageLinks: { thumbnail: cover },
				infoLink: bookUrl,
				categories: cats,
				source: 'GPU'
			});
		}

		res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
		res.status(200).json({ page: page, count: items.length, items: items });
	} catch (e) {
		const aborted = e && (e.name === 'AbortError');
		res.status(aborted ? 504 : 500).json({
			error: aborted ? 'Timeout saat mengambil data gpu.id' : 'Server error',
			detail: String((e && e.message) || e).slice(0, 300),
			page: page,
			items: []
		});
	}
}
