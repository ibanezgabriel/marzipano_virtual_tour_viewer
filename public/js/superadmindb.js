/**
 * Super Admin dashboard behavior.
 *
 * Phase 1 scope:
 * - Enforce that only authenticated `super_admin` users can access this page.
 * - Wire basic section navigation.
 *
 * Note: Logout handling is provided by `public/js/login.js` via the shared `#logout-btn`.
 */

document.addEventListener('DOMContentLoaded', async () => {
    // Enforce Super Admin access client-side for a better UX (server-side middleware still enforces this).
    try {
        const res = await fetch('/api/me');
        const me = await res.json();
        if (!me || !me.loggedIn) {
            window.location.replace('/login.html');
            return;
        }
        if (me.role !== 'super_admin') {
            window.location.replace('/dashboard.html');
            return;
        }
        const nameEl = document.querySelector('.user-card .user-name');
        if (nameEl) nameEl.textContent = me.username || 'Super Admin';
    } catch (e) {
        // If we cannot validate the session, fail closed and send the user to login.
        window.location.replace('/login.html');
        return;
    }

    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.content-section');

    // ---- Projects (overview) UI wiring ----
    const projectsListEl = document.getElementById('sa-project-list');
    const projectsEmptyStateEl = document.getElementById('sa-projects-empty-state');
    const projectsSearchInput = document.getElementById('sa-project-search-input');
    const projectsSearchBtn = document.getElementById('sa-project-search-btn');

    const renameProjectModal = document.getElementById('sa-rename-project-modal');
    const renameProjectForm = document.getElementById('sa-rename-project-form');
    const renameProjectIdInput = document.getElementById('sa-rename-project-id');
    const renameProjectNumberInput = document.getElementById('sa-rename-project-number');
    const renameProjectNameInput = document.getElementById('sa-rename-project-name');
    const renameProjectErrorEl = document.getElementById('sa-rename-project-error');
    const renameProjectCancelBtn = document.getElementById('sa-rename-project-cancel');
    const renameProjectSaveBtn = document.getElementById('sa-rename-project-save');

    let projectsLoadedOnce = false;
    let projectsQuery = '';
    let projectsAll = [];

    const ALLOWED_PROJECT_STATUSES = new Set(['on-going', 'completed']);
    const MAX_PROJECT_NAME_LENGTH = 150;
    const MAX_PROJECT_NUMBER_LENGTH = 20;

    function normalizeWorkflowState(value) {
        const v = String(value || '').trim().toUpperCase();
        if (v === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
        if (v === 'REJECTED') return 'REJECTED';
        if (v === 'MODIFIED') return 'MODIFIED';
        if (v === 'DRAFT') return 'DRAFT';
        return 'PUBLISHED';
    }

    function workflowLabel(state) {
        if (state === 'PENDING_APPROVAL') return 'Pending';
        if (state === 'REJECTED') return 'Rejected';
        if (state === 'MODIFIED') return 'Modified';
        if (state === 'DRAFT') return 'Draft';
        return 'Published';
    }

    function normalizeProjectStatus(status) {
        const s = String(status || '').trim().toLowerCase();
        if (!s) return 'on-going';
        if (ALLOWED_PROJECT_STATUSES.has(s)) return s;
        if (s === 'ongoing') return 'on-going';
        if (s === 'in-progress' || s === 'in progress') return 'on-going';
        return 'on-going';
    }

    function sanitizeProjectNumber(value) {
        return String(value || '')
            .replace(/[^A-Za-z0-9-]+/g, '')
            .slice(0, MAX_PROJECT_NUMBER_LENGTH);
    }

    function validateProjectName(name) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return 'Project name is required.';
        if (trimmed.length > MAX_PROJECT_NAME_LENGTH) return `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or less.`;
        if (/[<>:"/\\|?*]/.test(trimmed)) return 'Project name cannot contain: < > : " / \\ | ? *';
        return null;
    }

    async function fetchAllProjects() {
        const res = await fetch('/api/projects', { headers: { 'Accept': 'application/json' } });
        const data = await res.json().catch(() => []);
        if (!res.ok) throw new Error((data && (data.message || data.error)) || `Failed to load projects (HTTP ${res.status})`);
        return Array.isArray(data) ? data : [];
    }

    async function renameProject({ id, name, number, status }) {
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                name: String(name || '').trim(),
                number: String(number || '').trim(),
                status: normalizeProjectStatus(status),
            }),
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || `Failed to update project (HTTP ${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    async function updateProjectStatus(project, nextStatus) {
        const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                name: String(project.name || '').trim(),
                number: String(project.number || '').trim(),
                status: normalizeProjectStatus(nextStatus),
            }),
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || `Failed to update status (HTTP ${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    function openRenameProjectModal(project) {
        if (!renameProjectModal || !renameProjectIdInput || !renameProjectNameInput || !renameProjectNumberInput) return;
        if (renameProjectErrorEl) renameProjectErrorEl.textContent = '';
        renameProjectIdInput.value = project.id;
        renameProjectNumberInput.value = project.number || '';
        renameProjectNameInput.value = project.name || '';
        renameProjectModal.classList.add('visible');
        renameProjectModal.setAttribute('aria-hidden', 'false');
        renameProjectNumberInput.focus();
    }

    function closeRenameProjectModal() {
        if (!renameProjectModal) return;
        renameProjectModal.classList.remove('visible');
        renameProjectModal.setAttribute('aria-hidden', 'true');
        if (renameProjectErrorEl) renameProjectErrorEl.textContent = '';
    }

    function renderProjects(projects) {
        if (!projectsListEl) return;
        projectsListEl.innerHTML = '';

        const rows = Array.isArray(projects) ? projects : [];
        if (projectsEmptyStateEl) {
            projectsEmptyStateEl.style.display = rows.length === 0 ? 'block' : 'none';
        }
        if (rows.length === 0) return;

        for (const project of rows) {
            const state = normalizeWorkflowState(project && project.workflow_state);

            const row = document.createElement('div');
            row.className = 'project-row';
            row.dataset.projectId = project.id;

            const numberDisplay = document.createElement('div');
            numberDisplay.className = 'project-number-display';
            numberDisplay.textContent = project.number || '';
            const numberCell = document.createElement('div');
            numberCell.className = 'project-number-cell';
            numberCell.appendChild(numberDisplay);

            const nameDisplay = document.createElement('div');
            nameDisplay.className = 'project-name-display';
            nameDisplay.textContent = project.name || '';
            const nameCell = document.createElement('div');
            nameCell.className = 'project-name-cell';
            nameCell.appendChild(nameDisplay);

            const statusCell = document.createElement('div');
            statusCell.className = 'project-status-cell';
            const statusSelect = document.createElement('select');
            statusSelect.className = 'project-status-display project-status-select';
            const statusOptions = [
                { value: 'on-going', label: 'On-going' },
                { value: 'completed', label: 'Completed' },
            ];
            statusOptions.forEach(({ value, label }) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                statusSelect.appendChild(option);
            });
            statusSelect.value = normalizeProjectStatus(project.status);
            statusCell.appendChild(statusSelect);

            statusSelect.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            statusSelect.addEventListener('change', async () => {
                const previous = normalizeProjectStatus(project.status);
                const next = normalizeProjectStatus(statusSelect.value);
                if (next === previous) return;
                statusSelect.disabled = true;
                try {
                    const updated = await updateProjectStatus(project, next);
                    projectsAll = projectsAll.map((p) => (p.id === project.id ? { ...p, ...updated } : p));
                    applyProjectsSearch();
                    markAuditStale();
                } catch (e) {
                    statusSelect.value = previous;
                    window.alert(e.message || 'Failed to update status.');
                } finally {
                    statusSelect.disabled = false;
                }
            });

            const actionsCell = document.createElement('div');
            actionsCell.className = 'project-actions-cell';

            const viewBtn = document.createElement('button');
            viewBtn.type = 'button';
            viewBtn.className = 'btn-open';
            viewBtn.title = 'View';
            const viewIcon = document.createElement('img');
            viewIcon.src = '../assets/icons/view1.png';
            viewIcon.style.height = '20px';
            viewIcon.style.width = '20px';
            viewBtn.appendChild(viewIcon);
            const viewOrig = '../assets/icons/view1.png';
            const viewHover = '../assets/icons/view2.png';
            viewBtn.addEventListener('mouseenter', () => { viewIcon.src = viewHover; });
            viewBtn.addEventListener('mouseleave', () => { viewIcon.src = viewOrig; });

            const projectToken = (project.number && String(project.number).trim()) || project.id;
            viewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const params = new URLSearchParams({ project: projectToken });
                window.open(`project-viewer.html?${params.toString()}`, '_blank');
            });

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'btn-edit';
            editBtn.title = 'Edit';
            const editIcon = document.createElement('img');
            editIcon.src = '../assets/icons/edit1.png';
            editIcon.style.height = '20px';
            editIcon.style.width = '20px';
            editBtn.appendChild(editIcon);
            const editOrig = '../assets/icons/edit1.png';
            const editHover = '../assets/icons/edit2.png';
            editBtn.addEventListener('mouseenter', () => { editIcon.src = editHover; });
            editBtn.addEventListener('mouseleave', () => { editIcon.src = editOrig; });

            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openRenameProjectModal(project);
            });

            actionsCell.append(viewBtn, editBtn);
            row.append(numberCell, nameCell, statusCell, actionsCell);

            projectsListEl.appendChild(row);
        }
    }

    function applyProjectsSearch() {
        const q = (projectsSearchInput && projectsSearchInput.value.trim().toLowerCase()) || '';
        projectsQuery = q;
        if (!q) return renderProjects(projectsAll);
        const filtered = projectsAll.filter((p) =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.number || '').toLowerCase().includes(q) ||
            normalizeProjectStatus(p.status).includes(q) ||
            workflowLabel(normalizeWorkflowState(p.workflow_state)).toLowerCase().includes(q) ||
            normalizeWorkflowState(p.workflow_state).toLowerCase().includes(q)
        );
        renderProjects(filtered);
    }

    async function loadProjects({ force = false } = {}) {
        if (!projectsListEl) return;
        if (projectsLoadedOnce && !force) return;
        try {
            const all = await fetchAllProjects();
            // Projects that are still drafts should not appear in the Projects tab.
            projectsAll = Array.isArray(all)
                ? all.filter((p) => normalizeWorkflowState(p && p.workflow_state) !== 'DRAFT')
                : [];
            projectsLoadedOnce = true;
            applyProjectsSearch();
        } catch (e) {
            projectsAll = [];
            projectsLoadedOnce = false;
            renderProjects([]);
            if (projectsEmptyStateEl) {
                projectsEmptyStateEl.style.display = 'block';
                projectsEmptyStateEl.textContent = e.message || 'Failed to load projects.';
            }
        }
    }

    // ---- Audit Logs UI wiring ----
    const auditTbody = document.getElementById('audit-logs-tbody');
    const auditSearchInput = document.getElementById('audit-search-input');
    const auditSearchBtn = document.getElementById('audit-search-btn');
    const auditPrevBtn = document.getElementById('audit-prev-btn');
    const auditNextBtn = document.getElementById('audit-next-btn');
    const auditPageInfo = document.getElementById('audit-page-info');

    const AUDIT_PAGE_SIZE = 12;
    let auditLoadedOnce = false;
    let auditQuery = '';
    let auditOffset = 0;
    let auditTotal = 0;

    function markAuditStale() {
        auditLoadedOnce = false;
        auditOffset = 0;
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    function formatDateTime(value) {
        const d = new Date(value);
        if (!Number.isFinite(d.getTime())) return '';
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }

    function setAuditMessage(message) {
        if (!auditTbody) return;
        auditTbody.innerHTML = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent = message;
        tr.appendChild(td);
        auditTbody.appendChild(tr);
    }

    function renderAuditRows(rows) {
        if (!auditTbody) return;
        auditTbody.innerHTML = '';

        if (!rows || rows.length === 0) {
            setAuditMessage('No audit logs found.');
            return;
        }

        const formatAction = (value) => {
            const raw = String(value || '');
            const parts = raw.split(':');
            if (parts.length >= 3 && parts[0] === 'archive') {
                const kind = parts[1];
                const act = parts.slice(2).join(':');
                const kindLabel = kind === 'pano' ? 'Panorama' : kind === 'floorplan' ? 'Layout' : kind;
                const actLabel =
                    act === 'upload' ? 'Uploaded' :
                    act === 'update' ? 'Updated' :
                    act === 'rename' ? 'Renamed' :
                    act;
                return `${kindLabel} ${actLabel}`;
            }
            if (parts.length >= 2 && parts[0] === 'project') {
                const act = parts[1];
                return (
                    act === 'create' ? 'Project Created' :
                    act === 'rename' ? 'Project Renamed' :
                    act === 'name' ? 'Project Name Updated' :
                    act === 'number' ? 'Project Number Updated' :
                    act === 'status' ? 'Project Status Updated' :
                    act === 'modified' ? 'Project Modified' :
                    act === 'update' ? 'Project Updated' :
                    raw
                );
            }
            return raw;
        };

        for (const r of rows) {
            const tr = document.createElement('tr');

            const tdTs = document.createElement('td');
            tdTs.textContent = formatDateTime(r.created_at);

            const tdProjNo = document.createElement('td');
            tdProjNo.textContent = r.project_number || '';

            const tdProjName = document.createElement('td');
            tdProjName.textContent = r.project_name || '';

            const tdBy = document.createElement('td');
            tdBy.textContent = r.created_by || '';

            const tdAction = document.createElement('td');
            tdAction.textContent = formatAction(r.action);

            const tdMsg = document.createElement('td');
            tdMsg.textContent = r.message || '';

            tr.append(tdTs, tdProjNo, tdProjName, tdBy, tdAction, tdMsg);
            auditTbody.appendChild(tr);
        }
    }

    function setAuditPaginationState() {
        if (auditPageInfo) {
            if (!auditTotal) {
                auditPageInfo.textContent = '0 results';
            } else {
                const page = Math.floor(auditOffset / AUDIT_PAGE_SIZE) + 1;
                const pages = Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE));
                auditPageInfo.textContent = `Page ${page} of ${pages} • ${auditTotal} total`;
            }
        }
        if (auditPrevBtn) auditPrevBtn.disabled = auditOffset <= 0;
        if (auditNextBtn) auditNextBtn.disabled = !auditTotal || auditOffset + AUDIT_PAGE_SIZE >= auditTotal;
    }

    async function fetchAuditLogs({ q, limit, offset }) {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        const res = await fetch(`/api/audit-logs?${params.toString()}`, {
            headers: { 'Accept': 'application/json' }
        });

        // Read as text first so we can surface useful info even if the server returns HTML (e.g. 404/500 pages).
        const raw = await res.text().catch(() => '');
        let data = null;
        try {
            data = raw ? JSON.parse(raw) : null;
        } catch (e) {
            data = null;
        }

        if (!res.ok) {
            const msg =
                (data && (data.error || data.message)) ||
                `Failed to load audit logs (HTTP ${res.status})`;
            throw new Error(msg);
        }

        if (!data || typeof data !== 'object') {
            throw new Error('Invalid audit logs response');
        }

        return data;
    }

    async function loadAuditLogs({ force = false } = {}) {
        if (!auditTbody) return;
        if (auditLoadedOnce && !force) return;
        setAuditMessage('Loading audit logs...');
        try {
            const data = await fetchAuditLogs({ q: auditQuery, limit: AUDIT_PAGE_SIZE, offset: auditOffset });
            auditTotal = Number.isFinite(Number(data.total)) ? Number(data.total) : 0;

            // If the total shrank and the current offset is now out of range, rewind to the last page.
            if (auditTotal > 0 && auditOffset >= auditTotal) {
                auditOffset = Math.max(0, Math.floor((auditTotal - 1) / AUDIT_PAGE_SIZE) * AUDIT_PAGE_SIZE);
                const retry = await fetchAuditLogs({ q: auditQuery, limit: AUDIT_PAGE_SIZE, offset: auditOffset });
                auditTotal = Number.isFinite(Number(retry.total)) ? Number(retry.total) : auditTotal;
                renderAuditRows(Array.isArray(retry.rows) ? retry.rows : []);
            } else {
                renderAuditRows(Array.isArray(data.rows) ? data.rows : []);
            }
            setAuditPaginationState();
            auditLoadedOnce = true;
        } catch (e) {
            try { console.error('Audit logs load failed:', e); } catch (err) {}
            auditTotal = 0;
            setAuditPaginationState();
            setAuditMessage(e.message || 'Failed to load audit logs.');
        }
    }

    // ---- Approval Requests UI wiring ----
    const approvalTbody = document.getElementById('approval-requests-tbody');
    const approvalSearchInput = document.getElementById('approval-search-input');
    const approvalSearchBtn = document.getElementById('approval-search-btn');

    const APPROVAL_PAGE_SIZE = 50;
    let approvalsLoadedOnce = false;
    let approvalsQuery = '';
    let approvalsOffset = 0;
    let approvalsStatus = 'PENDING';

    function setApprovalMessage(message) {
        if (!approvalTbody) return;
        approvalTbody.innerHTML = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = message;
        tr.appendChild(td);
        approvalTbody.appendChild(tr);
    }

    function approvalInfoLabel(row) {
        const type = String(row.request_type || '');
        if (type === 'project:publish') return 'Publish project';
        return type || 'Request';
    }

    function renderApprovalRows(rows) {
        if (!approvalTbody) return;
        approvalTbody.innerHTML = '';

        if (!rows || rows.length === 0) {
            setApprovalMessage('No approval requests found.');
            return;
        }

        for (const r of rows) {
            const tr = document.createElement('tr');

            const tdTs = document.createElement('td');
            tdTs.textContent = formatDateTime(r.created_at);

            const tdProjNo = document.createElement('td');
            tdProjNo.textContent = r.project_number || '';

            const tdProjName = document.createElement('td');
            tdProjName.textContent = r.project_name || '';

            const tdActionCode = document.createElement('td');
            tdActionCode.textContent = r.action_code || '';

            const tdInfo = document.createElement('td');
            tdInfo.textContent = r.information || approvalInfoLabel(r);

            const tdBy = document.createElement('td');
            tdBy.textContent = r.requested_by || '';

            const tdAction = document.createElement('td');
            const reviewBtn = document.createElement('button');
            reviewBtn.type = 'button';
            reviewBtn.className = 'approval-action approval-review';
            reviewBtn.textContent = 'Review';
            reviewBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const pid = r.project_id ? String(r.project_id) : '';
                if (!pid) return;
                const params = new URLSearchParams({ project: pid, view: 'staging', return: 'superadmindb' });
                window.open(`project-editor.html?${params.toString()}`, '_blank');
            });

            const approveBtn = document.createElement('button');
            approveBtn.type = 'button';
            approveBtn.className = 'approval-action approval-approve';
            approveBtn.textContent = 'Approve';

            const rejectBtn = document.createElement('button');
            rejectBtn.type = 'button';
            rejectBtn.className = 'approval-action approval-reject';
            rejectBtn.textContent = 'Reject';

            const isPending = String(r.status || '').toUpperCase() === 'PENDING';
            approveBtn.disabled = !isPending;
            rejectBtn.disabled = !isPending;

            approveBtn.addEventListener('click', async () => {
                if (!isPending) return;
                const ok = window.confirm('Approve this request and publish the project?');
                if (!ok) return;
                approveBtn.disabled = true;
                rejectBtn.disabled = true;
                try {
                    await decideApproval(r.id, 'approve', '');
                    approvalsLoadedOnce = false;
                    await loadApprovalRequests({ force: true });
                    projectsLoadedOnce = false;
                    await loadProjects({ force: true });
                } catch (e) {
                    window.alert(e.message || 'Failed to approve.');
                }
            });

            rejectBtn.addEventListener('click', async () => {
                if (!isPending) return;
                const reason = window.prompt('Reject request. Enter a reason (optional):', '') || '';
                const ok = window.confirm('Reject this request?');
                if (!ok) return;
                approveBtn.disabled = true;
                rejectBtn.disabled = true;
                try {
                    await decideApproval(r.id, 'reject', reason);
                    approvalsLoadedOnce = false;
                    await loadApprovalRequests({ force: true });
                    projectsLoadedOnce = false;
                    await loadProjects({ force: true });
                } catch (e) {
                    window.alert(e.message || 'Failed to reject.');
                }
            });

            tdAction.append(reviewBtn, approveBtn, rejectBtn);
            tr.append(tdTs, tdProjNo, tdProjName, tdActionCode, tdInfo, tdBy, tdAction);
            approvalTbody.appendChild(tr);
        }
    }

    async function fetchApprovalRequests({ q, status, limit, offset }) {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (status) params.set('status', status);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        const res = await fetch(`/api/approval-requests?${params.toString()}`, {
            headers: { 'Accept': 'application/json' }
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.error || data.message)) || `Failed to load approval requests (HTTP ${res.status})`;
            throw new Error(msg);
        }
        if (!data || typeof data !== 'object') throw new Error('Invalid approval requests response');
        return data;
    }

    async function decideApproval(id, action, comment) {
        const url = action === 'approve'
            ? `/api/approval-requests/${encodeURIComponent(id)}/approve`
            : `/api/approval-requests/${encodeURIComponent(id)}/reject`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ comment }),
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || `Request failed (HTTP ${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    async function loadApprovalRequests({ force = false } = {}) {
        if (!approvalTbody) return;
        if (approvalsLoadedOnce && !force) return;
        setApprovalMessage('Loading approval requests...');
        try {
            const data = await fetchApprovalRequests({
                q: approvalsQuery,
                status: approvalsStatus,
                limit: APPROVAL_PAGE_SIZE,
                offset: approvalsOffset,
            });
            renderApprovalRows(Array.isArray(data.rows) ? data.rows : []);
            approvalsLoadedOnce = true;
        } catch (e) {
            setApprovalMessage(e.message || 'Failed to load approval requests.');
        }
    }

    // ---- User Management UI wiring ----
    const usersTbody = document.getElementById('users-tbody');
    const userSearchInput = document.getElementById('user-search-input');
    const userSearchBtn = document.getElementById('user-search-btn');
    const addAccountBtn = document.getElementById('add-account-btn');
    const userErrorEl = document.getElementById('user-error');

    const addUserModal = document.getElementById('add-user-modal');
    const addUserForm = document.getElementById('add-user-form');
    const addUserCancelBtn = document.getElementById('add-user-cancel');
    const addUserSubmitBtn = document.getElementById('add-user-submit');
    const addUsernameInput = document.getElementById('add-username');
    const addPasswordInput = document.getElementById('add-password');
    const addRoleSelect = document.getElementById('add-role');
    const addUserErrorEl = document.getElementById('add-user-error');

    let usersLoadedOnce = false;
    let usersQuery = '';

    function roleLabel(role) {
        return role === 'super_admin' ? 'Super Admin' : 'Admin';
    }

    function setUserError(message) {
        if (!userErrorEl) return;
        userErrorEl.textContent = message || '';
    }

    function renderUsers(users) {
        if (!usersTbody) return;
        usersTbody.innerHTML = '';

        const visibleUsers = Array.isArray(users) ? users.filter((u) => u && u.role !== 'super_admin') : [];

        if (visibleUsers.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 6;
            td.textContent = 'No users found.';
            tr.appendChild(td);
            usersTbody.appendChild(tr);
            return;
        }

        visibleUsers.forEach((u, idx) => {
            const tr = document.createElement('tr');

            const tdIndex = document.createElement('td');
            tdIndex.textContent = String(idx + 1);

            const tdUsername = document.createElement('td');
            tdUsername.textContent = u.username || '';

            const tdRole = document.createElement('td');
            tdRole.textContent = roleLabel(u.role);

            const tdCreated = document.createElement('td');
            tdCreated.textContent = formatDateTime(u.created_at);

            const tdStatus = document.createElement('td');
            tdStatus.textContent = u.is_active === false ? 'Suspended' : 'Active';

            const tdAction = document.createElement('td');
            const manageBtn = document.createElement('button');
            manageBtn.type = 'button';
            manageBtn.textContent = 'Manage';
            if (u.role === 'super_admin') {
                manageBtn.disabled = true;
                manageBtn.title = 'Super Admin accounts cannot be managed from the dashboard.';
            } else {
                manageBtn.addEventListener('click', () => {
                    openManageUserModal(u);
                });
            }
            tdAction.appendChild(manageBtn);

            tr.append(tdIndex, tdUsername, tdRole, tdCreated, tdStatus, tdAction);
            usersTbody.appendChild(tr);
        });
    }

    function openManageUserModal(user) {
        if (!user || !manageUserModal) return;
        if (manageUserErrorEl) manageUserErrorEl.textContent = '';
        manageUserIdInput.value = String(user.id || '');
        manageUsernameInput.value = user.username || '';
        manageRoleSelect.value = user.role === 'super_admin' ? 'super_admin' : 'admin';
        manageStatusSelect.value = user.is_active === false ? 'suspended' : 'active';
        manageNewPasswordInput.value = '';
        manageUserModal.classList.add('visible');
        manageUserModal.setAttribute('aria-hidden', 'false');
        manageUsernameInput.focus();
    }

    function closeManageUserModal() {
        if (!manageUserModal) return;
        manageUserModal.classList.remove('visible');
        manageUserModal.setAttribute('aria-hidden', 'true');
    }

    async function fetchUsers(q) {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        const res = await fetch(`/api/users?${params.toString()}`, {
            headers: { 'Accept': 'application/json' }
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.error || data.message)) || `Failed to load users (HTTP ${res.status})`;
            throw new Error(msg);
        }
        if (!Array.isArray(data)) throw new Error('Invalid users response');
        return data;
    }

    async function loadUsers({ force = false } = {}) {
        if (!usersTbody) return;
        if (usersLoadedOnce && !force) return;
        setUserError('');
        usersTbody.innerHTML = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 6;
        td.textContent = 'Loading users...';
        tr.appendChild(td);
        usersTbody.appendChild(tr);

        try {
            const users = await fetchUsers(usersQuery);
            renderUsers(users);
            usersLoadedOnce = true;
        } catch (e) {
            setUserError(e.message || 'Failed to load users.');
            renderUsers([]);
        }
    }

    function openAddUserModal() {
        if (!addUserModal) return;
        if (addUserErrorEl) addUserErrorEl.textContent = '';
        if (addUsernameInput) addUsernameInput.value = '';
        if (addPasswordInput) addPasswordInput.value = '';
        if (addRoleSelect) addRoleSelect.value = 'admin';
        addUserModal.classList.add('visible');
        addUserModal.setAttribute('aria-hidden', 'false');
        if (addUsernameInput) addUsernameInput.focus();
    }

    function closeAddUserModal() {
        if (!addUserModal) return;
        addUserModal.classList.remove('visible');
        addUserModal.setAttribute('aria-hidden', 'true');
    }

    async function createUser({ username, password, role }) {
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ username, password, role }),
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || `Failed to create user (HTTP ${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    async function updateUser(id, { username, role, is_active }) {
        const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ username, role, is_active }),
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || `Failed to update user (HTTP ${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    async function resetUserPassword(id, password) {
        const res = await fetch(`/api/users/${encodeURIComponent(id)}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ password }),
        });
        const raw = await res.text().catch(() => '');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.message || data.error)) || `Failed to reset password (HTTP ${res.status})`;
            throw new Error(msg);
        }
        return data;
    }

    const sectionMap = {
        'Projects': 'projects',
        'Approval Requests': 'approval-requests',
        'Audit Logs': 'audit-logs',
        'User Management': 'user-management'
    };

    navItems.forEach((item) => {
        item.addEventListener('click', () => {
            navItems.forEach((el) => el.classList.remove('active'));
            item.classList.add('active');

            const targetKey = sectionMap[item.textContent.trim()];
            sections.forEach((section) => {
                section.classList.toggle(
                    'active',
                    section.dataset.section === targetKey
                );
            });

            if (targetKey === 'audit-logs') {
                loadAuditLogs({ force: true });
            }
            if (targetKey === 'user-management') {
                loadUsers();
            }
            if (targetKey === 'approval-requests') {
                loadApprovalRequests();
            }
            if (targetKey === 'projects') {
                loadProjects();
            }
        });
    });

    if (projectsSearchBtn) {
        projectsSearchBtn.addEventListener('click', () => {
            projectsLoadedOnce = true;
            applyProjectsSearch();
        });
    }
    if (projectsSearchInput) {
        projectsSearchInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (projectsSearchBtn) projectsSearchBtn.click();
        });
    }

    if (renameProjectCancelBtn) {
        renameProjectCancelBtn.addEventListener('click', () => closeRenameProjectModal());
    }
    if (renameProjectModal) {
        renameProjectModal.addEventListener('click', (e) => {
            if (e.target === renameProjectModal) closeRenameProjectModal();
        });
    }
    if (renameProjectNumberInput) {
        renameProjectNumberInput.addEventListener('input', (e) => {
            const value = sanitizeProjectNumber(e.target.value || '');
            if (e.target.value !== value) e.target.value = value;
        });
    }
    if (renameProjectForm) {
        renameProjectForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!renameProjectIdInput || !renameProjectNameInput || !renameProjectNumberInput) return;
            if (renameProjectErrorEl) renameProjectErrorEl.textContent = '';

            const id = renameProjectIdInput.value;
            const number = sanitizeProjectNumber(renameProjectNumberInput.value || '');
            const name = String(renameProjectNameInput.value || '').trim();
            if (!number) {
                if (renameProjectErrorEl) renameProjectErrorEl.textContent = 'Project number is required.';
                return;
            }
            const nameError = validateProjectName(name);
            if (nameError) {
                if (renameProjectErrorEl) renameProjectErrorEl.textContent = nameError;
                return;
            }

            const current = projectsAll.find((p) => p && p.id === id) || null;
            const status = current ? current.status : 'on-going';

            if (renameProjectSaveBtn) renameProjectSaveBtn.disabled = true;
            try {
                const updated = await renameProject({ id, name, number, status });
                projectsAll = projectsAll.map((p) => (p.id === id ? { ...p, ...updated } : p));
                closeRenameProjectModal();
                applyProjectsSearch();
                markAuditStale();
            } catch (err) {
                if (renameProjectErrorEl) renameProjectErrorEl.textContent = err.message || 'Failed to update project.';
            } finally {
                if (renameProjectSaveBtn) renameProjectSaveBtn.disabled = false;
            }
        });
    }

    // Initial load for the default active tab.
    loadProjects();

    if (auditSearchBtn) {
        auditSearchBtn.addEventListener('click', () => {
            auditQuery = (auditSearchInput && auditSearchInput.value.trim()) || '';
            auditOffset = 0;
            auditLoadedOnce = false;
            loadAuditLogs({ force: true });
        });
    }
    if (auditSearchInput) {
        auditSearchInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (auditSearchBtn) auditSearchBtn.click();
        });
    }

    if (auditPrevBtn) {
        auditPrevBtn.addEventListener('click', () => {
            if (auditOffset <= 0) return;
            auditOffset = Math.max(0, auditOffset - AUDIT_PAGE_SIZE);
            auditLoadedOnce = false;
            loadAuditLogs({ force: true });
        });
    }

    if (auditNextBtn) {
        auditNextBtn.addEventListener('click', () => {
            if (!auditTotal || auditOffset + AUDIT_PAGE_SIZE >= auditTotal) return;
            auditOffset = auditOffset + AUDIT_PAGE_SIZE;
            auditLoadedOnce = false;
            loadAuditLogs({ force: true });
        });
    }

    if (userSearchBtn) {
        userSearchBtn.addEventListener('click', () => {
            usersQuery = (userSearchInput && userSearchInput.value.trim()) || '';
            usersLoadedOnce = false;
            loadUsers({ force: true });
        });
    }

    if (approvalSearchBtn) {
        approvalSearchBtn.addEventListener('click', () => {
            approvalsQuery = (approvalSearchInput && approvalSearchInput.value.trim()) || '';
            approvalsOffset = 0;
            approvalsLoadedOnce = false;
            loadApprovalRequests({ force: true });
        });
    }
    if (approvalSearchInput) {
        approvalSearchInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (approvalSearchBtn) approvalSearchBtn.click();
        });
    }
    if (userSearchInput) {
        userSearchInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (userSearchBtn) userSearchBtn.click();
        });
    }

    if (addAccountBtn) {
        addAccountBtn.addEventListener('click', () => openAddUserModal());
    }
    if (addUserCancelBtn) {
        addUserCancelBtn.addEventListener('click', () => closeAddUserModal());
    }
    if (addUserModal) {
        addUserModal.addEventListener('click', (e) => {
            if (e.target === addUserModal) closeAddUserModal();
        });
    }

    if (addUserForm) {
        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!addUsernameInput || !addPasswordInput || !addRoleSelect) return;

            const username = (addUsernameInput.value || '').trim();
            const password = String(addPasswordInput.value || '');
            const role = String(addRoleSelect.value || 'admin');

            if (addUserErrorEl) addUserErrorEl.textContent = '';

            if (!username) {
                if (addUserErrorEl) addUserErrorEl.textContent = 'Username is required.';
                return;
            }
            if (!/^[A-Za-z0-9_.-]+$/.test(username) || username.length > 50) {
                if (addUserErrorEl) addUserErrorEl.textContent = 'Username can only contain letters, numbers, underscore, dot, and dash (max 50).';
                return;
            }
            if (!password || password.length < 8) {
                if (addUserErrorEl) addUserErrorEl.textContent = 'Password must be at least 8 characters.';
                return;
            }

            if (addUserSubmitBtn) addUserSubmitBtn.disabled = true;
            try {
                await createUser({ username, password, role });
                closeAddUserModal();
                usersLoadedOnce = false;
                await loadUsers({ force: true });
            } catch (err) {
                if (addUserErrorEl) addUserErrorEl.textContent = err.message || 'Failed to create user.';
            } finally {
                if (addUserSubmitBtn) addUserSubmitBtn.disabled = false;
            }
        });
    }

    // Manage modal refs + wiring
    const manageUserModal = document.getElementById('manage-user-modal');
    const manageUserForm = document.getElementById('manage-user-form');
    const manageUserCancelBtn = document.getElementById('manage-user-cancel');
    const manageUserSaveBtn = document.getElementById('manage-user-save');
    const manageUserIdInput = document.getElementById('manage-user-id');
    const manageUsernameInput = document.getElementById('manage-username');
    const manageRoleSelect = document.getElementById('manage-role');
    const manageStatusSelect = document.getElementById('manage-status');
    const manageNewPasswordInput = document.getElementById('manage-new-password');
    const manageUserErrorEl = document.getElementById('manage-user-error');

    if (manageUsernameInput) {
        manageUsernameInput.addEventListener('input', (e) => {
            const raw = String(e.target.value || '');
            const cleaned = raw.replace(/[^A-Za-z0-9_.-]+/g, '').slice(0, 50);
            if (raw !== cleaned) e.target.value = cleaned;
        });
    }

    if (manageUserCancelBtn) manageUserCancelBtn.addEventListener('click', () => closeManageUserModal());
    if (manageUserModal) {
        manageUserModal.addEventListener('click', (e) => {
            if (e.target === manageUserModal) closeManageUserModal();
        });
    }

    if (manageUserForm) {
        manageUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!manageUserIdInput) return;
            if (manageUserErrorEl) manageUserErrorEl.textContent = '';

            const id = manageUserIdInput.value;
            const username = manageUsernameInput ? String(manageUsernameInput.value || '').trim() : '';
            const role = manageRoleSelect ? manageRoleSelect.value : 'admin';
            const status = manageStatusSelect ? manageStatusSelect.value : 'active';
            const is_active = status !== 'suspended';
            const newPassword = manageNewPasswordInput ? String(manageNewPasswordInput.value || '') : '';

            if (!username) {
                if (manageUserErrorEl) manageUserErrorEl.textContent = 'Username is required.';
                return;
            }
            if (!/^[A-Za-z0-9_.-]+$/.test(username) || username.length > 50) {
                if (manageUserErrorEl) manageUserErrorEl.textContent = 'Username can only contain letters, numbers, underscore, dot, and dash (max 50).';
                return;
            }
            if (newPassword && newPassword.length < 8) {
                if (manageUserErrorEl) manageUserErrorEl.textContent = 'New password must be at least 8 characters.';
                return;
            }

            if (manageUserSaveBtn) manageUserSaveBtn.disabled = true;
            try {
                await updateUser(id, { username, role, is_active });
                if (newPassword) {
                    await resetUserPassword(id, newPassword);
                }
                closeManageUserModal();
                usersLoadedOnce = false;
                await loadUsers({ force: true });
            } catch (err) {
                if (manageUserErrorEl) manageUserErrorEl.textContent = err.message || 'Failed to update user.';
            } finally {
                if (manageUserSaveBtn) manageUserSaveBtn.disabled = false;
            }
        });
    }
});
