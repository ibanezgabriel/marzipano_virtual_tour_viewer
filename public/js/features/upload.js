import { loadImages } from '../marzipano-viewer.js';
import { showAlert, showProgressDialog, hideProgressDialog, updateProgressDialog, setProgressDialogMessage } from '../dialog.js';
import { appendProjectParams } from '../project-context.js';

const addPanoEl = document.getElementById('add-scene');

export function initUpload() {
  addPanoEl.addEventListener('change', handleUpload);
}

async function handleUpload() {
  const files = addPanoEl.files;
  if (!files || files.length === 0) {
    return;
  }

  // Allowed file types
  const allowedTypes = ['image/jpeg', 'image/jpg'];

  // Filter files by allowed types
  const validFiles = Array.from(files).filter(file => allowedTypes.includes(file.type));

  if (validFiles.length === 0) {
    await showAlert(
      'Please select a valid panorama image. Only JPEG (.jpg, .jpeg) files are supported.',
      'Invalid file'
    );
    addPanoEl.value = '';
    return;
  }

  const formData = new FormData();
  for (let i = 0; i < validFiles.length; i++) {
    formData.append('panorama', validFiles[i]);
  }

  showProgressDialog('Uploading image(s)…');
  try {
    const uploadData = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', appendProjectParams('/upload'));
      xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) {
            const percent = (e.loaded / e.total) * 100;
            // Reserve 20% of the bar for upload bytes
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
        // Poll processing progress and map it to the remaining 80%
        setProgressDialogMessage('Processing image(s)…');
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
            await loadImages();
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
          await showAlert(error.message || 'Processing failed', 'Processing Error');
        }
      }, 500);
    } else {
      hideProgressDialog();
      await showAlert((uploadData && uploadData.message) || 'Error uploading images', 'Upload error');
    }
    addPanoEl.value = '';
  } catch (error) {
    hideProgressDialog();
    await showAlert('Failed to upload. Please check your connection and try again.', 'Upload error');
    addPanoEl.value = '';
  }
}
