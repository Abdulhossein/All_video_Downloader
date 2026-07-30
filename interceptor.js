// Runs in the MAIN world to intercept network requests (bypasses CSP on some sites and exposes window.fetch)
(function() {
    // Prevent multiple injections
    if (window._avdInterceptorInjected) return;
    window._avdInterceptorInjected = true;

    // Helper to send ytInitialPlayerResponse data
    let sentStreamingData = false;
    function trySendStreamingData() {
        if (sentStreamingData) return;
        try {
            const data = window.ytInitialPlayerResponse?.streamingData;
            if (data) {
                window.postMessage({ type: 'AVD_YOUTUBE_STREAMING_DATA', data: JSON.stringify(data) }, '*');
                sentStreamingData = true;
            }
        } catch (e) {}
    }

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        trySendStreamingData();
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

        try {
            const response = await originalFetch.apply(this, args);
            
            if (response.ok) {
                const contentType = response.headers.get('content-type') || '';
                const isMedia = contentType.includes('video') || contentType.includes('audio') || contentType.includes('mpegurl') || contentType.includes('dash');

                if (isMedia || (url && typeof url === 'string' && url.includes('googlevideo.com/videoplayback'))) {
                    window.postMessage({ type: 'AVD_INTERCEPTED_URL', url: url, contentType: contentType }, '*');
                } else if (contentType.includes('json') || contentType.includes('text')) {
                    // Fallback to scanning text content
                    try {
                        const clone = response.clone();
                        clone.text().then(text => {
                            if (text && text.length > 10) {
                                window.postMessage({ type: 'AVD_INTERCEPTED_RESPONSE', text: text, url: window.location.href }, '*');
                            }
                        }).catch(e => {});
                    } catch (e) {}
                }
            }
            return response;
        } catch (error) {
            // If the request fails, just re-throw the error
            throw error;
        }
    };

    const originalXHROpen = window.XMLHttpRequest.prototype.open;
    const originalXHRSend = window.XMLHttpRequest.prototype.send;
    
    window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        trySendStreamingData();
        this._requestUrl = url;
        // Keep the original youtube check here as a fast-path
        if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
            window.postMessage({ type: 'AVD_INTERCEPTED_URL', url: url }, '*');
        }
        return originalXHROpen.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            try {
                if (this.readyState === 4 && this.status === 200) {
                    const contentType = this.getResponseHeader('content-type') || '';
                    const isMedia = contentType.includes('video') || contentType.includes('audio') || contentType.includes('mpegurl') || contentType.includes('dash');

                    if (isMedia) {
                         window.postMessage({ type: 'AVD_INTERCEPTED_URL', url: this._requestUrl, contentType: contentType }, '*');
                    } else if (contentType.includes('json') || contentType.includes('text')) {
                        if (this.responseText && this.responseText.length > 10) {
                            window.postMessage({ type: 'AVD_INTERCEPTED_RESPONSE', text: this.responseText, url: window.location.href }, '*');
                        }
                    }
                }
            } catch (e) {}
        });
        return originalXHRSend.apply(this, args);
    };
})();
