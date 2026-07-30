// IndexedDB wrapper for persistent metadata caching

class CacheDB {
    constructor() {
        this.db = null;
        this.ready = this.init();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('AVDCache', 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = /** @type {IDBOpenDBRequest} */ (event.target).result;

                // Store parsed M3U8 data
                if (!db.objectStoreNames.contains('m3u8Cache')) {
                    const store = db.createObjectStore('m3u8Cache', { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // Store stream metadata
                if (!db.objectStoreNames.contains('streamMetadata')) {
                    const store = db.createObjectStore('streamMetadata', { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // Store connection speed estimates
                if (!db.objectStoreNames.contains('connectionSpeed')) {
                    db.createObjectStore('connectionSpeed', { keyPath: 'id' });
                }
            };
        });
    }

    /**
     * @param {string} storeName
     * @param {any} key
     */
    async get(storeName, key) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * @param {string} storeName
     * @param {any} value
     */
    async put(storeName, value) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put({ ...value, timestamp: Date.now() });

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * @param {string} storeName
     * @param {any} key
     */
    async delete(storeName, key) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    /**
     * @param {string} storeName
     * @param {number} maxAgeMsec
     */
    async clearOld(storeName, maxAgeMsec) {
        await this.ready;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const index = store.index('timestamp');
            const range = IDBKeyRange.upperBound(Date.now() - maxAgeMsec);
            const request = index.openCursor(range);

            request.onerror = () => reject(request.error);
            request.onsuccess = (event) => {
                const cursor = /** @type {IDBRequest} */ (event.target).result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
        });
    }
}

const cacheDB = new CacheDB();
