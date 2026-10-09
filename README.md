# Clipboard & Downloads Upload Manager

A Manifest V3 extension for Chrome, Edge, and Brave that makes repeated uploads and image pasting faster. When an enabled page opens an eligible file input, the extension presents a picker containing saved clipboard images and recent browser downloads. You can also open it with **Ctrl+Shift+V** to paste a selected image or a saved prompt with optional reference images into a message editor. The native operating-system picker remains available through **Browse files**.

**Current version: 1.2.6.** Requires Chromium 111 or newer. Keeping the picker above native browser popovers requires a browser with the Popover API; older browsers use a regular page overlay.

The gallery is stored locally, loads metadata before image data, and never sends the complete gallery through one extension message.

![Dark Clipboard Gallery popup with sample image previews](docs/clipboard-gallery-popup.png)

![Dark upload picker with Clipboard, Downloads, and Protected tabs](docs/upload-picker.png)

## Main features

- **Clipboard gallery:** Keep up to 50 recent Gallery images, protect important images from automatic rotation, and restore or delete individual items.
- **On-demand clipboard sync:** Read the system clipboard only after an explicit popup action or an eligible upload interaction.
- **Recent downloads:** Show real, bounded previews for supported image and video downloads, keep clear file-type cards for other formats, and attach a selected item when its original HTTP(S) URL can be fetched safely.
- **Extension-owned upload picker:** Render the picker in an extension-origin iframe rather than in page-owned DOM.
- **Keyboard image paste:** Focus a message editor, open the picker with `Ctrl+Shift+V` (`Command+Shift+V` on macOS), and select an image to send through the editor's paste handler. Customize the shortcut in your browser's extension settings.
- **Recipes:** Save reusable prompts on their own or with up to 8 ordered reference images. Insert them from the keyboard picker, then review before generating. Recipe references are stored independently of the gallery.
- **Dark interface:** A shared charcoal theme, muted sage accent, flat tabs, and larger image previews across the popup and picker.
- **Toolbar popup:** Access quick site controls, recent clipboard items, and protected images.
- **Native fallback:** Open the normal operating-system file picker at any time with **Browse files**.
- **Programmatic upload support:** Intercept user-triggered `input.click()` and `input.showPicker()` calls, including file inputs created outside the DOM. Deliver the selected image to the original input's change handler.
- **Overlay compatibility:** Place the picker above existing browser popovers where supported, and keep clicks inside its dialog from accidentally dismissing it.
- **Large-gallery compatibility:** Migrate the previous aggregate storage format incrementally without deleting the original data before commit.

## Toolbar popup

The dark popup and upload picker share a warm charcoal palette, a muted sage accent, plain source tabs, and larger image previews. Controls, status, and gallery content have a consistent hierarchy:

- **Add from clipboard** shows a busy state while an image is read and reports whether it was saved or was already the newest item.
- The **site switch** shows the active hostname and immediately enables or disables interception on that site.
- **Gallery** and **Protected** tabs include live counts.
- Image cards expose protect/restore and delete actions without rebuilding the entire gallery.
- Clearing the gallery requires a second click on the trash button to reduce accidental deletion.
- The footer reports how many images are stored locally and links to the test uploader.

Loading has explicit visual states instead of an empty or frozen panel:

1. Initial metadata loading displays skeleton cards.
2. Existing cards remain visible during quiet refreshes.
3. Previews are requested only near the viewport, decoded, and then faded in.
4. Legacy migration displays a progress banner and partial results as records become available.
5. Recoverable failures display a message and a **Retry** action.

The first preview of an older image can take longer because its thumbnail may need to be generated. Generated thumbnails are stored separately, so later popup and picker loads do not need to read the full original merely to display a preview.

## Upload picker

The upload picker provides four areas:

- **Clipboard:** Active saved images, loaded from lightweight metadata and lazy thumbnails.
- **Downloads:** Recent entries from the browser downloads history. Supported image files and MP4/WebM/Ogg videos load small previews on demand; other files retain a clear type card.
- **Protected:** Important gallery images that do not count toward the 50 recent-image rotation limit, loaded only when that section is opened.
- **Recipes:** Saved prompts, optionally accompanied by reference images. Use them when the picker is opened with the keyboard shortcut; an upload file input cannot receive a prompt.

When opened by a website's upload button, choosing an item attaches it to that upload action's original file input. When opened with the keyboard shortcut, choosing an image sends it to the message editor's paste handler.

Click **Select multiple** (or hold `Ctrl`/`Cmd`/`Shift` while clicking) to choose multiple images and downloads, then attach them all together with **Attach selected**. Press `Esc`, use the close button, or click outside the picker to dismiss it. Use **Browse files** when a website requires the native picker or a recent download cannot be fetched.

### Paste an image into a conversation

1. Click inside the conversation's message field.
2. Press **Ctrl+Shift+V** (or **Command+Shift+V** on macOS).
3. Select an image from **Clipboard**, **Downloads**, or **Protected**.
4. Wait for the conversation to display the attached image before sending your message.

The shortcut sends a file through a clipboard paste event; it does not replace the system clipboard. A handled paste is sent once, without a duplicate drop. If the editor does not accept paste, the extension tries its drop handler. If neither accepts the file, the picker stays open and shows an error. Use the site's upload button in that case.

### Save and reuse prompts or reference setups

1. Open the toolbar popup and click **Recipes ↗**.
2. Enter a name and your prompt. **Images are optional**: save immediately for a prompt-only recipe, or select up to 8 images from your gallery. Use the arrows beside selected references to set their order.
3. Click **Save recipe**. Open a saved recipe to edit it; **Cancel changes** restores its saved version. Deleting requires a second confirmation click.
4. Click the conversation's message field, press **Ctrl+Shift+V**, open **Recipes**, and click **Use recipe**.
5. Review the inserted prompt and any attachments before sending or generating.

Up to 40 recipes are stored locally, each with a prompt of up to 16,000 characters. Reference originals are copied into separate recipe records, so gallery rotation, image deletion and **Clear all** do not remove them. Deleting a recipe removes its copies and keeps the gallery originals.

Prompt-only recipes do not load or send image files. Recipes with references load originals two at a time, retain their saved order and send the images together through the editor's paste handler (or drop fallback), followed by the prompt. Text is inserted at the remembered caret through the editor's paste handler, native rich-text editing or a textarea input update. Existing text is retained; nothing is sent or generated automatically. A partial failure stays visible in the picker; retrying the same recipe during that opening does not duplicate references that were already accepted. This prevents duplicate local delivery; acceptance of an event is not proof that a site's server finished processing an attachment.

After a successful insertion, the toolbar popup shows **Last recipe**. Expand it to see **Connect** (picker-to-page relay), **Prepare** (recipe lookup, original reads and file conversion), and **Editor** (synchronous file and text delivery). Version 1.2.4 additionally breaks Editor down into **Files** (image paste/drop handlers), **Prompt** (text paste/native insertion), and **Focus** (focusing the editor and restoring the caret). This local measurement ends when the editor's handlers return; it does not wait for the site's network upload or attachment preview. Only the latest numeric timings, timestamp, image count and delivered byte count are stored under `lastRecipeTimingV1`, with no prompt, image, recipe name or website information. Nothing is transmitted for diagnostics.

For recipes with images on Gemini's `rich-textarea .ql-editor`, version 1.2.5 inserts the prompt using native text editing first, retaining selection, undo and input notifications. If that operation is unavailable, the previous text-paste handler remains the fallback. Image delivery, prompt-only recipes and other sites retain their existing behavior.

Version 1.2.6 prepares the original files, then inserts the prompt before delivering images on Gemini. Other sites keep images before the prompt. Each accepted part is remembered during that picker opening, so retrying after a failed image delivery does not repeat an already inserted prompt. A failed prompt on Gemini leaves pending images undelivered. The local timing also records the fixed delivery-order and insertion-method labels; no user content is included.

## Data and message architecture

Images are no longer kept in one large `clipboardImages` array. The current format uses:

- a small metadata index for ordering, dimensions, timestamps, and protected state;
- one storage record per original image;
- one separate, bounded storage record per generated thumbnail.

The UI uses a bounded protocol:

- `GET_IMAGE_LIST` returns metadata only;
- `GET_IMAGE_THUMBNAIL` returns one bounded preview;
- `GET_DOWNLOAD_THUMBNAIL` returns one bounded preview for a supported image download;
- `GET_IMAGE_DATA` returns one original only after it is selected.

Recipe names, prompts and reference metadata live in `savedRecipesV1`. Each copied original lives in its own `recipeImageV1:<recipeId>:<imageId>` record. Bounded previews are stored separately under `recipeImageThumbV1:<recipeId>:<imageId>`, so reopening recipe covers does not load the full originals. Existing 1.2.0 previews are copied to the separate cache on their first request, without replacing the original or regenerating an available preview. Failed saves and reference deletion clean up both kinds of record.

The manager and picker read recipe lists only from trusted extension contexts. The content script can request a recipe and its individual originals only after a validated picker relay authorizes that recipe for its current tab and session. New snapshots commit before recipe metadata; failed saves roll back new copies and preserve the previous recipe. Where available, Chromium's native Base64 decoder converts selected images directly into bytes; older browsers keep the compatible decoding path. Image contents and resolution are preserved.

New images are limited to 6 MiB after preparation. Thumbnails are bounded separately. This design avoids Chrome's 64 MiB extension-message ceiling even when the total local gallery is much larger.

```mermaid
sequenceDiagram
    participant Page as Web page
    participant Host as content.js
    participant Picker as Extension picker iframe
    participant Worker as background.js
    participant Offscreen as offscreen.js

    alt Website opens an eligible file input
        Page->>Host: Trusted upload interaction
    else User opens the keyboard picker
        Worker->>Host: TOGGLE_PICKER command
        Note over Host: Remember the message editor
    end
    Host->>Picker: Open iframe with per-open token
    Picker->>Worker: GET_IMAGE_LIST / GET_RECENT_DOWNLOADS
    Worker-->>Picker: Metadata only
    Picker->>Worker: GET_IMAGE_THUMBNAIL for visible items
    Worker-->>Picker: One bounded thumbnail
    Picker->>Worker: GET_DOWNLOAD_THUMBNAIL for visible image downloads
    Worker-->>Picker: One bounded download preview
    Host->>Worker: Authorized on-demand clipboard check
    Worker->>Offscreen: Read and prepare clipboard image
    Offscreen-->>Worker: One prepared image

    alt User selects a saved image
        Picker->>Host: Selected image ID
        Host->>Worker: GET_IMAGE_DATA for that ID
        Worker-->>Host: One original image
        Host->>Page: File input change or editor paste
    else User selects a recent download
        Picker->>Host: Validated download ID
        Host->>Worker: FETCH_DOWNLOAD_DATA
        Worker-->>Host: Bounded file data
        Host->>Page: File input change or editor paste
    else User chooses Browse files
        Picker->>Host: Native-picker request
        Host->>Page: Open native file picker
    end
```

### On-demand clipboard flow

Manifest V3 service workers do not have a normal DOM clipboard context. For a permitted sync, the worker temporarily creates [`offscreen.html`](offscreen.html), reads the clipboard in that document, prepares one image, saves it, and closes the offscreen document. There is no continuous focus, copy, or clipboard polling on web pages.

### Resumable legacy migration

Older versions stored all images in one aggregate value. On upgrade, the worker:

1. records migration intent and progress;
2. copies a small batch of records to separate image keys;
3. checkpoints after each copied record;
4. commits the new metadata index;
5. removes the old aggregate only after the new index has committed.

If the popup closes or the Manifest V3 worker is suspended, migration resumes from the last checkpoint the next time the gallery is requested. The popup shows **Optimizing your gallery** while this runs. Keep it open for the fastest completion, but an interruption does not require starting over.

## Picker security model

The picker is a web-accessible extension page because it must appear over the current website, but it is not rendered in the website's light DOM:

- `content.js` places it inside a **closed shadow root** as an extension-origin iframe.
- Each opening receives a random 128-bit capability token.
- Host/picker messages validate the iframe window, extension origin, parent origin, token, and message shape.
- Automatic clipboard reads require a short-lived, one-use session bound to the originating browser tab.
- Picker actions require trusted user events.
- The original clipboard image is requested only after the user selects its ID; the host page then receives only the explicitly selected file.
- Extension storage is restricted to trusted extension contexts where the browser supports `storage.local.setAccessLevel`.

Gallery processing stays on the device. The extension contains no telemetry. Selecting a recent download can make a network request to that download's original HTTP(S) URL; responses are size-limited, and the native picker is the fallback. Incognito use is disabled by the manifest.

## Repository structure

- [`manifest.json`](manifest.json): Manifest V3 configuration, permissions, content scripts, and picker resources.
- [`background.js`](background.js): Service worker for storage, migration, bounded messages, downloads, badges, and picker-session authorization.
- [`content.js`](content.js) and [`content.css`](content.css): Trusted upload interception, picker iframe host, message validation, and file attachment.
- [`ui-theme.css`](ui-theme.css): Shared dark palette, typography, and interface tokens for the popup and picker.
- [`page-file-picker.js`](page-file-picker.js): Small page-world adapter for programmatic file pickers; no extension APIs or gallery access.
- [`picker.html`](picker.html), [`picker.js`](picker.js), and [`picker.css`](picker.css): Extension-origin upload picker.
- [`popup.html`](popup.html), [`popup.js`](popup.js), and [`popup.css`](popup.css): Toolbar popup, gallery management, loading states, and site control.
- [`recipes.html`](recipes.html), [`recipes.js`](recipes.js), and [`recipes.css`](recipes.css): Local prompt and reference manager, editing and reference ordering.
- [`offscreen.html`](offscreen.html) and [`offscreen.js`](offscreen.js): Temporary clipboard and image-processing DOM context.
- [`test.html`](test.html) and [`test.js`](test.js): Local upload-integration test page.
- [`tests/background.protocol.test.js`](tests/background.protocol.test.js): Message-size and thumbnail-storage regression coverage.
- [`tests/background.recipes.test.js`](tests/background.recipes.test.js): Prompt-only recipes, independent snapshots, failure rollback, limits and selected-session access.
- [`tests/background.migration.test.js`](tests/background.migration.test.js): Restart, failure, collision, cleanup, and migration recovery coverage.
- [`tests/background.download-preview.test.js`](tests/background.download-preview.test.js): Download-preview limits, caching, sender validation, and type fallback coverage.
- [`tests/picker.relay.test.js`](tests/picker.relay.test.js): Picker Close/selection relay, deduplication, fast-click, and worker-restart coverage.
- [`tests/content.upload.browser.test.js`](tests/content.upload.browser.test.js): Real Chromium DOM tests across page and isolated worlds, with mocked extension transport.
- [`tests/extension.upload.browser.test.js`](tests/extension.upload.browser.test.js): Actual unpacked-extension tests for upload inputs, Flow-style popovers, shortcut paste, and exact selected file bytes.
- [`tests/extension.recipes.browser.test.js`](tests/extension.recipes.browser.test.js): Actual recipe manager and picker tests, prompt-only insertion, caret preservation, reference order, parallel reads and partial-failure retry.
- [`tests/render-ui.js`](tests/render-ui.js): Desktop and compact UI preview rendering.

## Installation

Chrome 111 or newer is required.

1. Clone or download this repository.
2. Open the browser's extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder named `Image clipboard`.
6. Optionally pin the extension to the toolbar.
7. Refresh any already-open websites before testing upload interception.

### Reloading after a source update

Reloading a Manifest V3 extension does not replace content scripts that are already injected into open tabs.

1. Open the browser's extensions page and click **Reload** on this extension.
2. Close and reopen the toolbar popup.
3. Hard-refresh every open site where the extension is used (`Ctrl+Shift+R`), including Flow, ChatGPT, and Gemini tabs. If necessary, close and reopen the tab.
4. Open the popup and let any **Optimizing your gallery** progress finish.

Do not uninstall the extension or clear its storage as a troubleshooting step if the gallery matters; uninstalling an unpacked extension can remove the storage associated with its extension ID.

## Troubleshooting

### `Message exceeded maximum allowed size of 64MiB`

The current UI never requests the whole gallery in one message. Seeing this error after updating almost always means an old `content.js` is still running in a tab or an older unpacked copy of the extension is still enabled.

1. Reload the extension from `chrome://extensions`, `brave://extensions`, or `edge://extensions`.
2. Hard-refresh **every** open page on which the extension ran. A normal extension reload alone is not enough.
3. Close and reopen the popup.
4. Clear the DevTools console before reproducing; existing console entries remain visible after a successful reload.
5. Check the extensions page for a second older unpacked copy. Disable the duplicate rather than uninstalling the copy that owns your gallery.
6. Keep the popup open while a legacy gallery migration is progressing, then retry the upload.

A fresh occurrence from a current tab should return a small `REFRESH_REQUIRED` response rather than transferring the old aggregate gallery.

### The popup is loading slowly after an upgrade

Keep it open while the migration progress banner advances. Migrated cards appear progressively. The first view of an image may also generate a thumbnail; later views use the separate thumbnail cache.

### The popup reports that the extension was updated

Close and reopen the popup, then refresh the affected website tab. This replaces invalidated extension contexts.

### Clipboard sync finds no image

Copy an actual bitmap image, then click **Add from clipboard** again. Plain text, a filesystem path, or a copied filename is not an image clipboard item. Browser clipboard policies require the explicit user action.

### The picker does not open

- Confirm the popup says the extension is enabled on the current hostname.
- Refresh the page after loading or reloading the extension.
- Try the included **Test uploader** page.
- Browser-internal pages such as `chrome://` and extension-store pages do not allow normal content-script injection.

### A recent download cannot be attached

The browser history entry may point to an expired, authenticated, local, or oversized resource. Use **Browse files** and select the downloaded file from the native picker.

### Google Flow: upload buttons and conversation paste

Enable the extension on `flow.google.com`, reload it after updating, and hard-refresh Flow. Its toolbar upload, prompt attachment menu, and keyboard paste use different paths:

| Action | How to use it | Extension behavior |
| --- | --- | --- |
| Toolbar upload | Open the top-right **Add media** menu and choose **Upload**. | Deliver the selected file to Flow's temporary file input. |
| Prompt attachment menu | Open **Add ingredients to the prompt box → Upload media**. | Keep the picker above Flow's native popover so its pending uploader remains alive. |
| Paste into the conversation | Click the message field, then press **Ctrl+Shift+V** and choose an image. | Send the image through the editor's clipboard paste handler, without reusing an earlier upload input. |

If another component covers the picker, confirm you are running **1.2.6**, then reload the extension and refresh Flow. A normal `z-index` cannot appear above a native browser popover; the current picker uses the browser's top layer where available. Clicks inside its closed-shadow dialog also stay separate from backdrop dismissal.

The toolbar upload was confirmed working by the user, and the corrected layer ordering was observed on the live Flow page. Automated tests pass for toolbar uploads, the prompt-menu lifecycle, and shortcut paste using a local fixture modeled on Flow's inspected upload and image-paste handlers. End-to-end image attachment through the prompt menu and **Ctrl+Shift+V** on the live authenticated Flow page still needs user confirmation; the automated fixture is not that confirmation.

Recipes have been tested with the actual unpacked extension against local editors, including separate image and text paste handlers, plain rich-text fields and textareas. Live Flow recipe insertion and upload-processing time still require confirmation on the authenticated site.

### Recipe insertion is slow on Gemini

The current version is 1.2.6. Image delivery retains the paste-first behavior restored in 1.2.3. The 1.2.2 drop-first path was reported to close the picker without attaching the image and has been reverted: cancellation of a drop event did not establish that Gemini accepted the file.

After using a recipe, expand **Last recipe** in the toolbar popup. A high **Prepare** value points to local loading/conversion; a high **Editor** value points to synchronous page handlers. If all three values are short but the attachment takes seconds to appear, that later processing is outside the measured insertion. Paste-first delivery, fallback, original bytes, retry behavior and timings are verified using an offline fixture with the actual unpacked extension in Brave. The fixture also checks that a drop zone which cancels events without attaching files does not take priority over a working paste handler. Live Gemini latency remains unresolved; the fixture does not measure Google's upload service.

A live user measurement on 1.2.3 showed 0.01s Connect, 0.01s Prepare and 3.63s Editor for one image. The more detailed 1.2.4 measurement showed 0.01s Files, 3.23s Prompt and 0.00s Focus, isolating the delay to prompt insertion after image delivery. Version 1.2.5 bypasses that text-paste handler using native text editing in Gemini's inspected rich-text editor, with paste as a fallback. The offline tests check native multiline insertion, selection replacement, undo, input notifications and fallback when native insertion is unavailable. Improvement on the live authenticated site still requires confirmation.

Live measurements on 1.2.5 still showed 3.57s Prompt. Version 1.2.6 reported **Prompt first · native**, with 3.82s Prompt and 0.02s Files, so neither native insertion nor changing delivery order resolved the delay. Work stopped at the user's request, with 1.2.6 retained and the later experimental insertion change reverted. Gemini latency remains unresolved.

### Compatibility limits

Browser-internal pages, upload widgets inside child frames, File System Access API pickers, and sites requiring trusted native change or paste events may require the site's native upload flow. The keyboard picker needs a message editor that accepts image paste or file drop; opening the gallery does not by itself guarantee attachment.

## Development checks

From the repository directory:

```powershell
node --check background.js
node --check content.js
node --check page-file-picker.js
node --check picker.js
node --check popup.js
node --check recipes.js
node --check offscreen.js
Get-ChildItem tests -Filter '*.test.js' |
    Where-Object { $_.Name -notlike '*browser.test.js' } |
    ForEach-Object {
        node $_.FullName
        if ($LASTEXITCODE -ne 0) { throw "Failed: $($_.Name)" }
    }
```

With Playwright available:

```powershell
node tests/content.upload.browser.test.js
node tests/extension.upload.browser.test.js
node tests/extension.recipes.browser.test.js
node tests/render-ui.js
```

- The content-script browser test uses real Chromium DOM and separate page/isolated worlds with mocked extension transport. It covers detached inputs, native fallback, pointer and keyboard activation, site disabling, and paste into the focused editor after a prior upload.
- The full extension test loads the unpacked extension in a disposable profile and exercises its actual picker, service worker, and file delivery. It checks Flow-style native popovers, shortcut paste, exact selected image bytes, and backdrop dismissal. It requires a recent Chrome build supporting DevTools `Extensions.loadUnpacked`; its debugging flag applies only to the temporary test profile.
- The recipe browser test uses another disposable profile to check actual create/save/use flows, independent copies after gallery clearing, exact bytes and order, two simultaneous original reads, prompt-only insertion at the caret and retry without duplicate references. It verifies that warm recipe covers read no original records, then measures delivery of an image larger than 4 MiB and compares SHA-256 hashes to confirm that the original is preserved. An offline Gemini fixture checks paste-first delivery despite misleading drop cancellation, drop fallback, rejected-file retry and local stage timings. Timings exclude any live site's processing or network upload time. It also saves desktop, compact recipe and timing-popup previews under `tmp/ui-preview`.
- The UI renderer saves desktop and compact previews under `tmp/ui-preview`.

Set `CHROMIUM_EXECUTABLE_PATH` when using an installed Chrome instead of Playwright's bundled browser; use `NODE_PATH` if Playwright is supplied by a separate workspace runtime. These checks do not upload files to a live Flow account.
