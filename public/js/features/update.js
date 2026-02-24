import { getSelectedImageName, loadImages, loadPanorama, clearCurrentPath } from '../marzipano-viewer.js';
import { cleanupHotspotsForDeletedImages } from './hotspots.js';
import { showAlert, showProgressDialog, hideProgressDialog, updateProgressDialog, setProgressDialogMessage } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

const updateBtnEl = document.getElementById('pano-update-btn');

export function initUpdate() {
  updateBtnEl.addEventListener('click', handleUpdate);
}

async function handleUpdate() {
  const selectedImageName = getSelectedImageName();
  if (!selectedImageName) {
    await showAlert('Please select an image to update.', 'Update');
    return;
  }

  const updateInput = document.createElement('input');
  updateInput.type = 'file';
  updateInput.accept = 'image/*';
  updateInput.style.display = 'none';

  updateInput.addEventListener('change', async () => {
    const file = updateInput.files[0];
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append('panorama', file);
    formData.append('oldFilename', selectedImageName);

    // Find the corresponding <li> and show updating text
    const imageListEl = document.getElementById('pano-image-list');
    let updatingLi = null;
    if (imageListEl) {
      updatingLi = Array.from(imageListEl.children).find(
        li => li.textContent === selectedImageName
      );
      if (updatingLi) {
        updatingLi.dataset.originalText = updatingLi.textContent;
        updatingLi.textContent = 'Updating image…';
      }
    }

    showProgressDialog('Uploading new image…');
    try {
      const uploadData = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', appendProjectParams('/upload/update'));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) {
            const percent = (e.loaded / e.total) * 100;
            const overall = Math.max(0, Math.min(20, Math.round((percent / 100) * 20)));
            updateProgressDialog(overall);
          }
        };
        xhr.onload = () => {
          try {
            const json = JSON.parse(xhr.responseText || '{}');
            resolve(json);
          } catch (e) {
            reject(e);
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      if (uploadData && uploadData.success && uploadData.jobId) {
        setProgressDialogMessage('Processing tiles…');
        const jobId = uploadData.jobId;
        
        // Poll job status with proper async handling
        const pollJobStatus = async () => {
          try {
            const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
            if (!res.ok) throw new Error('Failed to check processing status');
            const job = await res.json();
            
            if (job.status === 'error') {
              throw new Error(job.error || 'Processing failed');
            }
            
            if (job.status === 'done') {
              updateProgressDialog(100);
              hideProgressDialog();
              clearCurrentPath();
              await loadImages(cleanupHotspotsForDeletedImages);
              return true; // Done
            } else {
              const p = typeof job.percent === 'number' ? job.percent : 0;
              const overall = 20 + Math.round((Math.max(0, Math.min(100, p)) / 100) * 80);
              updateProgressDialog(overall);
              return false; // Continue polling
            }
          } catch (error) {
            throw new Error(`Job polling failed: ${error.message}`);
          }
        };
        
        // Start polling with interval
        const pollInterval = setInterval(async () => {
          try {
            const isDone = await pollJobStatus();
            if (isDone) {
              clearInterval(pollInterval);
            }
          } catch (error) {
            clearInterval(pollInterval);
            hideProgressDialog();
            if (updatingLi && updatingLi.dataset.originalText) {
              updatingLi.textContent = updatingLi.dataset.originalText;
              delete updatingLi.dataset.originalText;
            }
            await showAlert(error.message || 'Processing failed', 'Processing Error');
          }
        }, 500);
      } else {
        hideProgressDialog();
        if (updatingLi && updatingLi.dataset.originalText) {
          updatingLi.textContent = updatingLi.dataset.originalText;
          delete updatingLi.dataset.originalText;
        }
        await showAlert('Error updating image: ' + (uploadData && uploadData.message), 'Update');
      }
    } catch (error) {
      hideProgressDialog();
      if (updatingLi && updatingLi.dataset.originalText) {
        updatingLi.textContent = updatingLi.dataset.originalText;
        delete updatingLi.dataset.originalText;
      }
      await showAlert('Error updating image: ' + error, 'Update');
    }

    document.body.removeChild(updateInput);
  });

  document.body.appendChild(updateInput);
  updateInput.click();
}
