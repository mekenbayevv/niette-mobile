/* Service worker мобильного кабинета NIETTE.
 *
 * Кэшируем ТОЛЬКО оболочку (HTML, манифест, иконки). Данные не кэшируем
 * здесь принципиально: их кэширует сам экран в localStorage вместе с меткой
 * времени, и пользователь видит «данные на 14:32». Если бы цифры отдавал
 * service worker, вчерашние значения выглядели бы как сегодняшние.
 *
 * При смене CACHE_VERSION старый кэш удаляется, а новая версия берёт
 * управление сразу (skipWaiting + clients.claim) — иначе пользователь сидел бы
 * на старой оболочке до полного закрытия всех вкладок.
 */
const CACHE_VERSION = 'niette-shell-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // нет сети при установке — не блокируем
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POST к API — мимо кэша
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // запросы к Apps Script — только сеть

  // Оболочка: сначала сеть (чтобы обновление подхватывалось), при отказе — кэш.
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
