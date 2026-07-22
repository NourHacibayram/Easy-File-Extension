document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('image-grid');
  const emptyState = document.getElementById('empty-state');
  const countSpan = document.getElementById('storage-count');
  const clearBtn = document.getElementById('clear-all-btn');
  const syncBtn = document.getElementById('sync-clipboard-btn');
  const testBtn = document.getElementById('open-test-page');

  const toggleSiteBtn = document.getElementById('toggle-site-btn');
  const siteStatus = document.getElementById('site-status');
  let currentDomain = '';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].url) {
      try {
        const url = new URL(tabs[0].url);
        currentDomain = url.hostname;
        siteStatus.textContent = currentDomain ? `Active on ${currentDomain}` : 'Active on this site';
        checkDomainState();
      } catch (e) {
        siteStatus.textContent = 'Active on this site';
      }
    }
  });

  function checkDomainState() {
    if (!currentDomain) return;
    chrome.storage.local.get(['disabledDomains'], (data) => {
      const list = data.disabledDomains || [];
      const isDisabled = list.includes(currentDomain);
      if (isDisabled) {
        toggleSiteBtn.textContent = 'Disabled';
        toggleSiteBtn.classList.add('disabled');
      } else {
        toggleSiteBtn.textContent = 'Enabled';
        toggleSiteBtn.classList.remove('disabled');
      }
    });
  }

  toggleSiteBtn.addEventListener('click', () => {
    if (!currentDomain) return;
    chrome.storage.local.get(['disabledDomains'], (data) => {
      let list = data.disabledDomains || [];
      if (list.includes(currentDomain)) {
        list = list.filter(d => d !== currentDomain);
      } else {
        list.push(currentDomain);
      }
      chrome.storage.local.set({ disabledDomains: list }, () => {
        checkDomainState();
      });
    });
  });

  // On startup, check clipboard and then load images
  (async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'AUTO_CHECK_CLIPBOARD' });
    } catch (err) {
      console.warn('Auto sync on popup open failed:', err);
    }
    loadImages();
  })();

  async function loadImages() {
    const response = await chrome.runtime.sendMessage({ action: 'GET_IMAGES' });
    const images = (response && response.images) ? response.images : [];
    renderImages(images);
  }

  function renderImages(images) {
    grid.innerHTML = '';
    countSpan.textContent = `${images.length} image${images.length === 1 ? '' : 's'}`;

    if (images.length === 0) {
      grid.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    grid.style.display = 'grid';
    emptyState.style.display = 'none';

    images.forEach(img => {
      const card = document.createElement('div');
      card.className = 'card';

      card.innerHTML = `
        <button class="card-delete" title="Delete image">✕</button>
        <div class="card-img">
          <img src="${img.dataUrl}" alt="Clipboard image" />
        </div>
        <div class="card-meta">
          <span>${img.width}x${img.height}</span>
          <span>${formatTimeAgo(img.timestamp)}</span>
        </div>
      `;

      // Delete action
      const deleteBtn = card.querySelector('.card-delete');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: 'DELETE_IMAGE', id: img.id }, () => {
          loadImages();
        });
      });

      grid.appendChild(card);
    });
  }

  clearBtn.addEventListener('click', () => {
    if (confirm('Clear all saved clipboard images?')) {
      chrome.runtime.sendMessage({ action: 'CLEAR_ALL' }, () => {
        loadImages();
      });
    }
  });

  syncBtn.addEventListener('click', async () => {
    syncBtn.style.opacity = '0.6';
    try {
      let readSuccess = false;
      if (navigator.clipboard && navigator.clipboard.read) {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            for (const type of item.types) {
              if (type.startsWith('image/')) {
                const blob = await item.getType(type);
                const dataUrl = await blobToDataURL(blob);
                const meta = await getImageDimensions(dataUrl);
                const imageObj = {
                  id: 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                  dataUrl: dataUrl,
                  mimeType: type,
                  width: meta.width,
                  height: meta.height,
                  size: blob.size,
                  timestamp: Date.now()
                };
                await chrome.runtime.sendMessage({ action: 'SAVE_IMAGE', image: imageObj });
                readSuccess = true;
                break;
              }
            }
            if (readSuccess) break;
          }
        } catch (err) {
          console.warn('Popup direct clipboard read:', err);
        }
      }

      if (!readSuccess) {
        const res = await chrome.runtime.sendMessage({ action: 'FETCH_SYSTEM_CLIPBOARD' });
        if (res && res.success && res.found) readSuccess = true;
      }

      if (readSuccess) {
        loadImages();
      } else {
        showPopupToast('No image found in clipboard. Copy an image first!');
      }
    } catch (err) {
      showPopupToast('Could not access clipboard: ' + err.message);
    } finally {
      syncBtn.style.opacity = '1';
    }
  });

  function showPopupToast(text) {
    let toast = document.querySelector('.popup-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'popup-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function getImageDimensions(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = dataUrl;
    });
  }

  testBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('test.html') });
  });

  function formatTimeAgo(timestamp) {
    if (!timestamp) return 'Recently';
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
});
