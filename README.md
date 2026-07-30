# All Video Downloader (Contain Some Bugs - Will be updated later)

**The ultimate browser extension for downloading any video, audio, or file from the web.**

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](./manifest.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

All Video Downloader (AVD) is a powerful and versatile browser extension that empowers you to download virtually any media from any website. It features a sophisticated detection engine that finds videos, audio tracks, and other files that other downloaders miss, including complex HLS/M3U8 streams.

---

## Key Features

- **Comprehensive Detection:** Finds media that other downloaders can't by using multiple detection strategies.
- **Wide Format Support:** Download videos in MP4, WebM, and other formats. Captures HLS (M3U8) and MPEG-DASH (MPD) streams and assembles them into a single downloadable file.
- **Audio & Image Downloads:** Easily save audio tracks (MP3, WAV, OGG) and images (JPG, PNG, WebP).
- **Advanced "Files Mode":** Go beyond media! Enable Files Mode to detect and download documents (PDF, DOCX), archives (ZIP, RAR), and other file types.
- **Reliable YouTube Downloads:** A unique, robust method for downloading YouTube videos, audio, and thumbnails directly. (See [YouTube Downloader](#youtube-downloader) below).
- **Intuitive UI:** A clean and simple popup interface to browse, filter, sort, and manage all detected files.
- **In-Page Controls:** Convenient hover-buttons appear directly over videos and download links for one-click captures.
- **Multi-Download & Link Copying:** Select multiple files to download them all at once, or copy their links to the clipboard.
- **High Performance:** Built with performance in mind, using asynchronous operations and background workers to keep your browsing smooth.
- **Local File System Saving:** (Optional) Choose a folder on your local drive for a more organized download experience.

---

## How It Works

AVD uses a powerful, multi-layered approach to find downloadable content on any web page. This ensures maximum compatibility and a high success rate.

1.  **Network Interception:** The extension intelligently monitors network traffic. It inspects response headers for media content types (`video/mp4`, `audio/mpeg`, etc.) and immediately captures the file URL. This is a highly efficient and reliable method for direct media links.

2.  **DOM & Script Analysis:** AVD deeply analyzes the page's content.
    - It finds `<video>` and `<audio>` elements, even those hidden in Shadow DOMs.
    - It scans inline scripts and JSON data blobs (like `__NEXT_DATA__`) for embedded media URLs, which is crucial for modern, single-page applications.
    - It uses a `PerformanceObserver` to catch resources loaded dynamically by media players.

3.  **Heuristic Link Detection:** It identifies links (`<a>` tags) that are likely to be download links based on their URL, text (e.g., "Download"), or attributes.

---

## YouTube Downloader: The Converter API Integration Method

Downloading from YouTube is notoriously difficult due to its complex and ever-changing platform. AVD solves this with a unique and robust **YouTube Converter API Integration**.

Instead of trying to parse a complex web of internal YouTube code, the extension leverages a network of reliable, third-party converter services. Here’s how it works:

1.  **Direct Injection:** On a YouTube page, the extension injects a clean UI offering direct downloads for video (MP4), audio (MP3), and thumbnails.
2.  **API Request:** When you choose a format and quality, the extension sends the YouTube video URL to a secure, background API multiplexer (`cnv.cx`).
3.  **Smart Routing:** This API intelligently routes the request to one of several trusted converter services. The list of these services is even dynamically updated to ensure high availability.
4.  **Secure Download:** The converter service processes the video and returns a direct download link, which the extension then uses to start your download.

This method is significantly more reliable than traditional scraping techniques and ensures that you can consistently download your favorite YouTube content in the format you want.

---

## How to Use

1.  Navigate to a web page containing the media you want to download.
2.  Click the **All Video Downloader icon** in your browser's toolbar.
3.  The popup will display a list of all detected media and files.
4.  Use the **filters** (`🎬 Videos`, `🎵 Audio`, etc.), **search bar**, or **sort options** to find what you're looking for.
5.  Click the **Download button** (`⬇️`) next to an item, or use the checkboxes to select multiple files and click **"Download Selected"**.

---

## Advanced Features

- **Files Mode:** In the popup, toggle the "Files Mode" (`🚀 File Downloader`) switch. The extension will now detect a much broader range of file types, including documents, archives, and more.
- **Local Folder:** Go to Settings (`⚙️`) and enable "Use Local Filesystem". You will be prompted to choose a folder on your computer where all subsequent downloads from this extension will be saved.

---

## Installation from Source

1.  Clone this repository or download it as a ZIP file.
2.  Open Google Chrome and navigate to `chrome://extensions`.
3.  Enable **"Developer mode"** in the top-right corner.
4.  Click **"Load unpacked"**.
5.  Select the directory where you cloned or unzipped the repository.
6.  The extension will now be installed and ready to use.

---

## Contributing

Contributions are welcome! If you have ideas for new features, bug fixes, or improvements, please feel free to open an issue or submit a pull request.
