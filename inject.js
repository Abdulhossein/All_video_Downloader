// Enhanced network interceptor with video detection

(function() {
    'use strict';

    // Debounce utility function (FIX: was missing)
    /**
     * @param {Function} fn
     * @param {number} delay
     */
    function debounce(fn, delay) {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(/** @type {any} */ (this), args), delay);
        };
    }

    const detectedUrls = new Set();
    const MAX_CACHED_URLS = 10000; // Prevent unbounded growth

    const videoPatterns = [
        '.m3u8', '.mp4', '.webm', '.mov', '.mkv', '.flv', '.ts', '.m4s', '.mpd',
        '.m4a', '.aac', '.mp3', '.wav', '.ogg', '.flac', '.wma', 'manifest', 'playlist', 'stream', 'audio',
        '/video/', '/media/', '/content/', '/watch'
    ];

    const hostPatterns = [
        'googlevideo.com', 'youtube.com', 'youtu.be', 'vimeo.com',
        'cloudfront.net', 'akamai', 'cdn.', 'bitmovin', 'jwplayer'
    ];

    // Batch postMessages to prevent flooding (max 1 per 100ms)
    const messageQueue = new Set();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let messageTimer;

    /**
     * @param {any} msg
     */
    function queueMessage(msg) {
        messageQueue.add(msg);
        clearTimeout(messageTimer);
        messageTimer = setTimeout(() => {
            messageQueue.forEach(m => {
                try {
                    window.postMessage(m, '*');
                } catch (e) {}
            });
            messageQueue.clear();
        }, 100);
    }

    // Hook Fetch
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = String(args[0] || '');
        captureUrl(url);
        
        return originalFetch.apply(this, args).then(response => {
            if (response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const ranges = response.headers.get('content-range');
                
                if (contentType.includes('video') || contentType.includes('audio') || 
                    contentType.includes('mpegurl') || contentType.includes('dash') ||
                    url.includes('.m3u8') || url.includes('.mpd') || ranges) {
                    captureUrl(url, true);
                }
            }
            return response;
        }).catch(e => originalFetch.apply(this, args));
    };

    // Hook XHR
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(...args) {
        const url = args[1];
        /** @type {any} */ (this)._requestUrl = String(url || '');
        captureUrl(/** @type {any} */ (this)._requestUrl);
        return originalXHROpen.apply(this, /** @type {any} */ (args));
    };

    XMLHttpRequest.prototype.send = function(...args) {
        const self = /** @type {any} */ (this);
        const onReadyStateChange = self.onreadystatechange;
        
        self.onreadystatechange = function(...rcArgs) {
            if (self.readyState === 4 && self.status === 200) {
                const ct = self.getResponseHeader('content-type') || '';
                if (ct.includes('video') || ct.includes('audio') || 
                    ct.includes('mpegurl') || ct.includes('dash')) {
                    captureUrl(self._requestUrl, true);
                }
            }
            if (onReadyStateChange) onReadyStateChange.apply(self, /** @type {any} */ (rcArgs));
        };
        
        return originalXHRSend.apply(this, /** @type {any} */ (args));
    };

    /**
     * @param {string} url
     * @param {boolean=} isMedia
     */
    function captureUrl(url, isMedia) {
        if (!url || typeof url !== 'string' || url.length > 2000) return;
        
        // Cleanup if cache gets too large
        if (detectedUrls.size > MAX_CACHED_URLS) {
            const arr = Array.from(detectedUrls);
            detectedUrls.clear();
            arr.slice(-5000).forEach(u => detectedUrls.add(u));
        }
        
        const lowerUrl = url.toLowerCase();
        const isVideoUrl = videoPatterns.some(p => lowerUrl.includes(p)) ||
                          hostPatterns.some(h => lowerUrl.includes(h));
        
        if (isVideoUrl && !detectedUrls.has(url)) {
            detectedUrls.add(url);
            queueMessage({
                type: 'VIDEO_URL_DETECTED', 
                url,
                isMedia: isMedia || false
            });
        }
    }

    // YouTube extraction with limited retries
    function getYouTubeData() {
        if (!window.location.hostname.includes('youtube.com')) return;

        const checkYtData = () => {
            const win = /** @type {any} */ (window);
            const ytInit = win.ytInitialPlayerResponse || win.ytInitialData;
            if (ytInit?.streamingData?.formats || ytInit?.streamingData?.adaptiveFormats) {
                const formats = [
                    ...(ytInit.streamingData.formats || []),
                    ...(ytInit.streamingData.adaptiveFormats || [])
                ];
                
                if (formats.length > 0) {
                    queueMessage({
                        type: 'YOUTUBE_DATA_DETECTED',
                        streamingData: ytInit.streamingData,
                        videoTitle: ytInit.videoDetails?.title || document.title,
                        videoId: ytInit.videoDetails?.videoId || ''
                    });
                    return true;
                }
            }
            return false;
        };

        if (checkYtData()) return;

        // FIX: Max 10 attempts (was 60, causing 30 second hang)
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (checkYtData() || attempts >= 10) {
                clearInterval(interval);
            }
        }, 500);

        // Timeout after 5 seconds (was 30s)
        setTimeout(() => clearInterval(interval), 5000);
    }

    // Detect SPA navigation
    const observer = new MutationObserver(debounce(() => {
        if (window.location.hostname.includes('youtube.com')) {
            getYouTubeData();
        }
    }, 1000));

    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(getYouTubeData, 1000));
    } else {
        setTimeout(getYouTubeData, 1000);
    }

    console.log('[AVD Injector] Enhanced interceptor initialized');
})();
