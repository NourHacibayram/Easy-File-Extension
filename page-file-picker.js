// This small MAIN-world adapter sees page-owned click()/showPicker() calls,
// including inputs that were never added to the DOM. It has no extension APIs
// or gallery data. The isolated host decides whether to intercept each request.
(() => {
  const requestType = 'cip-file-picker-request';

  function requestPicker(input) {
    if (!(input instanceof HTMLInputElement) || input.type !== 'file'
        || input.disabled || input.dataset.cipBypass === 'true'
        || input.dataset.cipTemporary === 'true' || !navigator.userActivation?.isActive) return false;

    // A detached input cannot bubble an event to the isolated host. Connect it
    // synchronously in a hidden holder, then restore its exact original place.
    const originalParent = input.parentNode;
    const originalNext = input.nextSibling;
    let holder = null;
    try {
      if (!input.isConnected) {
        if (!document.documentElement) return false;
        holder = document.createElement('div');
        holder.hidden = true;
        document.documentElement.appendChild(holder);
        holder.appendChild(input);
      }
      return !input.dispatchEvent(new Event(requestType, {
        bubbles: true, composed: true, cancelable: true
      }));
    } finally {
      if (holder) {
        if (originalParent) originalParent.insertBefore(input, originalNext);
        else input.remove();
        holder.remove();
      }
    }
  }

  function wrapMethod(prototype, name) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value !== 'function') return;
    const original = descriptor.value;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: function (...args) {
        if (requestPicker(this)) return;
        return Reflect.apply(original, this, args);
      }
    });
  }

  wrapMethod(HTMLElement.prototype, 'click');
  wrapMethod(HTMLInputElement.prototype, 'showPicker');
})();
