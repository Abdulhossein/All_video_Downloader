// Enhanced content script - comprehensive media detection
'use strict';

const log = (msg) => console.log(`[AVD Content]`, msg);

// Helper function to strip trailing common media extensions from a title
const ALL_COMMON_EXTENSIONS = [
    'mp3', 'mp4', 'webm', 'ogg', 'wav', 'flac', 'aac', 'mkv', 'avi', // Audio/Video
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico',       // Images
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2',                          // Archives
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'        // Documents (less likely, but possible)
];

function stripTrailingMediaExtensions(title) {
    if (!title) return '';
    let cleanedTitle = title;

    let changed = true;
    while (changed) {
        changed = false;
        for (const ext of ALL_COMMON_EXTENSIONS) {
            // Case-insensitive match, and ensure it's at the very end
            if (cleanedTitle.toLowerCase().endsWith(`.${ext}`)) {
                cleanedTitle = cleanedTitle.substring(0, cleanedTitle.length - (ext.length + 1));
                changed = true;
                break; // Restart loop to check for more extensions
            }
        }
    }
    return cleanedTitle.trim();
}

let downloadAllTypesEnabled = false;
let enableHoverButtons = true;

chrome.storage.local.get(['downloadAllTypes', 'enableHoverButtons'], (result) => {
    downloadAllTypesEnabled = !!result.downloadAllTypes;
    if (result.enableHoverButtons !== undefined) {
        enableHoverButtons = !!result.enableHoverButtons;
    }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        if (changes.downloadAllTypes) {
            downloadAllTypesEnabled = !!changes.downloadAllTypes.newValue;
        }
        if (changes.enableHoverButtons) {
            enableHoverButtons = !!changes.enableHoverButtons.newValue;
        }
    }
});

// Listen for rescan requests from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'doRescan') {
        log('Rescan triggered by popup.');
        
        // Reset caches to ensure everything is re-discovered
        sentUrls.clear();
        processedElements.clear();

        // Re-run all discovery mechanisms
        findMedia(document.body || document.documentElement);
        scanScriptsForMedia();
        sendHtmlToBackground();
        injectYouTubeDirectStream(); // For YouTube pages

        sendResponse({ success: true });
    }
});

// Use regular Set instead of WeakSet (WeakSet doesn't work well for tracking)
const processedElements = new Set();
/** @type {Set<string>} */
const sentUrls = new Set(); // Max 50K URLs to prevent memory leak

// Cleanup old entries from sentUrls periodically (prevent unbounded growth)
setInterval(() => {
    if (sentUrls.size > 40000) {
        const arr = Array.from(sentUrls);
        processedElements.clear();
        sentUrls.clear();
        // Keep only recent 10K
        arr.slice(-10000).forEach(url => sentUrls.add(url));
        log('Cleaned up URL cache. Size: ' + sentUrls.size);
    }
}, 60000); // Every minute

// ============================================================================
// NETWORK INTERCEPTION (Bypasses deciphering/DRM by catching actual requests)
// ============================================================================
function injectNetworkInterceptor() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('interceptor.js');
    (document.head || document.documentElement).appendChild(script);
    
    script.onload = () => {
        script.remove();
    };

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data) return;
        
        if (event.data.type === 'AVD_YOUTUBE_STREAMING_DATA') {
            try {
                window._ytStreamingData = JSON.parse(event.data.data);
            } catch(e) {}
            return;
        }

        if (event.data.type === 'AVD_INTERCEPTED_RESPONSE') {
            // Forward the API response string to the background script's HTML scanner
            // since it uses the exact same logic (regex matching for media URLs)
            try {
                chrome.runtime.sendMessage({
                    action: 'scanHtmlForMedia',
                    html: event.data.text,
                    url: window.location.href,
                    title: document.title
                }).catch(() => {});
            } catch (e) {}
            return;
        }

        if (event.data.type === 'AVD_INTERCEPTED_URL') {
            try {
                const url = event.data.url;
                if (!url) return;

                const urlObj = new URL(url);
                // Remove chunk-specific params to get the full file URL
                urlObj.searchParams.delete('range');
                urlObj.searchParams.delete('rn');
                urlObj.searchParams.delete('rbuf');
                
                const cleanUrl = urlObj.toString();
                if (sentUrls.has(cleanUrl)) return;
                sentUrls.add(cleanUrl);

                const sendFinalStream = (quality, isAudioOverride = false) => {
                    const title = document.title.replace(/^\([0-9]+\)\s*/, ''); // Remove notification count
                    const type = isAudioOverride ? 'audio' : (cleanUrl.includes('youtube.com') || cleanUrl.includes('googlevideo.com') ? 'youtube' : 'video');
                    chrome.runtime.sendMessage({
                        action: 'trackStream',
                        stream: {
                            url: cleanUrl,
                            type: type,
                            title: title,
                            qualities: [{ quality: quality, url: cleanUrl }]
                        }
                    }).catch(e => {});
                };

                const itag = urlObj.searchParams.get('itag');

                if (itag) {
                    const mime = urlObj.searchParams.get('mime') || '';
                    const isAudio = mime.includes('audio');
                    let quality = `Itag ${itag}`;
                    if (itag === '18') quality = '360p (Muxed)';
                    else if (itag === '22') quality = '720p (Muxed)';
                    else if (isAudio) quality = 'Audio Only';
                    else quality = `Video Only (${quality})`;
                    sendFinalStream(quality, isAudio);
                } else if (event.data.contentType) {
                    // Handle generic media with contentType from interceptor
                    const contentType = event.data.contentType;
                    let finalQuality = 'Media';
                    let isAudioFinal = false;
                    if (contentType.includes('audio')) {
                        finalQuality = 'Audio';
                        isAudioFinal = true;
                    } else if (contentType.includes('video')) {
                        finalQuality = 'Video';
                    } else if (contentType.includes('mpegurl')) {
                        finalQuality = 'HLS Stream';
                    } else if (contentType.includes('dash')) {
                        finalQuality = 'DASH Stream';
                    }
                    sendFinalStream(finalQuality, isAudioFinal);
                } else {
                    // Fallback for URLs that didn't have a content type (e.g. the initial googlevideo.com url from 'open')
                    chrome.runtime.sendMessage({ action: 'getFileInfo', url: cleanUrl }, (response) => {
                        let finalQuality = 'Default';
                        let isAudioFinal = false;
                        
                        if (response && response.contentType) {
                            if (response.contentType.includes('audio')) {
                                finalQuality = 'Audio Only';
                                isAudioFinal = true;
                            } else {
                                finalQuality = 'Video Only';
                            }
                        }
                        sendFinalStream(finalQuality, isAudioFinal);
                    });
                }
            } catch (e) {}
            return;
        }
    });
}
injectNetworkInterceptor();

// ============================================================================
// PERFORMANCE OBSERVER (Catches all resource requests including those by players)
// ============================================================================
function observeNetworkResources() {
    const checkResource = (url) => {
        if (!url || !url.startsWith('http') || url.startsWith('blob:')) return;

        const isMedia = /\.(mp4|m3u8|mp3|webm|m4a|aac|flv|ogg|wav|vtt)(?:[\?#]|$)/i.test(url);
        
        // Filter out common UI sound effects if it's not a media file of interest
        if (!isMedia && url.match(/\/(failure|success|no_input|open|close|hover|click|pop|notification|beep)\.(mp3|wav|ogg)/i)) {
            return;
        }
        
        let shouldTrack = false;
        if (isMedia) {
            shouldTrack = true;
        } else if (downloadAllTypesEnabled) {
            // When all types are enabled, track everything except for a few noisy types
            // We'll let the user filter JS/CSS in the popup
            const extension = url.split('.').pop().split('?')[0].split('#')[0].toLowerCase();
            if (extension && !['html', 'htm', 'php', 'asp', 'jsp'].includes(extension)) {
                 shouldTrack = true;
            }
        }
        
        if (shouldTrack) {
            if (sentUrls.has(url)) return;
            sentUrls.add(url);
            
            // Send to background to get tracked
            chrome.runtime.sendMessage({
                action: 'trackStream',
                stream: {
                    url: url,
                    title: stripTrailingMediaExtensions(document.title.replace(/^\([0-9]+\)\s*/, '').trim()),
                    // Let background script determine the final type
                    type: 'auto', 
                    source: 'network-observer'
                }
            }).catch(e => {});
        }
    };

    try {
        // Check already loaded resources
        performance.getEntriesByType('resource').forEach(entry => checkResource(entry.name));

        // Observe future resources
        const observer = new PerformanceObserver((list) => {
            list.getEntries().forEach(entry => checkResource(entry.name));
        });
        observer.observe({ entryTypes: ['resource'] });
        log('PerformanceObserver active');
    } catch (e) {
        log('PerformanceObserver error: ' + e.message);
    }
}
observeNetworkResources();

// ============================================================================
// YOUTUBE DIRECT API INTEGRATION
// ============================================================================
function injectYouTubeDirectStream() {
    if (window.location.hostname.includes('youtube.com') && window.location.pathname.startsWith('/watch')) {
        const urlObj = new URL(window.location.href);
        const videoId = urlObj.searchParams.get('v');
        if (videoId && !sentUrls.has('yt_direct_' + videoId)) {
            sentUrls.add('yt_direct_' + videoId);
            
            let attempts = 0;
            const checkTitle = () => {
                attempts++;
                let title = document.title.replace(/^\(\d+\)\s*/, "").replace(" - YouTube", "").trim();
                
                if (!title || title.toLowerCase() === "youtube" || title.toLowerCase() === "watch") {
                    const titleEl = document.querySelector('#title h1 yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string');
                    if (titleEl && titleEl.textContent) {
                        title = titleEl.textContent.trim();
                    }
                }
                
                if ((!title || title.toLowerCase() === "youtube" || title.toLowerCase() === "watch") && attempts < 15) {
                    setTimeout(checkTitle, 1000);
                    return;
                }
                
                if (!title || title.toLowerCase() === "youtube" || title.toLowerCase() === "watch") {
                    title = "YouTube_Video";
                }
                
                // Apply stripping here for the base title
                title = stripTrailingMediaExtensions(title);

                const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
                // 1. MP4 Video Stream
                const videoStream = {
                    url: window.location.href + '#video', // Use distinct url to prevent merging
                    type: 'youtube', // Displays nice youtube styling
                    title: title,
                    thumbnail: thumbnailUrl,
                    isMain: true,
                    qualities: [
                        { quality: '1080p (MP4)', url: 'direct:video:1080', type: 'video' },
                        { quality: '720p (MP4)', url: 'direct:video:720', type: 'video' },
                        { quality: '360p (MP4)', url: 'direct:video:360', type: 'video' }
                    ]
                };
                chrome.runtime.sendMessage({ action: 'trackStream', stream: videoStream }).catch(e => {});

                // 2. MP3 Audio Stream
                const audioStream = {
                    url: window.location.href + '#audio',
                    type: 'audio', // Important: type='audio' ensures it shows when Audio filter is active
                    title: title + ' (MP3 Audio)',
                    thumbnail: thumbnailUrl,
                    isMain: true,
                    qualities: [
                        { quality: '320kbps (MP3)', url: 'direct:audio:320', type: 'audio' },
                        { quality: '256kbps (MP3)', url: 'direct:audio:256', type: 'audio' },
                        { quality: '128kbps (MP3)', url: 'direct:audio:128', type: 'audio' }
                    ]
                };
                chrome.runtime.sendMessage({ action: 'trackStream', stream: audioStream }).catch(e => {});

                // 3. Thumbnail Stream
                const imgStream = {
                    url: window.location.href + '#image',
                    type: 'image',
                    title: title + ' (Thumbnail)',
                    thumbnail: thumbnailUrl,
                    isMain: true,
                    qualities: [
                        { quality: 'Thumbnail (JPG)', url: 'direct:image:thumb', type: 'image' }
                    ]
                };
                chrome.runtime.sendMessage({ action: 'trackStream', stream: imgStream }).catch(e => {});
            };
            
            // Start checking title
            setTimeout(checkTitle, 1000);
        }
    }
}
injectYouTubeDirectStream();
// Handle YouTube SPA navigation
window.addEventListener("yt-navigate-finish", injectYouTubeDirectStream);

/**
 * Helper to query elements deeply, including those hidden inside Shadow DOMs
 * @param {string} selector 
 * @param {Element|Document} root 
 * @returns {Element[]}
 */
function querySelectorAllDeep(selector, root) {
    const results = [];
    const visited = new Set();
    
    function traverse(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);

        if (node.querySelectorAll) {
            node.querySelectorAll(selector).forEach(el => results.push(el));
        }
        
        const elements = node.querySelectorAll ? node.querySelectorAll('*') : [];
        elements.forEach(el => {
            if (el.shadowRoot) {
                traverse(el.shadowRoot);
            }
        });
        
        if (node.shadowRoot) {
            traverse(node.shadowRoot);
        }
    }
    
    traverse(root);
    return Array.from(new Set(results));
}

/**
 * @param {Element|HTMLElement|Document} node
 */
function findMedia(node) {
    if (!node) return;

    // Find <video> and <audio> tags (including inside Shadow DOM)
    try {
        querySelectorAllDeep('video, audio', node).forEach(mediaElement => {
            const elId = Math.random(); // Simple tracking instead of WeakSet
            if (processedElements.has(elId)) return;
            processedElements.add(elId);

            const handleSrc = () => {
                const src = mediaElement.currentSrc || mediaElement.src;
                if (src && !src.startsWith('blob:') && !sentUrls.has(src)) {
                    if (src.match(/\/(failure|success|no_input|open|close|hover|click|pop|notification|beep)\.(mp3|wav|ogg)/i)) return;
                    sentUrls.add(src);
                    const stream = {
                        url: src,
                        title: getTitle(mediaElement)
                    };
                    augmentRadioJavanStream(stream);
                    chrome.runtime.sendMessage({ action: 'trackStream', stream }).catch(e => {});
                }
            };

            // Extract from standard sources immediately
            if (mediaElement.currentSrc || mediaElement.src) {
                handleSrc();
            }

            // Extract from <source> tags
            mediaElement.querySelectorAll('source').forEach(source => {
                if (source.src && !source.src.startsWith('blob:') && !sentUrls.has(source.src)) {
                    if (source.src.match(/\/(failure|success|no_input|open|close|hover|click|pop|notification|beep)\.(mp3|wav|ogg)/i)) return;
                    sentUrls.add(source.src);
                    const stream = { url: source.src, title: getTitle(mediaElement) };
                    augmentRadioJavanStream(stream);
                    chrome.runtime.sendMessage({
                        action: 'trackStream',
                        stream: stream
                    }).catch(e => {});
                }
            });

            // Extract from lazy-load data attributes
            const dataSrc = mediaElement.getAttribute('data-src') || mediaElement.getAttribute('data-video-url') || mediaElement.getAttribute('data-audio-url');
            if (dataSrc && !sentUrls.has(dataSrc) && dataSrc.startsWith('http')) {
                sentUrls.add(dataSrc);
                chrome.runtime.sendMessage({
                    action: 'trackStream',
                    stream: { url: dataSrc, title: getTitle(mediaElement) }
                }).catch(e => {});
            }

            // Fallback for dynamically loaded streams
            mediaElement.addEventListener('canplay', handleSrc, { once: true });
            mediaElement.addEventListener('loadedmetadata', handleSrc, { once: true });
        });
    } catch (e) {
        // Ignore errors in querySelector
    }

    // Find links to media files
    const downloadKeywords = /download|دانلود|تحميل|descargar|télécharger|baixar|unduh|скачать/i;
    
    try {
        node.querySelectorAll('a[href]').forEach(anchor => {
            if (!anchor.href) return;
            if (anchor.getAttribute('data-avd-injected')) return; // already processed
            
            const href = anchor.href;
            if (!href.startsWith('http')) return;
            
            const type = detectContentType(href);
            const linkText = (anchor.textContent || '').trim();
            const anchorTitle = (anchor.title || '').trim();
            const hasDownloadAttr = anchor.hasAttribute('download');
            const classAndId = ((anchor.className || '') + ' ' + (anchor.id || '')).toLowerCase();
            
            // Detect if this link is likely a media download link:
            // 1. URL has a recognized media extension
            // 2. OR the link text/title says "download" in any language
            // 3. OR the anchor has a `download` attribute
            // 4. OR the class/id contains "download"
            // 5. OR if download all types is on, any file with a common file extension
            let isDownloadLink = type !== 'unknown' 
                || hasDownloadAttr
                || downloadKeywords.test(linkText)
                || downloadKeywords.test(anchorTitle)
                || /download/i.test(classAndId);

            let isProbablyFile = /\.[a-z0-9]{2,5}(?:[\?#]|$)/i.test(href);

            if (downloadAllTypesEnabled && isProbablyFile && !isDownloadLink) {
                if (!sentUrls.has(href)) {
                    sentUrls.add(href);
                    chrome.runtime.sendMessage({
                        action: 'trackStream',
                        stream: {
                            url: href,
                            title: anchor.title || linkText || getVideoTitleFromUrl(href),
                            type: 'auto'
                        }
                    }).catch(e => {});
                }
                // Don't attach a download button to every link on the page, only ones that look like downloads
                return;
            }
            
            if (!isDownloadLink) return;

            // Track stream if URL looks like media and hasn't been sent
            if (type !== 'unknown' && !sentUrls.has(href)) {
                sentUrls.add(href);
                const stream = {
                    url: href,
                    title: anchor.title || linkText || getVideoTitleFromUrl(href),
                    type: 'auto'
                };
                chrome.runtime.sendMessage({ action: 'trackStream', stream }).catch(e => {});
            }

            const isMediaLink = ['video', 'audio', 'hls', 'dash'].includes(type);
            if (!enableHoverButtons || !isMediaLink) return;

            // Inject inline download button next to the link
            anchor.setAttribute('data-avd-injected', 'true');
            
            // Use inline SVG — cannot be blocked by website CSP (unlike chrome-extension:// img URLs)
            const btn = document.createElement('span');
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8e2de2" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;display:inline-block;"><circle cx="12" cy="12" r="11" fill="rgba(40,40,40,0.85)" stroke="#8e2de2"/><path d="M12 7v6M9 10l3 3 3-3"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`;
            btn.style.cssText = `
                display: inline-block;
                cursor: pointer;
                margin-left: 5px;
                margin-right: 2px;
                vertical-align: middle;
                transition: transform 0.2s;
                line-height: 1;
            `;
            btn.title = 'Download with AVD';
            
            btn.onmouseenter = () => {
                btn.style.transform = 'scale(1.3)';
                btn.querySelector('svg').style.stroke = '#b55cf5';
            };
            btn.onmouseleave = () => {
                btn.style.transform = 'scale(1)';
                const svg = btn.querySelector('svg');
                if (svg) svg.style.stroke = '#8e2de2';

            };
            
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const streamUrl = href;
                const detectedType = detectContentType(href);
                
                // Prioritize title from URL if descriptive
                let titleFromUrl = getVideoTitleFromUrl(href);
                let bestTitle = 'media';

                const genericKeywords = ['download', 'media', 'video', 'audio', 'file', 'link'];
                const isGenericTitle = (text) => genericKeywords.some(keyword => text.toLowerCase().includes(keyword)) || text.length <= 5; // Very short titles are likely generic

                if (anchor.title && !isGenericTitle(anchor.title)) {
                    bestTitle = anchor.title;
                } else if (titleFromUrl && !isGenericTitle(titleFromUrl)) {
                    bestTitle = titleFromUrl;
                } else if (linkText && !isGenericTitle(linkText)) {
                    bestTitle = linkText;
                } else {
                    bestTitle = document.title.replace(/^\([0-9]+\)\s*/, '').trim() || 'media';
                    if (isGenericTitle(bestTitle)) { // If page title is also generic, fallback to URL title
                        bestTitle = titleFromUrl || 'media';
                    }
                }

                const streamForBg = {
                    url: streamUrl,
                    title: bestTitle,
                    type: detectedType
                };

                chrome.runtime.sendMessage({
                    action: 'queueDownload',
                    stream: streamForBg,
                    downloadUrl: streamUrl
                }).catch(() => {});
                
                // Visual feedback: green tick then restore
                btn.style.filter = 'hue-rotate(90deg) brightness(1.5)';
                btn.title = '✅ Queued!';
                setTimeout(() => {
                    btn.style.filter = 'none';
                    btn.title = 'Download with AVD';
                }, 1500);
            };
            
            anchor.insertAdjacentElement('afterend', btn);
        });
    } catch (e) {
        // Ignore errors
    }
}

/**
 * @param {Element} el
 * @returns {string}
 */
function getTitle(el) {
    try {
        // 1. Try to find a preceding paragraph or heading with text (very common in blogs/articles)
        let sibling = el.closest('p, div, section, figure') || el;
        sibling = sibling.previousElementSibling;
        
        // Go back up to 4 siblings to find text
        for (let i = 0; i < 4 && sibling; i++) {
            if (sibling.tagName.match(/^(P|H[1-6]|DIV|SPAN|B|STRONG)$/)) {
                const text = sibling.textContent.trim();
                // If it has substantial text (but not too much like a whole article)
                if (text && text.length > 3 && text.length < 150) {
                    return text;
                }
            }
            sibling = sibling.previousElementSibling;
        }

        // 2. Try to find a title from surrounding container
        const parent = el.closest('div, article, main, section');
        if (parent) {
            const h = parent.querySelector('h1, h2, h3, [class*="title"], [id*="title"]');
            if (h && h.textContent.trim()) {
                return h.textContent.trim().substring(0, 150);
            }
        }
        
        // 3. Fallback to page title
        return document.title || 'Video';
    } catch (e) {
        return 'Video';
    }
}

// ============================================================================
// RADIOJAVAN METADATA EXTRACTION
// ============================================================================
function augmentRadioJavanStream(stream) {
    if (!window.location.hostname.includes('radiojavan.com')) return;
    
    // RJ media URLs typically look like: https://host1.rj-mw1.com/media/...
    // If it's the main media element, we attach the page metadata.
    // We assume any video/audio on the song/video page is the main media.
    try {
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || '';
        const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
        
        if (ogTitle) {
            // "Vatan - Single by Sami Low & Saade"
            let title = ogTitle;
            let artist = '';
            
            if (ogTitle.includes(' by ')) {
                const parts = ogTitle.split(' by ');
                title = parts[0].replace(' - Single', '').trim();
                artist = parts[1].trim();
            } else if (ogTitle.includes(' - ')) {
                const parts = ogTitle.split(' - ');
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
            }
            
            stream.title = stripTrailingMediaExtensions(title);
            stream.artist = artist;
            if (ogImage) stream.thumbnail = ogImage;
            
            // Extract the info string (Song - 3 mins 42 secs - Jul 20, 2026)
            // It's usually in a <p> tag with text like "Song - " or "Video - "
            const pTags = Array.from(document.querySelectorAll('p'));
            const infoTag = pTags.find(p => p.textContent.includes(' - ') && (p.textContent.includes('Song') || p.textContent.includes('Video') || p.textContent.includes('Podcast')));
            
            if (infoTag) {
                // If artist exists, append this to artist, or add it as a separate field
                if (stream.artist) {
                    stream.artist += ' | ' + infoTag.textContent.trim();
                } else {
                    stream.artist = infoTag.textContent.trim();
                }
            } else if (ogDesc) {
                // Fallback to og:description which has similar info
                stream.artist += ' | ' + ogDesc.replace(/[<>:"/\|?*]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
            }
            
            // Mark as main video so popup can sort it to the top
            stream.isMain = true;
        }
    } catch (e) {}
}

/**
 * Try to extract advanced media info from JSON blobs (Next.js, generic JSON, RadioJavan)
 */
function extractAdvancedMediaInfo() {
    try {
        // 1. Next.js Data (used by many modern sites like RadioJavan)
        const nextDataElement = document.getElementById('__NEXT_DATA__');
        if (nextDataElement && nextDataElement.textContent) {
            try {
                const jsonData = JSON.parse(nextDataElement.textContent);
                const props = jsonData.props?.pageProps || {};
                const media = props.media || props.podcast || props.video || props.track || props.song;
                
                if (media) {
                    const url = media.hq_link || media.hd_4k_link || media.high || media.lq_link || media.low || media.url || media.file;
                    if (url && !sentUrls.has(url)) {
                        sentUrls.add(url);
                        chrome.runtime.sendMessage({
                            action: 'trackStream',
                            stream: {
                                url: url,
                                title: stripTrailingMediaExtensions(media.song || media.title || media.name || document.title),
                                artist: media.artist || media.podcast_artist || '',
                                thumbnail: media.photo || media.coverPhoto || media.thumbnail || media.image || ''
                            }
                        }).catch(e => {});
                    }
                }
            } catch (e) {}
        }

        // 2. RadioJavan specific older format
        for (const script of document.querySelectorAll('script')) {
            if (script.textContent && (script.textContent.includes('RJ.currentMP3') || script.textContent.includes('RJ.currentVideo'))) {
                const match = script.textContent.match(/RJ\.current(?:MP3|Video)\s*=\s*({.*?});/s);
                if (match) {
                    try {
                        const media = JSON.parse(match[1]);
                        const url = media.hq_link || media.lq_link;
                        if (url && !sentUrls.has(url)) {
                            sentUrls.add(url);
                            chrome.runtime.sendMessage({
                                action: 'trackStream',
                                stream: {
                                    url: url,
                                    title: stripTrailingMediaExtensions(media.song || media.title || document.title),
                                    artist: media.artist || '',
                                    thumbnail: media.photo || media.thumbnail || ''
                                }
                            }).catch(e => {});
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {
        log('Error in advanced media extraction: ' + e.message);
    }
}

/**
 * Perform a deep scan of all script tags to find hidden media URLs (JSON, initial state, etc.)
 * Useful for SPAs where video objects are loaded but not yet inserted into the DOM.
 */
function scanScriptsForMedia() {
    extractAdvancedMediaInfo();
    try {
        const scripts = document.querySelectorAll('script:not([src])');
        // Comprehensive regex to find media URLs, accounting for escaped slashes (\/)
        // Matches: http://.../file.mp4 or https:\/\/...\/file.m3u8
        let urlRegex;
        if (downloadAllTypesEnabled) {
            urlRegex = /(?:https?:(?:\?\/){2})[^\s"'<>]+?\.(?:mp4|m3u8|mp3|webm|m4a|aac|flv|wav|ogg|flac|wma|zip|rar|7z|pdf|docx?|xlsx?|pptx?|exe|msi|dmg|pkg|deb|rpm)(?:[?&#][^\s"'<>]+)?/gi;
        } else {
            urlRegex = /(?:https?:(?:\?\/){2})[^\s"'<>]+?\.(?:mp4|m3u8|mp3|webm|m4a|aac|flv|wav|ogg|flac|wma)(?:[?&#][^\s"'<>]+)?/gi;
        }
        
        // Try to find a global generic thumbnail in meta tags
        const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
        
        scripts.forEach(script => {
            if (!script.textContent) return;
            const text = script.textContent;
            const matches = text.match(urlRegex);
            if (matches) {
                matches.forEach(match => {
                    // Unescape slashes if they were escaped in JSON string
                    const cleanUrl = match.replace(/\//g, '/');
                    if (!sentUrls.has(cleanUrl)) {
                        sentUrls.add(cleanUrl);
                        
                        // Heuristic: Try to find "title" or "name" or "thumbnail" near this URL in the JSON string
                        // We just take a window of 500 chars around the URL to guess title
                        const urlIndex = text.indexOf(match);
                        const windowText = text.substring(Math.max(0, urlIndex - 500), Math.min(text.length, urlIndex + 500));
                        
                        let title = getVideoTitleFromUrl(cleanUrl) || document.title || 'Embedded Media';
                        let thumbnail = ogImage;
                        let artist = '';
                        
                        // Simple regex to find "title":"something" or "name":"something"
                        const titleMatch = windowText.match(/["'](?:title|name|song)["']\s*:\s*["']([^"']+)["']/i);
                        if (titleMatch && titleMatch[1]) {
                            title = titleMatch[1];
                        }
                        
                        const artistMatch = windowText.match(/["'](?:artist|author)["']\s*:\s*["']([^"']+)["']/i);
                        if (artistMatch && artistMatch[1]) {
                            artist = artistMatch[1];
                        }
                        
                        const thumbMatch = windowText.match(/["'](?:thumbnail|cover|image|photo)["']\s*:\s*["'](https?:\/\/[^"']+)["']/i);
                        if (thumbMatch && thumbMatch[1]) {
                            thumbnail = thumbMatch[1].replace(/\//g, '/');
                        }
                        
                        chrome.runtime.sendMessage({
                            action: 'trackStream',
                            stream: {
                                url: cleanUrl,
                                title: title,
                                artist: artist,
                                thumbnail: thumbnail,
                                isMain: true,
                                type: 'auto'
                            }
                        }).catch(e => {});
                    }
                });
            }
        });
    } catch (e) {
        log('Error scanning scripts: ' + e.message);
    }
}

// MutationObserver with debounce to avoid excessive processing
let mutationTimeout;
let htmlScanTimeout;

function sendHtmlToBackground() {
    clearTimeout(htmlScanTimeout);
    htmlScanTimeout = setTimeout(() => {
        try {
            const html = document.documentElement.outerHTML;
            if (!html) return;
            chrome.runtime.sendMessage({
                action: 'scanHtmlForMedia',
                html: html,
                url: window.location.href,
                title: document.title
            }).catch(() => {});
        } catch (e) {
            log('Error sending HTML to background: ' + e.message);
        }
    }, 2000); // 2 second debounce to prevent spamming
}

const observer = new MutationObserver((mutations) => {
    clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(() => {
        let shouldScanScripts = false;
        let shouldScanHtml = false;
        
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) { // ELEMENT_NODE
                        findMedia(node);
                        shouldScanHtml = true; // Any element addition is grounds for an HTML scan
                        if (node.tagName === 'SCRIPT' || node.querySelector('script')) {
                            shouldScanScripts = true;
                        }
                    }
                }
            }
        }
        if (shouldScanScripts) {
            scanScriptsForMedia();
        }
        if (shouldScanHtml) {
            sendHtmlToBackground();
        }
    }, 500); // Debounce 500ms instead of immediate
});

// Only observe main document, not all frames
observer.observe(document.documentElement, {
    childList: true,
    subtree: true
});

// Initial scan - wait for DOM to settle
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            findMedia(document.body || document.documentElement);
            scanScriptsForMedia();
            sendHtmlToBackground();
        }, 500);
    });
} else {
    setTimeout(() => {
        findMedia(document.body || document.documentElement);
        scanScriptsForMedia();
        sendHtmlToBackground();
    }, 500);
}

log('Initialized');

// ============================================================================
// IN-PAGE UI OVERLAYS (Watermarks and Link Buttons)
// ============================================================================

function initInPageUI() {
    if (!enableHoverButtons) return;

    // 1. Video Hover Watermark
    const watermark = document.createElement('div');
    watermark.id = 'avd-video-watermark';
    watermark.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        width: 36px;
        height: 36px;
        background: rgba(40, 40, 40, 0.85);
        border: 2px solid #8e2de2;
        border-radius: 50%;
        box-shadow: 0 4px 15px rgba(0,0,0,0.6);
        cursor: pointer;
        display: none;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s, background 0.2s;
        backdrop-filter: blur(4px);
    `;
    watermark.title = 'Download Media with AVD';
    
    // Use inline SVG arrow-down icon — cannot be blocked by website CSP
    watermark.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v10M8 11l4 4 4-4"/><line x1="6" y1="18" x2="18" y2="18"/></svg>`;
    
    // Hover effects
    watermark.addEventListener('mouseenter', () => {
        watermark.style.background = 'rgba(142, 45, 226, 0.95)';
        watermark.style.transform = 'scale(1.15)';
    });
    watermark.addEventListener('mouseleave', () => {
        watermark.style.background = 'rgba(40, 40, 40, 0.85)';
        watermark.style.transform = 'scale(1)';
    });

    document.documentElement.appendChild(watermark);

    let activeMedia = null;
    let hideTimeout = null;

    const showWatermark = (media) => {
        const rect = media.getBoundingClientRect();
        // Use viewport-relative coords (fixed positioning)
        const top = rect.top + 15;
        const left = rect.left + 15;
        
        watermark.style.top = top + 'px';
        watermark.style.left = left + 'px';
        watermark.style.display = 'flex';
        activeMedia = media;
    };

    const hideWatermark = () => {
        watermark.style.display = 'none';
        activeMedia = null;
    };

    let lastMove = 0;
    document.addEventListener('mousemove', (e) => {
        const now = Date.now();
        if (now - lastMove < 150) return; // throttle to ~6fps
        lastMove = now;

        // Fast path: Check if we are hovering over the watermark itself
        if (e.target === watermark || watermark.contains(/** @type {Node} */ (e.target))) {
            clearTimeout(hideTimeout);
            return;
        }

        // Deep check for media under cursor (handles transparent overlays)
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        const mediaEl = elements.find(el => el.tagName === 'VIDEO' || el.tagName === 'AUDIO');

        if (mediaEl) {
            clearTimeout(hideTimeout);
            
            const isVisibleVideo = mediaEl.tagName === 'VIDEO' && mediaEl.clientWidth > 150 && mediaEl.clientHeight > 100;
            const isVisibleAudio = mediaEl.tagName === 'AUDIO' && mediaEl.clientHeight > 20 && mediaEl.clientWidth > 100;

            if (isVisibleVideo || isVisibleAudio) {
                if (activeMedia !== mediaEl) {
                    showWatermark(mediaEl);
                }
            }
        } else {
            // No media under cursor, delay hide
            if (activeMedia) {
                clearTimeout(hideTimeout);
                hideTimeout = setTimeout(() => {
                    hideWatermark();
                }, 400);
            }
        }
    });

    const qualitiesMenu = document.createElement('div');
    qualitiesMenu.style.cssText = `
        position: fixed;
        z-index: 2147483648;
        background: rgba(30, 30, 30, 0.97);
        border: 1px solid #8e2de2;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.8);
        padding: 5px 0;
        display: none;
        flex-direction: column;
        min-width: 180px;
        max-width: 300px;
        backdrop-filter: blur(8px);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;
    document.documentElement.appendChild(qualitiesMenu);

    document.addEventListener('click', (e) => {
        if (!qualitiesMenu.contains(/** @type {Node} */ (e.target)) && e.target !== watermark && !watermark.contains(/** @type {Node} */ (e.target))) {
            qualitiesMenu.style.display = 'none';
        }
    });

    // Download action
    watermark.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (qualitiesMenu.style.display === 'flex') {
            qualitiesMenu.style.display = 'none';
            return;
        }

        const rect = watermark.getBoundingClientRect();
        // Use viewport-relative coords (fixed positioning)
        qualitiesMenu.style.top = (rect.bottom + 5) + 'px';
        qualitiesMenu.style.left = rect.left + 'px';

        qualitiesMenu.innerHTML = '<div style="padding: 10px; color: white; font-size: 13px; text-align: center;">Loading qualities...</div>';
        qualitiesMenu.style.display = 'flex';

        if (activeMedia) {
            // Send with tabId obtained from a stored var, or just let background return all streams for current tab
            chrome.runtime.sendMessage({ action: 'getDetectedStreams' }, (response) => {
                const src = activeMedia.currentSrc || activeMedia.src;
                let stream = null;

                if (response && response.streams && response.streams.length > 0) {
                    // On YouTube, prefer the youtube-type stream. Otherwise match by src.
                    if (window.location.hostname.includes('youtube.com')) {
                        stream = response.streams.find(s => s.type === 'youtube' && s.url.includes('#video'));
                        if (!stream) stream = response.streams.find(s => s.type === 'youtube');
                    }
                    if (!stream) {
                        stream = response.streams.find(s => s.url === src);
                    }
                    if (!stream) {
                        // Last resort: first non-image stream
                        stream = response.streams.find(s => s.type !== 'image');
                    }
                }

                // If not found in background (e.g. direct mp4 not tracked yet), create a temporary one
                if (!stream && src && !src.startsWith('blob:')) {
                    stream = {
                        url: src,
                        title: getTitle(activeMedia),
                        type: 'video',
                        qualities: [{ quality: 'Direct Link (MP4)', url: src, type: 'video' }]
                    };
                    chrome.runtime.sendMessage({ action: 'trackStream', stream });
                }

                if (!stream) {
                    qualitiesMenu.innerHTML = '<div style="padding: 10px; color: #ff6b6b; font-size: 13px; text-align: center;">Open Popup to download</div>';
                    setTimeout(() => qualitiesMenu.style.display = 'none', 2500);
                    return;
                }

                qualitiesMenu.innerHTML = '';
                
                // Add header
                const header = document.createElement('div');
                header.style.cssText = 'padding: 5px 12px; font-size: 11px; color: #aaa; border-bottom: 1px solid #444; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                header.textContent = sanitize(stream.title);
                qualitiesMenu.appendChild(header);

                // Add qualities
                const qualities = stream.qualities || [{ quality: 'Default', url: stream.url, type: stream.type }];
                qualities.forEach(q => {
                    const btn = document.createElement('div');
                    btn.style.cssText = `
                        padding: 8px 15px;
                        color: white;
                        font-size: 13px;
                        cursor: pointer;
                        transition: background 0.2s;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    `;
                    btn.innerHTML = `<span>${sanitize(q.quality, 50)}</span> <span style="font-size:10px; color:#888;">${q.type === 'audio' ? '🎵' : '🎬'}</span>`;
                    
                    btn.onmouseenter = () => btn.style.background = 'rgba(142, 45, 226, 0.4)';
                    btn.onmouseleave = () => btn.style.background = 'transparent';
                    
                    btn.onclick = (e2) => {
                        e2.preventDefault();
                        e2.stopPropagation();
                        
                        // The existing `stream` object from the background is almost perfect.
                        // We just need to tell the background which specific quality URL to download.
                        chrome.runtime.sendMessage({
                            action: 'queueDownload',
                            stream: stream, // Pass the full stream object
                            downloadUrl: q.url // Pass the selected quality URL
                        }).catch(() => {});
                        
                        btn.innerHTML = '<span>✅ Queued!</span>';
                        btn.style.color = '#4CAF50';
                        watermark.style.background = '#4CAF50';
                        setTimeout(() => {
                            qualitiesMenu.style.display = 'none';
                            watermark.style.background = 'rgba(142, 45, 226, 0.95)';
                        }, 800);
                    };
                    
                    qualitiesMenu.appendChild(btn);
                });
            });
        }
    });
}

// Initialize UI when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInPageUI);
} else {
    initInPageUI();
}
