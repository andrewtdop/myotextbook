// ===================== helpers =====================
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error || j.detail || text; } catch {}
    throw new Error(`${res.status} ${res.statusText}: ${msg}`);
  }
  try { return JSON.parse(text); } catch { return {}; }
}
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const el = (t, props={}, ...kids) => {
  const n = Object.assign(document.createElement(t), props);
  kids.flat().forEach(k => n.append(k));
  return n;
};
function badge(txt){ return el("span",{className:"badge",textContent:txt}); }

function getExportOptions() {
  return {
    includeToc: !!optToc?.checked,
    showPageNumbers: !!optPageNumbers?.checked
  };
}

// ===================== state & element refs =====================
let currentProject = null;
let sortableInstance = null;
let _allProjects = []; // dashboard cache for filtering
let currentUser = null;

async function refreshMe() {
  currentUser = await fetchJSON("/api/me").catch(()=>null);
  
  // Toggle admin button
  const addUserBtn = $("#addUserBtn");
  if (addUserBtn) addUserBtn.classList.toggle("hidden", !(currentUser?.is_admin));
  
  // Toggle UI elements based on authentication status
  updateUIForAuthStatus();
}

function updateUIForAuthStatus() {
  const isLoggedIn = !!currentUser;
  
  // Hide/show elements based on auth status
  const newProjectBtn = $("#newProjectBtn");
  const saveProjectBtn = $("#saveProjectBtn");
  const addContentForm = $("#addContentForm");
  const commentForm = $("#commentForm");
  
  // For anonymous users, hide creation/editing features
  if (newProjectBtn) newProjectBtn.style.display = isLoggedIn ? 'block' : 'none';
  if (saveProjectBtn) saveProjectBtn.style.display = isLoggedIn ? 'block' : 'none';
  if (addContentForm) addContentForm.style.display = isLoggedIn ? 'block' : 'none';
  if (commentForm) commentForm.style.display = isLoggedIn ? 'block' : 'none';
  
  // Note: Copy & Edit button visibility is handled separately in openProject()
  // based on project ownership logic
  
  // Show login prompt for anonymous users in project view
  showLoginPrompts(!isLoggedIn);
}

function showLoginPrompts(show) {
  // Remove existing login prompts
  document.querySelectorAll('.login-prompt').forEach(el => el.remove());
  
  if (!show) return;
  
  // Add login prompt to editor section
  const editorSection = $("#editor");
  if (editorSection && !editorSection.classList.contains('hidden')) {
    const prompt = document.createElement('div');
    prompt.className = 'login-prompt bg-gray-50 border border-gray-200 rounded p-4 mb-4';
    prompt.innerHTML = `
      <div class="flex items-center gap-2">
        <svg class="w-5 h-5 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"></path>
        </svg>
        <div>
          <p class="text-gray-800 font-medium">Login Required</p>
          <p class="text-gray-700 text-sm">You can view and export this project, but you need to <strong>log in</strong> to edit, comment, or create projects.</p>
        </div>
      </div>
    `;
    
    // Insert at the top of editor section - safer approach
    if (editorSection.firstChild) {
      editorSection.insertBefore(prompt, editorSection.firstChild);
    } else {
      editorSection.appendChild(prompt);
    }
  }
}

// Dashboard
const projectsSection = $("#projects");
const projectList     = $("#projectList");   // <tbody>
const projectEmpty    = $("#projectEmpty");
const projectSearch   = $("#projectSearch");
const newProjectBtn   = $("#newProjectBtn");

// Editor
const editorSection   = $("#editor");
const backBtn         = $("#backBtn");
const projectName     = $("#projectName");
const projectKeywords = $("#projectKeywords");
const saveProjectBtn  = $("#saveProjectBtn");
const editorEl        = $("#editor");

// Add content (unified form)
const addContentForm  = $("#addContentForm");
const kindSelect      = $("#kindSelect");
const titleInput      = $("#titleInput");
const urlRow          = $("#urlRow");
const urlInput        = $("#urlInput");
const fileInput       = $("#fileInput");
const headingInput    = $("#headingInput");

// Export
const optToc          = $("#optToc");
const optPageNumbers  = $("#optPageNumbers");
const exportPdfBtn    = $("#btnExportPdf");
const exportEpubBtn   = $("#btnExportEpub");

// Items table
const itemsTbody      = $("#itemsTbody");

// Global error visibility (handy while iterating)
window.addEventListener("error", e => console.error("Uncaught:", e.error || e.message));
window.addEventListener("unhandledrejection", e => console.error("Unhandled:", e.reason));

// ===================== boot =====================
window.addEventListener("DOMContentLoaded", () => {
  init().catch(e => { console.error(e); alert("Init failed: " + e.message); });
  // Bind logout button
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/";
    });
  }
});

async function init() {
  await refreshMe();
  await refreshProjectList();
  bindGlobalUI();
  bindKindUI(); // make sure URL row is correct on load
  // Always refresh dashboard after login/logout
  window.addEventListener("login", async () => {
    await refreshMe();
    await refreshProjectList();
  });
  window.addEventListener("logout", async () => {
    await refreshMe();
    await refreshProjectList();
  });
}

// ===================== keywords utils =====================
function getKeywordsFromOptions(opts) {
  const k = (opts && Array.isArray(opts.keywords)) ? opts.keywords : [];
  return k.map(s => String(s || "").trim()).filter(Boolean);
}
function parseKeywordsCSV(csv) {
  return (csv || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

// ===================== access requests (admin) =====================
async function loadAccessRequests() {
  try {
    const requests = await fetchJSON("/api/access-requests");
    const section = $("#accessRequestsSection");
    const list = $("#accessRequestsList");
    const noRequests = $("#noAccessRequests");
    
    if (!section || !list) return;
    
    // Show section for admins
    section.classList.remove("hidden");
    
    if (!requests || requests.length === 0) {
      list.innerHTML = "";
      noRequests?.classList.remove("hidden");
      return;
    }
    
    noRequests?.classList.add("hidden");
    
    list.innerHTML = requests.map(req => `
      <div class="border rounded p-3 bg-gray-50" data-request-id="${req.id}">
        <div class="flex items-start justify-between mb-2">
          <div>
            <div class="font-semibold">${req.first_name} ${req.last_name}</div>
            <div class="text-sm text-gray-600">${req.email}</div>
            ${req.affiliation ? `<div class="text-sm text-gray-600">${req.affiliation}</div>` : ''}
          </div>
          <div class="text-xs text-gray-500">
            ${new Date(req.created_at).toLocaleDateString()}
          </div>
        </div>
        <div class="flex gap-2 justify-end">
          <button class="decline-request px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-100 text-sm" data-id="${req.id}">
            Decline
          </button>
          <button class="approve-request px-3 py-1.5 rounded bg-green-600 hover:bg-green-700 text-white text-sm" data-id="${req.id}">
            Approve
          </button>
        </div>
      </div>
    `).join('');
    
    // Add event listeners
    list.querySelectorAll('.approve-request').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        if (confirm('Approve this access request? The user will receive an email with login credentials.')) {
          try {
            await fetchJSON(`/api/access-requests/${id}/approve`, { method: 'POST' });
            alert('Request approved! User will receive an email with credentials.');
            await loadAccessRequests();
          } catch (err) {
            alert('Error: ' + err.message);
          }
        }
      });
    });
    
    list.querySelectorAll('.decline-request').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        if (confirm('Decline this access request? The user will be notified via email.')) {
          try {
            await fetchJSON(`/api/access-requests/${id}/decline`, { method: 'POST' });
            alert('Request declined. User has been notified.');
            await loadAccessRequests();
          } catch (err) {
            alert('Error: ' + err.message);
          }
        }
      });
    });
  } catch (err) {
    console.error('Failed to load access requests:', err);
  }
}

// ===================== dashboard =====================
async function refreshProjectList() {
  await refreshMe();
  _allProjects = await fetchJSON("/api/projects");
  renderProjectList(_allProjects, projectSearch?.value || "");
}

function renderProjectList(rows, query) {
  if (!projectList) return;

  const q = (query || "").toLowerCase().trim();
  projectList.innerHTML = "";

  const filtered = rows.filter(p => {
    const name = (p.name || "").toLowerCase();
    const kws = getKeywordsFromOptions(p.options || {}).join(", ").toLowerCase();
    return !q || name.includes(q) || kws.includes(q);
  });

  if (!filtered.length) {
    projectEmpty?.classList.remove("hidden");
    return;
  }
  projectEmpty?.classList.add("hidden");

  filtered.forEach(p => {
    const created = new Date(p.created_at || Date.now()).toLocaleString?.() || "";
    const updated = new Date(p.updated_at || p.created_at || Date.now()).toLocaleString?.() || "";
    const kws = getKeywordsFromOptions(p.options || {}).join(", ");
    const owner = p.author_username || "—";

    const tr = el("tr", { className: "border-t border-gray-200 hover:bg-gray-50" });

    tr.append(
      el("td", { className: "p-2 align-top" },
        el("button", {
          className: "text-left w-full font-semibold text-red-600 hover:underline",
          onclick: () => openProject(p.id)
        }, p.name || "(Untitled)")
      ),
      el("td", { className: "p-2 align-top text-gray-700" }, created),
      el("td", { className: "p-2 align-top text-gray-700" }, updated),
      el("td", { className: "p-2 align-top text-gray-800 break-words" }, kws || "—"),
      el("td", { className: "p-2 align-top text-gray-700" }, owner),
      (() => {
        const td = el("td", { className: "p-2 align-top flex gap-1" });
        td.append(
          el("button", {
            className: "px-2 py-1 rounded bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-xs",
            onclick: () => openProject(p.id)
          }, "Open")
        );
        if (currentUser?.is_admin) {
          td.append(
            el("button", {
              className: "px-2 py-1 rounded bg-gray-300 hover:bg-gray-400 text-black text-xs",
              onclick: async (e) => {
                e.stopPropagation();
                if (confirm("Are you sure you want to delete this project?")) {
                  try {
                    console.log("Attempting to delete project", p.id);
                    const resp = await fetchJSON(`/api/projects/${p.id}`, { method: "DELETE" });
                    console.log("Delete response:", resp);
                    await refreshProjectList();
                    alert("Project deleted.");
                  } catch (err) {
                    console.error("Delete failed:", err);
                    alert("Delete failed: " + err.message);
                  }
                }
              }
            }, "Delete")
          );
        }
        return td;
      })()
    );

    projectList.append(tr);
  });
}

// ===================== navigation =====================
async function openProject(id){
  try{
    const p = await fetchJSON(`/api/projects/${id}`);
    currentProject = p;

    if (projectName)     projectName.value = p.name || "";
    if (projectKeywords) projectKeywords.value = getKeywordsFromOptions(p.options).join(", ");
    if (optToc)          optToc.checked = (p.options?.includeToc !== false);
    if (optPageNumbers)  optPageNumbers.checked = (p.options?.showPageNumbers !== false);

    projectsSection?.classList.add("hidden");
    editorSection?.classList.remove("hidden");
    if (editorEl) editorEl.dataset.projectId = p.id;

    // --- NEW: meta strip (version/owner), copy button visibility, version log ---
    const meta = $("#projectMeta");
    if (meta) meta.textContent = `Version: ${p.version_text || 'v1'}  ·  Owner: ${p.author_username || 'andrew'}`;

    await refreshMe();
    const copyBtn = $("#copyEditBtn");
    if (copyBtn) copyBtn.classList.toggle("hidden", !currentUser || currentUser.username === (p.author_username || 'andrew'));

    const tbody = $("#versionLogTbody");
    if (tbody) {
      let rows = await fetchJSON(`/api/projects/${id}/version-log`).catch(()=>[]);
      // If this is a copy and the first log is not the original, prepend the original
      if (rows.length && rows[0].action === "copy" && rows[0].from_version === null) {
        // Fetch original project info
        const proj = await fetchJSON(`/api/projects/${id}`).catch(()=>null);
        if (proj && proj.parent_project_id) {
          // Fetch parent version log
          const parentRows = await fetchJSON(`/api/projects/${proj.parent_project_id}/version-log`).catch(()=>[]);
          if (parentRows.length) {
            // Find the original creation log
            const orig = parentRows.find(r => r.action === "create");
            if (orig) rows = [orig, ...rows];
          }
        }
      }
      tbody.innerHTML = "";
      for (const r of rows) {
        const tr = el("tr", { className:"border-t" });
        tr.append(
          el("td",{className:"p-2"}, new Date(r.created_at).toLocaleString()),
          el("td",{className:"p-2"}, r.actor_username),
          el("td",{className:"p-2"}, r.action),
          el("td",{className:"p-2"}, `${r.from_version || '—'} → ${r.to_version}`)
        );
        tbody.append(tr);
      }
    }
    
    // Load comments
    await loadComments(id);
    // ---------------------------------------------------------------------------

    await renderItems();
    ensureSortable();
  }catch(e){
    console.error(e);
    alert("Failed to open project: " + e.message);
  }
}

function goToProjects() {
  currentProject = null;
  editorSection?.classList.add("hidden");
  projectsSection?.classList.remove("hidden");
  refreshProjectList().catch(console.error);
}

// ===================== bindings =====================
function bindGlobalUI(){
  // New project
  newProjectBtn?.addEventListener("click", async () => {
    if (!currentUser) {
      alert("Please log in to create projects");
      return;
    }
    const name = prompt("Name your project:", "Untitled Project");
    if (name == null) return;
    const p = await fetchJSON("/api/projects", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ name, options:{ showPageNumbers:true, includeToc:true, keywords: [] } })
    });
    await refreshProjectList();
    await openProject(p.id);
  });

  // Copy & Edit
  $("#copyEditBtn")?.addEventListener("click", async ()=>{
    if (!currentProject) return;
    await refreshMe();
    if (!currentUser) {
      alert("Please login first (Profile → Login).");
      return;
    }
    try {
      const j = await fetchJSON(`/api/projects/${currentProject.id}/copy`, { method:"POST" });
      await openProject(j.id);
      alert("Copy created. You can now edit your version.");
    } catch (err) { alert("Copy failed: " + err.message); }
  });

  // Profile button -> if not logged in, show login; else show profile
  $("#profileBtn")?.addEventListener("click", async ()=>{
    await refreshMe();
    if (!currentUser) {
      $("#loginModal")?.classList.remove("hidden");
      $("#loginModal")?.classList.add("flex");
      return;
    }
    // populate profile form
    const prof = await fetchJSON("/api/profile").catch(()=>null);
    const f = $("#profileForm");
    if (f && prof) {
      f.first_name.value = prof.first_name||"";
      f.last_name.value  = prof.last_name||"";
      f.affiliation.value= prof.affiliation||"";
      f.email.value      = prof.email||"";
      f.password.value   = "";
    }
    
    // If admin, load pending access requests
    if (currentUser.is_admin) {
      await loadAccessRequests();
    }
    
    $("#profileModal")?.classList.remove("hidden");
    $("#profileModal")?.classList.add("flex");
  });

  $("#profileClose")?.addEventListener("click", ()=>{
    $("#profileModal")?.classList.add("hidden");
    $("#profileModal")?.classList.remove("flex");
  });

  $("#loginClose")?.addEventListener("click", ()=>{
    $("#loginModal")?.classList.add("hidden");
    $("#loginModal")?.classList.remove("flex");
  });

  $("#loginForm")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
        try {
          await fetchJSON("/api/auth/login", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
          $("#loginModal")?.classList.add("hidden"); $("#loginModal")?.classList.remove("flex");
          await refreshMe();
          await refreshProjectList();
          alert("Logged in.");
        } catch (err) { alert(err.message); }
  });

  $("#profileForm")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      await fetchJSON("/api/profile", { method:"PUT", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      $("#profileModal")?.classList.add("hidden"); $("#profileModal")?.classList.remove("flex");
      await refreshMe();
      alert("Profile saved.");
    } catch (err) { alert(err.message); }
  });

  // Request Access modal handlers
  $("#requestAccessBtn")?.addEventListener("click", ()=>{
    $("#loginModal")?.classList.add("hidden");
    $("#loginModal")?.classList.remove("flex");
    $("#requestAccessModal")?.classList.remove("hidden");
    $("#requestAccessModal")?.classList.add("flex");
  });

  $("#requestAccessClose")?.addEventListener("click", ()=>{
    $("#requestAccessModal")?.classList.add("hidden");
    $("#requestAccessModal")?.classList.remove("flex");
  });

  $("#requestAccessForm")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    try {
      await fetchJSON("/api/access-request", { 
        method:"POST", 
        headers:{ "Content-Type":"application/json" }, 
        body: JSON.stringify(body) 
      });
      $("#requestAccessModal")?.classList.add("hidden");
      $("#requestAccessModal")?.classList.remove("flex");
      $("#requestAccessForm").reset();
      alert("Access request submitted! You'll receive an email if your request is approved.");
    } catch (err) { 
      alert("Error: " + err.message); 
    }
  });

  // Admin: Add User
  $("#addUserBtn")?.addEventListener("click", ()=>{
    $("#addUserModal")?.classList.remove("hidden");
    $("#addUserModal")?.classList.add("flex");
    // Reset to single user tab
    showSingleUserTab();
  });
  $("#addUserClose")?.addEventListener("click", ()=>{
    $("#addUserModal")?.classList.add("hidden");
    $("#addUserModal")?.classList.remove("flex");
  });
  $("#bulkUploadClose")?.addEventListener("click", ()=>{
    $("#addUserModal")?.classList.add("hidden");
    $("#addUserModal")?.classList.remove("flex");
  });
  
  // Tab switching for Add User modal
  function showSingleUserTab() {
    $("#addUserForm")?.classList.remove("hidden");
    $("#bulkUploadForm")?.classList.add("hidden");
    $("#singleUserTab")?.classList.add("border-red-600", "text-red-600", "font-semibold");
    $("#singleUserTab")?.classList.remove("text-gray-600");
    $("#bulkUploadTab")?.classList.remove("border-red-600", "text-red-600", "font-semibold");
    $("#bulkUploadTab")?.classList.add("text-gray-600");
    $("#bulkUploadStatus")?.classList.add("hidden");
  }
  
  function showBulkUploadTab() {
    $("#addUserForm")?.classList.add("hidden");
    $("#bulkUploadForm")?.classList.remove("hidden");
    $("#bulkUploadTab")?.classList.add("border-red-600", "text-red-600", "font-semibold");
    $("#bulkUploadTab")?.classList.remove("text-gray-600");
    $("#singleUserTab")?.classList.remove("border-red-600", "text-red-600", "font-semibold");
    $("#singleUserTab")?.classList.add("text-gray-600");
  }
  
  $("#singleUserTab")?.addEventListener("click", showSingleUserTab);
  $("#bulkUploadTab")?.addEventListener("click", showBulkUploadTab);
  
  // Single user form submission
  $("#addUserForm")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.is_admin = !!fd.get("is_admin");
    try {
      await fetchJSON("/api/admin/users", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
      $("#addUserModal")?.classList.add("hidden"); $("#addUserModal")?.classList.remove("flex");
      alert("User created.");
      e.target.reset();
    } catch (err) { alert(err.message); }
  });
  
  // Bulk CSV upload form submission
  $("#bulkUploadForm")?.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const statusDiv = $("#bulkUploadStatus");
    
    try {
      if (statusDiv) {
        statusDiv.textContent = "Uploading and processing CSV...";
        statusDiv.className = "text-gray-700 bg-gray-100 p-2 rounded";
        statusDiv.classList.remove("hidden");
      }
      
      const res = await fetch("/api/admin/users/bulk", { method: "POST", body: fd });
      const result = await res.json();
      
      if (!res.ok) {
        throw new Error(result.error || "Upload failed");
      }
      
      if (statusDiv) {
        let msg = `✓ ${result.message}\n`;
        if (result.results?.errors?.length > 0) {
          msg += `\nErrors/Warnings:\n${result.results.errors.join('\n')}`;
        }
        statusDiv.textContent = msg;
        statusDiv.className = "text-green-700 bg-green-50 p-3 rounded border border-green-200 whitespace-pre-wrap text-sm";
      }
      
      e.target.reset();
      
      // Auto-close after 3 seconds if no errors
      if (!result.results?.errors?.length) {
        setTimeout(() => {
          $("#addUserModal")?.classList.add("hidden");
          $("#addUserModal")?.classList.remove("flex");
        }, 3000);
      }
    } catch (err) {
      console.error("Bulk upload error:", err);
      if (statusDiv) {
        statusDiv.textContent = `✗ Error: ${err.message}`;
        statusDiv.className = "text-red-700 bg-red-50 p-2 rounded border border-red-200";
      }
    }
  });

  // Save project (name + options + keywords)
  saveProjectBtn?.addEventListener("click", async () => {
    if (!currentUser) {
      alert("Please log in to save projects");
      return;
    }
    if (!currentProject) return;

    const keywordsCsv = parseKeywordsCSV(projectKeywords?.value);

    await fetchJSON(`/api/projects/${currentProject.id}`, {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        name: projectName?.value?.trim() || "Untitled Project",
        options: {
          includeToc: !!optToc?.checked,
          showPageNumbers: !!optPageNumbers?.checked,
          keywords: keywordsCsv
        }
      })
    });

    alert("Project saved successfully!");
  });

  // Back
  backBtn?.addEventListener("click", (e) => { e.preventDefault(); goToProjects(); });

  // Live search
  projectSearch?.addEventListener("input", () => {
    renderProjectList(_allProjects, projectSearch.value);
  });

  // Unified Add Content form
  addContentForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUser) {
      alert("Please log in to add content");
      return;
    }
    if (!currentProject) return;

    const fd       = new FormData(addContentForm);
    const kind     = (fd.get("kind") || "url").toLowerCase();     // url | wikipedia | image | file | heading | titlepage
    const title    = (fd.get("title") || "").trim();
    const url      = (fd.get("url") || "").trim();
    const file     = fd.get("file");
    const subtitle = (fd.get("subtitle") || "").trim();

    try {
      // 1) Heading
      if (kind === "heading") {
        if (!title) return alert("Please provide a heading title.");
        await fetchJSON(`/api/projects/${currentProject.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "heading", title })
        });
        addContentForm.reset();
        kindSelect.value = "url";
        bindKindUI();
        await refreshProjectState();
        return;
      }

      // 2) Title Page
      if (kind === "titlepage") {
        await fetchJSON(`/api/projects/${currentProject.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "titlepage", title, options: { subtitle } })
        });
        addContentForm.reset();
        kindSelect.value = "url";
        bindKindUI();
        await refreshProjectState();
        return;
      }

      // 3) Otherwise, process by kind
      if (kind === "image") {
        // Prefer file if provided; else expect a URL
        if (file && file.size > 0) {
          if (!file.type?.startsWith("image/")) {
            return alert("Please choose an image file for the Image type.");
          }
          const up = new FormData();
          up.append("file", file);
          if (title) up.append("title", title);
          up.append("options", JSON.stringify({ caption: title || "", widthPct: 80 }));

          const res = await fetch(`/api/projects/${currentProject.id}/items/upload`, {
            method: "POST",
            body: up
          });
          if (!res.ok) throw new Error(await res.text());
        } else {
          if (!url) return alert("Please provide an image URL.");
          await fetchJSON(`/api/projects/${currentProject.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "image",
              title,
              url,
              options: { caption: title || "", widthPct: 80 }
            })
          });
        }

      } else if (kind === "file") {
        // DOCX / PDF / Image upload
        if (!(file && file.size > 0)) return alert("Please choose a file.");
        const up = new FormData();
        up.append("file", file);
        if (title) up.append("title", title);
        if (file.type?.startsWith("image/")) {
          up.append("options", JSON.stringify({ caption: title || "", widthPct: 80 }));
        }
        const res = await fetch(`/api/projects/${currentProject.id}/items/upload`, {
          method: "POST",
          body: up
        });
        if (!res.ok) throw new Error(await res.text());

      } else {
        // url / wikipedia
        if (!url) return alert("Please provide a URL.");
        const cacheContent = kind === "url" && document.getElementById("cacheContentCheckbox")?.checked;
        await fetchJSON(`/api/projects/${currentProject.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: (kind === "wikipedia" ? "wikipedia" : "url"),
            title,
            url,
            cacheContent
          })
        });
      }

      addContentForm.reset();
      kindSelect.value = "url";
      bindKindUI();
      await refreshProjectState();
    } catch (err) {
      console.error(err);
      alert("Add failed: " + err.message);
    }
  });

  // Export (progress modal + SSE)
  exportPdfBtn?.addEventListener("click", () => {
    const id = editorEl?.dataset?.projectId || currentProject?.id;
    if (!id) return alert("No active project selected.");
    window.startExport(id, "pdf", getExportOptions());
  });

  exportEpubBtn?.addEventListener("click", () => {
    const id = editorEl?.dataset?.projectId || currentProject?.id;
    if (!id) return alert("No active project selected.");
    window.startExport(id, "epub", getExportOptions());
  });

  const exportMarkdownBtn = $("#btnExportMarkdown");
  exportMarkdownBtn?.addEventListener("click", () => {
    const id = editorEl?.dataset?.projectId || currentProject?.id;
    if (!id) return alert("No active project selected.");
    window.startExport(id, "markdown", getExportOptions());
  });
}

// Toggle URL row & placeholder based on kind
function bindKindUI() {
  if (!kindSelect) return;
  const subtitleRow = $("#subtitleRow");
  const fileRow = $("#fileRow");
  const cacheRow = $("#cacheRow");
  const apply = () => {
    const k = (kindSelect.value || "url").toLowerCase();
    // Hide URL row for: file, heading, titlepage
    if (urlRow) urlRow.classList.toggle("hidden", k === "file" || k === "heading" || k === "titlepage");
    // Hide file row for: heading, titlepage
    if (fileRow) fileRow.classList.toggle("hidden", k === "heading" || k === "titlepage");
    // Show subtitle only for titlepage
    if (subtitleRow) subtitleRow.classList.toggle("hidden", k !== "titlepage");
    // Show cache checkbox only for URL type (not Wikipedia)
    if (cacheRow) cacheRow.classList.toggle("hidden", k !== "url");
    // Update URL placeholder
    if (urlInput) {
      urlInput.placeholder = (k === "image") ? "Image URL (https://...)" : "URL (https://...)";
    }
  };
  kindSelect.addEventListener("change", apply);
  apply();
}

// ===================== project state refresh =====================
async function refreshProjectState(){
  if(!currentProject) return;
  currentProject = await fetchJSON(`/api/projects/${currentProject.id}`);
  await renderItems();
  ensureSortable();
}

// ===================== export (legacy direct download — unused with modal, kept for reference) =====================
async function doExport(format){
  if(!currentProject) return;
  const res = await fetch(`/api/projects/${currentProject.id}/export`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      format,
      includeToc: !!optToc?.checked,
      showPageNumbers: !!optPageNumbers?.checked
    })
  });
  if(!res.ok){ const t = await res.text(); return alert("Export failed: " + t); }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition")||"";
  const m = /filename="?([^"]+)"?/i.exec(cd);
  const filename = m ? m[1] : `export.${format}`;
  const url = URL.createObjectURL(blob);
  const a = el("a",{href:url,download:filename});
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ===================== items rendering =====================
function iconForType(t){
  const map = { heading:"HEADING", url:"URL", wikipedia:"WIKI", docx:"DOCX", pdf:"PDF", image:"IMAGE", titlepage:"TITLE" };
  return badge(map[t] || t?.toUpperCase?.() || "");
}

function makeEditableText(value, placeholder, onSave){
  const wrap = el("div",{className:"cell"});
  const view = el("div",{className:"cell-view",textContent:value||"",title:"Click to edit"});
  if(!value) view.classList.add("text-gray-400");
  const input = el("input",{className:"cell-input hidden",value,placeholder});
  const finish = async (commit)=>{
    view.classList.remove("hidden"); input.classList.add("hidden");
    if(commit && input.value !== value){
      await onSave(input.value);
      view.textContent = input.value;
      view.classList.toggle("text-gray-400", !input.value);
      value = input.value;
    }
  };
  view.addEventListener("click",()=>{ input.classList.remove("hidden"); view.classList.add("hidden"); input.focus(); input.select(); });
  input.addEventListener("keydown",(e)=>{ if(e.key==="Enter") finish(true); if(e.key==="Escape") finish(false); });
  input.addEventListener("blur",()=>finish(true));
  wrap.append(view,input);
  return wrap;
}

async function saveItemPartial(it, patch){
  await fetchJSON(`/api/projects/${currentProject.id}/items/${it.id}`,{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(patch)
  });
}

async function renderItems(){
  if (!itemsTbody) return;
  itemsTbody.innerHTML = "";
  const items = currentProject?.items || [];
  if(!items.length){
    itemsTbody.append(el("tr",{}, el("td",{colSpan:6,className:"p-3 text-gray-500"},"No items yet.")));
    return;
  }

  items.forEach((it, idx)=>{
    const tr = document.createElement("tr");
    tr.className = "border-t border-gray-200 hover:bg-gray-50";
    tr.dataset.id = it.id;  // for Sortable.toArray()
    tr.id = it.id;          // extra safety

    // drag handle + index
    const dragTd = document.createElement("td");
    dragTd.className = "p-2 align-top";
    dragTd.append(
      el("span", {
        className:"drag-handle select-none cursor-move text-gray-600 px-2 py-1 inline-block rounded hover:bg-gray-200",
        title:"Drag to reorder"
      }, "≡"),
      el("span", {className:"text-gray-500 ml-2"}, String(idx+1))
    );
    tr.appendChild(dragTd);

    // title
    const titleTd = document.createElement("td");
    titleTd.className = "align-top";
    if (it.type === "titlepage") {
      titleTd.append(makeEditableText(it.title||"","Title Page",(v)=>saveItemPartial(it,{title:(v||"").trim()||"Untitled"})));
    } else {
      titleTd.append(makeEditableText(it.title||"","Title",(v)=>saveItemPartial(it,{title:(v||"").trim()||"Untitled"})));
    }
    tr.appendChild(titleTd);

    // type
    const typeTd = document.createElement("td");
    typeTd.className = "p-2 align-top";
    typeTd.append(iconForType(it.type === "titlepage" ? "titlepage" : it.type));
    tr.appendChild(typeTd);

    // url/file + image opts
    const refTd = document.createElement("td");
    refTd.className = "p-2 align-top space-y-1";
    if (it.type === "url" || it.type === "wikipedia" || (it.type === "image" && it.source_url)) {
      refTd.append(
        makeEditableText(it.source_url||"","https://...", (v)=>saveItemPartial(it,{source_url:(v||"").trim()||null}))
      );
    } else if (it.local_path) {
      refTd.append(el("div",{className:"text-xs text-gray-500 break-all"}, it.local_path));
    }
    if (it.type === "titlepage") {
      const opts = it.options || {};
      const subLbl = el("div",{className:"text-xs text-gray-600"},"Subtitle:");
      const subEdit = makeEditableText(opts.subtitle||"","optional subtitle",(v)=>saveItemPartial(it,{options:{subtitle:v||""}}));
      refTd.append(subLbl,subEdit);
    }
    if (it.type === "image") {
      const opts = it.options || {};
      const capLbl = el("div",{className:"text-xs text-gray-600"},"Caption:");
      const capEdit = makeEditableText(opts.caption||"","optional caption",(v)=>saveItemPartial(it,{options:{caption:v}}));
      const widthWrap = el("div",{className:"cell"});
      const widthLbl = el("div",{className:"text-xs text-gray-600"},"Width %:");
      const widthInput = el("input",{className:"cell-input",type:"number",min:10,max:100,value:Number(opts.widthPct||80)});
      widthInput.addEventListener("blur", async ()=>{
        const n = Math.min(100, Math.max(10, Number(widthInput.value||80)));
        if (n !== Number(opts.widthPct||80)) await saveItemPartial(it,{options:{widthPct:n}});
      });
      widthInput.addEventListener("keydown",(e)=>{ if(e.key==="Enter"||e.key==="Escape") widthInput.blur(); });
      widthWrap.append(widthLbl,widthInput);
      refTd.append(capLbl,capEdit,widthWrap);
    }
    tr.appendChild(refTd);

    // cached column (only for URL type)
    const cachedTd = document.createElement("td");
    cachedTd.className = "p-2 align-top text-center";
    if (it.type === "url") {
      const checkbox = el("input", {
        type: "checkbox",
        className: "accent-red-600 cursor-pointer",
        checked: it.cached_content ? true : false,
        title: it.cached_content ? "Using cached content" : "Fetch fresh content on export"
      });
      checkbox.addEventListener("change", async () => {
        try {
          const result = await fetchJSON(`/api/projects/${currentProject.id}/items/${it.id}/cache`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cache: checkbox.checked })
          });
          // Update the item in currentProject
          it.cached_content = result.cached ? "cached" : null;
          checkbox.title = result.cached ? "Using cached content" : "Fetch fresh content on export";
        } catch (err) {
          console.error("Failed to toggle cache:", err);
          // Revert checkbox state
          checkbox.checked = !checkbox.checked;
          alert("Failed to toggle cache: " + err.message);
        }
      });
      cachedTd.append(checkbox);
    } else {
      cachedTd.append(el("span", { className: "text-gray-400" }, "—"));
    }
    tr.appendChild(cachedTd);

    // delete
    const delTd = document.createElement("td");
    delTd.className = "p-2 align-top text-right";
    const delBtn = el("button",{className:"px-2 py-1 rounded border border-red-600 text-red-700 text-xs hover:bg-red-50"},"Delete");
    delBtn.addEventListener("click", async ()=>{
      if (!confirm("Delete this item?")) return;
      await fetchJSON(`/api/projects/${currentProject.id}/items/${it.id}`, { method:"DELETE" });
      await refreshProjectState();
    });
    delTd.append(delBtn);
    tr.appendChild(delTd);

    itemsTbody.appendChild(tr);
  });
}

// ===================== drag & drop =====================
function ensureSortable(){
  if (!window.Sortable) { console.warn("SortableJS not loaded"); return; }
  if (!itemsTbody) return;

  if (sortableInstance) { try { sortableInstance.destroy(); } catch{} sortableInstance = null; }
  if (!itemsTbody.children.length) return;

  sortableInstance = new Sortable(itemsTbody, {
    animation: 150,
    draggable: "tr",
    handle: ".drag-handle",
    dataIdAttr: "id",
    ghostClass: "bg-gray-100",
    dragClass: "bg-gray-200",
    forceFallback: true,
    fallbackOnBody: true,
    swapThreshold: 0.65,
    setData: (dt, dragEl) => dt.setData('text/plain', dragEl.dataset.id || ''),
    onChoose: (evt) => { const tr = evt.item; if (!tr.id) tr.id = tr.dataset.id || ""; },
    onEnd: async () => {
      let ids = [];
      try { ids = sortableInstance.toArray(); } catch {}
      if (!ids.length) {
        ids = Array.from(itemsTbody.querySelectorAll("tr"))
              .map(tr => tr.dataset.id || tr.id)
              .filter(Boolean);
      }
      const order = ids.map((id, i)=>({ id, position: i+1 }));
      try{
        const res = await fetch(`/api/projects/${currentProject.id}/items/reorder`, {
          method:"PUT",
          headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ order })
        });
        if (!res.ok) throw new Error(await res.text());
        await refreshProjectState();
      }catch(e){
        console.error("Reorder failed:", e);
        alert("Reorder failed: " + e.message);
      }
    }
  });

  $$("#itemsTbody tr").forEach(tr => { if (!tr.id) tr.id = tr.dataset.id || ""; });
}

// ===================== Comments System =====================
async function loadComments(projectId) {
  const commentsSection = $("#commentsSection");
  const commentsList = $("#commentsList");
  const commentsEmpty = $("#commentsEmpty");
  const commentForm = $("#commentForm");
  
  if (!commentsSection) return;
  
  try {
    const comments = await fetchJSON(`/api/projects/${projectId}/comments`);
    
    // Show comments section
    commentsSection.classList.remove("hidden");
    
    // Show/hide comment form based on auth
    if (commentForm) {
      commentForm.style.display = currentUser ? 'block' : 'none';
    }
    
    // Clear existing comments
    commentsList.innerHTML = '';
    
    if (comments.length === 0) {
      commentsEmpty.classList.remove("hidden");
      return;
    }
    
    commentsEmpty.classList.add("hidden");
    
    // Render comments
    for (const comment of comments) {
      const commentEl = createCommentElement(comment);
      commentsList.appendChild(commentEl);
    }
  } catch (err) {
    console.error("Failed to load comments:", err);
  }
}

function createCommentElement(comment) {
  const commentDiv = el("div", { 
    className: "border border-gray-200 rounded p-4 bg-white"
  });
  commentDiv.dataset.commentId = comment.id;
  
  const header = el("div", { className: "flex justify-between items-start mb-2" });
  
  const userInfo = el("div", { className: "text-sm text-gray-600" });
  const displayName = [comment.first_name, comment.last_name].filter(Boolean).join(' ') || comment.user_id;
  userInfo.textContent = `${displayName}${comment.affiliation ? ` (${comment.affiliation})` : ''} • ${new Date(comment.created_at).toLocaleString()}`;
  
  header.appendChild(userInfo);
  
  // Add delete button for comment author or admin
  if (currentUser && (currentUser.username === comment.user_id || currentUser.is_admin)) {
    const deleteBtn = el("button", {
      className: "text-red-600 hover:text-red-800 text-sm",
      textContent: "Delete"
    });
    deleteBtn.addEventListener("click", () => deleteComment(comment.id));
    header.appendChild(deleteBtn);
  }
  
  const commentText = el("div", { 
    className: "text-gray-800",
    textContent: comment.comment_text 
  });
  
  commentDiv.appendChild(header);
  commentDiv.appendChild(commentText);
  
  return commentDiv;
}

async function deleteComment(commentId) {
  if (!confirm("Are you sure you want to delete this comment?")) return;
  
  try {
    await fetchJSON(`/api/comments/${commentId}`, { method: "DELETE" });
    
    // Remove from UI
    const commentEl = $(`[data-comment-id="${commentId}"]`);
    if (commentEl) commentEl.remove();
    
    // Check if we need to show empty state
    const commentsList = $("#commentsList");
    const commentsEmpty = $("#commentsEmpty");
    if (commentsList && commentsList.children.length === 0) {
      commentsEmpty?.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Failed to delete comment:", err);
    alert("Failed to delete comment: " + err.message);
  }
}

// Comment form event listener
$("#addCommentForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  
  if (!currentUser) {
    alert("Please log in to comment");
    return;
  }
  
  if (!currentProject) return;
  
  const commentText = $("#commentText");
  if (!commentText || !commentText.value.trim()) {
    alert("Please enter a comment");
    return;
  }
  
  try {
    const newComment = await fetchJSON(`/api/projects/${currentProject.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment_text: commentText.value.trim() })
    });
    
    // Clear form
    commentText.value = '';
    
    // Add to UI
    const commentsList = $("#commentsList");
    const commentsEmpty = $("#commentsEmpty");
    
    if (commentsEmpty) commentsEmpty.classList.add("hidden");
    
    const commentEl = createCommentElement(newComment);
    commentsList.insertBefore(commentEl, commentsList.firstChild); // Add to top
    
  } catch (err) {
    console.error("Failed to post comment:", err);
    alert("Failed to post comment: " + err.message);
  }
});
