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

    // ---- Audit Logs UI wiring ----
    const auditTbody = document.getElementById('audit-logs-tbody');
    const auditSearchInput = document.getElementById('audit-search-input');
    const auditSearchBtn = document.getElementById('audit-search-btn');

    const AUDIT_PAGE_SIZE = 50;
    let auditLoadedOnce = false;
    let auditQuery = '';
    let auditOffset = 0;

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
            tdAction.textContent = r.action || '';

            const tdMsg = document.createElement('td');
            tdMsg.textContent = r.message || '';

            tr.append(tdTs, tdProjNo, tdProjName, tdBy, tdAction, tdMsg);
            auditTbody.appendChild(tr);
        }
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
            renderAuditRows(Array.isArray(data.rows) ? data.rows : []);
            auditLoadedOnce = true;
        } catch (e) {
            try { console.error('Audit logs load failed:', e); } catch (err) {}
            setAuditMessage(e.message || 'Failed to load audit logs.');
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
        manageRoleSelect.focus();
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

    async function updateUser(id, { role, is_active }) {
        const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ role, is_active }),
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
                loadAuditLogs();
            }
            if (targetKey === 'user-management') {
                loadUsers();
            }
        });
    });

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

    if (userSearchBtn) {
        userSearchBtn.addEventListener('click', () => {
            usersQuery = (userSearchInput && userSearchInput.value.trim()) || '';
            usersLoadedOnce = false;
            loadUsers({ force: true });
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
            const role = manageRoleSelect ? manageRoleSelect.value : 'admin';
            const status = manageStatusSelect ? manageStatusSelect.value : 'active';
            const is_active = status !== 'suspended';
            const newPassword = manageNewPasswordInput ? String(manageNewPasswordInput.value || '') : '';

            if (newPassword && newPassword.length < 8) {
                if (manageUserErrorEl) manageUserErrorEl.textContent = 'New password must be at least 8 characters.';
                return;
            }

            if (manageUserSaveBtn) manageUserSaveBtn.disabled = true;
            try {
                await updateUser(id, { role, is_active });
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
