// Web Worker for M3U8 parsing (offload heavy parsing to background thread)

self.onmessage = function(event) {
    const { playlist, playlistUrl, id } = event.data;
    
    try {
        const result = parseM3u8(playlist, playlistUrl);
        self.postMessage({ id, success: true, result });
    } catch (error) {
        self.postMessage({ id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
};

/**
 * @param {string} playlist
 * @param {string} playlistUrl
 */
function parseM3u8(playlist, playlistUrl) {
    const lines = playlist.split('\n');
    const segments = [];
    const variantPlaylists = [];
    let targetDuration = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;

        // Extract target duration for adaptive bitrate
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = parseInt(line.split(':')[1]);
        }

        if (line.startsWith('#EXT-X-STREAM-INF')) {
            if (i + 1 < lines.length) {
                const nextLine = lines[i + 1].trim();
                if (nextLine.length > 0 && !nextLine.startsWith('#')) {
                    // Parse bandwidth and resolution
                    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                    const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                    const frameRateMatch = line.match(/FRAME-RATE=([\d.]+)/);

                    const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0;
                    const resolution = resolutionMatch ? resolutionMatch[1] : null;
                    const frameRate = frameRateMatch ? parseFloat(frameRateMatch[1]) : 30;

                    let quality = 'Default';
                    if (resolution) {
                        const height = resolution.split('x')[1];
                        quality = height + 'p';
                    }

                    variantPlaylists.push({
                        url: new URL(nextLine, playlistUrl).href,
                        info: line,
                        quality: quality,
                        bandwidth: bandwidth,
                        resolution: resolution,
                        frameRate: frameRate
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

    return {
        segments,
        variantPlaylists,
        targetDuration,
        totalSegments: segments.length,
        estimatedDuration: segments.length * (targetDuration || 10)
    };
}
