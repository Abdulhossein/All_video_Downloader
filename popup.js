// Simple, robust popup controller
class PopupUI {
    constructor() {
        /** @type {any[]} */
        this.streams = [];
        /** @type {Map<number, {progressBar: HTMLProgressElement | null, progressText: HTMLSpanElement | null}>} */
        this.downloads = new Map();
        this.init();
    }

    init() {
        this.el = {
            loading: /** @type {HTMLElement} */ (document.getElementById('loading')),
            content: /** @type {HTMLElement} */ (document.getElementById('content')),
            empty: /** @type {HTMLElement} */ (document.getElementById('empty')),
            error: /** @type {HTMLElement} */ (document.getElementById('error')),
            errorText: /** @type {HTMLElement} */ (document.getElementById('error-text')),
            videoList: /** @type {HTMLElement} */ (document.getElementById('video-list')),
            videoCount: /** @type {HTMLElement} */ (document.getElementById('video-count')),
            
            // Footer buttons
            refreshBtn: /** @type {HTMLButtonElement} */ (document.getElementById('refresh-btn')),
            rescanBtn: /** @type {HTMLButtonElement} */ (document.getElementById('rescan-btn')),
            clearBtn: /** @type {HTMLButtonElement} */ (document.getElementById('clear-btn')),
            downloadSelectedBtn: /** @type {HTMLButtonElement} */ (document.getElementById('download-selected-btn')),
            copyLinksBtn: /** @type {HTMLButtonElement} */ (document.getElementById('copy-links-btn')),

            // Filters
            filtersBar: /** @type {HTMLElement} */ (document.getElementById('filters-bar')),
            searchFilter: /** @type {HTMLInputElement} */ (document.getElementById('search-filter')),
            selectAll: /** @type {HTMLInputElement} */ (document.getElementById('select-all')),
            filterTagsContainer: /** @type {HTMLElement} */ (document.querySelector('.filters-bar .tags')),
            sortSelect: /** @type {HTMLSelectElement} */ (document.getElementById('sort-select')),
            filesModeToggle: /** @type {HTMLInputElement} */ (document.getElementById('files-mode-toggle')),
            showMainTypesFilter: /** @type {HTMLInputElement} */ (document.getElementById('show-main-types-filter')),
            
            // Settings
            settingsBtn: /** @type {HTMLButtonElement} */ (document.getElementById('settings-btn')),
            settingsPanel: /** @type {HTMLElement} */ (document.getElementById('settings-panel')),
            useLocalFs: /** @type {HTMLInputElement} */ (document.getElementById('use-local-fs')),
            chooseFolderBtn: /** @type {HTMLButtonElement} */ (document.getElementById('choose-folder-btn')),
            folderStatus: /** @type {HTMLElement} */ (document.getElementById('folder-status')),
            enableHoverButtons: /** @type {HTMLInputElement} */ (document.getElementById('enable-hover-buttons')),
            headerTitle: /** @type {HTMLElement} */ (document.querySelector('.header-title h1')),
        };
        
        // Remove old references
        this.el.downloadMajorTypes = null;
        this.el.downloadAllFileTypes = null;


        this.currentFilter = 'all';
        this.currentSort = 'default';
        this.searchText = '';
        this.showMainTypes = false;
        this.cardsRendered = false;
        this.localFsEnabled = false;
        this.filesModeEnabled = false;

        this.initSettings();
        this.addEventListeners();
        this.load();
    }
    
    addEventListeners() {
        this.el.refreshBtn?.addEventListener('click', () => this.refreshPage());
        this.el.rescanBtn?.addEventListener('click', () => this.rescanPage());
        this.el.clearBtn?.addEventListener('click', () => this.clear());
        
        this.el.selectAll?.addEventListener('click', (e) => this.handleSelectAll(e));

        this.el.searchFilter?.addEventListener('input', (e) => {
            this.searchText = /** @type {HTMLInputElement} */ (e.target).value.toLowerCase();
            this.render();
        });

        this.el.sortSelect?.addEventListener('change', (e) => {
            this.currentSort = /** @type {HTMLSelectElement} */ (e.target).value;
            this.cardsRendered = false; // Force re-rendering of cards
            this.render();
        });
        
        this.el.filesModeToggle?.addEventListener('change', async (e) => {
            const checked = /** @type {HTMLInputElement} */ (e.target).checked;
            this.filesModeEnabled = checked;
            await chrome.storage.local.set({ downloadMajorTypes: checked });
            this.updateUiForMode();
        });
        
        this.el.showMainTypesFilter?.addEventListener('change', (e) => {
            this.showMainTypes = /** @type {HTMLInputElement} */ (e.target).checked;
            this.render();
        });
        
        this.el.downloadSelectedBtn?.addEventListener('click', () => this.downloadSelected());
        this.el.copyLinksBtn?.addEventListener('click', () => this.copyLinks());

        chrome.downloads.onChanged.addListener((delta) => this.updateProgress(delta));

        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'hlsProgress') {
                this.updateHlsProgress(request.streamUrl, request.progress);
            } else if (request.action === 'hlsError') {
                this.showHlsError(request.streamUrl, request.error);
            } else if (request.action === 'queueUpdated' || request.action === 'streamsUpdated') {
                this.refreshStreams(true);
            }
        });
    }

    async initSettings() {
        this.el.settingsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.el.settingsPanel) {
                const isVisible = this.el.settingsPanel.style.display === 'block';
                this.el.settingsPanel.style.display = isVisible ? 'none' : 'block';
            }
        });

        document.body.addEventListener('click', (e) => {
            if (this.el.settingsPanel && !this.el.settingsPanel.contains(/** @type {Node} */ (e.target)) && !this.el.settingsBtn?.contains(/** @type {Node} */ (e.target))) {
                this.el.settingsPanel.style.display = 'none';
            }
        });
        
        // Load settings from storage
        const settings = await chrome.storage.local.get(['useLocalFs', 'downloadMajorTypes', 'enableHoverButtons', 'showMainTypes']);
        
        this.filesModeEnabled = settings.downloadMajorTypes || false;
        if (this.el.filesModeToggle) this.el.filesModeToggle.checked = this.filesModeEnabled;

        this.showMainTypes = settings.showMainTypes || false;
        if (this.el.showMainTypesFilter) this.el.showMainTypesFilter.checked = this.showMainTypes;

        if (settings.enableHoverButtons === undefined) {
            await chrome.storage.local.set({ enableHoverButtons: true });
            this.enableHoverButtons = true;
        } else {
            this.enableHoverButtons = settings.enableHoverButtons;
        }
        
        this.localFsEnabled = settings.useLocalFs || false;
        
        if (this.el.useLocalFs) this.el.useLocalFs.checked = this.localFsEnabled;
        if (this.el.enableHoverButtons) this.el.enableHoverButtons.checked = this.enableHoverButtons;
        
        this.updateUiForMode();

        // Check if we already have a handle saved
        if (this.localFsEnabled) {
            try {
                const handle = await avdDb.getHandle();
                if (handle) {
                    if (this.el.folderStatus) this.el.folderStatus.style.display = 'block';
                    if (this.el.chooseFolderBtn) this.el.chooseFolderBtn.style.display = 'block';
                }
            } catch (e) {
                console.warn("Could not retrieve handle", e);
            }
        }

        this.el.useLocalFs?.addEventListener('change', async (e) => {
            const checked = /** @type {HTMLInputElement} */ (e.target).checked;
            this.localFsEnabled = checked;
            await chrome.storage.local.set({ useLocalFs: checked });

            if (checked) {
                try {
                    const handle = await avdDb.getHandle();
                    if (!handle) await this.promptForFolder();
                } catch (e) {
                    this.el.useLocalFs.checked = false;
                    this.localFsEnabled = false;
                    await chrome.storage.local.set({ useLocalFs: false });
                }
            }
        });

        this.el.enableHoverButtons?.addEventListener('change', async (e) => {
            const checked = /** @type {HTMLInputElement} */ (e.target).checked;
            this.enableHoverButtons = checked;
            await chrome.storage.local.set({ enableHoverButtons: checked });
        });

        this.el.chooseFolderBtn?.addEventListener('click', () => this.promptForFolder());
    }

    updateUiForMode() {
        const tagsContainer = this.el.filterTagsContainer;
        if (!tagsContainer) return;

        if (this.filesModeEnabled) {
            this.el.headerTitle.textContent = '🚀 File Downloader';
            this.el.searchFilter.placeholder = '🔍 Search all files...';
            tagsContainer.innerHTML = `
                <button class="filter-tag active" data-type="all">🌟 All</button>
                <button class="filter-tag" data-type="media">🖼️ Media</button>
                <button class="filter-tag" data-type="document">📄 docs</button>
                <button class="filter-tag" data-type="zip">📦 zips</button>
                <button class="filter-tag" data-type="os">🖥️ OS</button>
            `;
            this.el.showMainTypesFilter.parentElement.style.display = 'block';
        } else {
            this.el.headerTitle.textContent = '🚀 Media Downloader';
            this.el.searchFilter.placeholder = '🔍 Search by name, format, quality...';
            tagsContainer.innerHTML = `
                <button class="filter-tag active" data-type="all">🌟 All</button>
                <button class="filter-tag" data-type="video">🎬 Videos</button>
                <button class="filter-tag" data-type="audio">🎵 Audio</button>
                <button class="filter-tag" data-type="image">🖼️ Images</button>
            `;
            this.el.showMainTypesFilter.parentElement.style.display = 'none';
        }
        
        this.el.filterTags = tagsContainer.querySelectorAll('.filter-tag');
        this.el.filterTags.forEach(tag => {
            tag.addEventListener('click', (e) => {
                this.el.filterTags.forEach(t => t.classList.remove('active'));
                const btn = /** @type {HTMLElement} */ (e.target);
                btn.classList.add('active');
                this.currentFilter = btn.dataset.type || 'all';
                this.render();
            });
        });

        this.currentFilter = 'all';
        this.cardsRendered = false; // Force re-render after UI mode change
        this.render();
    }
    
    refreshPage() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (tabId) {
                this.show('loading');
                chrome.tabs.reload(tabId, () => {
                    this.streams = [];
                    this.cardsRendered = false;
                    if (this.el.videoList) this.el.videoList.innerHTML = '';
                    setTimeout(() => this.load(), 1000); // Give page time to load
                });
            }
        });
    }

    rescanPage() {
        this.show('loading');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (tabId) {
                chrome.runtime.sendMessage({ action: 'rescanPage', tabId }, () => {
                     setTimeout(() => this.load(), 500); // Poll for new results
                });
            } else {
                this.showError("Cannot find active tab to rescan.");
            }
        });
    }

    load() {
        this.show('loading');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (!tabId) {
                this.showError('Cannot access current tab');
                return;
            }

            chrome.runtime.sendMessage({ action: 'getDetectedStreams', tabId }, (response) => {
                if (chrome.runtime.lastError) {
                    this.showError('Connection error - reload the page');
                    return;
                }

                this.streams = response?.streams || [];
                this.cardsRendered = false;
                this.render();
            });
        });
    }

    render() {
        const hasStreams = this.streams.length > 0;
        
        // Always show filter bar, but disable if empty
        this.el.filtersBar.classList.toggle('disabled', !hasStreams);
        Array.from(this.el.filtersBar.querySelectorAll('input, select, button')).forEach(el => {
            (/**@type {HTMLInputElement | HTMLSelectElement | HTMLButtonElement}*/ (el)).disabled = !hasStreams;
        });

        if (!hasStreams) {
            this.show('empty');
            return;
        }

        this.show('content');
        
        if (!this.cardsRendered) {
            this.el.videoList.innerHTML = '';
            
            this.sortStreams();

            const fragment = document.createDocumentFragment();
            this.streams.forEach((stream, idx) => {
                fragment.appendChild(this.createCard(stream, idx));
            });
            
            this.el.videoList.appendChild(fragment);
            this.cardsRendered = true;
            
            this.el.videoList.querySelectorAll('.item-checkbox').forEach(cb => {
                cb.addEventListener('change', () => this.updateDownloadBtnState());
            });
        }
        
        this.applyFilters();
    }
    
    sortStreams() {
        this.streams.sort((a, b) => {
            if (a.isMain && !b.isMain) return -1;
            if (!a.isMain && b.isMain) return 1;

            if (this.currentSort === 'name-asc') return (a.title || '').localeCompare(b.title || '');
            if (this.currentSort === 'name-desc') return (b.title || '').localeCompare(a.title || '');
            if (this.currentSort === 'size-asc') return (a.size || 0) - (b.size || 0);
            if (this.currentSort === 'size-desc') return (b.size || 0) - (a.size || 0);

            return 0; // Default order
        });
    }
    
    applyFilters() {
        let visibleCount = 0;
        const mainTypes = ['zip', 'os', 'video', 'audio'];
        
        this.el.videoList.querySelectorAll('.video-item').forEach((card) => {
            const idx = parseInt(/** @type {HTMLElement} */(card).dataset.idx || '0', 10);
            const stream = this.streams[idx];
            
            let isMatch = true;
            
            // Search filter
            const searchTitle = (stream.title + ' ' + (stream.artist || '') + ' ' + stream.url).toLowerCase();
            const searchTerms = this.searchText.split(',').map(t => t.trim()).filter(t => t);
            if (searchTerms.length > 0 && !searchTerms.some(term => searchTitle.includes(term))) {
                isMatch = false;
            }
            
            // Category filter
            if (isMatch && this.currentFilter !== 'all') {
                const fileType = detectContentType(stream.url, stream.type);
                
                if (this.filesModeEnabled) {
                     switch (this.currentFilter) {
                        case 'media': isMatch = ['video', 'audio', 'image', 'hls', 'dash'].includes(fileType); break;
                        case 'document': isMatch = fileType === 'document'; break;
                        case 'zip': isMatch = fileType === 'zip'; break;
                        case 'os': isMatch = fileType === 'os'; break;
                    }
                } else {
                    const fileType = detectContentType(stream.url, stream.type);
                    switch (this.currentFilter) {
                        case 'video': isMatch = ['video', 'hls', 'dash'].includes(fileType); break;
                        case 'audio': isMatch = fileType === 'audio'; break;
                        case 'image': isMatch = fileType === 'image'; break;
                    }
                }
            }
            
            // "Show main types" filter
            if (isMatch && this.filesModeEnabled && this.showMainTypes) {
                const fileType = detectContentType(stream.url, stream.type);
                if (!mainTypes.includes(fileType)) {
                    isMatch = false;
                }
            }
            
            const cardEl = /** @type {HTMLElement} */(card);
            cardEl.style.display = isMatch ? 'flex' : 'none';
            if (isMatch) {
                visibleCount++;
            } else {
                const cb = /** @type {HTMLInputElement} */(cardEl.querySelector('.item-checkbox'));
                if (cb) cb.checked = false;
            }
        });
        
        if (this.el.selectAll) this.el.selectAll.checked = false;
        this.updateDownloadBtnState();
    }
    
    updateDownloadBtnState() {
        if (!this.el.downloadSelectedBtn || !this.el.copyLinksBtn) return;
        
        const totalCount = this.streams.length;
        const visibleCards = Array.from(this.el.videoList.querySelectorAll('.video-item')).filter(c => /**@type {HTMLElement}*/(c).style.display !== 'none');
        const visibleCount = visibleCards.length;
        const checkedBoxes = visibleCards.filter(c => (/**@type {HTMLInputElement}*/(c.querySelector('.item-checkbox'))).checked);
        const checkedCount = checkedBoxes.length;

        if (this.el.videoCount) {
            this.el.videoCount.textContent = `${checkedCount} / ${visibleCount} / ${totalCount}`;
        }
        
        const isQueueActive = this.streams.some(s => s.downloadStatus === 'queued' || s.downloadStatus === 'downloading');
        
        if (checkedCount > 0) {
            this.el.downloadSelectedBtn.textContent = `⬇️ Download (${checkedCount})`;
            this.el.copyLinksBtn.textContent = `📋 Copy (${checkedCount})`;
        } else {
            const isFiltered = this.currentFilter !== 'all' || this.searchText !== '' || (this.filesModeEnabled && this.showMainTypes);
            this.el.downloadSelectedBtn.textContent = isFiltered ? `⬇️ Download Visible (${visibleCount})` : '⬇️ Download All';
            this.el.copyLinksBtn.textContent = isFiltered ? '📋 Copy Visible' : '📋 Copy All';
        }
    }
    
    copyLinks() {
        let checkboxes = Array.from(document.querySelectorAll('.item-checkbox:checked'));
        if (checkboxes.length === 0) {
            checkboxes = Array.from(document.querySelectorAll('.item-checkbox')).filter(cb => 
                /** @type {HTMLElement} */(cb.closest('.video-item'))?.style.display !== 'none'
            );
        }
        
        const links = checkboxes.map(cb => {
            const card = cb.closest('.video-item');
            const select = card?.querySelector('.quality-select');
            return select ? (/** @type {HTMLSelectElement} */ (select).value) : '';
        }).filter(url => url);
        
        if (links.length > 0) {
            const textToCopy = links.join('\n');
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalText = this.el.copyLinksBtn.textContent;
                this.el.copyLinksBtn.textContent = '✅ Copied!';
                setTimeout(() => this.el.copyLinksBtn.textContent = originalText, 2000);
            });
        }
    }
    
    downloadSelected() {
        let checkboxes = Array.from(document.querySelectorAll('.item-checkbox:checked'));
        
        if (checkboxes.length === 0) {
            checkboxes = Array.from(document.querySelectorAll('.item-checkbox')).filter(cb => 
                /** @type {HTMLElement} */(cb.closest('.video-item'))?.style.display !== 'none'
            );
        }
        
        checkboxes.forEach((cb) => {
            const card = cb.closest('.video-item');
            if (card) {
                const idx = parseInt(/** @type {HTMLElement} */ (card).dataset.idx || '0', 10);
                const stream = this.streams[idx];
                const select = /** @type {HTMLSelectElement} */ (card.querySelector('.quality-select'));
                this.download(stream, select ? select.value : stream.url);
            }
        });
    }

    /**
     * @param {any} stream
     * @param {string} url
     */
    download(stream, url) {
        if (!url) {
            this.showError('Invalid download URL');
            return;
        }

        const filename = getFilename(stream, url);
        
        chrome.runtime.sendMessage({
            action: 'queueDownload',
            streamUrl: stream.url,
            url: url,
            filename: filename,
            useLocalFs: this.localFsEnabled
        });
    }

    createCard(stream, idx) {
        const card = document.createElement('div');
        card.className = 'video-item';
        if (stream.downloadStatus === 'completed') card.classList.add('completed-item');
        card.dataset.idx = String(idx);

        // Main Row
        const mainRow = document.createElement('div');
        mainRow.className = 'item-main-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'item-checkbox';
        
        const thumbnail = document.createElement('img');
        thumbnail.className = 'item-thumbnail';
        thumbnail.src = stream.thumbnail || 'icons/icon-48.png';
        thumbnail.onerror = () => { thumbnail.src = 'icons/icon-48.png'; thumbnail.onerror = null; };

        const title = document.createElement('div');
        title.className = 'video-title';
        const finalTitle = sanitize(stream.title || `Media ${idx + 1}`);
        title.title = finalTitle;
        const span = document.createElement('span');
        span.textContent = finalTitle;
        title.appendChild(span);
        title.addEventListener('click', () => {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
        });

        const select = document.createElement('select');
        select.className = 'quality-select';

        if (stream.qualities?.length > 1) {
            stream.qualities.forEach(q => {
                const opt = document.createElement('option');
                opt.value = q.url || '';
                opt.textContent = sanitize(q.quality || 'Default');
                select.appendChild(opt);
            });
        } else {
            const opt = document.createElement('option');
            opt.value = stream.url || '';
            opt.textContent = String(stream.type || 'Default').toUpperCase();
            select.appendChild(opt);
        }

        const btn = document.createElement('button');
        btn.className = 'download-btn';
        
        if (stream.downloadStatus === 'completed') btn.textContent = '✅';
        else if (stream.downloadStatus === 'queued') btn.textContent = '⏳';
        else if (stream.downloadStatus === 'downloading') btn.textContent = '⬇️';
        else btn.textContent = '⬇️';
        
        btn.onclick = (e) => {
            e.stopPropagation();
            this.download(stream, select.value);
        };

        mainRow.append(checkbox, thumbnail, title, select, btn);

        // Progress Row
        const progressWrapper = document.createElement('div');
        progressWrapper.className = 'progress-wrapper';
        progressWrapper.style.display = 'none';
        
        const progressBar = document.createElement('progress');
        progressBar.className = 'progress-bar';
        progressBar.max = 100;
        
        const progressText = document.createElement('span');
        progressText.className = 'progress-text';

        progressWrapper.append(progressBar, progressText);
        
        card.append(mainRow, progressWrapper);
        
        if (stream.downloadStatus === 'downloading' || stream.downloadStatus === 'queued') {
            this.updateCardProgress(card, stream.downloadId, stream.progress);
        }
        
        return card;
    }

    refreshStreams(rebuildCards = false) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (!tabId) return;
            chrome.runtime.sendMessage({ action: 'getDetectedStreams', tabId }, (response) => {
                if (chrome.runtime.lastError || !response?.streams) return;
                this.streams = response.streams;
                if (rebuildCards) {
                    this.cardsRendered = false;
                }
                this.render();
            });
        });
    }

    updateProgress(delta) {
        const stream = this.streams.find(s => s.downloadId === delta.id);
        if (!stream) return;
        
        const card = this.el.videoList.querySelector(`[data-idx='${this.streams.indexOf(stream)}']`);
        if (!card) return;

        this.updateCardProgress(card, delta.id, delta);
    }
    
    updateCardProgress(card, downloadId, progress) {
        const progressWrapper = card.querySelector('.progress-wrapper');
        if (!progressWrapper) return;
        
        const progressBar = /** @type {HTMLProgressElement} */(progressWrapper.querySelector('.progress-bar'));
        const progressText = /** @type {HTMLElement} */(progressWrapper.querySelector('.progress-text'));

        if (progress?.state?.current === 'complete') {
            progressWrapper.style.display = 'none';
            card.classList.add('completed-item');
            const btn = card.querySelector('.download-btn');
            if (btn) btn.textContent = '✅';
            return;
        }
        
        if (progress?.state?.current === 'interrupted') {
            progressBar.style.display = 'none';
            progressText.textContent = '❌ Error';
            progressText.style.color = 'red';
            progressWrapper.style.display = 'flex';
            return;
        }

        if (progress?.totalBytes?.current > 0) {
            const percentage = Math.round((progress.bytesReceived.current / progress.totalBytes.current) * 100);
            progressBar.value = percentage;
            progressText.textContent = `${percentage}%`;
            progressWrapper.style.display = 'flex';
        } else if (downloadId) {
            // It's queued or native download hasn't reported size yet
            progressText.textContent = 'Queued...';
            progressBar.removeAttribute('value');
            progressWrapper.style.display = 'flex';
        }
    }

    show(state) {
        this.el.loading.style.display = state === 'loading' ? 'block' : 'none';
        this.el.content.style.display = state === 'content' ? 'block' : 'none';
        this.el.empty.style.display = state === 'empty' ? 'block' : 'none';
        this.el.error.style.display = state === 'error' ? 'block' : 'none';
    }

    showError(msg) {
        if (this.el.errorText) this.el.errorText.textContent = sanitize(msg);
        this.show('error');
    }

    clear() {
        if (confirm('Clear all items from the list?')) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tabId = tabs?.[0]?.id;
                if (tabId) {
                    chrome.runtime.sendMessage({ action: 'clearStreams', tabId });
                }
            });
            this.streams = [];
            this.cardsRendered = false;
            this.render();
        }
    }
    
    handleSelectAll(e) {
        const isChecked = /** @type {HTMLInputElement} */ (e.target).checked;
        this.el.videoList.querySelectorAll('.video-item').forEach((card) => {
            if (/** @type {HTMLElement} */(card).style.display !== 'none') {
                const cb = /** @type {HTMLInputElement} */(card.querySelector('.item-checkbox'));
                if (cb) cb.checked = isChecked;
            }
        });
        this.updateDownloadBtnState();
    }
    
    async promptForFolder() {
        try {
            const handle = await window.showDirectoryPicker();
            await avdDb.putHandle(handle);
            this.localFsEnabled = true;
            if (this.el.useLocalFs) this.el.useLocalFs.checked = true;
            if (this.el.folderStatus) this.el.folderStatus.style.display = 'block';
            if (this.el.chooseFolderBtn) this.el.chooseFolderBtn.style.display = 'block';
        } catch (error) {
            console.error("Error prompting for folder:", error);
            this.localFsEnabled = false;
            if (this.el.useLocalFs) this.el.useLocalFs.checked = false;
            if (this.el.folderStatus) this.el.folderStatus.style.display = 'none';
            if (this.el.chooseFolderBtn) this.el.chooseFolderBtn.style.display = 'none';
            this.showError('Folder selection cancelled or failed. Local filesystem downloads disabled.');
        }
    }
    
    updateHlsProgress(streamUrl, progress) {
        const stream = this.streams.find(s => s.url === streamUrl);
        if (!stream) return;

        const card = this.el.videoList.querySelector(`[data-idx='${this.streams.indexOf(stream)}']`);
        if (!card) return;

        // Simulate a Chrome download delta for updateCardProgress
        const delta = {
            id: stream.downloadId, // Assuming stream.downloadId is set for HLS downloads
            bytesReceived: { current: progress.downloadedBytes },
            totalBytes: { current: progress.totalBytes },
            state: { current: progress.status === 'completed' ? 'complete' : 'in_progress' }
        };
        
        stream.progress = progress;
        stream.downloadStatus = progress.status === 'completed' ? 'completed' : 'downloading';

        this.updateCardProgress(card, stream.downloadId, delta);
    }

    showHlsError(streamUrl, error) {
        const stream = this.streams.find(s => s.url === streamUrl);
        if (!stream) return;

        const card = this.el.videoList.querySelector(`[data-idx='${this.streams.indexOf(stream)}']`);
        if (!card) return;

        stream.downloadStatus = 'error';

        const progressWrapper = card.querySelector('.progress-wrapper');
        if (!progressWrapper) return;
        
        const progressBar = /** @type {HTMLProgressElement} */(progressWrapper.querySelector('.progress-bar'));
        const progressText = /** @type {HTMLElement} */(progressWrapper.querySelector('.progress-text'));

        progressBar.style.display = 'none';
        progressText.textContent = `❌ Error: ${error}`;
        progressText.style.color = 'red';
        progressWrapper.style.display = 'flex';
    }
}

document.addEventListener('DOMContentLoaded', () => new PopupUI());
