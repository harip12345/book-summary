// Folio service worker - app shell offline cache
const CACHE = 'folio-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

// Endpoint dinamis yang TIDAK boleh di-cache (butuh jaringan langsung)
const DYNAMIC = /firestore\.googleapis|identitytoolkit|securetoken\.googleapis|firebaseinstallations|firebasedatabase|\.firebaseio\.com/;

self.addEventListener('install', function (event) {
	event.waitUntil(
		caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).catch(function () {})
	);
	self.skipWaiting();
});

self.addEventListener('activate', function (event) {
	event.waitUntil(
		caches.keys().then(function (keys) {
			return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
		})
	);
	self.clients.claim();
});

self.addEventListener('fetch', function (event) {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);

	// Jangan cache API kita sendiri & endpoint Firebase dinamis
	if (url.pathname.indexOf('/api/') === 0 || DYNAMIC.test(url.hostname)) return;

	// Navigasi halaman: network-first, fallback ke index.html (mode offline)
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req).then(function (res) {
				const copy = res.clone();
				caches.open(CACHE).then(function (c) { c.put('/index.html', copy); }).catch(function () {});
				return res;
			}).catch(function () {
				return caches.match('/index.html').then(function (r) { return r || caches.match('/'); });
			})
		);
		return;
	}

	// Aset lain (JS/CSS/font/CDN): cache-first lalu jaringan
	event.respondWith(
		caches.match(req).then(function (cached) {
			if (cached) return cached;
			return fetch(req).then(function (res) {
				if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
					const copy = res.clone();
					caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
				}
				return res;
			}).catch(function () { return caches.match(req); });
		})
	);
});
