'use strict';

// ============================================================================
// FILENAME UTILS (Copied from utils.js)
// ============================================================================
function sanitizeFilename(name) {
    if (!name) return '';
    return name.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s\s+/g, ' ').trim().substring(0, 150);
}

function getExtensionFromUrl(url) {
    if (!url) return '';
    try {
        const pathname = new URL(url).pathname;
        const lastDot = pathname.lastIndexOf('.');
        if (lastDot === -1) return '';
        return pathname.substring(lastDot + 1).toLowerCase().split('?')[0].split('#')[0];
    } catch (e) {
        return '';
    }
}

function getFilename(stream, downloadUrl) {
    let ext = getExtensionFromUrl(downloadUrl);
    if (!ext) {
        const typeMap = { 'video': 'mp4', 'audio': 'mp3', 'image': 'jpg', 'hls': 'mp4', 'dash': 'mp4' };
        ext = typeMap[stream.type] || 'mp4';
    }
    
    let name = 'media';
    try {
        const urlFilename = sanitizeFilename(decodeURIComponent(new URL(downloadUrl).pathname.split('/').pop() || ''));
        const titleFilename = sanitizeFilename(stream.title || '');

        if (titleFilename && !/^(media|video|audio|index|master|playlist)/i.test(titleFilename)) {
            name = titleFilename;
        } else if (urlFilename && !/^(media|video|audio|index|master|playlist)/i.test(urlFilename)) {
            const nameFromUrl = urlFilename.substring(0, urlFilename.lastIndexOf('.'));
            if (nameFromUrl) name = nameFromUrl;
        }
    } catch(e) {
        name = sanitizeFilename(stream.title || 'media');
    }

    const lastDot = name.lastIndexOf('.');
    if (lastDot > 0) {
        const potentialExt = name.substring(lastDot + 1).toLowerCase();
        const KNOWN_EXTENSIONS = ['mp3', 'mp4', 'webm', 'flv', 'mov', 'avi', 'mkv', 'aac', 'wav', 'ogg', 'jpeg', 'jpg', 'png', 'gif', 'bmp', 'm3u8', 'ts', 'm4s', 'mpd'];
        if (KNOWN_EXTENSIONS.includes(potentialExt)) {
            name = name.substring(0, lastDot);
        }
    }
    
    return sanitizeFilename(`${name}.${ext}`);
}


// ============================================================================
// DECLARATIVE NET REQUEST RULES (For YouTube Downloads)
// ============================================================================

async function setupDnrRules() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [1],
            addRules: [{
                id: 1,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
                        { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
                    ]
                },
                condition: {
                    urlFilter: '||googlevideo.com',
                    resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame', 'other']
                }
            }]
        });
        console.log('DNR rules updated');
    } catch (e) {
        console.error('Failed to update DNR rules:', e);
    }
}

// Setup on install/startup
chrome.runtime.onInstalled.addListener(() => setupDnrRules());
chrome.runtime.onStartup.addListener(() => setupDnrRules());
setupDnrRules(); // Call immediately as well

// ============================================================================
// INDEXED DB CACHE (simplified inline for MV3 compatibility)
// ============================================================================

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
                const db = event.target.result;
                if (!db.objectStoreNames.contains('m3u8Cache')) {
                    const store = db.createObjectStore('m3u8Cache', { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
                if (!db.objectStoreNames.contains('connectionSpeed')) {
                    db.createObjectStore('connectionSpeed', { keyPath: 'id' });
                }
            };
        });
    }

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
                const cursor = event.target.result;
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

// ============================================================================
// LOGGING & TAB DATA (must be defined before use)
// ============================================================================

const log = (msg) => console.log('[AVD BG]', msg);
const globalStreams = new Set();
let lastHtmlScan = 0;

let downloadMajorTypesEnabledBG = false;
let downloadAllFileTypesEnabledBG = false;
chrome.storage.local.get(['downloadMajorTypes', 'downloadAllFileTypes'], (result) => {
    downloadMajorTypesEnabledBG = !!result.downloadMajorTypes;
    downloadAllFileTypesEnabledBG = !!result.downloadAllFileTypes;
});
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.downloadMajorTypes) {
            downloadMajorTypesEnabledBG = !!changes.downloadMajorTypes.newValue;
        }
        if (changes.downloadAllFileTypes) {
            downloadAllFileTypesEnabledBG = !!changes.downloadAllFileTypes.newValue;
        }
    }
});


let estimatedBandwidth = 10000000; // Default: 10 Mbps

async function measureConnectionSpeed() {
    try {
        const startTime = Date.now();
        const response = await fetch('https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png', {
            method: 'HEAD',
            cache: 'no-store'
        });
        
        if (response.ok) {
            const size = response.headers.get('content-length');
            const time = Date.now() - startTime;
            if (size && time > 0) {
                // Calculate bits per second
                estimatedBandwidth = (parseInt(size) * 8) / (time / 1000);
                log(`Connection speed: ${(estimatedBandwidth / 1000000).toFixed(2)} Mbps`);
                
                // Cache the result
                cacheDB.put('connectionSpeed', {
                    id: 'current',
                    bandwidth: estimatedBandwidth,
                    timestamp: Date.now()
                }).catch(() => {});
            }
        }
    } catch (e) {
        log('Speed measurement failed: ' + e.message);
    }
}

function selectOptimalQuality(variantPlaylists) {
    if (!variantPlaylists || variantPlaylists.length === 0) {
        return null;
    }

    // Sort by bandwidth
    const sorted = [...variantPlaylists].sort((a, b) => a.bandwidth - b.bandwidth);

    // Select quality that fits within estimated bandwidth (80% buffer)
    const targetBandwidth = estimatedBandwidth * 0.8;
    const optimal = sorted.find(v => v.bandwidth <= targetBandwidth) || sorted[0];

    log(`Adaptive bitrate: Selected ${optimal.quality} (${optimal.bandwidth} bps vs ${estimatedBandwidth} bps available)`);
    return optimal;
}

// Measure connection speed every 30 minutes
setInterval(() => measureConnectionSpeed(), 1800000);

// ============================================================================
// WEB WORKER FOR M3U8 PARSING
// ============================================================================

let m3u8Worker;

function initWorker() {
    try {
        const workerUrl = chrome.runtime.getURL('m3u8-worker.js');
        m3u8Worker = new Worker(workerUrl);
        m3u8Worker.pending = new Map();
        m3u8Worker.messageId = 0;

        m3u8Worker.onmessage = function(event) {
            const { id, success, result, error } = event.data;
            const pending = this.pending.get(id);

            if (pending) {
                if (success) {
                    pending.resolve(result);
                } else {
                    pending.reject(new Error(error));
                }
                this.pending.delete(id);
            }
        };

        log('Web Worker initialized for M3U8 parsing');
    } catch (e) {
        log('Web Worker init failed: ' + e.message);
        m3u8Worker = null;
    }
}

/**
 * @param {string} playlist
 * @param {string} playlistUrl
 */
function parseM3u8WithWorker(playlist, playlistUrl) {
    return new Promise((resolve, reject) => {
        if (!m3u8Worker) {
            // Fallback to sync parsing
            resolve(parseM3u8(playlist, playlistUrl));
            return;
        }

        const id = ++m3u8Worker.messageId;
        m3u8Worker.pending.set(id, { resolve, reject });

        m3u8Worker.postMessage({
            id,
            playlist,
            playlistUrl
        });

        // Timeout after 5s
        setTimeout(() => {
            if (m3u8Worker.pending.has(id)) {
                m3u8Worker.pending.delete(id);
                reject(new Error('M3U8 parsing timeout'));
            }
        }, 5000);
    });
}

initWorker();


function detectContentType(url) {
    if (!url) return 'unknown';
    try {
        const a = new URL(url);
        const l = a.pathname.toLowerCase();
        const ext = l.split('.').pop() || '';

        if (!ext) return 'other';

        // Media
        if (['m3u8'].includes(ext)) return 'hls';
        if (['mpd'].includes(ext)) return 'dash';
        if (['mp4', 'webm', 'flv', 'mov', 'ogv', 'avi', 'mpg', 'mpeg', 'mkv', '3gp', 'wmv', 'ts'].includes(ext)) return 'video';
        if (['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac', 'wma'].includes(ext)) return 'audio';
        if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff'].includes(ext)) return 'image';

        // Archives
        if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'img', 'udf'].includes(ext)) return 'zip';
        
        // OS related files
        if (['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'app', 'ipa', 'run', 'bin'].includes(ext)) return 'os';

        // Documents
        if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'html', 'htm'].includes(ext)) return 'document';

        // Scripts & Styles
        if (['js', 'css', 'json'].includes(ext)) return 'script';

        // Fonts
        if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return 'font';
        
        return 'other';
    } catch(e) {
        return 'unknown';
    }
}

function getCodec(url) {
    if (!url) return null;
    const lower = url.toLowerCase();
    if (lower.includes('vp9') || lower.includes('vp09')) return 'VP9';
    if (lower.includes('av01')) return 'AV1';
    if (lower.includes('h264') || lower.includes('avc')) return 'H.264';
    if (lower.includes('h265') || lower.includes('hevc')) return 'H.265';
    if (lower.includes('opus')) return 'Opus';
    if (lower.includes('vorbis')) return 'Vorbis';
    if (lower.includes('aac')) return 'AAC';
    if (lower.includes('mp3')) return 'MP3';
    return null;
}

function getVideoTitleFromUrl(url) {
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname;
        const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
        return decodeURIComponent(filename) || 'media';
    } catch (e) {
        return 'media';
    }
}

function parseM3u8(playlist, playlistUrl) {
    const lines = playlist.split('\n');
    const segments = [];
    const variantPlaylists = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;

        if (line.startsWith('#EXT-X-STREAM-INF')) {
            if (i + 1 < lines.length) {
                const nextLine = lines[i+1].trim();
                if (nextLine.length > 0 && !nextLine.startsWith('#')) {
                    const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                    const resolution = resolutionMatch ? resolutionMatch[1] : null;
                    let quality = 'Default';
                    if (resolution) {
                        quality = resolution.split('x')[1] + 'p';
                    }
                    variantPlaylists.push({
                        url: new URL(nextLine, playlistUrl).href,
                        info: line,
                        quality: quality
                    });
                }
            }
        } else if (!line.startsWith('#')) {
            try {
                segments.push(new URL(line, playlistUrl).href);
            } catch (e) {
                // Skip malformed URLs
            }
        }
    }
    return { segments, variantPlaylists };
}

// ============================================================================
// ADD STREAM (parse HLS and track video)
// ============================================================================

/**
 * @param {number} tabId
 * @param {any} stream
 */
async function addStream(tabId, stream) {
    if (!stream) return;

    // Parse HLS to find qualities with caching & worker
    if ((stream.type === 'hls' || stream.url.includes('.m3u8')) && !stream.qualities) {
        try {
            const cacheKey = stream.url;
            const now = Date.now();
            const CACHE_TTL = 3600000; // 1 hour

            // Try to get from IndexedDB cache first
            let cachedData = null;
            try {
                cachedData = await cacheDB.get('m3u8Cache', cacheKey);
                if (cachedData && (now - cachedData.timestamp) < CACHE_TTL) {
                    stream.qualities = cachedData.qualities;
                    stream.url = cachedData.bestUrl;
                    stream.estimatedDuration = cachedData.estimatedDuration;
                    log('M3U8 loaded from IndexedDB cache');
                    return;
                }
            } catch (e) {
                // Cache miss or error, proceed with fetch
            }

            // Fetch with 5s timeout
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(stream.url, { signal: controller.signal });
            clearTimeout(timeout);
            
            const playlistText = await response.text();
            
            // Use Web Worker to parse M3U8
            const parseResult = await parseM3u8WithWorker(playlistText, stream.url);
            const { variantPlaylists, estimatedDuration } = parseResult;

            if (variantPlaylists.length > 0) {
                // Use adaptive bitrate selection
                const optimalVariant = selectOptimalQuality(variantPlaylists);
                
                stream.qualities = variantPlaylists.map(p => ({
                    quality: p.quality,
                    url: p.url,
                    bandwidth: p.bandwidth,
                    resolution: p.resolution
                }));
                stream.url = optimalVariant.url;
                stream.estimatedDuration = estimatedDuration;
                
                // Cache to IndexedDB
                try {
                    await cacheDB.put('m3u8Cache', {
                        url: cacheKey,
                        qualities: stream.qualities,
                        bestUrl: stream.url,
                        estimatedDuration,
                        timestamp: now
                    });
                } catch (e) {
                    log('Failed to cache M3U8: ' + e.message);
                }
            }
        } catch (e) {
            log('HLS parsing error: ' + e.message);
        }
    }

    // Fetch Content-Length if not already present
    if (stream.url && !stream.size && !stream.url.startsWith('blob:') && !stream.url.startsWith('data:')) {
        try {
            const response = await fetch(stream.url, { method: 'HEAD', cache: 'no-store' });
            if (response.ok) {
                const contentLength = response.headers.get('content-length');
                if (contentLength) {
                    stream.size = parseInt(contentLength, 10);
                    log(`Fetched size for ${stream.url.substring(0, 50)}: ${stream.size} bytes`);
                }
            }
        } catch (e) {
            log(`Failed to fetch HEAD for size of ${stream.url.substring(0, 50)}: ${e.message}`);
        }
    }

    // Validate stream object
    if (!stream.url || typeof stream.url !== 'string') return;

    let finalTitle = stream.title || 'media';
    const urlFilename = getVideoTitleFromUrl(stream.url);
    if (urlFilename && urlFilename !== 'media') {
        const nameWithoutExt = urlFilename.includes('.') ? urlFilename.substring(0, urlFilename.lastIndexOf('.')) : urlFilename;
        const genericNames = ['video', 'media', 'videoplayback', 'index', 'master', 'playlist', 'segment', 'stream', 'audio', 'watch', 'download', 'file'];
        
        if (!genericNames.includes(nameWithoutExt.toLowerCase())) {
            finalTitle = urlFilename;
            if (stream.title && stream.title !== urlFilename && !stream.artist && stream.title.toLowerCase() !== 'download') {
                stream.artist = stream.title;
            }
        }
    }

    const newStream = {
        url: stream.url,
        type: stream.type === 'auto' ? detectContentType(stream.url) : (stream.type || detectContentType(stream.url)),
        title: finalTitle,
        qualities: stream.qualities || [{ quality: 'Default', url: stream.url }],
        codec: stream.codec || getCodec(stream.url),
        bitrate: stream.bitrate || null,
        estimatedDuration: stream.estimatedDuration || null,
        isMain: stream.isMain || false,
        artist: stream.artist || '',
        thumbnail: stream.thumbnail || '',
        timestamp: Date.now(),
        downloadStatus: null,
        downloadId: null,
        progress: null,
        tabId: tabId // Store tabId for tab-specific filtering
    };

    // Deduplicate strictly by URL
    let existingStream = Array.from(globalStreams).find(s => s.url === newStream.url);

    // If not found by URL, deduplicate by Title + Type (but NOT for Audio to allow playlists)
    if (!existingStream) {
        existingStream = Array.from(globalStreams).find(s => {
            if (s.title !== newStream.title || s.type !== newStream.type) return false;
            if (s.title === getVideoTitleFromUrl(newStream.url) || s.title === 'Embedded Media' || s.title === 'Video' || s.title === 'Audio') return false;
            
            // DON'T deduplicate if they are audio files (allows playlists of MP3s with the same page title)
            const isAudioType = ['audio', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'].includes(s.type);
            if (isAudioType) return false;
            
            return true;
        });
    }

    if (existingStream) {
        // Merge qualities if new ones found
        if (newStream.qualities.length > existingStream.qualities.length) {
            existingStream.qualities = newStream.qualities;
            existingStream.url = newStream.url;
        }
        
        // Promote to main if the new observation is flagged as main
        if (newStream.isMain && !existingStream.isMain) {
            existingStream.isMain = true;
            if (newStream.artist) existingStream.artist = newStream.artist;
            if (newStream.thumbnail) existingStream.thumbnail = newStream.thumbnail;
        }
    } else {
        globalStreams.add(newStream);
    }

    updateBadge(tabId, globalStreams.size);
    log(`Stream found [${newStream.type}]: ${newStream.title.substring(0, 50)}`);
}
/**
 * @param {number} tabId
 * @param {number} count
 */
function updateBadge(tabId, count) {
    if (count > 0) {
        chrome.action.setBadgeText({ tabId, text: String(count) });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#667eea' });
    } else {
        chrome.action.setBadgeText({ tabId, text: '' });
    }
}

// ============================================================================
// BACKGROUND QUEUE MANAGER
// ============================================================================
class BackgroundQueue {
    constructor(maxConcurrent = 2) {
        this.queue = [];
        this.active = 0;
        this.maxConcurrent = maxConcurrent;
    }

    add(streamUrl, url, filename, useLocalFs = false) {
        const stream = Array.from(globalStreams).find(s => s.url === streamUrl);
        if (stream) {
            stream.downloadStatus = 'queued';
        }
        this.queue.push({ streamUrl, url, filename, useLocalFs });
        chrome.runtime.sendMessage({ action: 'queueUpdated' }).catch(() => {});
        this.process();
    }

    process() {
        if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
        
        const task = this.queue.shift();
        this.active++;
        
        const stream = Array.from(globalStreams).find(s => s.url === task.streamUrl);
        
        if (task.useLocalFs) {
            if (stream) {
                stream.downloadStatus = 'downloading';
                stream.downloadId = 'local-' + Date.now();
                chrome.runtime.sendMessage({ action: 'queueUpdated' }).catch(() => {});
            }
            this.downloadViaOffscreenFs(task, stream)
                .then(() => {
                    if (stream) stream.downloadStatus = 'completed';
                    this.onTaskComplete(null, null);
                })
                .catch(err => {
                    log("Local FS error: " + err);
                    if (stream) stream.downloadStatus = 'error';
                    this.onTaskComplete(null, null);
                });
            return;
        }

        if (task.url.startsWith('direct:')) {
            if (stream) {
                stream.downloadStatus = 'downloading';
                chrome.runtime.sendMessage({ action: 'queueUpdated' }).catch(() => {});
            }
            const parts = task.url.split(':');
            const format = parts[1];
            const quality = parts[2];
            
            handleDirectYouTube({ videoUrl: stream ? stream.url.replace('#video', '').replace('#audio', '') : task.streamUrl.replace('#video', '').replace('#audio', ''), format, quality, title: task.filename })
                .then(realUrl => {
                    this._startDownload(task, stream, realUrl);
                })
                .catch(err => {
                    log("YouTube Direct error: " + err);
                    if (stream) stream.downloadStatus = 'error';
                    this.onTaskComplete(null, null);
                    chrome.runtime.sendMessage({ action: 'queueUpdated' }).catch(() => {});
                });
            return;
        }

        this._startDownload(task, stream, task.url);
    }

    _startDownload(task, stream, realUrl) {
        chrome.downloads.download({
            url: realUrl,
            filename: task.filename,
            conflictAction: 'uniquify',
            saveAs: true
        }, (downloadId) => {
            if (downloadId) {
                if (stream) {
                    stream.downloadStatus = 'downloading';
                    stream.downloadId = downloadId;
                }
                
                const onDownloadChanged = (delta) => {
                    if (delta.id === downloadId) {
                        if (stream && delta.state) {
                            if (delta.state.current === 'complete') {
                                stream.downloadStatus = 'completed';
                                this.onTaskComplete(downloadId, onDownloadChanged);
                            } else if (delta.state.current === 'interrupted' || delta.state.current === 'broken') {
                                stream.downloadStatus = 'error';
                                this.onTaskComplete(downloadId, onDownloadChanged);
                            }
                        }
                    }
                };
                chrome.downloads.onChanged.addListener(onDownloadChanged);
            } else {
                log('Download failed to start: ' + chrome.runtime.lastError?.message);
                if (stream) stream.downloadStatus = 'error';
                this.onTaskComplete(null, null);
            }
            
            // Broadcast state update so UI updates immediately
            chrome.runtime.sendMessage({ action: 'queueUpdated' }).catch(() => {});
        });
    }

    async downloadViaOffscreenFs(task, stream) {
        const offscreenUrl = chrome.runtime.getURL('offscreen.html');
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });
        
        if (existingContexts.length === 0) {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['BLOBS'],
                justification: 'Background file system writing'
            });
        }

        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: 'downloadLocalFsOffscreen',
                url: task.url,
                filename: task.filename,
                streamUrl: task.streamUrl,
                fakeId: stream ? stream.downloadId : null
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError.message);
                } else if (response && response.error) {
                    reject(response.error);
                } else {
                    resolve();
                }
            });
        });
    }

    onTaskComplete(downloadId, listener) {
        this.active--;
        if (listener) {
            chrome.downloads.onChanged.removeListener(listener);
        }
        chrome.runtime.sendMessage({ action: 'queueUpdated' }).catch(() => {});
        this.process();
    }
}

const bgQueue = new BackgroundQueue(2);

// ============================================================================
// MESSAGE LISTENER
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        const tabId = request.tabId || sender.tab?.id;

        if (request.action === 'getDetectedStreams') {
            const requestedTabId = request.tabId || sender.tab?.id;
            const streams = Array.from(globalStreams).filter(s => {
                // If the stream is downloading/queued, keep it visible everywhere
                if (s.downloadStatus === 'queued' || s.downloadStatus === 'downloading') return true;
                // Otherwise, only show if it belongs to the current tab
                return s.tabId === requestedTabId;
            });
            sendResponse({ streams });
        } else if (request.action === 'trackStream') {
            if (tabId && request.stream) {
                addStream(tabId, request.stream);
            }
            sendResponse({ success: true });
        } else if (request.action === 'downloadHls') {
            if (request.stream && tabId) {
                downloadHlsViaOffscreen(request.stream, tabId);
            }
            sendResponse({ success: true });
        } else if (request.action === 'queueDownload') {
            if (request.stream && request.downloadUrl) {
                const stream = request.stream;
                const downloadUrl = request.downloadUrl;
                const filename = getFilename(stream, downloadUrl);
                bgQueue.add(stream.url, downloadUrl, filename, request.useLocalFs);
            }
            sendResponse({ success: true });
        } else if (request.action === 'triggerDownload') {
            chrome.downloads.download({
                url: request.url,
                filename: request.filename
            }, (downloadId) => {
                const onDownloadChanged = (delta) => {
                    if (delta.id === downloadId && delta.state?.current !== 'in_progress') {
                        chrome.runtime.sendMessage({ action: 'revokeBlob', url: request.url }).catch(()=>({}));
                        chrome.downloads.onChanged.removeListener(onDownloadChanged);
                    }
                };
                chrome.downloads.onChanged.addListener(onDownloadChanged);
            });
            sendResponse({ success: true });
        } else if (request.action === 'clearStreams') {
            globalStreams.clear();
            chrome.action.setBadgeText({ text: '' });
            sendResponse({ success: true });
        } else if (request.action === 'hlsProgress') {
            // Keep service worker alive and prevent "receiving end does not exist" errors
            sendResponse({ success: true });
        } else if (request.action === 'getFileInfo') {
            if (request.url) {
                fetch(request.url, { method: 'HEAD' })
                    .then(res => sendResponse({
                        contentLength: res.headers.get('content-length'),
                        contentType: res.headers.get('content-type')
                    }))
                    .catch(e => sendResponse({ error: e.message }));
                return true;
            }
        } else if (request.action === 'downloadDirectYouTube') {
            handleDirectYouTube(request).then((url) => {
                 chrome.downloads.download({
                     url: url,
                     filename: `${cleanFilename(request.title)}.${request.format === 'video' ? 'mp4' : 'mp3'}`
                 });
                 sendResponse({ success: true });
            }).catch(err => {
                 sendResponse({ error: err.message });
            });
            return true;
        } else if (request.action === 'resolveDirectLink') {
            handleDirectYouTube(request).then((url) => {
                sendResponse({ url: url });
            }).catch(err => {
                sendResponse({ error: err.message });
            });
            return true;
        } else if (request.action === 'rescanPage') {
            if (tabId) {
                chrome.tabs.sendMessage(tabId, { action: 'doRescan' }, () => {
                    if (chrome.runtime.lastError) {
                        log('Could not send rescan message to tab. It might be closed or a system page.');
                    }
                });
            }
            sendResponse({ success: true });
        } else if (request.action === 'scanHtmlForMedia') {
            if (tabId && request.html) {
                const now = Date.now();
                if (now - lastHtmlScan > 2000) {
                    lastHtmlScan = now;
                    setTimeout(() => processHtmlForMedia(tabId, request.html, request.url, request.title), 0);
                }
            }
            sendResponse({ success: true });
        } else {
            sendResponse({ error: 'Unknown action' });
        }
    } catch (e) {
        log('Message error: ' + e.message);
        sendResponse({ error: e.message });
    }
});

// YOUTUBE DETECTION
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url?.includes('youtube.com')) {
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => window.ytInitialPlayerResponse
        }, (results) => {
            if (chrome.runtime.lastError || !results?.[0]?.result) return;
            processYoutubeData(tabId, results[0].result);
        });
    }
});

function processHtmlForMedia(tabId, html, pageUrl, pageTitle) {
    if (!html || !tabId) return;
    
    // Define extension groups
    const mediaExtensions = ['mp4', 'm3u8', 'mp3', 'webm', 'm4a', 'aac', 'flv', 'ogg', 'wav', 'mov', 'avi', 'mpg', 'mkv', '3gp', 'wmv', 'ts', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
    const majorExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'img', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'run', 'bin'];
    const allFileExtensions = ['js', 'css', 'json', 'html', 'htm', 'xml', 'ttf', 'otf', 'woff', 'woff2'];

    let extensionsToScan = [];
    if (downloadAllFileTypesEnabledBG) {
        extensionsToScan = [...mediaExtensions, ...majorExtensions, ...allFileExtensions];
    } else if (downloadMajorTypesEnabledBG) {
        extensionsToScan = [...mediaExtensions, ...majorExtensions];
    } else {
        extensionsToScan = mediaExtensions;
    }

    const mediaRegex = new RegExp(`(?:https?(?:\\\\?/){2})[^"'\s<>\\{\\}\\[\\]]+(?:\\.${extensionsToScan.join('|\\.')})(?:(?:\\\\?\\?)[^"'\s<>\\{\\}\\[\\]]*)?`, 'gi');

    let match;
    const foundUrls = new Set();
    
    if (html.length < 100) return;
    
    let safety = 0;
    while ((match = mediaRegex.exec(html)) !== null && safety < 1000) {
        safety++;
        let url = match[0].replace(/\\/g, '');
        
        if (!url.startsWith('http')) continue;
        if (foundUrls.has(url)) continue;
        foundUrls.add(url);
        
        let alreadyExists = false;
        for (const stream of globalStreams) {
            if (stream.url === url) {
                alreadyExists = true;
                break;
            }
        }
        
        if (!alreadyExists) {
            const type = detectContentType(url);
            let title = pageTitle || "Scraped Media";
            const filenameMatch = url.match(/\/([^\/?#]+)$/);
            if (filenameMatch && filenameMatch[1]) {
                const name = decodeURIComponent(filenameMatch[1]);
                if (name.length < 50) {
                    title = name;
                }
            }
            
            addStream(tabId, {
                url: url,
                type: type,
                title: title,
                source: 'html-scanner'
            });
        }
    }
}

/**
 * @param {number} tabId
 * @param {any} data
 */
function processYoutubeData(tabId, data) {
    if (!data?.videoDetails?.title) return;

    const videoTitle = data.videoDetails.title;
    const streamingData = data.streamingData;
    if (!streamingData) return;

    const formats = (streamingData.formats || []).concat(streamingData.adaptiveFormats || []);
    
    const qualities = formats
        .filter(f => f.url && f.qualityLabel)
        .map(f => ({
            quality: f.qualityLabel,
            url: f.url,
        }));

    const uniqueQualities = Array.from(new Map(qualities.map(item => [item.quality, item])).values())
        .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

    if (uniqueQualities.length > 0) {
        addStream(tabId, {
            url: uniqueQualities[0].url,
            type: 'youtube',
            title: videoTitle,
            qualities: uniqueQualities,
        });
    }
}

// DOWNLOAD RETRY WITH EXPONENTIAL BACKOFF
/**
 * @param {string} url
 * @param {number=} maxRetries
 * @param {number=} baseDelay
 */
async function fetchWithRetry(url, maxRetries = 3, baseDelay = 500) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return response;
            
            if (response.status === 429) {
                // Rate limited - retry with backoff
                throw new Error('Rate limited');
            }
            if (response.status >= 500) {
                // Server error - retry
                throw new Error('Server error: ' + response.status);
            }
            
            return response; // Don't retry 4xx errors except 429
        } catch (error) {
            lastError = error;
            
            if (attempt < maxRetries) {
                // Exponential backoff with jitter
                const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
                log(`Retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

async function downloadHlsViaOffscreen(stream, tabId) {
    try {
        const offscreenUrl = chrome.runtime.getURL('offscreen.html');
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });

        if (existingContexts.length === 0) {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['BLOBS'],
                justification: 'To download generated HLS video blobs'
            });
        }

        chrome.runtime.sendMessage({
            action: 'downloadHlsOffscreen',
            stream: stream,
            tabId: tabId
        });
    } catch (e) {
        log('Failed to start offscreen HLS download: ' + e.message);
        chrome.runtime.sendMessage({
            action: 'hlsError',
            streamUrl: stream.url,
            error: 'Offscreen initialization failed: ' + e.message
        }).catch(() => {});
    }
}


// Global persistence is now used, so we don't clear streams on tab close/update.
// The user manually clears the queue using the "Clear" button in the popup.

// Cleanup stale IndexedDB cache entries every 30 minutes
setInterval(() => {
    cacheDB.clearOld('m3u8Cache', 3600000).then(() => {
        log('Cleaned up stale M3U8 cache');
    }).catch(e => log('Cache cleanup error: ' + e.message));
}, 1800000);

log('Background service worker initialized');

// ============================================================================
// YOUTUBE DIRECT API
// ============================================================================
let cachedConverterServers = null;
let lastServerFetchTime = 0;

async function getConverterServers() {
    const defaultServers = [
        { name: "y2meta-uk", origin: "https://iframe.y2meta-uk.com", referer: "https://iframe.y2meta-uk.com/" },
        { name: "mp3yt", origin: "https://mp3yt.is", referer: "https://mp3yt.is/" },
    ];
    
    // Cache for 24 hours
    if (cachedConverterServers && (Date.now() - lastServerFetchTime < 24 * 60 * 60 * 1000)) {
        return cachedConverterServers;
    }
    
    try {
        // Auto-update proxy servers from the GreasyFork script
        const response = await fetch('https://update.greasyfork.org/scripts/527945/YouTube%20Direct%20Downloader.user.js');
        const text = await response.text();
        
        // Regex to extract CONVERTER_SERVERS array from the source code
        const match = text.match(/const\s+CONVERTER_SERVERS\s*=\s*(\[[\s\S]*?\]);/);
        if (match && match[1]) {
            // Convert JS object syntax to valid JSON
            let jsonStr = match[1]
                .replace(/([a-zA-Z0-9_]+)\s*:/g, '"$1":') // Quote keys
                .replace(/'/g, '"') // Replace single quotes with double
                .replace(/,\s*([\]}])/g, '$1'); // Remove trailing commas
            
            const servers = JSON.parse(jsonStr);
            if (servers && servers.length > 0) {
                cachedConverterServers = servers;
                lastServerFetchTime = Date.now();
                log('Updated converter servers from GreasyFork');
                return servers;
            }
        }
    } catch (e) {
        log('Failed to fetch updated servers from GreasyFork: ' + e.message);
    }
    
    return defaultServers;
}

async function handleDirectYouTube(request) {
    const CONVERTER_API_BASE = "https://cnv.cx";
    const servers = await getConverterServers();
    
    let payload;
    if (request.format === "video") {
        payload = new URLSearchParams({
            link: request.videoUrl,
            format: "mp4",
            audioBitrate: "128",
            videoQuality: request.quality,
            filenameStyle: "pretty",
            vCodec: "h264",
        });
    } else {
        payload = new URLSearchParams({
            link: request.videoUrl,
            format: "mp3",
            audioBitrate: request.quality,
            filenameStyle: "pretty",
        });
    }

    let lastError = null;
    for (const server of servers) {
        try {
            // 1. Get Key
            const keyRes = await fetch(`${CONVERTER_API_BASE}/v2/sanity/key`, {
                headers: { "Origin": server.origin, "Referer": server.referer }
            });
            const keyData = await keyRes.json();
            if (!keyData?.key) throw new Error("Failed to get API key");
            
            // 2. Convert
            const convertRes = await fetch(`${CONVERTER_API_BASE}/v2/converter`, {
                method: 'POST',
                headers: { 
                    "Origin": server.origin, 
                    "Referer": server.referer, 
                    "Content-Type": "application/x-www-form-urlencoded",
                    "key": keyData.key
                },
                body: payload
            });
            
            const result = await convertRes.json();
            if (result?.url) return result.url;
            throw new Error(`No download URL received (${result?.error?.code || result?.status || 'unknown error'})`);
        } catch (e) {
            lastError = e;
            log(`Server ${server.name} failed: ${e.message}`);
        }
    }
    
    throw lastError || new Error("All converter servers failed");
}

function cleanFilename(filename) {
    if (!filename) return "YouTube_Video";
    return filename.replace(/[<>:"/\\|?*]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/^\.+/, "").replace(/\.+$/, "").replace(/\s+/g, " ").trim() || "YouTube_Video";
}
