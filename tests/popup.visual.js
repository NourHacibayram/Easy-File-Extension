(async () => {
  const response = await fetch('../popup.html');
  const source = await response.text();
  const parsed = new DOMParser().parseFromString(source, 'text/html');

  document.body.replaceWith(parsed.body);
  document.title = 'Clipboard Gallery popup preview';

  const byId = (id) => document.getElementById(id);
  byId('site-status').textContent = 'example.com';
  byId('clear-all-btn').disabled = false;
  byId('active-count').textContent = '6';
  byId('hidden-count').textContent = '2';
  byId('storage-count').textContent = '8 images saved locally';
  byId('skeleton-grid').hidden = true;
  byId('empty-state').hidden = true;
  byId('status-banner').hidden = true;
  byId('gallery-spinner').hidden = true;

  const colors = [
    ['#5b21b6', '#ec4899'],
    ['#0369a1', '#22d3ee'],
    ['#92400e', '#fbbf24'],
    ['#14532d', '#34d399'],
    ['#7f1d1d', '#fb7185'],
    ['#1e3a8a', '#818cf8']
  ];
  const grid = byId('image-grid');
  grid.hidden = false;
  grid.replaceChildren(...colors.map(createCard));

  await Promise.all(Array.from(grid.images).map((image) => image.decode().catch(() => {})));
  document.documentElement.dataset.visualReady = 'true';

  function createCard(pair, index) {
    const card = document.createElement('article');
    card.className = 'card';

    const previewContainer = document.createElement('div');
    previewContainer.className = 'card-img is-ready';
    const preview = document.createElement('img');
    preview.className = 'card-preview is-ready';
    preview.alt = `Example gallery image ${index + 1}`;
    preview.src = createSample(pair, index);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.innerHTML = `
      <button class="card-action card-hide" type="button" aria-label="Protect image">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.7"/></svg>
      </button>
      <button class="card-action card-delete" type="button" aria-label="Delete image">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V4.75M15 7V4.75M6.5 7l.75 12h9.5l.75-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>`;
    previewContainer.append(preview, actions);

    const metadata = document.createElement('div');
    metadata.className = 'card-meta';
    metadata.innerHTML = `<span class="card-dimensions">${800 + index * 160} × ${600 + index * 90}</span><span class="card-time">${index === 0 ? 'Just now' : `${index}h ago`}</span>`;
    card.append(previewContainer, metadata);
    return card;
  }

  function createSample(pair, index) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${pair[0]}"/><stop offset="1" stop-color="${pair[1]}"/></linearGradient></defs>
      <rect width="600" height="400" fill="url(#g)"/>
      <circle cx="${100 + index * 48}" cy="${105 + index * 22}" r="74" fill="white" fill-opacity=".16"/>
      <path d="M55 335l115-135 92 88 82-105 205 152" fill="none" stroke="white" stroke-opacity=".72" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
})();
