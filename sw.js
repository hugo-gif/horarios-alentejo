/* =============================================================
   Service Worker — Horários do Alentejo (offline)
   Cache: ra-cache-v3
   Estratégia:
     • install: pré-cache resiliente (allSettled) dos ficheiros vitais.
     • fetch:
         - navegação: network-first com fallback offline para /index.html;
         - /horarios.json: stale-while-revalidate (resposta imediata + atualização em fundo);
         - estáticos locais: cache-first com fallback de rede;
         - cross-origin (Tailwind CDN / Google Fonts): cache dinâmico opaque.
   ============================================================= */

const CACHE_NAME = 'ra-cache-v3';

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/app.js',
  '/horarios.json',
  '/icon.svg',
  '/icon-maskable.svg',
];

/* Chave de cache normalizada (sem query, ex.: /app.js?v=36 -> /app.js). */
function chave(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

/* Pré-cache resiliente de um único recurso: nunca rejeita nem bloqueia a
   instalação (o timeout evita que um fetch pendente congele o SW). */
async function precacheItem(cache, url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    clearTimeout(timer);
    if (res && res.ok) {
      await cache.put(url, res);
    } else {
      console.warn('[SW] Pré-cache falhou (HTTP ' + (res && res.status) + ') para', url);
    }
  } catch (err) {
    clearTimeout(timer);
    console.warn('[SW] Pré-cache falhou para', url, '—', err && err.message);
  }
}

self.addEventListener('install', (event) => {
  // Ativa imediatamente, sem esperar pelo fim do pré-cache.
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // allSettled: uma falha isolada (404/query/CORS) nunca aborta a instalação.
      Promise.allSettled(PRECACHE.map((url) => precacheItem(cache, url)))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Não interferir com o painel de administração.
  if (url.pathname.endsWith('/admin.html')) return;

  // Navegação: network-first com fallback offline (evita ERR_INTERNET_DISCONNECTED).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() =>
          caches.match('/index.html', { ignoreSearch: true })
            .then((r) => r || caches.match('/', { ignoreSearch: true }))
        )
    );
    return;
  }

  // Recursos do próprio domínio.
  if (url.origin === self.location.origin) {
    // /horarios.json: stale-while-revalidate (resposta imediata + atualização em fundo).
    if (url.pathname.endsWith('/horarios.json')) {
      event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
          const cached = await cache.match(chave(req.url), { ignoreSearch: true });
          const rede = fetch(req)
            .then((res) => {
              if (res && res.ok) cache.put(chave(req.url), res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || rede;
        })
      );
      return;
    }

    // Estáticos locais (app.js, manifest, ícones…): cache-first com fallback de rede.
    event.respondWith(
      caches.match(chave(req.url), { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(chave(req.url), copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // Cross-origin (Tailwind CDN, Google Fonts): cache dinâmico com resposta opaque.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const rede = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || rede;
    })
  );
});