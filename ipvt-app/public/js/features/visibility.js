/* Toggles panorama visibility (hide/unhide) in the editor. */
import { loadImages, loadPanorama } from '../marzipano-viewer.js';
import { showAlert, showTimedAlert } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';
import { reloadHotspots } from './hotspots.js';
import { layoutApi } from './layouts.js';

export function initVisibility() {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pano-action="visibility"]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const li = button.closest('#pano-image-list li');
    const filename = li?.dataset?.filename;
    if (!filename) return;

    try {
      await loadPanorama(filename);
    } catch (_e) {}

    const currentlyHidden = li?.dataset?.hidden === '1';
    const nextHidden = !currentlyHidden;

    try {
      const res = await fetch(appendProjectParams('/api/panos/visibility'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, hidden: nextHidden }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.success !== true) {
        const msg = (data && (data.message || data.error)) ? (data.message || data.error) : `Server responded with ${res.status}`;
        await showAlert(`Unable to update visibility: ${msg}`, 'Visibility');
        return;
      }

      await loadImages();
      try { await reloadHotspots(); } catch (_e) {}
      try { await layoutApi.reloadHotspots(); } catch (_e) {}

      await showTimedAlert(nextHidden ? 'Panorama hidden.' : 'Panorama unhidden.', 'Visibility', 400);
    } catch (error) {
      await showAlert('Unable to update visibility: ' + (error?.message || error), 'Visibility');
    }
  });
}

