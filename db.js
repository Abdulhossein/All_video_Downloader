// Simple IndexedDB wrapper for storing the download directory handle

class AVDDatabase {
    constructor() {
        this.dbName = 'AVD_Storage';
        this.storeName = 'handles';
    }

    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            
            request.onerror = (e) => reject(e.target.error);
            
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
        });
    }

    async getHandle(key = 'downloadFolder') {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.get(key);
            request.onerror = (e) => reject(e.target.error);
            request.onsuccess = (e) => resolve(request.result);
        });
    }

    async saveHandle(handle, key = 'downloadFolder') {
        if (!this.db) await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(handle, key);
            request.onerror = (e) => reject(e.target.error);
            request.onsuccess = () => resolve();
        });
    }
}

const avdDb = new AVDDatabase();
