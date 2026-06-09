'use strict';

const STAR = '\u2605';
const EM_DASH = '\u2014';
const ELLIPSIS = '\u2026';

const LS_CUSTOM_SOURCES = 'iptv-custom-sources';
const LS_BUILTIN_URL = 'iptv-builtin-url';
const LS_PLAYLIST_MANIFEST = 'iptv-playlist-manifest';
const LS_FAVORITES = 'iptv-favorites';
const LS_STREAM_STATUS = 'iptv-stream-status';
const STREAM_OK_TTL = 24 * 60 * 60 * 1000;
const STREAM_FAIL_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_STREAM_STATUS_ENTRIES = 25000;
const CHECK_CONCURRENCY = 4;
const MANIFEST_TIMEOUT_MS = 6000;
const LEVEL_PROBE_MS = 4000;
const BACKGROUND_BATCH_SIZE = 80;
const BACKGROUND_PAUSE_MS = 40;
const IPTV_BASE = 'https://iptv-org.github.io/iptv/';
const GITHUB_API = 'https://api.github.com/repos/iptv-org/iptv/contents';
const GITHUB_REF = 'gh-pages';
const MANIFEST_CACHE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUILTIN = IPTV_BASE + 'categories/kids.m3u';
const BUILTIN_LABEL = 'iptv-org';

const COUNTRY_ALIASES = {
  uk: 'United Kingdom',
  int: 'International',
  undefined: 'Undefined',
};

const FALLBACK_MANIFEST = [
  { label: 'Main', options: [
    { value: IPTV_BASE + 'index.m3u', label: 'All channels' },
  ]},
  { label: 'By Category', options: [
    { value: IPTV_BASE + 'categories/kids.m3u', label: 'Kids' },
    { value: IPTV_BASE + 'categories/news.m3u', label: 'News' },
    { value: IPTV_BASE + 'categories/sports.m3u', label: 'Sports' },
    { value: IPTV_BASE + 'categories/entertainment.m3u', label: 'Entertainment' },
  ]},
  { label: 'By Country', options: [
    { value: IPTV_BASE + 'countries/us.m3u', label: 'United States' },
    { value: IPTV_BASE + 'countries/uk.m3u', label: 'United Kingdom' },
    { value: IPTV_BASE + 'countries/de.m3u', label: 'Germany' },
  ]},
];

let allChannels = [];
let filtered = [];
let currentHls = null;
let currentChannel = null;
let toastTimer = null;
let customSources = [];
let pasteCounter = 0;
let favorites = [];
let favoritesOnly = false;
let streamStatus = {};
let hideBroken = true;
let availabilityChecking = false;
let backgroundCheckActive = false;

/* â”€â”€ FETCH â”€â”€ */
async function fetchM3U(url) {
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.includes('#EXTM3U') || text.includes('#EXTINF')) return text;
    throw new Error('Not a valid M3U response');
  } catch (e) {
    console.warn('Direct fetch failed, trying proxy...', e.message);
  }

  const proxies = [
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];
  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy, { cache: 'no-store' });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes('#EXTINF')) return text;
    } catch (_) {}
  }
  throw new Error('All fetch attempts failed');
}

/* â”€â”€ PARSE M3U â”€â”€ */
function parseM3U(text, sourceLabel) {
  const lines = text.split('\n');
  const channels = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      meta = { name: '', logo: '', group: '', country: '', language: '', url: '', sourceLabel };
      const nameM = line.match(/,(.+)$/);
      if (nameM) meta.name = nameM[1].trim();
      const attr = (key) => { const m = line.match(new RegExp(`${key}="([^"]*)"`)); return m ? m[1] : ''; };
      meta.logo     = attr('tvg-logo');
      meta.group    = attr('group-title');
      meta.country  = attr('tvg-country');
      meta.language = attr('tvg-language');
    } else if (line && !line.startsWith('#') && meta) {
      meta.url = line;
      if (meta.name && meta.url) channels.push({ ...meta });
      meta = null;
    }
  }
  return channels;
}

function isValidM3U(text) {
  const t = text.trim();
  return t.includes('#EXTM3U') || t.includes('#EXTINF');
}

function mergeChannels(sources) {
  const seen = new Set();
  const merged = [];
  for (const list of sources) {
    for (const ch of list) {
      if (!seen.has(ch.url)) {
        seen.add(ch.url);
        merged.push(ch);
      }
    }
  }
  return merged;
}

/* â”€â”€ CUSTOM SOURCES â”€â”€ */
function loadCustomSources() {
  try {
    const raw = localStorage.getItem(LS_CUSTOM_SOURCES);
    customSources = raw ? JSON.parse(raw) : [];
    pasteCounter = customSources.filter(s => s.type === 'paste').length;
  } catch (_) {
    customSources = [];
  }
}

function saveCustomSources() {
  localStorage.setItem(LS_CUSTOM_SOURCES, JSON.stringify(customSources));
}

function labelFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return 'Custom URL';
  }
}

function nextPasteLabel() {
  pasteCounter += 1;
  return `Pasted playlist ${pasteCounter}`;
}

function renderCustomSourceList() {
  const el = document.getElementById('custom-sources');
  if (!customSources.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = customSources.map(s =>
    `<div class="custom-source-item">
      <span class="custom-source-label" title="${escHtml(s.label)}">${escHtml(s.label)}</span>
      <span class="custom-source-type">${escHtml(s.type)}</span>
      <button type="button" class="custom-source-remove" data-id="${escHtml(s.id)}" aria-label="Remove">Ã—</button>
    </div>`
  ).join('');
  el.querySelectorAll('.custom-source-remove').forEach(btn => {
    btn.addEventListener('click', () => removeCustomSource(btn.dataset.id));
  });
}

function addCustomSourceFromUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) {
    showToast('Enter a playlist URL.', true);
    return;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    showToast('URL must start with http:// or https://', true);
    return;
  }
  if (customSources.some(s => s.type === 'url' && s.value === trimmed)) {
    showToast('This URL is already added.', true);
    return;
  }
  const source = {
    id: crypto.randomUUID(),
    label: labelFromUrl(trimmed),
    type: 'url',
    value: trimmed,
    enabled: true,
  };
  customSources.push(source);
  saveCustomSources();
  renderCustomSourceList();
  document.getElementById('custom-url-input').value = '';
  reloadAllChannels();
  showToast(`Added ${source.label}`, false);
}

function addCustomSourceFromPaste(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    showToast('Paste M3U content first.', true);
    return;
  }
  if (!isValidM3U(trimmed)) {
    showToast('Invalid M3U â€” needs #EXTM3U or #EXTINF lines.', true);
    return;
  }
  const channels = parseM3U(trimmed, 'paste');
  if (!channels.length) {
    showToast('No channels found in pasted content.', true);
    return;
  }
  const source = {
    id: crypto.randomUUID(),
    label: nextPasteLabel(),
    type: 'paste',
    value: trimmed,
    enabled: true,
  };
  customSources.push(source);
  saveCustomSources();
  renderCustomSourceList();
  document.getElementById('custom-paste-input').value = '';
  reloadAllChannels();
  showToast(`Added ${channels.length} channels from paste`, false);
}

function removeCustomSource(id) {
  const source = customSources.find(s => s.id === id);
  customSources = customSources.filter(s => s.id !== id);
  saveCustomSources();
  renderCustomSourceList();
  if (currentChannel && source) reloadAllChannels();
  else reloadAllChannels();
}

async function loadBuiltInPlaylist(url) {
  const text = await fetchM3U(url);
  const channels = parseM3U(text, BUILTIN_LABEL);
  if (!channels.length) throw new Error('No channels parsed from built-in playlist');
  return channels;
}

async function loadCustomSource(source) {
  if (source.type === 'paste') {
    const channels = parseM3U(source.value, source.label);
    if (!channels.length) throw new Error(`No channels in ${source.label}`);
    return channels;
  }
  const text = await fetchM3U(source.value);
  const channels = parseM3U(text, source.label);
  if (!channels.length) throw new Error(`No channels in ${source.label}`);
  return channels;
}

/* â”€â”€ RELOAD ALL â”€â”€ */
async function reloadAllChannels() {
  const builtinUrl = document.getElementById('source-select').value;
  if (!builtinUrl) return;

  const wasPlaying = currentChannel;
  const playingUrl = wasPlaying ? wasPlaying.url : null;

  showLoading('FETCHING PLAYLISTS' + ELLIPSIS);
  document.getElementById('search').value = '';

  const enabledCustom = customSources.filter(s => s.enabled);
  const results = await Promise.allSettled([
    loadBuiltInPlaylist(builtinUrl),
    ...enabledCustom.map(s => loadCustomSource(s)),
  ]);

  const channelLists = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      channelLists.push(result.value);
    } else {
      const name = i === 0 ? 'Built-in playlist' : enabledCustom[i - 1].label;
      errors.push(name);
      console.error(`Failed to load ${name}:`, result.reason);
    }
  });

  allChannels = mergeChannels(channelLists);

  applyChannelFilter();

  if (playingUrl) {
    const newIdx = allChannels.findIndex(ch => ch.url === playingUrl);
    if (newIdx >= 0) {
      document.querySelectorAll('.channel-item').forEach(el =>
        el.classList.toggle('active', parseInt(el.dataset.idx) === newIdx)
      );
      currentChannel = allChannels[newIdx];
    } else {
      stopPlayback();
    }
  }

  if (allChannels.length) {
    if (errors.length) {
      showToast(`Loaded with errors: ${errors.join(', ')}`, true);
    } else if (!wasPlaying) {
      showToast(`Loaded ${allChannels.length.toLocaleString()} channels`, false);
    }
  } else {
    showToast(errors.length
      ? `Could not load: ${errors.join(', ')}`
      : 'No channels loaded.', true);
  }

  hideLoading();
  localStorage.setItem(LS_BUILTIN_URL, builtinUrl);
  updateHideBrokenToggle();
  startBackgroundCheck();
}

/* -- STREAM AVAILABILITY -- */
function streamStatusTtl(status) {
  return status === 'fail' ? STREAM_FAIL_TTL : STREAM_OK_TTL;
}

function loadStreamStatus() {
  try {
    const raw = localStorage.getItem(LS_STREAM_STATUS);
    if (!raw) return;
    const data = JSON.parse(raw);
    const now = Date.now();
    streamStatus = {};
    for (const [url, entry] of Object.entries(data)) {
      if (entry && entry.status && now - entry.checkedAt < streamStatusTtl(entry.status)) {
        streamStatus[url] = entry;
      }
    }
  } catch (_) {
    streamStatus = {};
  }
}

function pruneStreamStatus() {
  const entries = Object.entries(streamStatus);
  if (entries.length <= MAX_STREAM_STATUS_ENTRIES) return;
  const sorted = entries.sort((a, b) => a[1].checkedAt - b[1].checkedAt);
  const remove = entries.length - MAX_STREAM_STATUS_ENTRIES;
  for (let i = 0; i < remove; i++) {
    if (sorted[i][1].status === 'ok') delete streamStatus[sorted[i][0]];
  }
}

function saveStreamStatus() {
  pruneStreamStatus();
  try {
    localStorage.setItem(LS_STREAM_STATUS, JSON.stringify(streamStatus));
  } catch (_) {}
}

function getStreamStatus(url) {
  const entry = streamStatus[url];
  if (!entry) return null;
  if (Date.now() - entry.checkedAt >= streamStatusTtl(entry.status)) {
    delete streamStatus[url];
    return null;
  }
  return entry.status;
}

function setStreamStatus(url, status) {
  if (!url || (status !== 'ok' && status !== 'fail')) return;
  streamStatus[url] = { status, checkedAt: Date.now() };
  saveStreamStatus();
}

function countBrokenInList(list) {
  return list.filter(ch => getStreamStatus(ch.url) === 'fail').length;
}

function countUncheckedInList(list) {
  return list.filter(ch => getStreamStatus(ch.url) === null).length;
}

function getChannelsToCheck() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  let list = favoritesOnly ? [...favorites] : [...allChannels];
  if (q) list = list.filter(ch => channelMatchesSearch(ch, q));
  return list;
}

function getUncheckedChannels(list) {
  return list.filter(ch => getStreamStatus(ch.url) === null);
}

function probeStream(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve('fail');
      return;
    }

    let finished = false;
    let hls = null;
    let manifestTimer = null;
    let levelTimer = null;

    const cleanup = () => {
      clearTimeout(manifestTimer);
      clearTimeout(levelTimer);
      if (hls) {
        hls.destroy();
        hls = null;
      }
    };

    const finish = (status) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(status);
    };

    const beginLevelProbe = () => {
      levelTimer = setTimeout(() => finish('fail'), LEVEL_PROBE_MS);
      hls.startLoad(-1);
    };

    manifestTimer = setTimeout(() => finish('fail'), MANIFEST_TIMEOUT_MS);

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const probeVideo = document.createElement('video');
      hls = new Hls({
        enableWorker: true,
        maxBufferLength: 2,
        maxMaxBufferLength: 4,
        autoStartLoad: false,
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        clearTimeout(manifestTimer);
        beginLevelProbe();
      });
      hls.on(Hls.Events.LEVEL_LOADED, () => finish('ok'));
      hls.on(Hls.Events.FRAG_LOADED, () => finish('ok'));
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) finish('fail');
      });
      hls.attachMedia(probeVideo);
      hls.loadSource(url);
      return;
    }

    if (/\.m3u8/i.test(url)) {
      const probeVideo = document.createElement('video');
      const nativeTimer = setTimeout(() => finish('fail'), MANIFEST_TIMEOUT_MS + LEVEL_PROBE_MS);
      probeVideo.onloadedmetadata = () => {
        clearTimeout(nativeTimer);
        finish('ok');
      };
      probeVideo.onerror = () => {
        clearTimeout(nativeTimer);
        finish('fail');
      };
      probeVideo.src = url;
      return;
    }

    finish('fail');
  });
}

async function runAvailabilityCheck(targets, { background = false } = {}) {
  if (!targets.length) return { ok: 0, fail: 0 };

  availabilityChecking = true;
  updateCheckAvailabilityButton(0, targets.length, background);

  let ok = 0;
  let fail = 0;
  let index = 0;

  async function worker() {
    while (index < targets.length) {
      const i = index++;
      const ch = targets[i];
      const status = await probeStream(ch.url);
      setStreamStatus(ch.url, status);
      if (status === 'ok') ok++;
      else fail++;
      updateCheckAvailabilityButton(i + 1, targets.length, background);
      if ((i + 1) % 40 === 0) updateHideBrokenToggle();
    }
  }

  const workers = Array.from(
    { length: Math.min(CHECK_CONCURRENCY, targets.length) },
    () => worker()
  );
  await Promise.all(workers);

  availabilityChecking = false;
  updateCheckAvailabilityButton();
  updateHideBrokenToggle();
  applyChannelFilter();

  return { ok, fail };
}

async function checkAvailability() {
  if (availabilityChecking || !allChannels.length) return;

  const scope = getChannelsToCheck();
  const targets = getUncheckedChannels(scope);
  if (!targets.length) {
    showToast('All channels in this list are already checked.', false);
    return;
  }

  backgroundCheckActive = false;
  const { ok, fail } = await runAvailabilityCheck(targets);
  const remaining = getUncheckedChannels(allChannels).length;
  let msg = `Checked ${targets.length}: ${ok} working, ${fail} broken`;
  if (remaining) msg += ` \u00b7 ${remaining.toLocaleString()} left`;
  showToast(msg, false);

  if (remaining) startBackgroundCheck();
}

async function startBackgroundCheck() {
  if (backgroundCheckActive || availabilityChecking) return;
  const remaining = getUncheckedChannels(allChannels);
  if (!remaining.length) return;

  backgroundCheckActive = true;
  while (backgroundCheckActive && !availabilityChecking) {
    const batch = getUncheckedChannels(allChannels).slice(0, BACKGROUND_BATCH_SIZE);
    if (!batch.length) break;
    await runAvailabilityCheck(batch, { background: true });
    if (getUncheckedChannels(allChannels).length) {
      await new Promise(r => setTimeout(r, BACKGROUND_PAUSE_MS));
    }
  }
  backgroundCheckActive = false;
  updateCheckAvailabilityButton();

  const broken = countBrokenInList(allChannels);
  const unchecked = countUncheckedInList(allChannels);
  if (broken && !unchecked) {
    showToast(`Scan complete: ${broken.toLocaleString()} broken streams hidden`, false);
  }
}

function updateCheckAvailabilityButton(done, total, background) {
  const btn = document.getElementById('check-availability-btn');
  if (!btn) return;
  if (availabilityChecking && total) {
    const prefix = background ? 'Scanning' : 'Checking';
    btn.textContent = `${prefix} ${done}/${total}\u2026`;
    btn.disabled = true;
  } else {
    const unchecked = countUncheckedInList(allChannels);
    btn.textContent = unchecked
      ? `Check availability (${unchecked.toLocaleString()} left)`
      : 'Check availability';
    btn.disabled = !allChannels.length;
  }
}

function updateHideBrokenToggle() {
  const btn = document.getElementById('hide-broken-toggle');
  if (!btn) return;
  const base = favoritesOnly ? favorites : allChannels;
  const brokenCount = countBrokenInList(base);
  btn.textContent = brokenCount
    ? `Hide broken (${brokenCount.toLocaleString()})`
    : 'Hide broken';
  btn.classList.toggle('active', hideBroken);
}

function toggleHideBroken() {
  hideBroken = !hideBroken;
  updateHideBrokenToggle();
  applyChannelFilter();
}

function getFilterBase() {
  return favoritesOnly ? favorites : allChannels;
}



/* â”€â”€ FAVORITES â”€â”€ */
function loadFavorites() {
  try {
    const raw = localStorage.getItem(LS_FAVORITES);
    favorites = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(favorites)) favorites = [];
  } catch (_) {
    favorites = [];
  }
}

function saveFavorites() {
  localStorage.setItem(LS_FAVORITES, JSON.stringify(favorites));
}

function isFavorite(url) {
  return favorites.some(f => f.url === url);
}

function snapshotChannel(ch) {
  return {
    name: ch.name,
    logo: ch.logo || '',
    group: ch.group || '',
    country: ch.country || '',
    language: ch.language || '',
    url: ch.url,
    sourceLabel: ch.sourceLabel || '',
  };
}

function addFavorite(ch) {
  if (isFavorite(ch.url)) return;
  favorites.unshift(snapshotChannel(ch));
  saveFavorites();
  updateFavoritesToggle();
  applyChannelFilter();
  updateFavoriteButton();
  showToast('Added to favorites', false);
}

function removeFavorite(url) {
  favorites = favorites.filter(f => f.url !== url);
  saveFavorites();
  updateFavoritesToggle();
  applyChannelFilter();
  updateFavoriteButton();
  showToast('Removed from favorites', false);
}

function toggleFavorite() {
  if (!currentChannel) return;
  if (isFavorite(currentChannel.url)) removeFavorite(currentChannel.url);
  else addFavorite(currentChannel);
}

function updateFavoriteButton() {
  const btn = document.getElementById('favorite-btn');
  if (!currentChannel) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = 'flex';
  const favorited = isFavorite(currentChannel.url);
  btn.textContent = favorited ? STAR + ' Favorited' : STAR + ' Favorite';
  btn.classList.toggle('favorited', favorited);
}

function updateFavoritesToggle() {
  const btn = document.getElementById('favorites-toggle');
  const count = favorites.length;
  btn.textContent = count
    ? `${STAR} Favorites (${count})`
    : STAR + ' Favorites';
  btn.classList.toggle('active', favoritesOnly);
}

function channelMatchesSearch(ch, q) {
  return ch.name.toLowerCase().includes(q) ||
    (ch.group && ch.group.toLowerCase().includes(q)) ||
    (ch.country && ch.country.toLowerCase().includes(q)) ||
    (ch.sourceLabel && ch.sourceLabel.toLowerCase().includes(q));
}

function applyChannelFilter() {
  const q = document.getElementById('search').value.toLowerCase().trim();
  let list = getFilterBase();
  if (q) list = list.filter(ch => channelMatchesSearch(ch, q));
  if (hideBroken) list = list.filter(ch => getStreamStatus(ch.url) !== 'fail');
  filtered = list;
  renderChannels();
  updateHideBrokenToggle();
}

function toggleFavoritesView() {
  favoritesOnly = !favoritesOnly;
  updateFavoritesToggle();
  applyChannelFilter();
}

/* â”€â”€ RENDER â”€â”€ */
function renderChannelRow(ch, idx, mode) {
  const logoHtml = ch.logo
    ? `<img class="ch-logo" src="${escHtml(ch.logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="ch-logo-placeholder" style="display:none">${escHtml(ch.name.slice(0,2).toUpperCase())}</div>`
    : `<div class="ch-logo-placeholder">${escHtml(ch.name.slice(0,2).toUpperCase())}</div>`;
  const tags = [ch.group, ch.country].filter(Boolean)
    .map(t => `<span class="ch-tag">${escHtml(t)}</span>`).join('');
  const sourceTag = ch.sourceLabel && ch.sourceLabel !== BUILTIN_LABEL
    ? `<span class="ch-source">${escHtml(ch.sourceLabel)}</span>` : '';
  const favMark = !favoritesOnly && isFavorite(ch.url)
    ? '<span class="ch-fav-mark" aria-hidden="true">' + STAR + '</span>' : '';
  const status = getStreamStatus(ch.url);
  const statusMark = status === 'ok'
    ? '<span class="ch-status ok" title="Working">\u2713</span>'
    : status === 'fail'
      ? '<span class="ch-status fail" title="Unavailable">\u2717</span>'
      : '';
  const isActive = currentChannel && currentChannel.url === ch.url;
  const playFn = mode === 'favorites'
    ? `playFavorite(${idx})`
    : `playChannel(${allChannels.findIndex(c => c.url === ch.url)})`;
  return `<div class="channel-item${isActive ? ' active' : ''}" data-idx="${idx}" onclick="${playFn}">
    ${logoHtml}
    <div class="ch-info">
      <div class="ch-name">${escHtml(ch.name)}</div>
      <div class="ch-meta">${tags}${sourceTag}</div>
    </div>
    ${statusMark}${favMark}
  </div>`;
}

function renderChannels() {
  const el = document.getElementById('channel-list');
  if (!filtered.length) {
    let msg = 'No channels found.';
    if (hideBroken && countBrokenInList(getFilterBase()) > 0) {
      msg = 'All matching channels are marked broken. Turn off Hide broken to see them.';
    } else if (favoritesOnly) {
      msg = favorites.length
        ? 'No favorites match your search.'
        : 'No favorites yet. Play a channel and tap ' + STAR + ' Favorite.';
    }
    el.innerHTML = `<div class="empty-state"><p>${msg}</p></div>`;
    return;
  }
  const mode = favoritesOnly ? 'favorites' : 'all';
  el.innerHTML = filtered.map((ch, i) => renderChannelRow(ch, i, mode)).join('');
}

/* â”€â”€ SEARCH â”€â”€ */
document.getElementById('search').addEventListener('input', applyChannelFilter);

/* â”€â”€ PLAY â”€â”€ */
function setNowPlaying(ch) {
  document.getElementById('np-title').textContent = ch.name;
  document.getElementById('np-subtitle').textContent =
    [ch.group, ch.country, ch.language].filter(Boolean).join(' Â· ') || 'Live Stream';
  document.getElementById('live-pill').style.display = 'inline-flex';
  document.getElementById('placeholder').style.display = 'none';
  updateFavoriteButton();
}

function highlightActiveChannel() {
  if (!currentChannel) return;
  document.querySelectorAll('.channel-item').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    const ch = filtered[idx];
    el.classList.toggle('active', ch && ch.url === currentChannel.url);
  });
}

function playChannelObject(ch) {
  if (!ch) return;
  currentChannel = ch;
  highlightActiveChannel();
  setNowPlaying(ch);
  startStream(ch.url);
}

function playChannel(idx) {
  const ch = allChannels[idx];
  if (!ch) return;
  playChannelObject(ch);
}

function playFavorite(idx) {
  const ch = filtered[idx];
  if (!ch) return;
  playChannelObject(ch);
}

function startStream(url) {
  const video = document.getElementById('video');
  if (currentHls) { currentHls.destroy(); currentHls = null; }
  video.pause(); video.src = '';

  if (Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    currentHls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStreamStatus(url, 'ok');
      updateHideBrokenToggle();
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (e, data) => {
      if (!data.fatal) return;
      setStreamStatus(url, 'fail');
      updateHideBrokenToggle();
      applyChannelFilter();
      showToast('Stream unavailable. Try another channel.', true);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.onloadeddata = () => {
      setStreamStatus(url, 'ok');
      updateHideBrokenToggle();
    };
    video.onerror = () => {
      setStreamStatus(url, 'fail');
      updateHideBrokenToggle();
      applyChannelFilter();
    };
    video.play().catch(() => {});
  } else {
    video.src = url;
    video.play().catch(() => showToast('Cannot play this stream format in your browser.', true));
  }
}

function stopPlayback() {
  const video = document.getElementById('video');
  if (currentHls) { currentHls.destroy(); currentHls = null; }
  video.pause(); video.src = '';
  currentChannel = null;
  document.getElementById('placeholder').style.display = 'flex';
  document.getElementById('live-pill').style.display = 'none';
  document.getElementById('favorite-btn').style.display = 'none';
  document.getElementById('np-title').textContent = 'No channel selected';
  document.getElementById('np-subtitle').textContent = 'Pick a channel from the list';
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
}

/* â”€â”€ UTILS â”€â”€ */
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showLoading(msg) {
  document.getElementById('loader-text').textContent = msg;
  document.getElementById('loading-overlay').style.display = 'flex';
}
function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = isError ? 'err' : ''; }, 4000);
}

/* â”€â”€ UI WIRING â”€â”€ */
function toggleAddPlaylistPanel() {
  const panel = document.getElementById('add-playlist-panel');
  const toggle = document.getElementById('add-playlist-toggle');
  const open = panel.classList.toggle('open');
  toggle.classList.toggle('open', open);
  toggle.textContent = open ? 'âˆ’ Add playlist' : '+ Add playlist';
}

function switchSourceTab(tab) {
  document.querySelectorAll('.source-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.getElementById('tab-url').classList.toggle('active', tab === 'url');
  document.getElementById('tab-paste').classList.toggle('active', tab === 'paste');
}

document.getElementById('add-playlist-toggle').addEventListener('click', toggleAddPlaylistPanel);
document.getElementById('add-url-btn').addEventListener('click', () => {
  addCustomSourceFromUrl(document.getElementById('custom-url-input').value);
});
document.getElementById('add-paste-btn').addEventListener('click', () => {
  addCustomSourceFromPaste(document.getElementById('custom-paste-input').value);
});
document.getElementById('custom-url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addCustomSourceFromUrl(e.target.value);
});
document.querySelectorAll('.source-tab').forEach(tab => {
  tab.addEventListener('click', () => switchSourceTab(tab.dataset.tab));
});
document.getElementById('source-select').addEventListener('change', reloadAllChannels);
document.getElementById('favorite-btn').addEventListener('click', toggleFavorite);
document.getElementById('favorites-toggle').addEventListener('click', toggleFavoritesView);
document.getElementById('check-availability-btn').addEventListener('click', checkAvailability);
document.getElementById('hide-broken-toggle').addEventListener('click', toggleHideBroken);

/* â”€â”€ IPTV-ORG PLAYLIST INDEX (GitHub API) â”€â”€ */
function formatSlug(filename) {
  const slug = filename.replace(/\.m3u$/i, '');
  return slug.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function playlistUrl(folder, filename) {
  return folder ? IPTV_BASE + folder + '/' + filename : IPTV_BASE + filename;
}

async function fetchGithubM3uDir(dir) {
  const res = await fetch(`${GITHUB_API}/${dir}?ref=${GITHUB_REF}`);
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${dir}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error(`Unexpected response for ${dir}`);
  return items
    .filter(i => i.type === 'file' && i.name.endsWith('.m3u'))
    .map(i => i.name)
    .sort((a, b) => a.localeCompare(b));
}

async function fetchLabelMaps() {
  const maps = { countries: {}, languages: {} };
  try {
    const [countries, languages] = await Promise.all([
      fetch('https://iptv-org.github.io/api/countries.json').then(r => r.ok ? r.json() : []),
      fetch('https://iptv-org.github.io/api/languages.json').then(r => r.ok ? r.json() : []),
    ]);
    for (const c of countries) {
      if (c.code) maps.countries[c.code.toLowerCase()] = c.name;
    }
    for (const l of languages) {
      if (l.code) maps.languages[l.code.toLowerCase()] = l.name;
    }
  } catch (e) {
    console.warn('Could not load iptv-org label maps', e);
  }
  return maps;
}

function countryLabel(code, map) {
  if (COUNTRY_ALIASES[code]) return COUNTRY_ALIASES[code];
  return map[code] || formatSlug(code);
}

function languageLabel(code, map) {
  if (code === 'undefined') return 'Undefined';
  return map[code] || formatSlug(code);
}

async function buildPlaylistManifest() {
  const [categories, countries, languages, labelMaps] = await Promise.all([
    fetchGithubM3uDir('categories'),
    fetchGithubM3uDir('countries'),
    fetchGithubM3uDir('languages'),
    fetchLabelMaps(),
  ]);

  return [
    { label: 'Main', options: [
      { value: playlistUrl('', 'index.m3u'), label: 'All channels' },
      { value: playlistUrl('', 'index.category.m3u'), label: 'All (by category)' },
      { value: playlistUrl('', 'index.country.m3u'), label: 'All (by country)' },
      { value: playlistUrl('', 'index.language.m3u'), label: 'All (by language)' },
    ]},
    { label: 'By Category', options: categories.map(f => ({
      value: playlistUrl('categories', f),
      label: formatSlug(f),
    }))},
    { label: 'By Country', options: countries.map(f => {
      const code = f.replace(/\.m3u$/i, '').toLowerCase();
      return {
        value: playlistUrl('countries', f),
        label: countryLabel(code, labelMaps.countries),
      };
    }).sort((a, b) => a.label.localeCompare(b.label))},
    { label: 'By Language', options: languages.map(f => {
      const code = f.replace(/\.m3u$/i, '').toLowerCase();
      return {
        value: playlistUrl('languages', f),
        label: languageLabel(code, labelMaps.languages),
      };
    }).sort((a, b) => a.label.localeCompare(b.label))},
  ];
}

function loadCachedManifest() {
  try {
    const raw = localStorage.getItem(LS_PLAYLIST_MANIFEST);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.fetchedAt < MANIFEST_CACHE_MS) return cached.groups;
  } catch (_) {}
  return null;
}

function saveCachedManifest(groups) {
  localStorage.setItem(LS_PLAYLIST_MANIFEST, JSON.stringify({
    fetchedAt: Date.now(),
    groups,
  }));
}

function renderBuiltinSelect(groups) {
  const select = document.getElementById('source-select');
  select.innerHTML = groups.map(g => {
    const opts = g.options.map(o =>
      `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`
    ).join('');
    return `<optgroup label="${escHtml(g.label)}">${opts}</optgroup>`;
  }).join('');
  select.disabled = false;
}

async function populateBuiltinSelect() {
  const select = document.getElementById('source-select');
  let groups = loadCachedManifest();

  if (!groups) {
    try {
      groups = await buildPlaylistManifest();
      saveCachedManifest(groups);
    } catch (e) {
      console.error('GitHub playlist index failed, using fallback', e);
      groups = FALLBACK_MANIFEST;
      showToast('Could not refresh playlist list from GitHub â€” using fallback.', true);
    }
  }

  renderBuiltinSelect(groups);

  const savedUrl = localStorage.getItem(LS_BUILTIN_URL) || DEFAULT_BUILTIN;
  const hasOption = [...select.options].some(o => o.value === savedUrl);
  select.value = hasOption ? savedUrl : DEFAULT_BUILTIN;
}

/* â”€â”€ BOOT â”€â”€ */
window.addEventListener('DOMContentLoaded', async () => {
  loadStreamStatus();
  loadFavorites();
  updateFavoritesToggle();
  updateCheckAvailabilityButton();
  updateHideBrokenToggle();
  loadCustomSources();
  renderCustomSourceList();
  await populateBuiltinSelect();
  reloadAllChannels();
});
