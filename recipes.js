(() => {
  const $ = id => document.getElementById(id);
  let recipes = [];
  let gallery = [];
  let current = null;
  let selected = [];
  let offset = 0;
  let dirty = false;
  let busy = false;
  let deleteArmed = false;
  let previewVersion = 0;
  const previews = new Map();

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.success) throw new Error(response?.error || 'The extension was updated. Reload this page.');
    return response;
  }
  function status(text, error = false) {
    $('recipe-status').textContent = text;
    $('recipe-status').dataset.kind = error ? 'error' : 'success';
  }
  function changed() {
    dirty = true; deleteArmed = false; $('delete-recipe').textContent = 'Delete recipe';
    $('saved-state').textContent = 'Unsaved changes'; status('');
  }
  function editable() {
    if (busy) return false;
    if (dirty) { status('Save or cancel your changes before opening another recipe.', true); return false; }
    return true;
  }
  function open(recipe = null) {
    current = recipe; selected = recipe ? recipe.images.map(image => image.id) : [];
    $('recipe-name').value = recipe?.name || ''; $('recipe-prompt').value = recipe?.prompt || '';
    $('editor-title').textContent = recipe ? 'Edit recipe' : 'New recipe';
    $('saved-state').textContent = recipe ? 'Saved locally' : 'Unsaved';
    $('delete-recipe').hidden = !recipe;
    $('delete-recipe').textContent = 'Delete recipe';
    dirty = false; deleteArmed = false; status(''); renderLibrary(); renderGallery();
  }
  function renderLibrary() {
    const list = $('saved-recipes'); list.replaceChildren();
    if (!recipes.length) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Your first recipe starts here.'; list.append(note); }
    recipes.forEach(recipe => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'saved-recipe';
      button.setAttribute('aria-current', String(current?.id === recipe.id));
      const title = document.createElement('strong'); title.textContent = recipe.name;
      const count = document.createElement('span'); count.textContent = recipe.images.length
        ? `${recipe.images.length} reference${recipe.images.length === 1 ? '' : 's'} · saved prompt` : 'Prompt only';
      button.append(title, count); button.addEventListener('click', () => { if (editable()) open(recipe); });
      list.append(button);
    });
  }
  async function loadGallery(reset = false) {
    const response = await request({ action: 'GET_IMAGE_LIST', offset: reset ? 0 : offset, limit: 50 });
    if (reset) gallery = [];
    for (const image of response.images) if (!gallery.some(item => item.id === image.id)) gallery.push(image);
    offset = (reset ? 0 : offset) + response.images.length;
    $('more-images').hidden = !response.hasMore;
    renderGallery();
  }
  function renderSelection() {
    $('reference-count').textContent = `${selected.length} / 8`;
    const list = $('selected-references'); list.replaceChildren();
    selected.forEach((id, index) => {
      const item = document.createElement('li');
      const preview = document.createElement('img'); preview.alt = '';
      const saved = current?.images.some(image => image.id === id);
      const cacheKey = saved ? `${current.id}:${id}` : id;
      preview.dataset.previewKey = cacheKey;
      if (previews.has(cacheKey)) preview.src = previews.get(cacheKey);
      const label = document.createElement('span'); label.textContent = `Reference ${index + 1}`;
      const earlier = document.createElement('button'); earlier.type = 'button'; earlier.textContent = '←'; earlier.disabled = index === 0;
      earlier.setAttribute('aria-label', `Move reference ${index + 1} earlier`);
      earlier.addEventListener('click', () => { [selected[index - 1], selected[index]] = [selected[index], selected[index - 1]]; changed(); renderGallery(); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove reference ${index + 1}`);
      remove.addEventListener('click', () => { selected = selected.filter(imageId => imageId !== id); changed(); renderGallery(); });
      item.append(preview, label, earlier, remove); list.append(item);
    });
  }
  function renderGallery() {
    renderSelection();
    const grid = $('reference-gallery'); grid.replaceChildren();
    const choices = [...(current?.images || []), ...gallery].filter((image, index, all) => all.findIndex(item => item.id === image.id) === index);
    const jobs = [];
    for (const [index, image] of choices.entries()) {
      const label = document.createElement('label'); label.className = 'reference-choice';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.includes(image.id);
      checkbox.setAttribute('aria-label', `Reference image ${index + 1}, ${image.width || 0} by ${image.height || 0}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked && selected.length === 8) { checkbox.checked = false; status('A recipe can contain up to 8 references.', true); return; }
        selected = checkbox.checked ? [...selected, image.id] : selected.filter(id => id !== image.id);
        changed(); renderGallery();
      });
      const preview = document.createElement('img'); preview.alt = ''; preview.loading = 'lazy';
      const saved = current?.images.some(item => item.id === image.id);
      const cacheKey = saved ? `${current.id}:${image.id}` : image.id;
      if (previews.has(cacheKey)) preview.src = previews.get(cacheKey);
      else jobs.push({ preview, image, recipeId: saved ? current.id : '', cacheKey });
      label.append(preview, checkbox); grid.append(label);
    }
    if (!choices.length) grid.textContent = 'No gallery images yet. You can save this prompt on its own.';
    loadPreviews(jobs, ++previewVersion);
  }
  async function loadPreviews(jobs, version) {
    let next = 0;
    await Promise.all([0, 1].map(async () => {
      while (next < jobs.length && version === previewVersion) {
        const job = jobs[next++];
        try {
          const response = await request(job.recipeId
            ? { action: 'GET_RECIPE_THUMBNAIL', recipeId: job.recipeId, imageId: job.image.id }
            : { action: 'GET_IMAGE_THUMBNAIL', id: job.image.id });
          if (response.thumbnailDataUrl?.startsWith('data:image/')) {
            previews.set(job.cacheKey, response.thumbnailDataUrl);
            if (previews.size > 120) previews.delete(previews.keys().next().value);
            if (job.preview.isConnected) job.preview.src = response.thumbnailDataUrl;
            document.querySelectorAll('#selected-references img').forEach(preview => {
              if (preview.dataset.previewKey === job.cacheKey) preview.src = response.thumbnailDataUrl;
            });
          }
        } catch (error) { /* Keep the selectable placeholder if a preview fails. */ }
      }
    }));
  }
  function setBusy(value) {
    busy = value;
    $('recipe-form').querySelectorAll('button, input, textarea').forEach(element => element.disabled = value);
    $('new-recipe').disabled = value;
    $('save-recipe').textContent = value ? 'Saving…' : 'Save recipe';
    if (!value) renderSelection();
  }
  $('recipe-form').addEventListener('input', changed);
  $('new-recipe').addEventListener('click', () => { if (editable()) { open(); $('recipe-name').focus(); } });
  $('cancel-edit').addEventListener('click', () => { if (!busy) open(current); });
  $('more-images').addEventListener('click', () => loadGallery().catch(error => status(error.message, true)));
  $('add-clipboard').addEventListener('click', async () => {
    $('add-clipboard').disabled = true;
    try {
      const result = await request({ action: 'FETCH_SYSTEM_CLIPBOARD' });
      if (!result.found) throw new Error('Copy an image first, then add it here.');
      await loadGallery(true); status('Image added to your gallery. Select it below.');
    } catch (error) { status(error.message, true); }
    finally { $('add-clipboard').disabled = false; }
  });
  $('recipe-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); status(selected.length ? 'Saving your recipe and reference copies…' : 'Saving your prompt…');
    try {
      const response = await request({ action: 'SAVE_RECIPE', recipe: { id: current?.id,
        name: $('recipe-name').value, prompt: $('recipe-prompt').value, imageIds: selected } });
      recipes = [response.recipe, ...recipes.filter(recipe => recipe.id !== response.recipe.id)];
      open(response.recipe); status('Saved. Open Ctrl+Shift+V in your message field, then choose Recipes.');
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  });
  $('delete-recipe').addEventListener('click', async () => {
    if (!current || busy) return;
    if (!deleteArmed) { deleteArmed = true; $('delete-recipe').textContent = 'Confirm delete'; return status('Click Confirm delete to remove this recipe and its saved reference copies.', true); }
    setBusy(true);
    try {
      await request({ action: 'DELETE_RECIPE', recipeId: current.id });
      recipes = recipes.filter(recipe => recipe.id !== current.id); open(); status('Recipe deleted. Your gallery images were kept.');
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  });
  (async () => {
    try { recipes = (await request({ action: 'GET_RECIPES' })).recipes; renderLibrary(); await loadGallery(true); }
    catch (error) { status(error.message, true); }
  })();
})();
