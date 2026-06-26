// Folio - New York Times Best Sellers proxy (Vercel Serverless Function).
// Official NYT Books API. No AI, no guessing: ranks come straight from NYT.
//
// GET /api/bestseller-nyt?list=fiction|nonfiction|advice|children
//   -> { list, listName, publishedDate, items: [ { rank, title, authors, ... } ] }
//
// Required environment variable: NYT_API_KEY (free at developer.nytimes.com)

const NYT_BASE = 'https://api.nytimes.com/svc/books/v3/lists/current/';

const LIST_MAP = {
	fiction: 'combined-print-and-e-book-fiction',
	nonfiction: 'combined-print-and-e-book-nonfiction',
	advice: 'advice-how-to-and-miscellaneous',
	children: 'childrens-middle-grade-hardcover'
};

export default async function handler(req, res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}

	const key = process.env.NYT_API_KEY;
	if (!key) {
		res.status(500).json({ error: 'NYT_API_KEY belum diset di environment Vercel.', items: [] });
		return;
	}

	const q = req.query || {};
	const listParam = String(q.list || 'fiction').toLowerCase();
	const listName = LIST_MAP[listParam] || LIST_MAP.fiction;

	const url = NYT_BASE + listName + '.json?api-key=' + encodeURIComponent(key);

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
			res.status(r.status).json({ error: 'NYT error', detail: String(txt).slice(0, 300), items: [] });
			return;
		}

		const data = await r.json();
		const results = (data && data.results) || {};
		const books = results.books || [];
		const items = books.map(function (b) {
			let link = b.amazon_product_url || '';
			if (!link && Array.isArray(b.buy_links) && b.buy_links[0]) link = b.buy_links[0].url || '';
			return {
				id: 'nyt-' + (b.primary_isbn13 || b.primary_isbn10 || String(b.rank)),
				rank: b.rank || 0,
				title: b.title || '',
				authors: b.author ? [b.author] : [],
				publisher: b.publisher || '',
				publishedDate: '',
				description: b.description || '',
				imageLinks: { thumbnail: b.book_image || '' },
				infoLink: link,
				categories: [],
				source: 'New York Times'
			};
		});

		res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
		res.status(200).json({
			list: listParam,
			listName: results.list_name || listName,
			publishedDate: results.published_date || (data && data.results && data.results.published_date) || '',
			items: items
		});
	} catch (e) {
		res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300), items: [] });
	}
}
