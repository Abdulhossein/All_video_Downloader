const log = (msg) => console.log(`[AVD Offscreen]`, msg);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'downloadHlsOffscreen') {
        handleHlsDownload(request.stream, request.tabId);
        sendResponse({ success: true });
    } else if (request.action === 'revokeBlob') {
        URL.revokeObjectURL(request.url);
        sendResponse({ success: true });
    } else if (request.action === 'downloadLocalFsOffscreen') {
        handleLocalFsDownload(request).then(() => {
            sendResponse({ success: true });
        }).catch(err => {
            sendResponse({ error: err.message || err.toString() });
        });
        return true; // Keep message channel open for async
    }
});

// DOWNLOAD RETRY WITH EXPONENTIAL BACKOFF
async function handleLocalFsDownload(request) {
    // 1. Get the directory handle from IndexedDB
    const dirHandle = await avdDb.getHandle();
    if (!dirHandle) {
        throw new Error("No custom download folder found in database.");
    }
    
    // 2. Verify permission to write
    const permission = await verifyPermission(dirHandle, true);
    if (!permission) {
        throw new Error("Missing permission to write to the chosen folder. Please set the folder again.");
    }

    // 3. Create the file inside the directory
    const fileHandle = await dirHandle.getFileHandle(request.filename, { create: true });
    
    // 4. Fetch the file (could be large, so we stream it)
    log(`Starting Local FS download for: ${request.filename}`);
    const response = await fetchWithRetry(request.url, 3, 500);
    if (!response.body) throw new Error("No response body");

    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
    
    // 5. Create a writable stream to the local file
    const writable = await fileHandle.createWritable();
    
    // 6. Pipe the response body to the file, while tracking progress
    const reader = response.body.getReader();
    let receivedBytes = 0;
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        await writable.write(value);
        receivedBytes += value.length;
        
        // Broadcast progress occasionally
        if (request.fakeId && totalBytes > 0) {
            chrome.runtime.sendMessage({
                action: 'hlsProgress',
                streamUrl: request.streamUrl,
                progress: { loaded: receivedBytes, total: totalBytes }
            }).catch(() => {});
        }
    }
    
    await writable.close();
    log(`Local FS download complete: ${request.filename}`);
}

async function verifyPermission(fileHandle, readWrite) {
    const options = {};
    if (readWrite) {
        options.mode = 'readwrite';
    }
    // @ts-ignore
    if ((await fileHandle.queryPermission(options)) === 'granted') {
        return true;
    }
    return false;
}
async function fetchWithRetry(url, maxRetries = 3, baseDelay = 500) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return response;
            if (response.status === 429) throw new Error('Rate limited');
            if (response.status >= 500) throw new Error('Server error: ' + response.status);
            return response;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
                log(`Retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

function parseM3u8WithWorker(playlist, playlistUrl) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('m3u8-worker.js');
        worker.onmessage = (e) => {
            if (e.data.error) {
                reject(new Error(e.data.error));
            } else {
                resolve(e.data.result);
            }
            worker.terminate();
        };
        worker.onerror = (error) => {
            reject(error);
            worker.terminate();
        };
        worker.postMessage({ playlist, playlistUrl, id: 1 });
    });
}

// HLS DOWNLOAD HANDLER (parallel segment downloading with retry)
async function handleHlsDownload(stream, tabId) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        
        const response = await fetchWithRetry(stream.url);
        clearTimeout(timeout);
        
        const playlistText = await response.text();
        const parseResult = await parseM3u8WithWorker(playlistText, stream.url);
        const { segments, variantPlaylists } = parseResult;

        let targetSegments = segments;

        if (segments.length === 0 && variantPlaylists.length > 0) {
            const chosenVariant = variantPlaylists[variantPlaylists.length - 1];
            const variantResponse = await fetchWithRetry(chosenVariant.url);
            const variantPlaylistText = await variantResponse.text();
            const parsedVariant = await parseM3u8WithWorker(variantPlaylistText, chosenVariant.url);
            targetSegments = parsedVariant.segments;
        }

        if (targetSegments.length === 0) {
            throw new Error('No video segments found');
        }

        // Download segments in parallel (max 6 concurrent) with retry
        const segmentArrayBuffers = [];
        const MAX_CONCURRENT = 6;
        
        for (let i = 0; i < targetSegments.length; i += MAX_CONCURRENT) {
            const batch = targetSegments.slice(i, i + MAX_CONCURRENT);
            const results = await Promise.allSettled(
                batch.map(url => fetchWithRetry(url, 3).then(r => r.arrayBuffer()))
            );
            
            results.forEach((result, idx) => {
                if (result.status === 'fulfilled') {
                    segmentArrayBuffers.push(result.value);
                } else {
                    log('Segment download failed after retries: ' + batch[idx]);
                }
            });

            // Report progress back to background so popup updates
            chrome.runtime.sendMessage({
                action: 'hlsProgress',
                streamUrl: stream.url,
                progress: { loaded: Math.min(i + MAX_CONCURRENT, targetSegments.length), total: targetSegments.length }
            }).catch(() => {});
        }

        if (segmentArrayBuffers.length === 0) {
            throw new Error('Failed to download any segments');
        }

        // Concatenate segments and create download
        const blob = new Blob(segmentArrayBuffers, { type: 'video/mp2t' });
        const blobUrl = URL.createObjectURL(blob);
        const cleanFilename = (stream.title || 'video').replace(/[<>:"/\\|?*]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/^\.+/, "").replace(/\.+$/, "").replace(/\s+/g, " ").trim() || 'video';
        const filename = cleanFilename + '.ts';

        chrome.runtime.sendMessage({
            action: 'triggerDownload',
            url: blobUrl,
            filename: filename
        }).catch(() => {});

    } catch (e) {
        log('HLS download failed: ' + e.message);
        chrome.runtime.sendMessage({
            action: 'hlsError',
            streamUrl: stream.url,
            error: e.message
        }).catch(() => {});
    }
}
