// ==UserScript==
// @name         B站视频分P搜索(适配多P视频)
// @namespace    https://github.com/yourname/bilibili-pagelist-search
// @version      2.2
// @description  在B站多P视频页面添加可拖拽搜索按钮，支持按分P标题筛选
// @author       Assistant
// @match        *://www.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      api.bilibili.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        DEBOUNCE_DELAY: 300,
        CACHE_EXPIRE_HOURS: 24,
        CONTAINER_ID: 'bili-pagelist-search-container',
        API_TIMEOUT: 8000,
    };

    const debounce = (fn, delay) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); }; };
    const escapeHtml = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
    const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function safeFetch(url) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('请求超时')), CONFIG.API_TIMEOUT);
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Referer': 'https://www.bilibili.com/', 'User-Agent': navigator.userAgent },
                onload: (resp) => {
                    clearTimeout(timeout);
                    try { resolve(resp); } catch (e) { reject(e); }
                },
                onerror: (err) => { clearTimeout(timeout); reject(err); },
                ontimeout: () => { clearTimeout(timeout); reject(new Error('超时')); },
                onabort: () => { clearTimeout(timeout); reject(new Error('中断')); }
            });
        });
    }

    // 提取当前视频 bvid
    function getCurrentBvid() {
        const m = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
        return m ? m[1] : null;
    }

    // ========== 1. 使用 pagelist 接口获取全部分P（最可靠） ==========
    async function fetchPagesByApi(bvid) {
        const url = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`;
        try {
            const resp = await safeFetch(url);
            const data = JSON.parse(resp.responseText);
            if (data.code === 0 && data.data) {
                return data.data.map(p => ({
                    title: p.part || `P${p.page}`,
                    page: p.page,
                    link: `https://www.bilibili.com/video/${bvid}?p=${p.page}`,
                    duration: formatDuration(p.duration),
                }));
            }
        } catch (e) {
            console.warn('[分P搜索] pagelist API 失败，尝试备用方案', e);
        }
        return [];
    }

    // ========== 2. 备用：从 __INITIAL_STATE__ 提取 availableVideoList ==========
    function parseFromAvailableVideoList() {
        try {
            const state = window.__INITIAL_STATE__;
            const list = state?.availableVideoList;
            if (!Array.isArray(list)) return [];
            const bvid = getCurrentBvid();
            return list.map((v, idx) => {
                const page = v.page || v.cid || idx + 1;
                const title = v.title || (v.part || `视频${idx+1}`);
                const link = bvid ? `https://www.bilibili.com/video/${bvid}?p=${page}` : '#';
                const duration = formatDuration(v.duration);
                return { title, page, link, duration };
            });
        } catch (e) {
            console.warn('[分P搜索] availableVideoList 解析失败', e);
            return [];
        }
    }

    // ========== 3. DOM 解析（兜底） ==========
    function parsePagesFromDOM() {
        try {
            // 适配新的 .video-pod__item 结构
            const items = document.querySelectorAll('.video-pod__item');
            const bvid = getCurrentBvid();
            const videos = [];
            items.forEach((item, idx) => {
                const titleEl = item.querySelector('.title-txt');
                const durationEl = item.querySelector('.duration');
                const title = titleEl ? titleEl.textContent.trim() : `P${idx+1}`;
                const link = bvid ? `https://www.bilibili.com/video/${bvid}?p=${idx+1}` : '#';
                const duration = durationEl ? durationEl.textContent.trim() : '';
                videos.push({ title, page: idx+1, link, duration });
            });
            return videos;
        } catch (e) {
            console.warn('[分P搜索] DOM 解析失败', e);
            return [];
        }
    }

    function formatDuration(sec) {
        if (!sec && sec !== 0) return '';
        const s = parseInt(sec);
        if (isNaN(s)) return sec.toString();
        const m = Math.floor(s / 60);
        return `${m}:${String(s % 60).padStart(2, '0')}`;
    }

    // ========== 缓存 ==========
    function setCache(bvid, data) {
        GM_setValue(`bili_pagelist_cache_${bvid}`, JSON.stringify({ ts: Date.now(), data }));
    }
    function getCache(bvid) {
        const raw = GM_getValue(`bili_pagelist_cache_${bvid}`, null);
        if (!raw) return null;
        try {
            const obj = JSON.parse(raw);
            if (Date.now() - obj.ts < CONFIG.CACHE_EXPIRE_HOURS * 3600 * 1000) return obj.data;
        } catch (e) {}
        return null;
    }

    // ========== UI 部分（同原版，只修改了一些 id/class） ==========
    function createStyles() {
        GM_addStyle(`
            #${CONFIG.CONTAINER_ID} { position:fixed; z-index:99999; cursor:grab; }
            #${CONFIG.CONTAINER_ID}:active { cursor:grabbing; }
            .bili-psearch-btn { width:42px; height:42px; border-radius:50%; background:#fb7299; color:#fff; border:none; font-size:18px; box-shadow:0 2px 10px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; transition:transform .2s; user-select:none; }
            .bili-psearch-btn:hover { background:#fc5c7d; transform:scale(1.05); }
            .bili-psearch-panel { display:none; position:absolute; right:50px; top:0; width:350px; max-height:600px; background:#fff; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.15); flex-direction:column; }
            .bili-psearch-panel.active { display:flex; }
            .bili-psearch-header { padding:12px 15px; border-bottom:1px solid #eee; display:flex; gap:8px; align-items:center; }
            .bili-psearch-header input { flex:1; padding:8px 12px; border:1px solid #ddd; border-radius:20px; outline:none; }
            .bili-psearch-header input:focus { border-color:#fb7299; }
            .bili-psearch-close { background:none; border:none; font-size:18px; color:#999; cursor:pointer; }
            .bili-psearch-list { flex:1; overflow-y:auto; padding:5px 0; }
            .bili-psearch-item { display:block; padding:10px 15px; text-decoration:none; color:#333; border-bottom:1px solid #f5f5f5; transition:.2s; }
            .bili-psearch-item:hover { background:#f5f5f5; }
            .bili-psearch-item-title { font-size:14px; margin-bottom:4px; }
            .bili-psearch-item-meta { font-size:12px; color:#999; }
            .bili-psearch-empty, .bili-psearch-loading { padding:40px 20px; text-align:center; color:#999; }
        `);
    }

    function createUI() {
        const existing = document.getElementById(CONFIG.CONTAINER_ID);
        if (existing) existing.remove();
        const container = document.createElement('div');
        container.id = CONFIG.CONTAINER_ID;
        container.style.right = '20px';
        container.style.top = '50%';
        container.style.transform = 'translateY(-50%)';
        container.innerHTML = `
            <button class="bili-psearch-btn">🔍</button>
            <div class="bili-psearch-panel">
                <div class="bili-psearch-header">
                    <input type="text" placeholder="搜索分P标题...">
                    <button class="bili-psearch-close">✕</button>
                </div>
                <div class="bili-psearch-list"></div>
            </div>
        `;
        document.body.appendChild(container);

        const btn = container.querySelector('.bili-psearch-btn');
        const panel = container.querySelector('.bili-psearch-panel');
        const input = container.querySelector('input');
        const closeBtn = container.querySelector('.bili-psearch-close');
        const listArea = container.querySelector('.bili-psearch-list');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('active');
            if (panel.classList.contains('active')) input.focus();
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.remove('active');
        });
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) panel.classList.remove('active');
        });

        // 拖拽
        let dragging = false, startX, startY, startLeft, startTop;
        btn.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            dragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = container.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            function onMove(e) {
                if (!dragging) return;
                e.preventDefault();
                const dx = e.clientX - startX, dy = e.clientY - startY;
                container.style.left = Math.min(window.innerWidth-60, Math.max(0, startLeft + dx)) + 'px';
                container.style.top = Math.min(window.innerHeight-60, Math.max(0, startTop + dy)) + 'px';
                container.style.right = 'auto';
                container.style.transform = 'none';
            }
            function onUp() {
                dragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
        btn.addEventListener('dragstart', e => e.preventDefault());

        return { container, input, listArea };
    }

    // ========== 主程序 ==========
    function main() {
        createStyles();
        const ui = createUI();
        let allVideos = [];
        let isLoading = false;

        function renderList(videos, keyword = '') {
            ui.listArea.innerHTML = '';
            if (videos.length === 0) {
                ui.listArea.innerHTML = `<div class="bili-psearch-empty">${keyword ? '没有匹配的分P' : '未能获取分P列表，请刷新后重试'}</div>`;
                return;
            }
            videos.forEach(v => {
                const a = document.createElement('a');
                a.className = 'bili-psearch-item';
                a.href = v.link;
                a.target = '_self';
                const titleHtml = keyword ? escapeHtml(v.title).replace(new RegExp(`(${escapeRegExp(keyword)})`, 'gi'), '<mark style="background:#fff3cd">$1</mark>') : escapeHtml(v.title);
                a.innerHTML = `<div class="bili-psearch-item-title">${titleHtml}</div><div class="bili-psearch-item-meta">P${v.page}${v.duration ? ' | '+v.duration : ''}</div>`;
                ui.listArea.appendChild(a);
            });
        }

        const performSearch = debounce((kw) => {
            if (!kw.trim()) { renderList(allVideos); return; }
            const lower = kw.toLowerCase();
            const filtered = allVideos.filter(v => v.title.toLowerCase().includes(lower) || String(v.page).includes(lower));
            renderList(filtered, kw);
        }, CONFIG.DEBOUNCE_DELAY);

        ui.input.addEventListener('input', () => performSearch(ui.input.value));

        async function loadData() {
            if (isLoading) return;
            isLoading = true;
            ui.listArea.innerHTML = '<div class="bili-psearch-loading">正在加载分P列表...</div>';

            const bvid = getCurrentBvid();
            if (!bvid) {
                ui.listArea.innerHTML = '<div class="bili-psearch-empty">未能识别当前视频，请确认在B站视频页面。</div>';
                isLoading = false;
                return;
            }

            // 1. 读缓存
            const cached = getCache(bvid);
            if (cached && cached.length) {
                allVideos = cached;
                renderList(allVideos);
                isLoading = false;
                return;
            }

            // 2. 调用 pagelist API
            let videos = await fetchPagesByApi(bvid);

            // 3. API 失败 → 尝试 availableVideoList
            if (videos.length === 0) {
                videos = parseFromAvailableVideoList();
            }

            // 4. 最后 DOM 兜底
            if (videos.length === 0) {
                videos = parsePagesFromDOM();
            }

            if (videos.length > 0) {
                allVideos = videos;
                setCache(bvid, videos);
                renderList(allVideos);
            } else {
                ui.listArea.innerHTML = '<div class="bili-psearch-empty">未找到任何分P数据。<br/>请确认是多P视频页面，然后刷新重试。</div>';
            }
            isLoading = false;
        }

        loadData();

        // 监听 DOM 动态加载（例如单页应用切换后重新加载）
        const observer = new MutationObserver(debounce(() => {
            if (allVideos.length === 0 && !isLoading) loadData();
        }, 1000));
        observer.observe(document.body, { childList: true, subtree: true });

        // 路由变化重新加载
        let lastUrl = location.href;
        new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                allVideos = [];
                isLoading = false;
                loadData();
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }
})();