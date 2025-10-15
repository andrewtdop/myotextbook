(() => {
  const $modal   = document.getElementById('export-modal');
  const $msg     = document.getElementById('export-message');
  const $bar     = document.getElementById('export-bar');
  const $pct     = document.getElementById('export-percent');
  const $err     = document.getElementById('export-error');
  const $actions = document.getElementById('export-actions');
  const $dl      = document.getElementById('export-download');
  const $close   = document.getElementById('export-close');

  let es = null; // EventSource

  function showModal()   { $modal.classList.remove('hidden'); $modal.classList.add('flex'); }
  function hideModal()   { $modal.classList.remove('flex');   $modal.classList.add('hidden'); }
  function setMessage(t) { $msg.textContent = t || ''; }
  function setError(t)   { if (!t) { $err.classList.add('hidden'); $err.textContent=''; } else { $err.classList.remove('hidden'); $err.textContent = t; } }
  function setPct(cur, total) {
    const pct = Math.max(0, Math.min(100, Math.round((cur / Math.max(1,total)) * 100)));
    $bar.style.width = pct + '%';
    $pct.textContent = pct + '%';
  }
  function resetUI() {
    setMessage('Starting…');
    setError('');
    setPct(0, 100);
    $actions.classList.add('hidden');
    $dl.removeAttribute('href');
    $dl.removeAttribute('download');
  }

  // Public function you can call from buttons:
  // startExport(projectId, format = 'pdf', options = { showPageNumbers: true, includeToc: true })
  async function startExport(projectId, format = 'pdf', options = {}) {
    if (!projectId) { alert('Missing project id'); return; }

    // defaults
    const body = {
      format,
      showPageNumbers: options.showPageNumbers !== false,
      includeToc: options.includeToc !== false
    };

    resetUI();
    showModal();

    let jobId;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!r.ok) throw new Error(await r.text());
      ({ jobId } = await r.json());
      if (!jobId) throw new Error('No job id returned');
    } catch (e) {
      setError('Failed to start export: ' + (e.message || e));
      return;
    }

    // Subscribe to progress SSE
    if (es) { try { es.close(); } catch {} }
    es = new EventSource(`/api/progress/${encodeURIComponent(jobId)}`);

    es.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }

      const { step = 0, total = 1, message = '', done = false, error = '', output } = data;
      setMessage(message);
      setPct(step, total);

      if (error) {
        setError(error);
      }

      if (done) {
        es.close();
        es = null;

        if (output && !error) {
          // Show Download button
          const href = `/api/download?path=${encodeURIComponent(output)}`;
          $dl.href = href;
          $dl.download = output.split('/').pop() || 'export';
          $actions.classList.remove('hidden');

          // Auto-download after a short tick (optional; comment out if you prefer manual)
          setTimeout(() => {
            const a = document.createElement('a');
            a.href = href;
            a.download = $dl.download;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }, 350);
        }
      }
    };

    es.onerror = () => {
      // If the stream errors out, keep the modal but indicate reconnect suggestion
      setError('Lost connection to progress stream. If it does not finish, try again.');
      try { es.close(); } catch {}
      es = null;
    };
  }

  // Optional: close button (won’t cancel the job; just hides the modal)
  $close?.addEventListener('click', () => {
    hideModal();
    if (es) { try { es.close(); } catch {} es = null; }
  });

  // Expose globally for inline onclick or other scripts
  window.startExport = startExport;
})();
