function setupInputListener(inputId, previewId, thumbId, nameId, detailsId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const thumb = document.getElementById(thumbId);
  const name = document.getElementById(nameId);
  const details = document.getElementById(detailsId);

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    name.textContent = file.name;
    details.textContent = `${(file.size / 1024).toFixed(1)} KB | ${file.type || 'image'}`;

    const reader = new FileReader();
    reader.onload = (event) => {
      thumb.src = event.target.result;
      preview.classList.add('active');
    };
    reader.readAsDataURL(file);
  });
}

setupInputListener('input-demo-1', 'preview-1', 'thumb-1', 'name-1', 'details-1');
setupInputListener('input-demo-2', 'preview-2', 'thumb-2', 'name-2', 'details-2');
