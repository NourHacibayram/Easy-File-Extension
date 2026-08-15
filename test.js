if (typeof document !== 'undefined') {
  function setupInputListener(inputId, previewId, thumbId, nameId, detailsId) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    const thumb = document.getElementById(thumbId);
    const name = document.getElementById(nameId);
    const details = document.getElementById(detailsId);
    if (!input || !preview) return;

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (name) name.textContent = file.name;
      if (details) details.textContent = `${(file.size / 1024).toFixed(1)} KB | ${file.type || 'image'}`;

      const reader = new FileReader();
      reader.onload = (event) => {
        if (thumb) thumb.src = event.target.result;
        preview.classList.add('active');
      };
      reader.readAsDataURL(file);
    });
  }

  function setupMultiInputListener(inputId, previewId, containerId) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    const container = document.getElementById(containerId);
    if (!input || !preview || !container) return;

    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      if (files.length === 0) return;

      container.replaceChildren();
      preview.classList.add('active');

      files.forEach((file) => {
        const itemBox = document.createElement('div');
        itemBox.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,0.06);border-radius:10px;border:1px solid rgba(255,255,255,0.1);min-width:220px;';

        const thumb = document.createElement('img');
        thumb.style.cssText = 'width:44px;height:44px;border-radius:8px;object-fit:cover;background:#000;';

        const info = document.createElement('div');
        info.innerHTML = `<h5 style="font-size:0.85rem;margin:0 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;">${file.name}</h5><span style="font-size:0.75rem;color:#94a3b8;">${(file.size / 1024).toFixed(1)} KB</span>`;

        itemBox.append(thumb, info);
        container.appendChild(itemBox);

        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = (e) => { thumb.src = e.target.result; };
          reader.readAsDataURL(file);
        } else {
          thumb.style.display = 'none';
        }
      });
    });
  }

  setupInputListener('input-demo-1', 'preview-1', 'thumb-1', 'name-1', 'details-1');
  setupInputListener('input-demo-2', 'preview-2', 'thumb-2', 'name-2', 'details-2');
  setupMultiInputListener('input-demo-3', 'preview-3', 'multi-preview-container');
}
