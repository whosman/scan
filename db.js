/* db.js - keeps the student's pages on the phone, so closing the browser or the camera app loses nothing. MIT licence.
   Everything fails soft: if storage is blocked or full, the app still works, it just does not remember. */
(function (root) {
  'use strict';
  const NAME = 'hwscan', VER = 1;
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const rq = indexedDB.open(NAME, VER);
        rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore('pages', { keyPath: 'id' }); d.createObjectStore('kv'); };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = rq.onblocked = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function run(store, mode, fn) {
    return open().then((db) => !db ? null : new Promise((res) => {
      try {
        const tx = db.transaction(store, mode), out = fn(tx.objectStore(store));
        tx.oncomplete = () => res(out && out.result !== undefined ? out.result : true);
        tx.onerror = tx.onabort = () => res(null);
      } catch (e) { res(null); }
    }));
  }
  const api = {
    putPage: (rec) => run('pages', 'readwrite', (s) => s.put(rec)),
    delPage: (id) => run('pages', 'readwrite', (s) => s.delete(id)),
    setOrder: (ids) => run('kv', 'readwrite', (s) => s.put(ids, 'order')),
    async loadAll() {
      const o = await run('kv', 'readonly', (s) => s.get('order')), a = await run('pages', 'readonly', (s) => s.getAll());
      const order = Array.isArray(o) ? o : [], all = Array.isArray(a) ? a : [];
      const by = new Map(all.map((p) => [p.id, p]));
      return order.map((id) => by.get(id)).filter(Boolean);
    },
    async clear() { await run('pages', 'readwrite', (s) => s.clear()); await run('kv', 'readwrite', (s) => s.clear()); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HWDB = api;
})(typeof self !== 'undefined' ? self : this);
