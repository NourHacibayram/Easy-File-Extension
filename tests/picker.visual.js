(async () => {
  const source = await fetch('../picker.html').then((response) => response.text());
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  parsed.querySelectorAll('script').forEach((script) => script.remove());
  document.body.replaceWith(parsed.body);
  document.title = 'Upload picker visual fixture';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'visual-host-close';
  close.setAttribute('aria-label', 'Close picker');
  close.textContent = '\u00d7';
  Object.assign(close.style, {
    position: 'fixed', zIndex: '20', top: '10px', right: '10px', width: '40px', height: '40px',
    display: 'grid', placeItems: 'center', padding: '0', border: '1px solid rgba(255,255,255,.12)',
    borderRadius: '11px', background: 'rgba(27,31,44,.97)', color: '#cbd5e1',
    boxShadow: '0 4px 14px rgba(0,0,0,.24)', font: '400 24px/1 system-ui,sans-serif', cursor: 'pointer'
  });
  close.addEventListener('click', () => {
    document.querySelector('.picker-shell')?.remove();
    close.remove();
    document.documentElement.dataset.closed = 'true';
  });
  document.body.appendChild(close);

  const samples = [
    ['#5b21b6', '#ec4899'], ['#0369a1', '#22d3ee'], ['#92400e', '#fbbf24'],
    ['#14532d', '#34d399'], ['#7f1d1d', '#fb7185'], ['#1e3a8a', '#818cf8'],
    ['#6d28d9', '#38bdf8'], ['#9f1239', '#f59e0b'], ['#0f766e', '#60a5fa'],
    ['#7e22ce', '#f472b6'], ['#166534', '#2dd4bf'], ['#9a3412', '#facc15']
  ];
  const clipboardImages = samples.slice(0, 9).map((colors, index) => createImageTile(colors, index));
  const protectedImages = samples.slice(9).map((colors, index) => createImageTile(colors, index + 9, true));
  const downloads = [
    ['design-export.png', 1],
    ['project-cover.webp', 4],
    ['reference-board.jpg', 7],
    ['motion-preview.mp4'],
    ['project-data.json'],
    ['brand-assets.zip']
  ].map(([name, artworkIndex]) => createDownloadTile(name, artworkIndex));

  document.getElementById('clipboard-grid').replaceChildren(...clipboardImages);
  document.getElementById('hidden-grid').replaceChildren(...protectedImages);
  document.getElementById('downloads-grid').replaceChildren(...downloads);
  document.getElementById('clipboard-count').textContent = String(clipboardImages.length);
  document.getElementById('clipboard-tab-count').textContent = String(clipboardImages.length);
  document.getElementById('hidden-count').textContent = String(protectedImages.length);
  document.getElementById('hidden-section-count').textContent = String(protectedImages.length);
  document.getElementById('downloads-count').textContent = String(downloads.length);
  document.getElementById('downloads-tab-count').textContent = String(downloads.length);

  const tabs = Array.from(document.querySelectorAll('.source-tab'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
  tabs.forEach((tab) => tab.addEventListener('click', () => activate(tab)));
  document.documentElement.dataset.visualReady = 'true';

  function activate(tab) {
    const panelId = tab.getAttribute('aria-controls');
    tabs.forEach((item) => {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.id !== panelId; });
    document.getElementById('picker-body').scrollTop = 0;
  }

  function createImageTile(colors, index, isProtected = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tile-wrap';
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.setAttribute('aria-label', `Attach image ${index + 1}`);
    const square = document.createElement('span');
    square.className = 'tile-square';
    const image = document.createElement('img');
    image.className = 'preview loaded';
    image.alt = '';
    image.src = makeArtwork(colors, index);
    square.appendChild(image);
    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = `${800 + index * 60} \u00d7 ${800 + index * 45}`;
    tile.append(square, label);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'hide-action';
    action.setAttribute('aria-label', isProtected ? 'Restore image' : 'Protect image');
    action.textContent = isProtected ? '\u21a9' : '\u25c9';
    wrapper.append(tile, action);
    return wrapper;
  }

  function createDownloadTile(name, artworkIndex) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.setAttribute('aria-label', `Attach ${name}`);
    const square = document.createElement('span');
    square.className = 'tile-square';
    if (Number.isInteger(artworkIndex)) {
      const image = document.createElement('img');
      image.className = 'preview loaded';
      image.alt = '';
      image.src = makeArtwork(samples[artworkIndex], artworkIndex);
      square.appendChild(image);
    } else {
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = name.split('.').pop();
      square.appendChild(icon);
    }
    const label = document.createElement('span');
    label.className = 'tile-label';
    label.textContent = name;
    tile.append(square, label);
    return tile;
  }

  function makeArtwork(colors, index) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
      <rect width="600" height="600" rx="60" fill="url(#g)"/><circle cx="${130 + index * 19}" cy="145" r="90" fill="white" fill-opacity=".14"/>
      <path d="M70 485 210 310l105 105 90-120 130 190" fill="none" stroke="white" stroke-opacity=".78" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
})();
