(function () {
  'use strict';
  const STORAGE_KEY = 'spp.session.v1';
  const USER_PERMISSION_CODES = ['USER_VIEW', 'USER_CREATE', 'USER_EDIT', 'USER_STATUS', 'USER_PASSWORD_RESET'];
  const DATABASE_PERMISSION_CODES=(function(){const codes=[];['BRANCH','TARGET','CUSTOMER_LEVEL','SALES_PROFILE','CUSTOMER','CATEGORY','BRAND','COMPETITOR','PROMOTION'].forEach(function(entity){['VIEW','CREATE','EDIT','DELETE','IMPORT','EXPORT'].forEach(function(action){codes.push('DATABASE_'+entity+'_'+action);});});return codes;})();
  const FEATURE_PERMISSION_CODES=['VISIT_PLAN_VIEW','VISIT_PLAN_CREATE','VISIT_PLAN_EDIT','VISIT_PLAN_DELETE','VISIT_PLAN_ASSIGN','VISIT_PLAN_IMPORT','VISIT_PLAN_EXPORT','VISIT_VIEW','VISIT_CREATE_UNPLANNED','VISIT_CHECK_IN','VISIT_CHECK_OUT','VISIT_EDIT_RESULT','VISIT_REVIEW','VISIT_APPROVE','DASHBOARD_VIEW','REPORT_VIEW','REPORT_EXPORT'];
  const ALL_PERMISSION_CODES=USER_PERMISSION_CODES.concat(DATABASE_PERMISSION_CODES,FEATURE_PERMISSION_CODES);
  const state = { token: null, expiresAt: null, user: null, mustChangePassword: false, busy: false, currentRoute:'login', routeRequestId:0, permissions: [], permissionScopes:{}, permissionsLoaded: false, permissionsPromise: null, users: [], usersLoaded: false, usersPromise: null, selectedUserId: null, userMode: 'edit', userImportRows:null,userImportPreview:null, databaseMeta:null,databaseMetaPromise:null, databaseEntity:'branch', databaseItems:[], databasePage:1, databasePageSize:readDatabasePageSize(), databaseRowHeight:readDatabaseRowHeight(), databaseTotal:0, databaseTotalPages:1, databaseSelected:null, databaseFilters:{}, databaseSortField:'', databaseSortDirection:'ASC', importHeaders:null,importRows:null, importBatch:null, visitPlanMeta:null,visitPlanMetaPromise:null, visitPlans:[], visitPlanPage:1, visitPlanTotalPages:1, selectedVisitPlan:null, visitPlanCustomerLines:[], visitPlanFilters:{},visitPlanSortField:'',visitPlanSortDirection:'DESC',planImportRows:null,planImportBatch:null, visitMeta:null,visitMetaPromise:null, visits:[], visitPage:1, visitTotalPages:1, selectedVisit:null, dashboardData:null,dashboardLoadedAt:0, reportItems:[],reportSummary:null, reportPage:1, reportTotalPages:1, maintenanceToken:null,cleanupPreviewId:null,storageData:null };

  function readDatabasePageSize(){try{const value=Number(localStorage.getItem('spp.database.pageSize'));return[25,50,100,300,500,1000].indexOf(value)!==-1?value:25;}catch(error){return 25;}}
  function readDatabaseRowHeight(){try{const value=Number(localStorage.getItem('spp.database.rowHeight'));return[40,52,64,80].indexOf(value)!==-1?value:52;}catch(error){return 52;}}
  const app = document.getElementById('app');

  function serverCall(action, payload) {
    return new Promise(function (resolve, reject) {
      google.script.run
        .withSuccessHandler(function (response) {
          if (response && response.ok) resolve(response.data);
          else reject(response && response.error ? response.error : { code: 'SERVER_ERROR', message: 'ระบบไม่สามารถดำเนินการได้' });
        })
        .withFailureHandler(function () { reject({ code: 'NETWORK_ERROR', message: 'ไม่สามารถติดต่อ Server ได้ กรุณาลองใหม่' }); })
        .apiCall(action, payload || {});
    });
  }

  function render(templateId) {
    const template = document.getElementById(templateId);
    if (!template) throw { code:'UI_VERSION_MISMATCH', message:'ไม่พบหน้าจอ '+templateId+' กรุณาอัปเดต Index.html และ Scripts.html ให้เป็นเวอร์ชันเดียวกัน' };
    app.replaceChildren(template.content.cloneNode(true));
    bindPasswordToggles();
  }

  function renderRoute(route,templateId){state.currentRoute=route;state.routeRequestId+=1;state.busy=false;render(templateId);bindShell();return state.routeRequestId;}
  function isCurrentRoute(route,requestId,requiredElementId){return state.currentRoute===route&&state.routeRequestId===requestId&&(!requiredElementId||!!document.getElementById(requiredElementId));}

  function renderLogin() {
    state.busy = false;
    state.currentRoute='login';state.routeRequestId+=1;
    render('login-view');
    const form = document.getElementById('login-form');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (state.busy) return;
      clearError(form);
      const data = new FormData(form);
      setBusy(form, true, 'กำลังเข้าสู่ระบบ…');
      try {
        const result = await serverCall('login', {
          username: data.get('username'),
          password: data.get('password'),
          clientLabel: clientLabel()
        });
        acceptAuth(result);
        if (state.mustChangePassword) renderPasswordChange();
        else await openDashboard();
      } catch (error) {
        showError(form, friendlyMessage(error));
      } finally {
        setBusy(form, false);
      }
    });
  }

  function renderPasswordChange() {
    state.currentRoute='password';state.routeRequestId+=1;
    render('password-view');
    const form = document.getElementById('password-form');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (state.busy) return;
      clearError(form);
      const data = new FormData(form);
      setBusy(form, true, 'กำลังบันทึก…');
      try {
        const result = await serverCall('changePassword', {
          sessionToken: state.token,
          newPassword: data.get('newPassword'),
          confirmPassword: data.get('confirmPassword'),
          clientLabel: clientLabel()
        });
        acceptAuth(result);
        await openDashboard();
        toast('เปลี่ยนรหัสผ่านเรียบร้อย');
      } catch (error) {
        if (isSessionError(error)) return expireSession();
        showError(form, friendlyMessage(error));
      } finally {
        setBusy(form, false);
      }
    });
  }

  async function openDashboard() {
    if (!state.user || !state.token) return expireSession();
    renderRoute('dashboard','dashboard-view');
    if(state.dashboardData)renderDashboardAnalytics();
    if(!state.dashboardData||Date.now()-Number(state.dashboardLoadedAt||0)>60000)loadDashboardAnalytics();
    if(state.permissionsLoaded)updatePermissionVisibility();
    else loadMyPermissions(false).then(function(){updatePermissionVisibility();}).catch(function(error){if(isSessionError(error))expireSession();});
  }

  function loadDatabaseMeta(){if(state.databaseMeta)return Promise.resolve(state.databaseMeta);if(state.databaseMetaPromise)return state.databaseMetaPromise;state.databaseMetaPromise=serverCall('database.meta',{sessionToken:state.token}).then(function(result){state.databaseMeta=result;state.databaseMetaPromise=null;return result;},function(error){state.databaseMetaPromise=null;throw error;});return state.databaseMetaPromise;}
  function loadVisitPlanMeta(){if(state.visitPlanMeta)return Promise.resolve(state.visitPlanMeta);if(state.visitPlanMetaPromise)return state.visitPlanMetaPromise;state.visitPlanMetaPromise=serverCall('visitPlan.meta',{sessionToken:state.token}).then(function(result){state.visitPlanMeta=result;state.visitPlanMetaPromise=null;return result;},function(error){state.visitPlanMetaPromise=null;throw error;});return state.visitPlanMetaPromise;}
  function loadVisitMeta(){if(state.visitMeta)return Promise.resolve(state.visitMeta);if(state.visitMetaPromise)return state.visitMetaPromise;state.visitMetaPromise=serverCall('visit.meta',{sessionToken:state.token}).then(function(result){state.visitMeta=result;state.visitMetaPromise=null;return result;},function(error){state.visitMetaPromise=null;throw error;});return state.visitMetaPromise;}
  function bindShell() {
    document.querySelectorAll('[data-display-name]').forEach(function (element) { element.textContent = state.user.displayName; });
    document.querySelectorAll('[data-role]').forEach(function (element) { element.textContent = state.user.roleCode; });
    document.querySelectorAll('[data-avatar]').forEach(function (element) { element.textContent = initials(state.user.displayName); });
    document.querySelectorAll('[data-admin-only]').forEach(function (element) { element.hidden = !isAdminRole(state.user.roleCode); });
    ensureDynamicNavigation();
    setupMobileNavigation();
    updatePermissionVisibility();
    document.querySelectorAll('[data-logout]').forEach(function (button) { button.addEventListener('click', logout); });
    document.querySelectorAll('[data-route]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (button.dataset.route === 'users') openUsers();
        else if (button.dataset.route === 'visitPlans') openVisitPlans();
        else if (button.dataset.route === 'visits') openVisits();
        else if (button.dataset.route === 'report') openReport();
        else if (button.dataset.route === 'database') openDatabase();
        else if (button.dataset.route === 'systemMaintenance') openSystemMaintenance();
        else if (button.dataset.route === 'profile') openProfile();
        else openDashboard();
      });
    });
  }

  function setupMobileNavigation(){const shell=document.querySelector('.app-shell'),sidebar=shell&&shell.querySelector('.sidebar'),topbar=shell&&shell.querySelector('.topbar');if(!shell||!sidebar||!topbar)return;const toggle=document.createElement('button');toggle.type='button';toggle.className='mobile-menu-toggle';toggle.setAttribute('aria-label','เปิดเมนู');toggle.setAttribute('aria-expanded','false');toggle.textContent='☰';topbar.insertBefore(toggle,topbar.firstChild);const close=document.createElement('button');close.type='button';close.className='mobile-menu-close';close.setAttribute('aria-label','ปิดเมนู');close.textContent='×';sidebar.insertBefore(close,sidebar.firstChild);const backdrop=document.createElement('button');backdrop.type='button';backdrop.className='mobile-nav-backdrop';backdrop.setAttribute('aria-label','ปิดเมนู');shell.appendChild(backdrop);function setOpen(open){document.body.classList.toggle('mobile-nav-open',open);toggle.setAttribute('aria-expanded',open?'true':'false');}toggle.addEventListener('click',function(){setOpen(true);});close.addEventListener('click',function(){setOpen(false);});backdrop.addEventListener('click',function(){setOpen(false);});sidebar.querySelectorAll('[data-route],[data-logout]').forEach(function(button){button.addEventListener('click',function(){setOpen(false);});});}

  function updatePermissionVisibility() {
    document.querySelectorAll('[data-user-view]').forEach(function (element) { element.hidden = !hasPermission('USER_VIEW'); });
    document.querySelectorAll('[data-database-view]').forEach(function (element) { element.hidden = !state.permissions.some(function(code){return code.indexOf('DATABASE_')===0&&code.slice(-5)==='_VIEW';}); });
    document.querySelectorAll('[data-visit-plan-view]').forEach(function(element){element.hidden=!hasPermission('VISIT_PLAN_VIEW');});
  }

  function ensureDynamicNavigation(){document.querySelectorAll('.nav-list').forEach(function(nav){let plan=nav.querySelector('[data-route="visitPlans"]');if(!plan){const visit=nav.querySelector('[data-route="visits"]');plan=document.createElement('button');plan.type='button';plan.dataset.route='visitPlans';plan.dataset.visitPlanView='';plan.innerHTML='▣ <span>Visit Plan</span>';nav.insertBefore(plan,visit||null);}if(state.user&&state.user.isOwner&&!nav.querySelector('[data-route="systemMaintenance"]')){const users=nav.querySelector('[data-route="users"]'),button=document.createElement('button');button.type='button';button.dataset.route='systemMaintenance';button.innerHTML='⌁ <span>พื้นที่ / ล้างข้อมูล</span>';nav.insertBefore(button,users?users.nextSibling:null);}nav.querySelectorAll('[data-route]').forEach(function(button){button.classList.toggle('is-active',button.dataset.route===state.currentRoute);});});}

  function hasPermission(permissionCode) { return state.permissions.indexOf(permissionCode) !== -1; }
  function isAdminRole(roleCode) { return String(roleCode || '').toUpperCase() === 'ADMIN'; }
  function roleRankClient(roleCode) { return { AUDITOR: 10, SALES: 20, MANAGER: 30, ADMIN: 40 }[String(roleCode || '').toUpperCase()] || 0; }
  function defaultPermissionsForRole(roleCode){const role=String(roleCode||'').toUpperCase();if(role==='ADMIN')return ALL_PERMISSION_CODES.slice();if(role==='MANAGER')return DATABASE_PERMISSION_CODES.filter(function(code){return code.slice(-7)!=='_DELETE';}).concat(['VISIT_PLAN_VIEW','VISIT_PLAN_CREATE','VISIT_PLAN_EDIT','VISIT_PLAN_ASSIGN','VISIT_PLAN_IMPORT','VISIT_PLAN_EXPORT','VISIT_VIEW','VISIT_CREATE_UNPLANNED','VISIT_CHECK_IN','VISIT_CHECK_OUT','VISIT_EDIT_RESULT','VISIT_REVIEW','VISIT_APPROVE','DASHBOARD_VIEW','REPORT_VIEW','REPORT_EXPORT']);if(role==='SALES')return['VISIT_PLAN_VIEW','VISIT_VIEW','VISIT_CREATE_UNPLANNED','VISIT_CHECK_IN','VISIT_CHECK_OUT','VISIT_EDIT_RESULT','DASHBOARD_VIEW','REPORT_VIEW'];if(role==='AUDITOR')return['VISIT_PLAN_VIEW','VISIT_VIEW','DASHBOARD_VIEW','REPORT_VIEW','REPORT_EXPORT'];return[];}
  function canManageUser(user) {
    if (!user || user.isOwner) return false;
    if (state.user.isOwner) return true;
    return roleRankClient(state.user.roleCode) > roleRankClient(user.roleCode);
  }

  function loadMyPermissions(forceReload) {
    if (state.permissionsLoaded && !forceReload) return Promise.resolve(state.permissions);
    if (state.permissionsPromise) return state.permissionsPromise;
    state.permissionsPromise = serverCall('permissions.me', { sessionToken: state.token }).then(function (result) {
      state.permissions = result.permissions || [];
      state.permissionScopes = result.scopes || {};
      state.permissionsLoaded = true;
      return state.permissions;
    });
    return state.permissionsPromise.then(function (permissions) {
      state.permissionsPromise = null;
      return permissions;
    }, function (error) {
      state.permissionsPromise = null;
      throw error;
    });
  }

  function openProfile() {
    if (!state.user) return;
    renderRoute('profile','profile-view');
    document.querySelectorAll('[data-profile-username]').forEach(function (element) { element.textContent = state.user.username; });
    const form = document.getElementById('profile-password-form');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (state.busy) return;
      clearError(form);
      const data = new FormData(form);
      setBusy(form, true, 'กำลังเปลี่ยนรหัสผ่าน…');
      try {
        const result = await serverCall('profile.changePassword', {
          sessionToken: state.token,
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
          confirmPassword: data.get('confirmPassword'),
          clientLabel: clientLabel()
        });
        acceptAuth(result);
        state.users = [];
        state.usersLoaded = false;
        state.usersPromise = null;
        state.busy = false;
        openProfile();
        toast('เปลี่ยนรหัสผ่านเรียบร้อย และออก Session ใหม่แล้ว');
      } catch (error) {
        if (isSessionError(error)) return expireSession();
        showError(form, friendlyMessage(error));
      } finally {
        setBusy(form, false);
      }
    });
  }

  async function openUsers() {
    if (!state.user || !hasPermission('USER_VIEW')) return toast('คุณไม่มีสิทธิ์ดูรายการผู้ใช้');
    if (state.usersLoaded) {
      renderManagedUsersPage();
      return;
    }
    const requestId=renderRoute('users','users-view');
    const loadingBody=document.getElementById('admin-user-rows');
    if(loadingBody)loadingBody.innerHTML='<tr><td colspan="3">กำลังโหลดผู้ใช้งาน…</td></tr>';
    try {
      await loadManagedUsers(false);
      if(!isCurrentRoute('users',requestId,'admin-user-rows'))return;
      if (!state.users.some(function (user) { return user.userId === state.selectedUserId; })) state.selectedUserId = state.users[0] ? state.users[0].userId : null;
      state.userMode = state.selectedUserId ? 'edit' : 'create';
      bindUserManagement();
    } catch (error) {
      if(!isCurrentRoute('users',requestId))return;
      if (isSessionError(error)) return expireSession();
      toast(friendlyMessage(error));
      await openDashboard();
    }
  }

  function renderManagedUsersPage() {
    renderRoute('users','users-view');
    bindUserManagement();
  }

  function loadManagedUsers(forceReload) {
    if (state.usersLoaded && !forceReload) return Promise.resolve(state.users);
    if (state.usersPromise) return state.usersPromise;
    state.usersPromise = serverCall('users.list', { sessionToken: state.token }).then(function (users) {
      state.users = users;
      state.usersLoaded = true;
      return users;
    });
    return state.usersPromise.then(function (users) {
      state.usersPromise = null;
      return users;
    }, function (error) {
      state.usersPromise = null;
      throw error;
    });
  }

  function bindUserManagement() {
    const search = document.getElementById('user-search');
    const status = document.getElementById('user-status-filter');
    document.querySelector('[data-user-action="new"]').hidden = !hasPermission('USER_CREATE');
    const canUseUserTools=isAdminRole(state.user.roleCode);document.querySelector('[data-user-template]').hidden=!canUseUserTools;document.querySelector('[data-user-export]').hidden=!canUseUserTools;document.querySelector('[data-user-import-label]').hidden=!canUseUserTools;
    search.addEventListener('input', renderManagedUserList);
    status.addEventListener('change', renderManagedUserList);
    document.querySelector('[data-user-action="new"]').addEventListener('click', function () {
      state.userMode = 'create';
      state.selectedUserId = null;
      renderManagedUserList();
      openManagedUserDetail();
    });
    const form = document.getElementById('admin-user-form');
    form.addEventListener('submit', saveManagedUser);
    document.querySelector('[data-user-action="toggle-status"]').addEventListener('click', toggleManagedUserStatus);
    document.querySelector('[data-user-action="show-reset"]').addEventListener('click', function () {
      document.getElementById('password-reset-panel').hidden = false;
      form.elements.resetPassword.focus();
    });
    document.querySelector('[data-user-action="reset-password"]').addEventListener('click', resetManagedUserPassword);
    document.querySelector('[data-user-action="save-permissions"]').addEventListener('click', saveSelectedUserPermissions);
    document.querySelector('[data-user-action="close"]').addEventListener('click',closeManagedUserDetail);
    document.querySelector('[data-user-template]').addEventListener('click',downloadManagedUserTemplate);
    document.querySelector('[data-user-export]').addEventListener('click',exportManagedUsers);
    document.getElementById('user-import-file').addEventListener('change',importManagedUsersCsv);
    bindUserColumnResizers();
    renderManagedUserList();
    closeManagedUserDetail();
  }

  function downloadManagedUserTemplate(){downloadCsv('user_management_template.csv',['Username','DisplayName','RoleCode','Status','TemporaryPassword'],[]);toast('ดาวน์โหลด User Template แล้ว');}

  async function exportManagedUsers(){try{const rows=await serverCall('users.export',{sessionToken:state.token,search:document.getElementById('user-search').value,status:document.getElementById('user-status-filter').value});downloadCsv('user_management_export_'+new Date().toISOString().slice(0,10)+'.csv',['UserId','Username','DisplayName','RoleCode','Status','MustChangePassword','IsSystemOwner','CreatedAt','UpdatedAt'],rows);toast('Export ผู้ใช้ '+rows.length+' รายการแล้ว');}catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}}

  async function importManagedUsersCsv(event){const file=event.target.files[0];event.target.value='';if(!file)return;try{const csv=parseCsv(await file.text());if(!csv.length)throw{code:'IMPORT_INVALID',message:'ไฟล์ไม่มีข้อมูล'};const headers=csv.shift().map(function(value){return String(value).trim();}),required=['Username','DisplayName','RoleCode','Status','TemporaryPassword'];required.forEach(function(field){if(headers.indexOf(field)===-1)throw{code:'IMPORT_INVALID',message:'ไม่พบคอลัมน์ '+field};});state.userImportRows=csv.filter(function(row){return row.some(function(value){return String(value).trim()!=='';});}).map(function(row){const item={};headers.forEach(function(header,index){item[header]=row[index]||'';});return item;});openManagedUserImportPreview();}catch(error){toast(friendlyMessage(error));}}

  async function openManagedUserImportPreview(){const template=document.getElementById('user-import-preview-template'),node=template.content.cloneNode(true);document.body.appendChild(node);document.querySelector('[data-user-import-close]').addEventListener('click',closeManagedUserImportPreview);document.querySelector('[data-user-import-cancel]').addEventListener('click',closeManagedUserImportPreview);document.querySelector('[data-user-import-commit]').addEventListener('click',commitManagedUsersImport);await previewManagedUsersImport();}

  function closeManagedUserImportPreview(){document.querySelectorAll('.modal-backdrop').forEach(function(node){node.remove();});state.userImportPreview=null;state.userImportRows=null;}

  async function previewManagedUsersImport(){try{const result=await serverCall('users.previewImport',{sessionToken:state.token,rows:state.userImportRows});state.userImportPreview=result;const summary=document.getElementById('user-import-summary'),body=document.getElementById('user-import-preview-body');summary.replaceChildren();[['CREATE',result.counts.CREATE],['UPDATE',result.counts.UPDATE],['ERROR',result.counts.ERROR]].forEach(function(item){const card=document.createElement('article'),strong=document.createElement('strong'),span=document.createElement('span');card.className='panel report-summary-card';strong.textContent=item[1];span.textContent=item[0];card.append(strong,span);summary.appendChild(card);});body.replaceChildren();result.rows.forEach(function(item){const tr=document.createElement('tr'),values=[item.rowNumber,item.operation,item.error,item.record.Username,item.record.DisplayName,item.record.RoleCode,item.record.Status,item.record.TemporaryPassword];values.forEach(function(value){const td=document.createElement('td');td.textContent=value==null?'':value;tr.appendChild(td);});body.appendChild(tr);});document.querySelector('[data-user-import-commit]').disabled=result.counts.ERROR>0;}catch(error){closeManagedUserImportPreview();toast(friendlyMessage(error));}}

  async function commitManagedUsersImport(){if(!state.userImportPreview)return;const button=document.querySelector('[data-user-import-commit]');button.disabled=true;try{const result=await serverCall('users.commitImport',{sessionToken:state.token,rows:state.userImportRows});closeManagedUserImportPreview();state.usersLoaded=false;await loadManagedUsers(true);renderManagedUserList();toast('Import ผู้ใช้สำเร็จ '+result.committed+' รายการ');}catch(error){button.disabled=false;if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}}

  function renderManagedUserList() {
    const body = document.getElementById('admin-user-rows');
    if (!body) return;
    body.replaceChildren();
    const query = String(document.getElementById('user-search').value || '').trim().toLowerCase();
    const status = document.getElementById('user-status-filter').value;
    const visible = state.users.filter(function (user) {
      return (!query || (user.displayName + ' ' + user.username).toLowerCase().indexOf(query) !== -1) && (status === 'ALL' || user.status === status);
    });
    document.getElementById('user-list-empty').hidden = visible.length !== 0;
    visible.forEach(function (user) {
      const row = document.createElement('tr');
      row.tabIndex = 0;
      if (user.userId === state.selectedUserId) row.className = 'selected-row';
      row.innerHTML = '<td><strong></strong><small></small></td><td></td><td></td>';
      row.children[0].querySelector('strong').textContent = user.displayName;
      row.children[0].querySelector('small').textContent = user.username;
      row.children[1].textContent = user.roleCode;
      row.children[2].appendChild(statusBadge(user.status));
      const select = function () {
        state.userMode = 'edit';
        state.selectedUserId = user.userId;
        renderManagedUserList();
        openManagedUserDetail();
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
      body.appendChild(row);
    });
  }

  function renderManagedUserForm() {
    const form = document.getElementById('admin-user-form');
    const user = state.users.find(function (item) { return item.userId === state.selectedUserId; }) || null;
    const creating = state.userMode === 'create';
    form.reset();
    clearManagedUserError();
    form.elements.userId.value = user ? user.userId : '';
    form.elements.version.value = user ? user.version : 1;
    form.elements.displayName.value = user ? user.displayName : '';
    form.elements.username.value = user ? user.username : '';
    form.elements.username.disabled = !creating;
    form.elements.roleCode.value = user ? user.roleCode : 'SALES';
    const isCurrentUser = Boolean(user && user.userId === state.user.userId);
    const canManage = creating || canManageUser(user);
    form.elements.displayName.disabled = !creating && (!hasPermission('USER_EDIT') || !canManage);
    form.elements.roleCode.disabled = isCurrentUser || (!creating && (!hasPermission('USER_EDIT') || !canManage));
    Array.from(form.elements.roleCode.options).forEach(function (option) { option.disabled = option.value === 'ADMIN' ? !state.user.isOwner : (!state.user.isOwner && roleRankClient(option.value) >= roleRankClient(state.user.roleCode)); });
    form.elements.temporaryPassword.required = creating;
    document.getElementById('create-password-field').hidden = !creating;
    document.getElementById('edit-user-actions').hidden = creating || !user;
    document.getElementById('password-reset-panel').hidden = true;
    document.getElementById('admin-form-mode').textContent = creating ? 'CREATE USER' : 'USER DETAIL';
    document.getElementById('admin-user-heading').textContent = creating ? 'สร้างผู้ใช้ใหม่' : (user ? user.displayName : 'เลือกผู้ใช้งาน');
    const badge = document.getElementById('admin-user-status');
    badge.className = 'status ' + statusClass(user ? user.status : 'ACTIVE');
    badge.textContent = user ? user.status : 'NEW';
    document.querySelector('[data-form-label]').textContent = creating ? 'สร้างผู้ใช้' : 'บันทึกการเปลี่ยนแปลง';
    const toggle = document.getElementById('admin-status-action');
    if (user) toggle.textContent = user.status === 'ACTIVE' ? 'Deactivate' : 'Activate';
    toggle.hidden = !hasPermission('USER_STATUS') || (!creating && !canManage);
    toggle.disabled = isCurrentUser || !canManage;
    document.querySelector('[data-user-action="show-reset"]').hidden = !hasPermission('USER_PASSWORD_RESET') || (!creating && !canManage);
    document.getElementById('admin-save-user').hidden = creating ? !hasPermission('USER_CREATE') : (!hasPermission('USER_EDIT') || !canManage);
    const permissionPanel = document.getElementById('user-permission-panel');
    permissionPanel.hidden = creating || !user || !isAdminRole(state.user.roleCode) || !canManage;
    document.querySelector('[data-user-action="save-permissions"]').hidden = isCurrentUser;
    if (!permissionPanel.hidden) loadSelectedUserPermissions(user.userId);
  }

  function openManagedUserDetail(){const layout=document.querySelector('.admin-user-layout'),detail=document.querySelector('[data-user-detail]');if(!detail)return;detail.hidden=false;if(layout)layout.classList.add('detail-open');renderManagedUserForm();detail.scrollIntoView({behavior:'smooth',block:'start'});}
  function closeManagedUserDetail(){const layout=document.querySelector('.admin-user-layout'),detail=document.querySelector('[data-user-detail]');state.selectedUserId=null;state.userMode='edit';if(detail)detail.hidden=true;if(layout)layout.classList.remove('detail-open');renderManagedUserList();}

  function userColumnWidth(key){try{const saved=Number(localStorage.getItem('spp.user.column.'+key));if(saved>=90&&saved<=600)return saved;}catch(error){}return key==='user'?300:key==='role'?180:150;}
  function applyUserColumnWidths(){const table=document.querySelector('.admin-user-table');if(!table)return;let total=0;['user','role','status'].forEach(function(key){const width=userColumnWidth(key),col=table.querySelector('col[data-user-col="'+key+'"]');if(col)col.style.width=width+'px';total+=width;});table.style.width=Math.max(620,total)+'px';}
  function bindUserColumnResizers(){const table=document.querySelector('.admin-user-table');if(!table)return;applyUserColumnWidths();table.querySelectorAll('[data-user-resize]').forEach(function(handle){const key=handle.dataset.userResize;let dragging=false,startX=0,startWidth=0;function move(event){if(!dragging)return;const col=table.querySelector('col[data-user-col="'+key+'"]');if(!col)return;const width=Math.max(90,Math.min(600,startWidth+event.clientX-startX));col.style.width=Math.round(width)+'px';const total=Array.from(table.querySelectorAll('col')).reduce(function(sum,item){return sum+(parseFloat(item.style.width)||150);},0);table.style.width=Math.max(620,total)+'px';}function finish(){if(!dragging)return;dragging=false;handle.classList.remove('is-dragging');document.body.classList.remove('is-resizing-column');const col=table.querySelector('col[data-user-col="'+key+'"]');if(col)try{localStorage.setItem('spp.user.column.'+key,String(Math.round(parseFloat(col.style.width)||150)));}catch(error){}}handle.addEventListener('pointerdown',function(event){const col=table.querySelector('col[data-user-col="'+key+'"]');if(!col)return;dragging=true;startX=event.clientX;startWidth=parseFloat(col.style.width)||col.getBoundingClientRect().width;handle.classList.add('is-dragging');document.body.classList.add('is-resizing-column');handle.setPointerCapture(event.pointerId);event.stopPropagation();event.preventDefault();});handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('dblclick',function(event){try{localStorage.removeItem('spp.user.column.'+key);}catch(error){}applyUserColumnWidths();event.stopPropagation();});});}

  async function loadSelectedUserPermissions(userId) {
    const host = document.getElementById('user-permission-options');
    if (!host) return;
    host.innerHTML = '<div class="empty-state">กำลังโหลด Permission…</div>';
    try {
      const result = await serverCall('permissions.get', { sessionToken: state.token, userId: userId });
      if (state.selectedUserId !== userId || !document.getElementById('user-permission-options')) return;
      host.replaceChildren();
      let currentModule = '';
      result.permissions.forEach(function (permission) {
        if (permission.module !== currentModule) { currentModule = permission.module; const heading=document.createElement('h4'); heading.className='permission-module-heading'; heading.textContent=currentModule; host.appendChild(heading); }
        const row = document.createElement('label');
        row.className = 'permission-option';
        row.innerHTML = '<span><strong></strong><small></small></span><select data-effect><option value="INHERIT">Inherit</option><option value="ALLOW">Allow</option><option value="DENY">Deny</option></select><select data-scope><option value="INHERIT">Scope: Inherit</option><option value="OWN">Own</option><option value="TEAM">Team</option><option value="BRANCH">Branch</option><option value="ALL">All</option></select>';
        row.querySelector('strong').textContent = permission.code;
        row.querySelector('small').textContent = 'Role default: ' + (permission.roleDefault ? 'Allow' : 'Deny') + ' • Effective: ' + (permission.effective ? 'Allow' : 'Deny');
        const select = row.querySelector('[data-effect]');
        select.dataset.permissionCode = permission.code;
        select.value = permission.override;
        select.disabled = userId === state.user.userId;
        const scope=row.querySelector('[data-scope]');scope.dataset.permissionScope=permission.code;scope.value=permission.scope||'INHERIT';scope.disabled=userId===state.user.userId;
        host.appendChild(row);
      });
    } catch (error) {
      if (isSessionError(error)) return expireSession();
      host.innerHTML = '';
      showManagedUserError(friendlyMessage(error));
    }
  }

  async function saveSelectedUserPermissions() {
    const user = state.users.find(function (item) { return item.userId === state.selectedUserId; });
    if (!user || state.busy || user.userId === state.user.userId) return;
    const overrides = {};
    const scopes = {};
    document.querySelectorAll('[data-permission-code]').forEach(function (select) { overrides[select.dataset.permissionCode] = select.value; });
    document.querySelectorAll('[data-permission-scope]').forEach(function(select){scopes[select.dataset.permissionScope]=select.value;});
    const form = document.getElementById('admin-user-form');
    setManagedUserBusy(form, true);
    try {
      await serverCall('permissions.set', { sessionToken: state.token, userId: user.userId, overrides: overrides, scopes:scopes });
      await loadSelectedUserPermissions(user.userId);
      toast('บันทึกสิทธิราย User เรียบร้อย');
    } catch (error) {
      if (isSessionError(error)) return expireSession();
      showManagedUserError(friendlyMessage(error));
    } finally { setManagedUserBusy(form, false); }
  }

  async function saveManagedUser(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = event.currentTarget;
    clearManagedUserError();
    const creating = state.userMode === 'create';
    const payload = {
      sessionToken: state.token,
      displayName: form.elements.displayName.value,
      roleCode: form.elements.roleCode.value
    };
    if (creating) {
      payload.username = form.elements.username.value;
      payload.temporaryPassword = form.elements.temporaryPassword.value;
    } else {
      payload.userId = form.elements.userId.value;
      payload.expectedVersion = Number(form.elements.version.value);
    }
    setManagedUserBusy(form, true);
    try {
      const saved = await serverCall(creating ? 'users.create' : 'users.update', payload);
      await reloadManagedUsers(saved.userId);
      closeManagedUserDetail();
      toast(creating ? 'สร้างผู้ใช้เรียบร้อย' : 'บันทึกข้อมูลผู้ใช้เรียบร้อย');
    } catch (error) {
      if (isSessionError(error)) return expireSession();
      showManagedUserError(friendlyMessage(error));
    } finally {
      setManagedUserBusy(form, false);
    }
  }

  async function toggleManagedUserStatus() {
    const user = state.users.find(function (item) { return item.userId === state.selectedUserId; });
    if (!user || state.busy) return;
    const nextStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (!window.confirm((nextStatus === 'ACTIVE' ? 'เปิด' : 'ปิด') + 'บัญชี ' + user.username + ' หรือไม่?')) return;
    const form = document.getElementById('admin-user-form');
    setManagedUserBusy(form, true);
    try {
      const saved = await serverCall('users.setStatus', { sessionToken: state.token, userId: user.userId, expectedVersion: user.version, status: nextStatus });
      await reloadManagedUsers(saved.userId);
      toast('เปลี่ยนสถานะผู้ใช้เรียบร้อย');
    } catch (error) {
      if (isSessionError(error)) return expireSession();
      showManagedUserError(friendlyMessage(error));
    } finally { setManagedUserBusy(form, false); }
  }

  async function resetManagedUserPassword() {
    const user = state.users.find(function (item) { return item.userId === state.selectedUserId; });
    const form = document.getElementById('admin-user-form');
    const temporaryPassword = form.elements.resetPassword.value;
    if (!user || state.busy) return;
    if (!temporaryPassword || !window.confirm('ตั้งรหัสผ่านชั่วคราวใหม่และเพิกถอน Session ทั้งหมดของ ' + user.username + ' หรือไม่?')) return;
    setManagedUserBusy(form, true);
    try {
      const saved = await serverCall('users.resetPassword', { sessionToken: state.token, userId: user.userId, expectedVersion: user.version, temporaryPassword: temporaryPassword });
      await reloadManagedUsers(saved.userId);
      toast('ตั้งรหัสผ่านชั่วคราวเรียบร้อย');
    } catch (error) {
      if (isSessionError(error)) return expireSession();
      showManagedUserError(friendlyMessage(error));
    } finally { setManagedUserBusy(form, false); }
  }

  async function reloadManagedUsers(selectedUserId) {
    await loadManagedUsers(true);
    state.selectedUserId = selectedUserId || state.selectedUserId;
    state.userMode = 'edit';
    renderManagedUserList();
    renderManagedUserForm();
  }

  function setManagedUserBusy(form, busy) {
    state.busy = busy;
    form.setAttribute('aria-busy', String(busy));
    const selected = state.users.find(function (item) { return item.userId === state.selectedUserId; });
    const isCurrentUser = Boolean(selected && selected.userId === state.user.userId);
    const canManageSelected = state.userMode === 'create' || canManageUser(selected);
    form.querySelectorAll('button,input,select').forEach(function (element) {
      element.disabled = busy || (!busy && element.name === 'username' && state.userMode !== 'create') || (!busy && state.userMode !== 'create' && element.name === 'displayName' && (!hasPermission('USER_EDIT') || !canManageSelected)) || (!busy && state.userMode !== 'create' && element.name === 'roleCode' && (!hasPermission('USER_EDIT') || !canManageSelected)) || (!busy && isCurrentUser && (element.name === 'roleCode' || element.id === 'admin-status-action' || element.hasAttribute('data-permission-code')));
    });
    const spinner = form.querySelector('[data-form-spinner]');
    if (spinner) spinner.hidden = !busy;
  }

  function showManagedUserError(message) {
    const element = document.getElementById('admin-form-error');
    element.textContent = message;
    element.hidden = false;
  }

  function clearManagedUserError() {
    const element = document.getElementById('admin-form-error');
    if (!element) return;
    element.textContent = '';
    element.hidden = true;
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    badge.className = 'status ' + statusClass(status);
    badge.textContent = status;
    return badge;
  }

  function statusClass(status) { return status === 'ACTIVE' ? 'status--active' : 'status--disabled'; }

  async function loadDashboardAnalytics(){
    try{state.dashboardData=await serverCall('analytics.dashboard',{sessionToken:state.token});state.dashboardLoadedAt=Date.now();renderDashboardAnalytics();}
    catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  }

  function renderDashboardAnalytics(){
    const data=state.dashboardData;if(!data||!document.getElementById('dashboard-kpis'))return;
    document.querySelector('[data-dashboard-scope]').textContent=data.scope==='OWN'?'แสดงเฉพาะ Visit ของคุณ • อัปเดต '+formatThaiDateTime(data.generatedAt):'แสดงภาพรวม Visit ทั้งระบบ • อัปเดต '+formatThaiDateTime(data.generatedAt);
    const definitions=[['แผนวันนี้','todayPlanned','⌖'],['กำลังเข้าพบ','todayCheckedIn','◉'],['เสร็จวันนี้','todayCompleted','✓'],['เกินกำหนด','overdue','!'],['ลูกค้าวันนี้','uniqueCustomers','♧'],['Follow-up ถึงกำหนด','followUpsDue','↗'],['ยอดสั่งซื้อเดือนนี้','monthOrderAmount','฿'],['โอกาสขายเดือนนี้','monthOpportunityAmount','◎'],['โอกาสซื้อเฉลี่ย %','averagePurchaseProbability','%'],['ความสนใจเฉลี่ย','averageInterestScore','★']];
    const kpis=document.getElementById('dashboard-kpis');kpis.replaceChildren();definitions.forEach(function(item){const card=document.createElement('article');card.className='panel kpi-card';const icon=document.createElement('span');icon.className='kpi-icon';icon.textContent=item[2];const value=document.createElement('strong');value.textContent=Number(data.metrics[item[1]]||0).toLocaleString('th-TH');const label=document.createElement('span');label.textContent=item[0];card.append(icon,value,label);kpis.appendChild(card);});
    renderDashboardSeries(data.series);renderDashboardStatuses(data.statusCounts);renderDashboardVisitList('dashboard-upcoming',data.upcoming,'ไม่มี Visit ที่กำลังจะถึง');renderDashboardVisitList('dashboard-recent',data.recent,'ยังไม่มีความเคลื่อนไหว');
  }

  function renderDashboardSeries(series){const host=document.getElementById('dashboard-series');if(!host)return;host.replaceChildren();const max=Math.max(1,...series.map(function(x){return Math.max(x.planned,x.completed);}));series.forEach(function(item){const column=document.createElement('div');column.className='series-column';const bars=document.createElement('div');bars.className='series-bars';const planned=document.createElement('i');planned.className='series-planned';planned.style.height=Math.max(4,item.planned/max*100)+'%';planned.title='แผน '+item.planned;const completed=document.createElement('i');completed.className='series-completed';completed.style.height=Math.max(4,item.completed/max*100)+'%';completed.title='สำเร็จ '+item.completed;const label=document.createElement('span');label.textContent=item.label;const count=document.createElement('small');count.textContent=item.completed+'/'+item.planned;bars.append(planned,completed);column.append(count,bars,label);host.appendChild(column);});}

  function renderDashboardStatuses(counts){const host=document.getElementById('dashboard-statuses');if(!host)return;host.replaceChildren();Object.keys(counts).forEach(function(status){const row=document.createElement('div');const label=document.createElement('span');label.textContent=status;const value=document.createElement('strong');value.textContent=Number(counts[status]||0).toLocaleString('th-TH');row.append(label,value);host.appendChild(row);});}

  function renderDashboardVisitList(id,items,empty){const host=document.getElementById(id);if(!host)return;host.replaceChildren();if(!items.length){const p=document.createElement('p');p.className='muted';p.textContent=empty;host.appendChild(p);return;}items.forEach(function(item){const row=document.createElement('button');row.type='button';const main=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small'),badge=document.createElement('em');strong.textContent=item.visitCode+' • '+item.customerName;small.textContent=item.employeeName+' • '+formatThaiDateTime(item.plannedStartAt);badge.textContent=item.status;main.append(strong,small);row.append(main,badge);row.addEventListener('click',function(){openVisits();});host.appendChild(row);});}

  async function openReport(){
    const requestId=renderRoute('report','report-view');
    const body=document.getElementById('report-table-body');if(body)body.innerHTML='<tr><td colspan="9">กำลังเตรียม Report…</td></tr>';
    try{if(!state.visitMeta){const result=await serverCall('report.bootstrap',reportFilters(1,50));if(!isCurrentRoute('report',requestId,'report-table-body'))return;state.visitMeta=result.meta;bindReport();applyVisitReportResult(result.report);}else{bindReport();if(state.reportItems.length&&state.reportSummary)renderVisitReport(state.reportSummary);await loadVisitReport(1);}}
    catch(error){if(!isCurrentRoute('report',requestId))return;if(isSessionError(error))return expireSession();toast(friendlyMessage(error));await openDashboard();}
  }

  function bindReport(){
    const meta=state.visitMeta;meta.statuses.forEach(function(x){document.getElementById('report-status').add(new Option(x,x));});
    document.querySelector('[data-report-export]').hidden=!hasPermission('REPORT_EXPORT');
    meta.users.forEach(function(x){document.getElementById('report-employee').add(new Option(x.name+' — '+x.username,x.id));});meta.customers.forEach(function(x){document.getElementById('report-customer').add(new Option(x.code+' — '+x.name,x.id));});meta.branches.forEach(function(x){document.getElementById('report-branch').add(new Option(x.code+' — '+x.name,x.id));});meta.purposes.forEach(function(x){document.getElementById('report-purpose').add(new Option(x.code+' — '+x.name,x.id));});meta.outcomes.forEach(function(x){document.getElementById('report-outcome').add(new Option(x.code+' — '+x.name,x.id));});
    if(!meta.canReview&&String(state.user.roleCode).toUpperCase()!=='AUDITOR')document.getElementById('report-employee').hidden=true;
    ['report-status','report-type','report-branch','report-employee','report-customer','report-purpose','report-outcome','report-date-from','report-date-to'].forEach(function(id){document.getElementById(id).addEventListener('change',function(){loadVisitReport(1);});});document.getElementById('report-search').addEventListener('input',debounceReportReload);
    document.querySelector('[data-report-prev]').addEventListener('click',function(){if(state.reportPage>1)loadVisitReport(state.reportPage-1);});document.querySelector('[data-report-next]').addEventListener('click',function(){if(state.reportPage<state.reportTotalPages)loadVisitReport(state.reportPage+1);});document.querySelector('[data-report-export]').addEventListener('click',exportVisitReport);
  }

  let reportReloadTimer=null;function debounceReportReload(){window.clearTimeout(reportReloadTimer);reportReloadTimer=window.setTimeout(function(){loadVisitReport(1);},800);}
  function reportFilters(page,pageSize){return{sessionToken:state.token,search:document.getElementById('report-search').value,dateFrom:document.getElementById('report-date-from').value,dateTo:document.getElementById('report-date-to').value,status:document.getElementById('report-status').value,visitType:document.getElementById('report-type').value,branchId:document.getElementById('report-branch').value,employeeUserId:document.getElementById('report-employee').value,customerId:document.getElementById('report-customer').value,purposeId:document.getElementById('report-purpose').value,outcomeId:document.getElementById('report-outcome').value,page:page,pageSize:pageSize||50};}

  function applyVisitReportResult(result){state.reportItems=result.items;state.reportSummary=result.summary;state.reportPage=result.page;state.reportTotalPages=result.totalPages;renderVisitReport(result.summary);}
  async function loadVisitReport(page){const body=document.getElementById('report-table-body');if(!body)return;if(!state.reportItems.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=9;td.textContent='กำลังจัดทำ Report…';tr.appendChild(td);body.replaceChildren(tr);}try{const result=await serverCall('report.visits',reportFilters(page,50));if(!document.getElementById('report-table-body'))return;applyVisitReportResult(result);}catch(error){if(isSessionError(error))return expireSession();const current=document.getElementById('report-table-body');if(current){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=9;td.textContent='สร้าง Report ไม่สำเร็จ: '+friendlyMessage(error);tr.appendChild(td);current.replaceChildren(tr);}toast(friendlyMessage(error));}}

  function renderVisitReport(summary){
    const host=document.getElementById('report-summary'),body=document.getElementById('report-table-body');if(!host||!body)return;host.replaceChildren();
    [['ทั้งหมด',summary.planned],['เสร็จสิ้น',summary.completed],['Review แล้ว',summary.reviewed],['ยกเลิก',summary.cancelled]].forEach(function(item){const card=document.createElement('article');card.className='panel report-summary-card';const strong=document.createElement('strong');strong.textContent=Number(item[1]||0).toLocaleString('th-TH');const span=document.createElement('span');span.textContent=item[0];card.append(strong,span);host.appendChild(card);});
    body.replaceChildren();if(!state.reportItems.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=9;td.textContent='ไม่พบข้อมูลตาม Filter';tr.appendChild(td);body.appendChild(tr);}
    state.reportItems.forEach(function(item){
      const tr=document.createElement('tr'),values=[item.VisitCode,item.CustomerCode+' — '+item.CustomerName,item.Employee,formatThaiDateTime(item.PlannedStartAt),item.Status,item.Purpose,item.Outcome,item.CheckInAt,item.CheckOutAt];
      values.forEach(function(value,index){const td=document.createElement('td');if(index===4){const badge=document.createElement('span');badge.className='status-badge '+visitStatusClass(value);badge.textContent=value;td.appendChild(badge);}else if(index===7||index===8){const isCheckIn=index===7,lat=isCheckIn?item.CheckInLatitude:item.CheckOutLatitude,lng=isCheckIn?item.CheckInLongitude:item.CheckOutLongitude,accuracy=isCheckIn?item.CheckInAccuracy:item.CheckOutAccuracy,time=document.createElement('span');time.textContent=formatThaiDateTime(value);td.className='report-gps-cell';td.appendChild(time);if(lat!==''&&lng!==''){const link=document.createElement('a');link.className='gps-link';link.target='_blank';link.rel='noopener noreferrer';link.href='https://www.google.com/maps?q='+encodeURIComponent(lat+','+lng);link.textContent=formatCoordinate(lat)+', '+formatCoordinate(lng)+' • ±'+Number(accuracy||0)+' m';td.appendChild(link);}}else td.textContent=value;tr.appendChild(td);});body.appendChild(tr);
    });
    const pageLabel=document.querySelector('[data-report-page]'),previous=document.querySelector('[data-report-prev]'),next=document.querySelector('[data-report-next]');if(pageLabel)pageLabel.textContent='หน้า '+state.reportPage+' / '+state.reportTotalPages;if(previous)previous.disabled=state.reportPage<=1;if(next)next.disabled=state.reportPage>=state.reportTotalPages;
  }

  async function exportVisitReport(){try{let page=1,all=[],result;do{result=await serverCall('report.export',reportFilters(page,500));all=all.concat(result.items);page++;}while(page<=result.totalPages);const headers=['VisitCode','VisitPlanId','CustomerCode','CustomerName','BranchCode','BranchName','Employee','Username','VisitType','PlannedStartAt','PlannedEndAt','Status','Purpose','Outcome','OrderAmount','OpportunityAmount','PurchaseProbability','InterestScore','CustomerPotentialScore','ProductInterestCount','CompetitorPrice','StoreStockQuantity','DisplayScore','DurationMinutes','CheckInAt','CheckInLatitude','CheckInLongitude','CheckInAccuracy','CheckOutAt','CheckOutLatitude','CheckOutLongitude','CheckOutAccuracy','Notes','FollowUpText','FollowUpAt','Version'];downloadCsv('visit_report_'+new Date().toISOString().slice(0,10)+'.csv',headers,all);toast('Export Report '+all.length+' รายการแล้ว');}catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}}

  async function openVisitPlans(){if(!hasPermission('VISIT_PLAN_VIEW'))return;const requestId=renderRoute('visitPlans','visit-plans-view');const body=document.getElementById('plan-table-body');if(body)body.innerHTML='<tr><td>กำลังเตรียม Visit Plan…</td></tr>';try{if(!state.visitPlanMeta){const result=await serverCall('visitPlan.bootstrap',visitPlanRequest(state.visitPlanPage||1,25));if(!isCurrentRoute('visitPlans',requestId,'plan-table-body'))return;state.visitPlanMeta=result.meta;bindVisitPlans();applyVisitPlanListResult(result.list);}else{bindVisitPlans();if(state.visitPlans.length)renderVisitPlanTable();await loadVisitPlans(state.visitPlanPage||1);}}catch(error){if(!isCurrentRoute('visitPlans',requestId))return;if(isSessionError(error))return expireSession();toast(friendlyMessage(error));await openDashboard();}}
  function bindVisitPlans(){document.querySelector('[data-plan-new]').hidden=!state.visitPlanMeta.canCreate;document.querySelector('[data-plan-template]').hidden=!state.visitPlanMeta.canImport;document.querySelector('[data-plan-import-label]').hidden=!state.visitPlanMeta.canImport;document.querySelector('[data-plan-export]').hidden=!state.visitPlanMeta.canExport;document.querySelector('[data-plan-new]').addEventListener('click',function(){state.selectedVisitPlan=null;state.visitPlanCustomerLines=[];openVisitPlanForm();});document.getElementById('plan-search').addEventListener('input',function(){window.clearTimeout(visitReloadTimer);visitReloadTimer=window.setTimeout(function(){loadVisitPlans(1);},800);});document.querySelector('[data-plan-prev]').addEventListener('click',function(){if(state.visitPlanPage>1)loadVisitPlans(state.visitPlanPage-1);});document.querySelector('[data-plan-next]').addEventListener('click',function(){if(state.visitPlanPage<state.visitPlanTotalPages)loadVisitPlans(state.visitPlanPage+1);});document.querySelector('[data-plan-template]').addEventListener('click',downloadVisitPlanTemplate);document.querySelector('[data-plan-export]').addEventListener('click',exportVisitPlans);document.getElementById('plan-import-file').addEventListener('change',importVisitPlanCsv);document.getElementById('visit-plan-form').addEventListener('submit',saveVisitPlanForm);document.querySelector('[data-plan-delete]').addEventListener('click',deleteSelectedVisitPlan);document.querySelector('[data-plan-close]').addEventListener('click',closeVisitPlanForm);document.getElementById('plan-customer-search').addEventListener('input',queueVisitPlanCustomerSearch);closeVisitPlanForm();}
  function downloadVisitPlanTemplate(){const headers=state.visitPlanMeta.importFields||state.visitPlanMeta.fields,guide={VisitPlanCode:'คำอธิบายภาษาไทย — รหัสแผน ห้ามซ้ำ เช่น VP26110001',CustomerId:'รหัสลูกค้าหรือรหัสชั่วคราว เช่น SM-000002-051',BranchId:'รหัสหรือชื่อย่อสาขา เช่น EBB',AssignedUserId:'Username หรือรหัสพนักงาน เช่น 67139',PurposeId:'รหัสหรือชื่อวัตถุประสงค์ เช่น SERVICE',StartAt:'วันเวลาเริ่ม เช่น 10/11/2026 09:00 หรือ 2026-11-10 09:00',EndAt:'วันเวลาสิ้นสุด หรือเว้นว่างเมื่อ UnlimitedEndDate=TRUE',UnlimitedEndDate:'ไม่มีกำหนดสิ้นสุด: TRUE หรือ FALSE',RecurrenceType:'ความถี่: ONCE / DAILY / WEEKLY / MONTHLY',RecurrenceInterval:'ทำซ้ำทุกกี่รอบ เช่น 1 (เว้นว่างจะใช้ 1)',TargetVisitCount:'จำนวน Visit เป้าหมายของลูกค้ารายนี้ เช่น 4 (เว้นว่างจะใช้ 1)',Status:'สถานะ: ACTIVE หรือ INACTIVE',Notes:'หมายเหตุ'};downloadCsv('visit_plan_template.csv',headers,[guide]);}
  function visitPlanRequest(page,pageSize){return{sessionToken:state.token,search:document.getElementById('plan-search').value,fieldFilters:state.visitPlanFilters,sortField:state.visitPlanSortField,sortDirection:state.visitPlanSortDirection,page:page,pageSize:pageSize||25};}
  function applyVisitPlanListResult(result){state.visitPlans=result.items;state.visitPlanPage=result.page;state.visitPlanTotalPages=result.totalPages;renderVisitPlanTable();}
  async function loadVisitPlans(page){const body=document.getElementById('plan-table-body');if(!body)return;body.innerHTML='<tr><td>กำลังโหลดแผน…</td></tr>';try{const result=await serverCall('visitPlan.list',visitPlanRequest(page,25));if(!document.getElementById('plan-table-body'))return;applyVisitPlanListResult(result);}catch(error){toast(friendlyMessage(error));}}
  function renderVisitPlanTable(){const meta=state.visitPlanMeta,head=document.getElementById('plan-table-head'),body=document.getElementById('plan-table-body'),header=document.createElement('tr'),filters=document.createElement('tr');filters.className='column-filter-row';meta.fields.forEach(function(field){const th=document.createElement('th'),button=document.createElement('button');button.type='button';button.className='sort-header';button.textContent=(meta.labels[field]||field)+(state.visitPlanSortField===field?(state.visitPlanSortDirection==='ASC'?' ▲':' ▼'):'');button.addEventListener('click',function(){if(state.visitPlanSortField===field)state.visitPlanSortDirection=state.visitPlanSortDirection==='ASC'?'DESC':'ASC';else{state.visitPlanSortField=field;state.visitPlanSortDirection='ASC';}loadVisitPlans(1);});th.appendChild(button);header.appendChild(th);const fh=document.createElement('th'),input=document.createElement('input');input.placeholder='กรอง';input.value=state.visitPlanFilters[field]||'';input.addEventListener('input',function(){state.visitPlanFilters[field]=input.value;window.clearTimeout(visitReloadTimer);visitReloadTimer=window.setTimeout(function(){loadVisitPlans(1);},800);});fh.appendChild(input);filters.appendChild(fh);});const actionHead=document.createElement('th'),actionFilter=document.createElement('th');actionHead.textContent='จัดการ';actionHead.className='plan-action-column';actionFilter.className='plan-action-column';header.appendChild(actionHead);filters.appendChild(actionFilter);head.replaceChildren(header,filters);body.replaceChildren();state.visitPlans.forEach(function(plan){const tr=document.createElement('tr');tr.className='visit-plan-row';meta.fields.forEach(function(field){const td=document.createElement('td'),displayField=field==='AssignedUserId'?'AssignedUser':(field==='PurposeId'?'Purpose':field),value=plan[displayField];td.textContent=value==null?'':(field.indexOf('At')!==-1?formatThaiDateTime(value):value);tr.appendChild(td);});const actionCell=document.createElement('td'),action=document.createElement('button');action.type='button';action.className='button button--ghost plan-action-button';action.textContent=meta.canEdit?'แก้ไข':'ดูรายละเอียด';action.addEventListener('click',function(event){event.stopPropagation();openExistingVisitPlan(plan);});actionCell.className='plan-action-column';actionCell.appendChild(action);tr.appendChild(actionCell);tr.addEventListener('click',function(){openExistingVisitPlan(plan);});body.appendChild(tr);});if(!state.visitPlans.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=meta.fields.length+1;td.textContent='ไม่พบ Visit Plan';tr.appendChild(td);body.appendChild(tr);}document.querySelector('[data-plan-page]').textContent='หน้า '+state.visitPlanPage+' / '+state.visitPlanTotalPages;document.querySelector('[data-plan-prev]').disabled=state.visitPlanPage<=1;document.querySelector('[data-plan-next]').disabled=state.visitPlanPage>=state.visitPlanTotalPages;}
  let visitPlanDetailRequestId=0;
  async function openExistingVisitPlan(plan){const requestId=++visitPlanDetailRequestId,detail=document.querySelector('[data-plan-detail]'),layout=detail&&detail.closest('.database-layout'),title=document.querySelector('[data-plan-form-title]'),fields=document.getElementById('plan-fields'),form=document.getElementById('visit-plan-form');if(!detail||!plan||!plan.VisitPlanId)return toast('ไม่พบรหัส Visit Plan');if(layout)layout.classList.add('detail-open');detail.hidden=false;if(title)title.textContent='กำลังโหลด '+String(plan.VisitPlanCode||'Visit Plan')+'…';if(fields)fields.innerHTML='<div class="detail-loading"><span class="spinner"></span><strong>กำลังโหลดรายละเอียดแผนและรายชื่อลูกค้า…</strong></div>';if(form){const submit=form.querySelector('[type="submit"]'),remove=form.querySelector('[data-plan-delete]');if(submit)submit.hidden=true;if(remove)remove.hidden=true;}window.scrollTo({top:0,behavior:'smooth'});try{const result=await serverCall('visitPlan.get',{sessionToken:state.token,visitPlanId:plan.VisitPlanId});if(requestId!==visitPlanDetailRequestId||state.currentRoute!=='visitPlans')return;state.selectedVisitPlan=result;state.visitPlanCustomerLines=(result.customerLines||[]).slice();renderVisitPlanForm();}catch(error){if(requestId!==visitPlanDetailRequestId)return;if(fields){const message=document.createElement('div');message.className='auth-error';message.textContent=friendlyMessage(error);fields.replaceChildren(message);}toast(friendlyMessage(error));}}
  function renderVisitPlanForm(){const meta=state.visitPlanMeta,item=state.selectedVisitPlan||{},host=document.getElementById('plan-fields');host.replaceChildren();document.querySelector('[data-plan-form-title]').textContent=state.selectedVisitPlan?'แก้ไข '+item.VisitPlanCode:'สร้าง Visit Plan';(meta.formFields||meta.fields).forEach(function(field){const label=document.createElement('label'),caption=document.createElement('span'),type=meta.types[field]||'text';label.className='field';caption.textContent=meta.labels[field]||field;label.appendChild(caption);let input;if(type==='textarea'){input=document.createElement('textarea');}else if(type==='boolean'){input=document.createElement('select');input.add(new Option('FALSE','FALSE'));input.add(new Option('TRUE','TRUE'));}else if(['user','purpose'].indexOf(type)!==-1){input=document.createElement('select');input.add(new Option('เลือก',''));(meta.lookups[type]||[]).forEach(function(x){input.add(new Option(x.code+' — '+x.name,x.id));});}else if(type==='recurrence'){input=document.createElement('select');['ONCE','DAILY','WEEKLY','MONTHLY'].forEach(function(x){input.add(new Option(x,x));});}else{input=document.createElement('input');input.type=type==='datetime'?'datetime-local':(type==='number'?'number':'text');}input.name=field;let value=item[field];if(type==='datetime')value=toLocalInput(value);input.value=value==null?'':value;input.disabled=state.selectedVisitPlan?!meta.canEdit:!meta.canCreate;label.appendChild(input);host.appendChild(label);});const form=document.getElementById('visit-plan-form'),editable=state.selectedVisitPlan?meta.canEdit:meta.canCreate;form.querySelector('[type="submit"]').hidden=!editable;form.querySelector('[data-plan-delete]').hidden=!state.selectedVisitPlan||!meta.canDelete;document.getElementById('plan-customer-search').disabled=!editable;renderVisitPlanCustomerLines();clearError(form);}
  let planCustomerSearchTimer=null;
  function queueVisitPlanCustomerSearch(event){window.clearTimeout(planCustomerSearchTimer);const query=event.target.value.trim(),results=document.querySelector('[data-plan-customer-results]'),status=document.querySelector('[data-plan-customer-search-status]');if(!query){results.hidden=true;results.replaceChildren();status.textContent='';return;}status.textContent='กำลังค้นหา…';planCustomerSearchTimer=window.setTimeout(function(){searchVisitPlanCustomers(query);},320);}
  async function searchVisitPlanCustomers(query){const results=document.querySelector('[data-plan-customer-results]'),status=document.querySelector('[data-plan-customer-search-status]');try{const response=await serverCall('visitPlan.customerSearch',{sessionToken:state.token,query:query,excludeIds:state.visitPlanCustomerLines.map(function(line){return line.CustomerId;})});if(!document.getElementById('plan-customer-search'))return;results.replaceChildren();response.items.forEach(function(customer){const button=document.createElement('button'),main=document.createElement('strong'),sub=document.createElement('span');button.type='button';button.className='plan-customer-result';main.textContent=(customer.temporaryCode||customer.code||'-')+' — '+customer.name;sub.textContent=[customer.branchCode,customer.branchShortName,customer.branchName,customer.phone].filter(Boolean).join(' · ');button.append(main,sub);button.addEventListener('click',function(){state.visitPlanCustomerLines.push({CustomerId:customer.id,CustomerCode:customer.code,TemporaryCustomerCode:customer.temporaryCode,CustomerName:customer.name,BranchId:customer.branchId,BranchCode:customer.branchCode,BranchShortName:customer.branchShortName,BranchName:customer.branchName,TargetVisitCount:1,Priority:'NORMAL',Notes:''});document.getElementById('plan-customer-search').value='';results.hidden=true;renderVisitPlanCustomerLines();});results.appendChild(button);});results.hidden=false;status.textContent=response.items.length?'เลือกจากผลลัพธ์ '+response.items.length+' ราย':'ไม่พบลูกค้า';}catch(error){status.textContent='';toast(friendlyMessage(error));}}
  function renderVisitPlanCustomerLines(){const host=document.querySelector('[data-plan-customer-lines]'),count=document.querySelector('[data-plan-customer-count]');if(!host)return;host.replaceChildren();count.textContent=state.visitPlanCustomerLines.length;if(!state.visitPlanCustomerLines.length){const empty=document.createElement('div');empty.className='plan-customer-empty';empty.textContent='ยังไม่มีลูกค้าในแผน — ค้นหาและเพิ่มอย่างน้อย 1 ราย';host.appendChild(empty);return;}const editable=state.selectedVisitPlan?state.visitPlanMeta.canEdit:state.visitPlanMeta.canCreate;state.visitPlanCustomerLines.forEach(function(line,index){const row=document.createElement('article');row.className='plan-customer-line';const identity=document.createElement('div'),name=document.createElement('strong'),branch=document.createElement('span');identity.className='plan-customer-identity';name.textContent=(line.TemporaryCustomerCode||line.CustomerCode||'-')+' — '+line.CustomerName;branch.textContent=[line.BranchCode,line.BranchShortName,line.BranchName].filter(Boolean).join(' · ');identity.append(name,branch);const targetLabel=document.createElement('label'),targetCaption=document.createElement('span'),target=document.createElement('input');targetCaption.textContent='จำนวน Visit เป้าหมาย';target.type='number';target.min='1';target.value=line.TargetVisitCount||1;target.disabled=!editable;target.addEventListener('change',function(){line.TargetVisitCount=Math.max(1,Number(target.value)||1);});targetLabel.append(targetCaption,target);const priorityLabel=document.createElement('label'),priorityCaption=document.createElement('span'),priority=document.createElement('select');priorityCaption.textContent='ความสำคัญ';['LOW','NORMAL','HIGH','URGENT'].forEach(function(value){priority.add(new Option(value,value));});priority.value=line.Priority||'NORMAL';priority.disabled=!editable;priority.addEventListener('change',function(){line.Priority=priority.value;});priorityLabel.append(priorityCaption,priority);const notesLabel=document.createElement('label'),notesCaption=document.createElement('span'),notes=document.createElement('input');notesCaption.textContent='หมายเหตุรายลูกค้า';notes.value=line.Notes||'';notes.disabled=!editable;notes.addEventListener('input',function(){line.Notes=notes.value;});notesLabel.append(notesCaption,notes);const remove=document.createElement('button');remove.type='button';remove.className='icon-button plan-customer-remove';remove.textContent='×';remove.title='นำลูกค้าออกจากแผน';remove.disabled=!editable;remove.addEventListener('click',function(){state.visitPlanCustomerLines.splice(index,1);renderVisitPlanCustomerLines();});row.append(identity,targetLabel,priorityLabel,notesLabel,remove);host.appendChild(row);});}
  function openVisitPlanForm(){const detail=document.querySelector('[data-plan-detail]');if(!detail)return;const layout=detail.closest('.database-layout');if(layout)layout.classList.add('detail-open');detail.hidden=false;renderVisitPlanForm();window.scrollTo({top:0,behavior:'smooth'});}
  function closeVisitPlanForm(){visitPlanDetailRequestId++;const detail=document.querySelector('[data-plan-detail]'),layout=detail&&detail.closest('.database-layout');state.selectedVisitPlan=null;state.visitPlanCustomerLines=[];if(layout)layout.classList.remove('detail-open');if(detail)detail.hidden=true;window.scrollTo({top:0,behavior:'smooth'});}
  async function saveVisitPlanForm(event){event.preventDefault();const form=event.currentTarget,plan={};new FormData(form).forEach(function(v,k){plan[k]=v;});if(state.selectedVisitPlan)plan.VisitPlanId=state.selectedVisitPlan.VisitPlanId;setBusy(form,true,'กำลังบันทึก…');try{state.selectedVisitPlan=await serverCall('visitPlan.save',{sessionToken:state.token,plan:plan,customers:state.visitPlanCustomerLines,expectedVersion:state.selectedVisitPlan?state.selectedVisitPlan.Version:0});state.visitPlanCustomerLines=(state.selectedVisitPlan.customerLines||[]).slice();await loadVisitPlans(state.visitPlanPage);renderVisitPlanForm();toast('บันทึก Visit Plan '+state.visitPlanCustomerLines.length+' ลูกค้าแล้ว');}catch(error){showError(form,friendlyMessage(error));}finally{setBusy(form,false);}}
  async function deleteSelectedVisitPlan(){if(!state.selectedVisitPlan||!window.confirm('ยืนยันลบ Visit Plan?'))return;try{await serverCall('visitPlan.delete',{sessionToken:state.token,visitPlanId:state.selectedVisitPlan.VisitPlanId});closeVisitPlanForm();await loadVisitPlans(1);toast('ลบแผนแล้ว');}catch(error){toast(friendlyMessage(error));}}
  async function exportVisitPlans(){try{const result=await serverCall('visitPlan.export',{sessionToken:state.token});downloadCsv('visit_plan_export.csv',result.headers,result.rows);toast('Export '+result.rows.length+' รายการลูกค้าแล้ว');}catch(error){toast(friendlyMessage(error));}}
  async function importVisitPlanCsv(event){const file=event.target.files[0];event.target.value='';if(!file)return;try{const rows=parseCsv(await file.text()),headers=rows.shift().map(function(x){return String(x).trim();});state.planImportRows=rows.filter(function(row){const first=String(row[0]||'').trim();return first.indexOf('คำอธิบายภาษาไทย')!==0&&row.some(function(x){return String(x).trim()!=='';});}).map(function(row){const o={};headers.forEach(function(h,i){o[h]=row[i]||'';});return o;});if(!state.planImportRows.length)throw new Error('กรุณาเพิ่มข้อมูลใต้แถวคำอธิบายภาษาไทยก่อน Import');openPlanImportPreview();}catch(error){toast(friendlyMessage(error));}}
  function openPlanImportPreview(){const template=document.getElementById('import-preview-template'),node=template.content.cloneNode(true);document.body.appendChild(node);const modal=document.querySelector('.modal-backdrop');modal.querySelector('[data-import-close]').addEventListener('click',closeImportPreview);modal.querySelector('[data-import-cancel]').addEventListener('click',closeImportPreview);modal.querySelector('[data-import-preview]').addEventListener('click',previewPlanImport);modal.querySelector('[data-import-commit]').addEventListener('click',commitPlanImport);previewPlanImport();}
  async function previewPlanImport(){const modal=document.querySelector('.modal-backdrop'),body=modal&&modal.querySelector('#import-preview-body'),head=modal&&modal.querySelector('#import-preview-head'),summary=modal&&modal.querySelector('#import-preview-summary'),commit=modal&&modal.querySelector('[data-import-commit]');if(body){if(head)head.replaceChildren();if(summary)summary.replaceChildren();const tr=document.createElement('tr'),td=document.createElement('td');td.textContent='กำลังตรวจสอบ '+state.planImportRows.length+' แถว กรุณารอสักครู่…';tr.appendChild(td);body.replaceChildren(tr);}if(commit)commit.disabled=true;try{const result=await serverCall('visitPlan.previewImport',{sessionToken:state.token,rows:state.planImportRows,mode:modal.querySelector('[data-import-mode]').value,blankPolicy:modal.querySelector('[data-import-blank]').value,errorPolicy:modal.querySelector('[data-import-error-policy]').value});state.planImportBatch=result;renderGenericImportPreview(result,state.visitPlanMeta.importFields||state.visitPlanMeta.fields,state.visitPlanMeta.labels);}catch(error){if(body){const tr=document.createElement('tr'),td=document.createElement('td');td.textContent=friendlyMessage(error);tr.appendChild(td);body.replaceChildren(tr);}toast(friendlyMessage(error));}}
  function renderGenericImportPreview(result,fields,labels){const modal=document.querySelector('.modal-backdrop');if(!modal)return;const summary=modal.querySelector('#import-preview-summary'),head=modal.querySelector('#import-preview-head'),body=modal.querySelector('#import-preview-body');if(!summary||!head||!body)return;const filters=[['ALL',result.rows.length],['CREATE',result.counts.CREATE],['UPDATE',result.counts.UPDATE],['NO_CHANGE',result.counts.NO_CHANGE],['ERROR',result.counts.ERROR]];summary.replaceChildren();function renderRows(filter){summary.querySelectorAll('.import-summary-filter').forEach(function(button){button.classList.toggle('is-active',button.dataset.filter===filter);});body.replaceChildren();const rows=filter==='ALL'?result.rows:result.rows.filter(function(item){return String(item.operation).replace(/\s+/g,'_')===filter;});rows.forEach(function(item){const tr=document.createElement('tr');if(item.operation==='ERROR')tr.className='import-row-error';[item.rowNumber,item.operation,item.error].concat(fields.map(function(field){return item.record[field];})).forEach(function(v){const td=document.createElement('td');td.textContent=v==null?'':v;tr.appendChild(td);});body.appendChild(tr);});if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=fields.length+3;td.textContent='ไม่มีรายการในกลุ่มนี้';tr.appendChild(td);body.appendChild(tr);}}filters.forEach(function(item){const card=document.createElement('button');card.type='button';card.className='panel report-summary-card import-summary-filter';card.dataset.filter=item[0];card.innerHTML='<strong></strong><span></span>';card.querySelector('strong').textContent=item[1];card.querySelector('span').textContent=item[0]==='ALL'?'ทั้งหมด':item[0].replace('_',' ');card.addEventListener('click',function(){renderRows(item[0]);});summary.appendChild(card);});const hr=document.createElement('tr');['แถว','ผล','Error'].concat(fields).forEach(function(field,index){const th=document.createElement('th');th.textContent=index<3?field:(labels[field]||field);hr.appendChild(th);});head.replaceChildren(hr);renderRows('ALL');modal.querySelector('[data-import-commit]').disabled=result.counts.ERROR>0&&modal.querySelector('[data-import-error-policy]').value==='ALL_OR_NONE';}
  async function commitPlanImport(){try{const result=await serverCall('visitPlan.commitImport',{sessionToken:state.token,batchId:state.planImportBatch.batchId});closeImportPreview();await loadVisitPlans(1);toast('Import Visit Plan '+result.committed+' รายการ');}catch(error){toast(friendlyMessage(error));}}

  async function openVisits() {
    const requestId=renderRoute('visits','visits-view');
    const body=document.getElementById('visit-table-body');if(body)body.innerHTML='<tr><td colspan="6">กำลังเตรียม Visit…</td></tr>';
    try{
      // Do not let the browser restore an old employee selection when the
      // route is rebuilt; the initial Visit view must show every visible task.
      document.getElementById('visit-status-filter').value='CURRENT';
      document.getElementById('visit-employee-filter').value='';
      document.getElementById('visit-date-from').value='';
      document.getElementById('visit-date-to').value='';
      if(!state.visitMeta){
        const result=await serverCall('visit.bootstrap',visitFilters(1));
        if(!isCurrentRoute('visits',requestId,'visit-table-body'))return;
        state.visitMeta=result.meta;bindVisits();applyVisitListResult(result.list);
      }else{
        bindVisits();if(state.visits.length)renderVisitTable();await loadVisits(1);
      }
    }catch(error){if(!isCurrentRoute('visits',requestId))return;if(isSessionError(error))return expireSession();toast(friendlyMessage(error));await openDashboard();}
  }

  function bindVisits(){
    const status=document.getElementById('visit-status-filter');state.visitMeta.statuses.forEach(function(value){status.add(new Option(value,value));});
    const employee=document.getElementById('visit-employee-filter');
    if(state.visitMeta.canReview||String(state.user.roleCode).toUpperCase()==='AUDITOR')state.visitMeta.users.forEach(function(user){employee.add(new Option(user.name+' — '+user.username,user.id));});else employee.hidden=true;
    document.querySelector('[data-visit-new]').hidden=String(state.user.roleCode).toUpperCase()==='AUDITOR';
    document.querySelector('[data-visit-export]').hidden=!hasPermission('REPORT_EXPORT');
    document.querySelector('[data-visit-new]').addEventListener('click',function(){try{state.selectedVisit=null;renderVisitEditor();}catch(error){toast(friendlyMessage(error));}});
    document.querySelector('[data-visit-export]').addEventListener('click',exportVisitsFromList);
    document.getElementById('visit-search').addEventListener('input',debounceVisitReload);
    ['visit-status-filter','visit-employee-filter','visit-date-from','visit-date-to'].forEach(function(id){document.getElementById(id).addEventListener('change',function(){loadVisits(1);});});
    document.querySelector('[data-visit-prev]').addEventListener('click',function(){if(state.visitPage>1)loadVisits(state.visitPage-1);});
    document.querySelector('[data-visit-next]').addEventListener('click',function(){if(state.visitPage<state.visitTotalPages)loadVisits(state.visitPage+1);});
  }

  let visitReloadTimer=null;
  function debounceVisitReload(){window.clearTimeout(visitReloadTimer);visitReloadTimer=window.setTimeout(function(){loadVisits(1);},800);}

  function visitFilters(page){return{sessionToken:state.token,search:document.getElementById('visit-search').value,status:document.getElementById('visit-status-filter').value,employeeUserId:document.getElementById('visit-employee-filter').value,dateFrom:document.getElementById('visit-date-from').value,dateTo:document.getElementById('visit-date-to').value,page:page,pageSize:25};}

  async function exportVisitsFromList(){
    try{
      let page=1,all=[],result;const base=visitFilters(1);
      do{result=await serverCall('report.export',Object.assign({},base,{page:page,pageSize:500}));all=all.concat(result.items);page++;}while(page<=result.totalPages);
      downloadCsv('visits_'+new Date().toISOString().slice(0,10)+'.csv',visitExportHeaders(),all);toast('Export Visit '+all.length+' รายการแล้ว');
    }catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  }

  function visitExportHeaders(){return['VisitCode','VisitPlanId','CustomerCode','CustomerName','BranchCode','BranchName','Employee','Username','VisitType','PlannedStartAt','PlannedEndAt','Status','Purpose','Outcome','OrderAmount','OpportunityAmount','PurchaseProbability','InterestScore','CustomerPotentialScore','ProductInterestCount','CompetitorPrice','StoreStockQuantity','DisplayScore','DurationMinutes','CheckInAt','CheckInLatitude','CheckInLongitude','CheckInAccuracy','CheckOutAt','CheckOutLatitude','CheckOutLongitude','CheckOutAccuracy','Notes','FollowUpText','FollowUpAt','Version'];}

  function applyVisitListResult(result){state.visits=result.items;state.visitPage=result.page;state.visitTotalPages=result.totalPages;renderVisitTable();}

  async function loadVisits(page){
    const body=document.getElementById('visit-table-body');const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='กำลังโหลด Visit…';tr.appendChild(td);body.replaceChildren(tr);
    try{const result=await serverCall('visit.list',visitFilters(page));if(!document.getElementById('visit-table-body'))return;applyVisitListResult(result);}
    catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  }

  function renderVisitTable(){
    const body=document.getElementById('visit-table-body');if(!body)return;body.replaceChildren();
    if(!state.visits.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='ยังไม่มี Visit ตามตัวกรอง';tr.appendChild(td);body.appendChild(tr);}
    state.visits.forEach(function(visit){
      const tr=document.createElement('tr');tr.className='visit-row';tr.tabIndex=0;tr.setAttribute('role','button');tr.setAttribute('aria-label','เปิด '+visit.visitCode);
      [visit.visitCode,visit.customerCode+' — '+visit.customerName,visit.employeeName,formatThaiDateTime(visit.plannedStartAt),visit.visitType,visit.status].forEach(function(value,index){
        const td=document.createElement('td');
        if(index===0){const button=document.createElement('button');button.type='button';button.className='visit-open-button';button.textContent=value;button.addEventListener('click',function(event){event.stopPropagation();openVisitFromList(visit);});td.appendChild(button);}
        else if(index===5){const badge=document.createElement('span');badge.className='status-badge '+visitStatusClass(value);badge.textContent=value;td.appendChild(badge);}
        else td.textContent=value;
        tr.appendChild(td);
      });
      tr.addEventListener('click',function(){openVisitFromList(visit);});
      tr.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();openVisitFromList(visit);}});
      body.appendChild(tr);
    });
    document.querySelector('[data-visit-page]').textContent='หน้า '+state.visitPage+' / '+state.visitTotalPages;document.querySelector('[data-visit-prev]').disabled=state.visitPage<=1;document.querySelector('[data-visit-next]').disabled=state.visitPage>=state.visitTotalPages;
  }

  function openVisitFromList(visit){
    try{state.selectedVisit=visit;renderVisitEditor();}
    catch(error){toast('ไม่สามารถเปิด Visit ได้: '+friendlyMessage(error));}
  }

  function renderVisitEditor(){
    const host=document.getElementById('visit-detail-host'),template=document.getElementById('visit-editor-template');if(!host||!template)return;host.replaceChildren(template.content.cloneNode(true));host.hidden=false;host.scrollIntoView({behavior:'smooth',block:'start'});
    const form=document.getElementById('visit-form'),visit=state.selectedVisit;
    document.querySelector('[data-visit-editor-title]').textContent=visit?(visit.visitCode+' • '+visit.status):'สร้าง Visit ใหม่';
    fillVisitSelect(form.elements.VisitPlanId,state.visitMeta.plans||[],'Unplanned Visit',function(x){return x.code;});
    setupVisitCustomerPicker(form,visit);
    fillVisitSelect(form.elements.PurposeId,state.visitMeta.purposes,'เลือกวัตถุประสงค์',function(x){return x.code+' — '+x.name;});
    const allowedUsers=state.visitMeta.canAssign?state.visitMeta.users:state.visitMeta.users.filter(function(x){return x.id===state.user.userId;});fillVisitSelect(form.elements.EmployeeUserId,allowedUsers,'เลือกพนักงาน',function(x){return x.name+' — '+x.username;});
    if(!state.visitMeta.canAssign)form.elements.EmployeeUserId.disabled=true;
    if(visit){form.elements.VisitPlanId.value=visit.visitPlanId||'';form.elements.CustomerId.value=visit.customerId;form.elements.EmployeeUserId.value=visit.employeeUserId;form.elements.VisitType.value=visit.visitPlanId?'PLANNED':(visit.visitType||'UNPLANNED');form.elements.PurposeId.value=visit.purposeId;form.elements.PlannedStartAt.value=toLocalInput(visit.plannedStartAt);form.elements.PlannedEndAt.value=toLocalInput(visit.plannedEndAt);form.elements.Notes.value=visit.notes;}
    else{form.elements.EmployeeUserId.value=state.user.userId;form.elements.VisitType.value='UNPLANNED';form.elements.PlannedStartAt.value=toLocalInput(new Date().toISOString());}
    form.elements.VisitPlanId.addEventListener('change',function(){const plan=(state.visitMeta.plans||[]).find(function(x){return x.id===form.elements.VisitPlanId.value;});if(plan){selectVisitCustomerByQuery(form,plan.customerId);form.elements.EmployeeUserId.value=plan.employeeUserId;form.elements.PurposeId.value=plan.purposeId;form.elements.PlannedStartAt.value=toLocalInput(plan.startAt);form.elements.PlannedEndAt.value=toLocalInput(plan.endAt);form.elements.VisitType.value='PLANNED';}else form.elements.VisitType.value='UNPLANNED';});
    const editable=!visit||['PLANNED','REVISION_REQUIRED'].indexOf(visit.status)!==-1;Array.from(form.elements).forEach(function(element){if(element.type!=='button'&&element.type!=='submit')element.disabled=!editable||(element.name==='EmployeeUserId'&&!state.visitMeta.canAssign)||element.name==='VisitType';});form.querySelector('[type="submit"]').hidden=!editable||String(state.user.roleCode).toUpperCase()==='AUDITOR';
    const startNow=form.querySelector('[data-visit-start-now]');if(startNow){startNow.hidden=!editable;startNow.addEventListener('click',function(){form.elements.PlannedStartAt.value=toLocalInput(new Date().toISOString());});}
    const cancel=form.querySelector('[data-visit-cancel]');cancel.hidden=!visit||['PLANNED','REVISION_REQUIRED'].indexOf(visit.status)===-1||String(state.user.roleCode).toUpperCase()==='AUDITOR';cancel.addEventListener('click',cancelSelectedVisit);
    form.addEventListener('submit',saveVisitForm);document.querySelector('[data-visit-close]').addEventListener('click',function(){host.hidden=true;host.replaceChildren();});
    renderVisitRuntime();
    if(visit&&visit.visitPlanId)loadVisitPlanContext(visit);
  }

  async function loadVisitPlanContext(visit){
    const editor=document.querySelector('.visit-editor');if(!editor)return;const section=document.createElement('section');section.className='visit-plan-context';section.dataset.visitPlanContext='';section.innerHTML='<div class="detail-loading"><span class="spinner"></span><strong>กำลังโหลดประวัติและรอบถัดไป…</strong></div>';editor.appendChild(section);
    try{const result=await serverCall('visit.context',{sessionToken:state.token,visitId:visit.visitId});if(!state.selectedVisit||state.selectedVisit.visitId!==visit.visitId||!document.querySelector('[data-visit-plan-context]'))return;renderVisitPlanContext(section,result);}
    catch(error){section.textContent='ไม่สามารถโหลดประวัติแผนได้: '+friendlyMessage(error);}
  }

  function renderVisitPlanContext(host,result){
    host.replaceChildren();const plan=result.plan;if(!plan)return;const head=document.createElement('div');head.className='visit-context-head';const title=document.createElement('div'),eyebrow=document.createElement('span'),heading=document.createElement('h4'),summary=document.createElement('p');eyebrow.className='eyebrow';eyebrow.textContent='VISIT PLAN';heading.textContent=plan.visitPlanCode+' • ตารางเข้าพบ';summary.textContent=plan.recurrenceType+' ทุก '+plan.recurrenceInterval+' รอบ • เป้าหมาย '+plan.targetVisitCount+' ครั้ง • แสดงกำหนดการสูงสุด 24 รอบ';title.append(eyebrow,heading,summary);head.appendChild(title);host.appendChild(head);
    const grid=document.createElement('div');grid.className='visit-context-grid';grid.appendChild(buildVisitContextList('กำหนดการจากแผน',result.schedule,true));grid.appendChild(buildVisitContextList('ประวัติที่ดำเนินการแล้ว',result.history,false));host.appendChild(grid);
  }

  function buildVisitContextList(title,items,isSchedule){const panel=document.createElement('article'),heading=document.createElement('h5'),list=document.createElement('div');panel.className='visit-context-panel';heading.textContent=title;list.className='visit-context-list';panel.append(heading,list);if(!items.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='ยังไม่มีข้อมูล';list.appendChild(empty);return panel;}items.forEach(function(item){const row=document.createElement('div'),main=document.createElement('span'),status=document.createElement('strong');main.textContent=(item.visitCode?item.visitCode+' • ':'')+formatThaiDateTime(item.plannedStartAt);status.textContent=item.status==='FUTURE'?'กำหนดการล่วงหน้า':item.status;status.className=item.status==='FUTURE'?'future-status':'';row.append(main,status);list.appendChild(row);});return panel;}

  function fillVisitSelect(select,items,firstLabel,labeler){select.replaceChildren(new Option(firstLabel,''));items.forEach(function(item){select.add(new Option(labeler(item),item.id));});}

  let visitCustomerSearchTimer=null;
  function setupVisitCustomerPicker(form,visit){const search=document.getElementById('visit-customer-search'),results=document.querySelector('[data-visit-customer-results]'),status=document.querySelector('[data-visit-customer-status]');if(!search||!results)return;if(visit){search.value=(visit.customerCode||'')+' — '+(visit.customerName||'');status.textContent='เลือกลูกค้าแล้ว';}search.addEventListener('input',function(){form.elements.CustomerId.value='';status.textContent='';results.hidden=true;results.replaceChildren();window.clearTimeout(visitCustomerSearchTimer);const query=search.value.trim();if(!query)return;status.textContent='กำลังค้นหา…';visitCustomerSearchTimer=window.setTimeout(function(){loadVisitCustomerChoices(form,query);},300);});}
  async function loadVisitCustomerChoices(form,query){const search=document.getElementById('visit-customer-search'),results=document.querySelector('[data-visit-customer-results]'),status=document.querySelector('[data-visit-customer-status]');if(!search||!results)return;try{const response=await serverCall('visitPlan.customerSearch',{sessionToken:state.token,query:query,excludeIds:[]});if(!document.getElementById('visit-customer-search'))return;results.replaceChildren();response.items.forEach(function(customer){const button=document.createElement('button'),main=document.createElement('strong'),sub=document.createElement('span');button.type='button';button.className='plan-customer-result';main.textContent=(customer.temporaryCode||customer.code||'-')+' — '+customer.name;sub.textContent=[customer.branchShortName,customer.branchName,customer.phone].filter(Boolean).join(' · ');button.append(main,sub);button.addEventListener('click',function(){form.elements.CustomerId.value=customer.id;search.value=main.textContent;status.textContent='เลือกลูกค้าแล้ว';results.hidden=true;});results.appendChild(button);});results.hidden=false;status.textContent=response.items.length?'เลือกจากผลลัพธ์ '+response.items.length+' ราย':'ไม่พบลูกค้า';}catch(error){status.textContent='';toast(friendlyMessage(error));}}
  async function selectVisitCustomerByQuery(form,query){const search=document.getElementById('visit-customer-search'),status=document.querySelector('[data-visit-customer-status]');if(!query||!search)return;search.value='กำลังค้นหาลูกค้า…';try{const response=await serverCall('visitPlan.customerSearch',{sessionToken:state.token,query:query,excludeIds:[]}),customer=(response.items||[]).find(function(item){return item.id===query;})||(response.items||[])[0];if(customer){form.elements.CustomerId.value=customer.id;search.value=(customer.temporaryCode||customer.code||'-')+' — '+customer.name;if(status)status.textContent='เลือกลูกค้าแล้ว';}else{form.elements.CustomerId.value='';search.value='';if(status)status.textContent='ไม่พบลูกค้าในแผน';}}catch(error){form.elements.CustomerId.value='';search.value='';toast(friendlyMessage(error));}}

  async function saveVisitForm(event){event.preventDefault();const form=event.currentTarget;if(state.busy)return;clearError(form);if(!form.elements.CustomerId.value)return showError(form,'กรุณาค้นหาและเลือกลูกค้าจากผลลัพธ์');const values={};new FormData(form).forEach(function(value,key){values[key]=value;});if(form.elements.EmployeeUserId.disabled)values.EmployeeUserId=state.user.userId;if(state.selectedVisit)values.VisitId=state.selectedVisit.visitId;setBusy(form,true,'กำลังบันทึก…');try{state.selectedVisit=await serverCall('visit.save',{sessionToken:state.token,visit:values,expectedVersion:state.selectedVisit?state.selectedVisit.version:0});renderVisitEditor();toast('บันทึก Visit เรียบร้อย');loadVisits(state.visitPage).catch(function(error){toast(friendlyMessage(error));});}catch(error){if(isSessionError(error))return expireSession();showError(form,friendlyMessage(error));}finally{setBusy(form,false);}}

  function renderVisitRuntime(){
    const host=document.querySelector('[data-visit-runtime]'),visit=state.selectedVisit;if(!host)return;if(!visit){host.hidden=true;return;}host.hidden=false;host.replaceChildren();
    const title=document.createElement('h4');title.textContent='การดำเนินการ Visit';host.appendChild(title);
    const timeline=document.createElement('div');timeline.className='visit-timeline';(visit.events||[]).forEach(function(event){const item=document.createElement('div'),strong=document.createElement('strong'),content=document.createElement('div'),span=document.createElement('span'),gps=document.createElement('a');strong.textContent=event.eventType;span.textContent=formatThaiDateTime(event.occurredAt)+' • ความแม่นยำ '+event.accuracyMeters+' เมตร';gps.className='gps-link';gps.target='_blank';gps.rel='noopener noreferrer';gps.href='https://www.google.com/maps?q='+encodeURIComponent(event.latitude+','+event.longitude);gps.textContent='Latitude '+formatCoordinate(event.latitude)+'  Longitude '+formatCoordinate(event.longitude)+'  ↗ เปิดแผนที่';content.className='visit-event-content';content.append(span,gps);item.append(strong,content);timeline.appendChild(item);});(visit.reviews||[]).forEach(function(review){const item=document.createElement('div'),strong=document.createElement('strong'),span=document.createElement('span'),p=document.createElement('p');strong.textContent=review.decision;span.textContent=formatThaiDateTime(review.reviewedAt)+' • '+review.reviewerName;p.textContent=review.comment;item.append(strong,span,p);timeline.appendChild(item);});if(timeline.children.length)host.appendChild(timeline);
    const own=visit.employeeUserId===state.user.userId,canOperate=String(state.user.roleCode).toUpperCase()!=='AUDITOR'&&(own||state.visitMeta.canReview);
    if(visit.status==='PLANNED'&&canOperate){const button=visitActionButton('Check-in พร้อม GPS','primary');button.addEventListener('click',function(){runVisitGpsAction('visit.checkIn',{visitId:visit.visitId},'Check-in สำเร็จ');});host.appendChild(button);}
    if(visit.status==='CHECKED_IN'&&canOperate)host.appendChild(buildCheckOutForm());
    if(visit.status==='COMPLETED'&&state.visitMeta.canReview)host.appendChild(buildReviewForm());
    else if(visit.status==='COMPLETED'){const p=document.createElement('p');p.className='muted';p.textContent='บันทึกผลแล้ว กำลังรอ Manager Review';host.appendChild(p);}
  }

  function visitActionButton(label,kind){const button=document.createElement('button');button.type='button';button.className='button button--'+(kind||'ghost');button.textContent=label;return button;}

  function buildCheckOutForm(){
    const form=document.createElement('form');form.className='visit-action-form visit-analytics-form';
    const fields=[['outcomeId','ผลการเข้าพบ','select',state.visitMeta.outcomes],['OrderAmount','มูลค่าคำสั่งซื้อ','number'],['OpportunityAmount','มูลค่าโอกาสขาย','number'],['PurchaseProbability','โอกาสสั่งซื้อ 0–100%','number'],['InterestScore','ความสนใจ 1–5','number'],['CustomerPotentialScore','ศักยภาพลูกค้า 1–5','number'],['ProductInterestCount','จำนวนสินค้าที่สนใจ','number'],['CategoryId','Category','select',state.visitMeta.categories],['BrandId','Brand','select',state.visitMeta.brands],['CompetitorId','Competitor','select',state.visitMeta.competitors],['CompetitorPrice','ราคาคู่แข่ง','number'],['StoreStockQuantity','จำนวนสต็อกหน้าร้าน','number'],['DisplayScore','Display Score 0–100','number'],['PromotionId','Promotion','select',state.visitMeta.promotions],['followUpText','งานที่ต้องติดตาม','text'],['followUpAt','วัน Follow-up','datetime-local'],['notes','รายละเอียดผลการเข้าพบ','textarea']];
    fields.forEach(function(def){const label=document.createElement('label'),caption=document.createElement('span');label.className='field';caption.textContent=def[1];label.appendChild(caption);let input;if(def[2]==='select'){input=document.createElement('select');fillVisitSelect(input,def[3]||[],'ไม่ระบุ',function(x){return x.code+' — '+x.name;});}else if(def[2]==='textarea'){input=document.createElement('textarea');label.classList.add('field--wide');}else{input=document.createElement('input');input.type=def[2];if(def[2]==='number')input.step='0.01';}input.name=def[0];if(def[0]==='outcomeId')input.required=true;label.appendChild(input);form.appendChild(label);});
    const submit=visitActionButton('Check-out และบันทึกผล','primary');submit.type='submit';form.appendChild(submit);form.addEventListener('submit',function(event){event.preventDefault();const payload={visitId:state.selectedVisit.visitId};new FormData(form).forEach(function(value,key){payload[key]=value;});runVisitGpsAction('visit.checkOut',payload,'Check-out และบันทึกผลสำเร็จ');});return form;
  }

  function buildReviewForm(){const form=document.createElement('form');form.className='visit-action-form visit-review-form';const decision=document.createElement('select');decision.name='decision';decision.add(new Option('อนุมัติ','APPROVED'));decision.add(new Option('ขอแก้ไข','REVISION_REQUESTED'));const comment=document.createElement('textarea');comment.name='comment';comment.placeholder='ความเห็นของ Manager';const submit=visitActionButton('บันทึก Review','primary');submit.type='submit';form.append(decision,comment,submit);form.addEventListener('submit',async function(event){event.preventDefault();submit.disabled=true;submit.textContent='กำลังบันทึก…';try{state.selectedVisit=await serverCall('visit.review',{sessionToken:state.token,visitId:state.selectedVisit.visitId,decision:decision.value,comment:comment.value});renderVisitEditor();toast('บันทึก Review แล้ว');loadVisits(state.visitPage).catch(function(error){toast(friendlyMessage(error));});}catch(error){submit.disabled=false;submit.textContent='บันทึก Review';toast(friendlyMessage(error));}});return form;}

  async function runVisitGpsAction(action,payload,successMessage){try{toast('กำลังอ่านตำแหน่ง GPS…');const point=await currentGpsPoint();state.selectedVisit=await serverCall(action,Object.assign({sessionToken:state.token},payload,point));renderVisitEditor();toast(successMessage);loadVisits(state.visitPage).catch(function(error){toast(friendlyMessage(error));});}catch(error){toast(friendlyMessage(error));}}

  function currentGpsPoint(){return new Promise(function(resolve,reject){if(!navigator.geolocation)return reject({code:'GPS_REQUIRED',message:'อุปกรณ์ไม่รองรับ GPS'});navigator.geolocation.getCurrentPosition(function(position){resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMeters:position.coords.accuracy});},function(error){reject({code:'GPS_REQUIRED',message:error.code===1?'กรุณาอนุญาตการเข้าถึงตำแหน่ง':'ไม่สามารถอ่านตำแหน่ง GPS ได้ภายในเวลาที่กำหนด'});},{enableHighAccuracy:true,timeout:8000,maximumAge:120000});});}

  async function cancelSelectedVisit(){if(!state.selectedVisit||!window.confirm('ยืนยันการยกเลิก Visit นี้?'))return;try{state.selectedVisit=await serverCall('visit.cancel',{sessionToken:state.token,visitId:state.selectedVisit.visitId});await loadVisits(state.visitPage);renderVisitEditor();toast('ยกเลิก Visit แล้ว');}catch(error){toast(friendlyMessage(error));}}

  function visitStatusClass(status){return['REVIEWED','COMPLETED'].indexOf(status)!==-1?'status-badge--active':status==='CANCELLED'?'status-badge--inactive':'status-badge--pending';}
  function formatCoordinate(value){const number=Number(value);return isFinite(number)?number.toFixed(6):'-';}
  function formatThaiDateTime(value){if(!value)return'-';const date=new Date(value);return isNaN(date.getTime())?'-':date.toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'});}
  function toLocalInput(value){if(!value)return'';const date=new Date(value);if(isNaN(date.getTime()))return'';const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);return local.toISOString().slice(0,16);}

  async function openDatabase() {
    if (!state.user || roleRankClient(state.user.roleCode) < roleRankClient('MANAGER')) return toast('เฉพาะ Manager หรือ Admin เท่านั้น');
    const requestId=renderRoute('database','database-view');
    renderDatabaseTabsPlaceholder();
    const body=document.getElementById('db-table-body');if(body)body.innerHTML='<tr><td colspan="20">กำลังเตรียม Database…</td></tr>';
    try {
      if (!state.databaseMeta) {
        const result=await serverCall('database.bootstrap',databaseFilters(1,state.databasePageSize));
        if(!isCurrentRoute('database',requestId,'db-table-body'))return;
        state.databaseMeta=result.meta;bindDatabase();applyDatabasePageResult(result.list);
      }else{
        bindDatabase();await loadDatabasePage(1);
      }
    } catch (error) {
      if(!isCurrentRoute('database',requestId))return;
      if (isSessionError(error)) return expireSession();
      state.databaseMeta=null;
      const message=friendlyMessage(error),errorBody=document.getElementById('db-table-body');
      if(errorBody){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=20;td.textContent=message;tr.appendChild(td);errorBody.replaceChildren(tr);}
      toast(message);
    }
  }

  function renderDatabaseTabsPlaceholder(){const tabs=document.getElementById('db-entity-tabs'),names=['01.Branch','02.Target','03.Customer Level','04.Sales Representative & Executive','05.Customer','06.Category','07.Brand','08.Competitors','09.Special LTO & Local Promotion'];if(!tabs)return;tabs.replaceChildren();names.forEach(function(name,index){const button=document.createElement('button');button.type='button';button.textContent=name;button.disabled=true;if(index===0)button.classList.add('is-active');tabs.appendChild(button);});}

  function bindDatabase() {
    const tabs=document.getElementById('db-entity-tabs'),names={branch:'01.Branch',target:'02.Target',customerLevel:'03.Customer Level',salesProfile:'04.Sales Representative & Executive',customer:'05.Customer',category:'06.Category',brand:'07.Brand',competitor:'08.Competitors',promotion:'09.Special LTO & Local Promotion'};
    tabs.replaceChildren();state.databaseMeta.order.forEach(function(key){const button=document.createElement('button');button.type='button';button.dataset.dbEntity=key;button.textContent=names[key]||key;tabs.appendChild(button);});
    if(!state.databaseMeta.entities[state.databaseEntity])state.databaseEntity=state.databaseMeta.order[0];
    document.querySelectorAll('[data-db-entity]').forEach(function(button){
      button.classList.toggle('is-active', button.dataset.dbEntity === state.databaseEntity);
      button.addEventListener('click', async function(){
        state.databaseEntity = button.dataset.dbEntity; state.databaseSelected = null;state.databaseFilters={};state.databaseSortField='';state.databaseSortDirection='ASC';
        document.querySelectorAll('[data-db-entity]').forEach(function(item){ item.classList.toggle('is-active', item === button); });
        configureDatabaseView(); await loadDatabasePage(1);
      });
    });
    configureDatabaseView();
    document.getElementById('db-search').addEventListener('input', debounceDatabaseReload);
    document.querySelector('[data-db-new]').addEventListener('click', function(){ state.databaseSelected = null; openDatabaseFormPanel(); });
    document.querySelector('[data-db-prev]').addEventListener('click', function(){ if(state.databasePage > 1) loadDatabasePage(state.databasePage - 1); });
    document.querySelector('[data-db-next]').addEventListener('click', function(){ if(state.databasePage < state.databaseTotalPages) loadDatabasePage(state.databasePage + 1); });
    const pageSizeSelect=document.querySelector('[data-db-page-size]');pageSizeSelect.value=String(state.databasePageSize);pageSizeSelect.addEventListener('change',function(){const value=Number(pageSizeSelect.value);state.databasePageSize=[25,50,100,300,500,1000].indexOf(value)!==-1?value:25;try{localStorage.setItem('spp.database.pageSize',String(state.databasePageSize));}catch(error){}loadDatabasePage(1);});
    const rowHeightSelect=document.querySelector('[data-db-row-height]');rowHeightSelect.value=String(state.databaseRowHeight);rowHeightSelect.addEventListener('change',function(){const value=Number(rowHeightSelect.value);state.databaseRowHeight=[40,52,64,80].indexOf(value)!==-1?value:52;try{localStorage.setItem('spp.database.rowHeight',String(state.databaseRowHeight));}catch(error){}applyDatabaseRowHeight();});applyDatabaseRowHeight();
    document.querySelector('[data-db-template]').addEventListener('click', downloadDatabaseTemplate);
    document.querySelector('[data-db-export]').addEventListener('click', exportFilteredDatabase);
    document.getElementById('db-import-file').addEventListener('change', importDatabaseCsv);
    document.getElementById('database-form').addEventListener('submit', saveDatabaseForm);
    document.querySelector('[data-db-delete]').addEventListener('click',deleteSelectedDatabaseRecord);
    document.querySelector('[data-db-close]').addEventListener('click',closeDatabaseFormPanel);
  }

  let databaseReloadTimer = null;
  function debounceDatabaseReload(){ window.clearTimeout(databaseReloadTimer); databaseReloadTimer = window.setTimeout(function(){ loadDatabasePage(1); }, 800); }

  function configureDatabaseView() {
    const names = {branch:'Branch',target:'Target',customerLevel:'Customer Level',salesProfile:'Sales Representative & Executive',customer:'Customer',category:'Category',brand:'Brand',competitor:'Competitors',promotion:'Special LTO & Local Promotion'};
    const schema=state.databaseMeta.entities[state.databaseEntity];
    document.querySelector('[data-db-title]').textContent = names[state.databaseEntity];
    document.querySelector('[data-db-new]').hidden=!schema.canCreate;document.querySelector('[data-db-template]').hidden=!schema.canImport;document.getElementById('db-import-file').parentElement.hidden=!schema.canImport;document.querySelector('[data-db-export]').hidden=!schema.canExport;
    closeDatabaseFormPanel();
  }

  function fillDatabaseSelect(select, items, firstLabel) {
    const selected = select.value;
    select.replaceChildren(new Option(firstLabel, ''));
    (items || []).forEach(function(item){ select.add(new Option(item.code + ' — ' + item.name, item.id)); });
    select.value = selected;
  }

  function databaseFilters(page, pageSize) {
    return { sessionToken:state.token, entity:state.databaseEntity, search:document.getElementById('db-search').value,fieldFilters:state.databaseFilters,sortField:state.databaseSortField,sortDirection:state.databaseSortDirection,page:page || 1, pageSize:pageSize || state.databasePageSize };
  }

  async function loadDatabasePage(page) {
    const body = document.getElementById('db-table-body');
    if (!body) return;
    body.replaceChildren();
    const loading = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 20; cell.textContent = 'กำลังโหลดข้อมูล…'; loading.appendChild(cell); body.appendChild(loading);
    try {
      const result = await serverCall('database.list', databaseFilters(page, state.databasePageSize));
      if (!document.getElementById('db-table-body')) return;
      applyDatabasePageResult(result);
    } catch(error){ if(isSessionError(error)) return expireSession(); toast(friendlyMessage(error)); }
  }

  function applyDatabasePageResult(result){state.databaseItems=result.items;state.databasePage=result.page;state.databasePageSize=result.pageSize;state.databaseTotal=result.total;state.databaseTotalPages=result.totalPages;renderDatabaseTable();}

  function renderDatabaseTable() {
    const schema = state.databaseMeta.entities[state.databaseEntity];
    const head = document.getElementById('db-table-head'); const body = document.getElementById('db-table-body'); const colgroup=document.getElementById('db-table-cols'); const table=document.querySelector('.database-table');
    if (!head || !body || !colgroup || !table) return;
    colgroup.replaceChildren();let totalWidth=0;schema.fields.forEach(function(field){const col=document.createElement('col'),width=databaseColumnWidth(field);col.dataset.dbCol=field;col.style.width=width+'px';colgroup.appendChild(col);totalWidth+=width;});table.style.width=Math.max(720,totalWidth)+'px';applyDatabaseRowHeight();
    const trh = document.createElement('tr'),trf=document.createElement('tr');trf.className='column-filter-row';
    schema.fields.forEach(function(field,index){ const th=document.createElement('th'),button=document.createElement('button'),handle=document.createElement('span');button.type='button';button.className='sort-header';button.textContent=(schema.labels[field]||field)+(state.databaseSortField===field?(state.databaseSortDirection==='ASC'?' ▲':' ▼'):'');button.addEventListener('click',function(){if(state.databaseSortField===field)state.databaseSortDirection=state.databaseSortDirection==='ASC'?'DESC':'ASC';else{state.databaseSortField=field;state.databaseSortDirection='ASC';}loadDatabasePage(1);});handle.className='column-resize-handle';handle.title='ลากเพื่อปรับความกว้างคอลัมน์';bindDatabaseColumnResizer(handle,field,index);th.append(button,handle);trh.appendChild(th);const filterTh=document.createElement('th'),filter=document.createElement('input');filter.placeholder='กรอง';filter.value=state.databaseFilters[field]||'';filter.addEventListener('input',function(){state.databaseFilters[field]=filter.value;debounceDatabaseReload();});filterTh.appendChild(filter);trf.appendChild(filterTh); });
    head.replaceChildren(trh,trf); body.replaceChildren();
    if (!state.databaseItems.length) { const tr=document.createElement('tr'); const td=document.createElement('td'); td.colSpan=schema.fields.length; td.textContent='ยังไม่มีข้อมูลตามตัวกรอง'; tr.appendChild(td); body.appendChild(tr); }
    state.databaseItems.forEach(function(item){
      const tr=document.createElement('tr'); tr.tabIndex=0;
      schema.fields.forEach(function(field){ const td=document.createElement('td'); td.textContent=databaseDisplayValue(field,item[field]); tr.appendChild(td); });
      tr.addEventListener('click', function(){ state.databaseSelected=item; openDatabaseFormPanel(); document.querySelectorAll('#db-table-body tr').forEach(function(row){row.classList.toggle('is-selected',row===tr);}); });
      body.appendChild(tr);
    });
    document.querySelector('[data-db-page]').textContent='หน้า '+state.databasePage+' / '+state.databaseTotalPages;
    document.querySelector('[data-db-total]').textContent='ทั้งหมด '+Number(state.databaseTotal||0).toLocaleString('th-TH')+' รายการ';
    document.querySelector('[data-db-page-size]').value=String(state.databasePageSize);
    document.querySelector('[data-db-prev]').disabled=state.databasePage<=1; document.querySelector('[data-db-next]').disabled=state.databasePage>=state.databaseTotalPages;
  }

  function applyDatabaseRowHeight(){const table=document.querySelector('.database-table'),select=document.querySelector('[data-db-row-height]');if(table)table.style.setProperty('--db-row-height',String(state.databaseRowHeight)+'px');if(select)select.value=String(state.databaseRowHeight);}

  function databaseDisplayValue(field, value) {
    const type=state.databaseMeta.entities[state.databaseEntity].types[field],items=state.databaseMeta.lookups[type]||[];if(items.length){const item=items.find(function(x){return x.id===String(value);});return item?item.code+' — '+item.name:String(value||'');}
    if (field === 'TargetAmount') return Number(value||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
    return String(value == null ? '' : value);
  }

  function renderDatabaseForm() {
    const schema=state.databaseMeta.entities[state.databaseEntity]; const item=state.databaseSelected||{}; const host=document.getElementById('db-fields'); host.replaceChildren();
    document.querySelector('[data-db-form-title]').textContent=state.databaseSelected?'แก้ไขข้อมูล':'เพิ่มข้อมูล';
    schema.fields.forEach(function(field){
      const label=document.createElement('label'); label.className='field'; const caption=document.createElement('span'); caption.textContent=(schema.labels[field]||field)+(schema.required.indexOf(field)!==-1?' *':''); label.appendChild(caption);
      const type=schema.types[field]||'text';let input;
      if(type==='textarea'){input=document.createElement('textarea');}
      else if(type==='boolean'){input=document.createElement('select');input.add(new Option('FALSE','FALSE'));input.add(new Option('TRUE','TRUE'));}
      else if(field==='Status'){input=document.createElement('select');input.add(new Option('ACTIVE','ACTIVE'));input.add(new Option('INACTIVE','INACTIVE'));}
      else if(['branch','customerLevel','user','category','brand','salesProfile'].indexOf(type)!==-1){input=document.createElement('select');input.add(new Option('ไม่ระบุ',''));(state.databaseMeta.lookups[type]||[]).forEach(function(x){input.add(new Option(x.code+' — '+x.name,x.id));});}
      else if(type==='position'){input=document.createElement('select');['REPRESENTATIVE','EXECUTIVE'].forEach(function(x){input.add(new Option(x,x));});}
      else if(type==='customerPrefix'){input=document.createElement('select');['คุณ','ร้านค้า','บจก.','หจก.','บมจ.','หสม.'].forEach(function(x){input.add(new Option(x,x));});}
      else if(type==='promotionType'){input=document.createElement('select');['LTO','LOCAL'].forEach(function(x){input.add(new Option(x,x));});}
      else{input=document.createElement('input');input.type=type==='date'?'date':(['number','decimal'].indexOf(type)!==-1?'number':'text');if(type==='decimal')input.step='0.01';}
      input.name=field;input.value=item[field] == null ? (field==='Status'?'ACTIVE':'') : item[field];input.required=schema.required.indexOf(field)!==-1;input.disabled=Boolean(state.databaseSelected&&!schema.canEdit)||Boolean(!state.databaseSelected&&!schema.canCreate);label.appendChild(input);host.appendChild(label);
    });
    document.getElementById('database-form').querySelector('[type="submit"]').hidden=state.databaseSelected?!schema.canEdit:!schema.canCreate;const deleteButton=document.querySelector('[data-db-delete]');deleteButton.hidden=!state.databaseSelected||!schema.canDelete;
    clearError(document.getElementById('database-form'));
  }

  function openDatabaseFormPanel(){const panel=document.querySelector('[data-db-detail]'),layout=document.querySelector('.database-layout');if(!panel)return;panel.hidden=false;if(layout)layout.classList.add('detail-open');renderDatabaseForm();panel.scrollIntoView({behavior:'smooth',block:'start'});}
  function closeDatabaseFormPanel(){const panel=document.querySelector('[data-db-detail]'),layout=document.querySelector('.database-layout');state.databaseSelected=null;if(panel)panel.hidden=true;if(layout)layout.classList.remove('detail-open');document.querySelectorAll('#db-table-body tr').forEach(function(row){row.classList.remove('is-selected');});}

  function databaseColumnStorageKey(field){return'spp.database.column.'+state.databaseEntity+'.'+field;}
  function databaseColumnWidth(field){try{const saved=Number(localStorage.getItem(databaseColumnStorageKey(field)));if(saved>=80&&saved<=600)return saved;}catch(error){}const type=state.databaseMeta.entities[state.databaseEntity].types[field]||'text';return['textarea','text'].indexOf(type)!==-1?180:130;}
  function bindDatabaseColumnResizer(handle,field,index){let startX=0,startWidth=0,dragging=false;function resize(event){if(!dragging)return;const col=document.querySelectorAll('#db-table-cols col')[index],table=document.querySelector('.database-table');if(!col||!table)return;const width=Math.max(80,Math.min(600,startWidth+event.clientX-startX));col.style.width=Math.round(width)+'px';const widths=Array.from(document.querySelectorAll('#db-table-cols col')).reduce(function(total,item){return total+(parseFloat(item.style.width)||130);},0);table.style.width=Math.max(720,widths)+'px';}function finish(){if(!dragging)return;dragging=false;handle.classList.remove('is-dragging');document.body.classList.remove('is-resizing-column');const col=document.querySelectorAll('#db-table-cols col')[index];if(col)try{localStorage.setItem(databaseColumnStorageKey(field),String(Math.round(parseFloat(col.style.width)||130)));}catch(error){}}handle.addEventListener('pointerdown',function(event){const col=document.querySelectorAll('#db-table-cols col')[index];if(!col)return;dragging=true;startX=event.clientX;startWidth=parseFloat(col.style.width)||col.getBoundingClientRect().width;handle.classList.add('is-dragging');document.body.classList.add('is-resizing-column');handle.setPointerCapture(event.pointerId);event.stopPropagation();event.preventDefault();});handle.addEventListener('pointermove',resize);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);handle.addEventListener('dblclick',function(event){try{localStorage.removeItem(databaseColumnStorageKey(field));}catch(error){}renderDatabaseTable();event.stopPropagation();});}

  async function saveDatabaseForm(event) {
    event.preventDefault(); const form=event.currentTarget; if(state.busy)return; clearError(form); const values={}; new FormData(form).forEach(function(value,key){values[key]=value;});
    const schema=state.databaseMeta.entities[state.databaseEntity]; if(state.databaseSelected) values[schema.idField]=state.databaseSelected[schema.idField];
    setBusy(form,true,'กำลังบันทึก…');
    try { await serverCall('database.save',{sessionToken:state.token,entity:state.databaseEntity,record:values,expectedVersion:state.databaseSelected?state.databaseSelected.Version:0}); state.databaseSelected=null; state.databaseMeta=await serverCall('database.meta',{sessionToken:state.token}); configureDatabaseView(); await loadDatabasePage(state.databasePage); toast('บันทึกข้อมูลเรียบร้อย'); }
    catch(error){ if(isSessionError(error))return expireSession(); showError(form,friendlyMessage(error)); }
    finally{setBusy(form,false);}
  }

  async function deleteSelectedDatabaseRecord(){const schema=state.databaseMeta.entities[state.databaseEntity];if(!state.databaseSelected||!schema.canDelete||!window.confirm('ยืนยันการลบข้อมูลนี้? หากเกิด Transaction แล้วระบบจะปฏิเสธการลบ'))return;try{await serverCall('database.delete',{sessionToken:state.token,entity:state.databaseEntity,recordId:state.databaseSelected[schema.idField]});closeDatabaseFormPanel();await loadDatabasePage(1);toast('ลบข้อมูลเรียบร้อย');}catch(error){toast(friendlyMessage(error));}}

  function downloadDatabaseTemplate() {
    const schema=state.databaseMeta.entities[state.databaseEntity],headers=[schema.idField].concat(schema.fields); downloadCsv(state.databaseEntity+'_template.csv',headers,[]); toast('ดาวน์โหลด Template แล้ว — ปล่อย '+schema.idField+' ว่างสำหรับข้อมูลใหม่');
  }

  async function exportFilteredDatabase() {
    try {
      let page=1, all=[], result;
      do { result=await serverCall('database.list',databaseFilters(page,200)); all=all.concat(result.items); page++; } while(page<=result.totalPages);
      const schema=state.databaseMeta.entities[state.databaseEntity],headers=[schema.idField].concat(schema.fields); downloadCsv(state.databaseEntity+'_export.csv',headers,all); toast('Export '+all.length+' รายการแล้ว');
    } catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  }

  async function importDatabaseCsv(event) {
    const file=event.target.files[0]; event.target.value=''; if(!file)return;
    try {
      const schema=state.databaseMeta.entities[state.databaseEntity]; const rows=parseCsv(await file.text());
      if(!rows.length) throw {code:'IMPORT_INVALID',message:'ไฟล์ไม่มีข้อมูล'};
      const headers=rows.shift().map(function(x){return String(x).trim();}); const missing=schema.required.filter(function(field){return headers.indexOf(field)===-1;}); if(missing.length) throw {code:'IMPORT_INVALID',message:'ขาดคอลัมน์ '+missing.join(', ')};
      state.importHeaders=headers;state.importRows=rows.filter(function(row){return row.some(function(value){return String(value).trim()!=='';});});openImportPreview();
    } catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  }

  function openImportPreview(){const template=document.getElementById('import-preview-template'),node=template.content.cloneNode(true),modal=node.querySelector('.modal-backdrop');document.body.appendChild(node);modal.querySelector('[data-import-close]').addEventListener('click',closeImportPreview);modal.querySelector('[data-import-cancel]').addEventListener('click',closeImportPreview);modal.querySelector('[data-import-preview]').addEventListener('click',previewDatabaseImport);modal.querySelector('[data-import-commit]').addEventListener('click',commitDatabaseImport);previewDatabaseImport();}
  function closeImportPreview(){document.querySelectorAll('.modal-backdrop').forEach(function(node){node.remove();});state.importBatch=null;state.importHeaders=null;state.importRows=null;}
  async function previewDatabaseImport(){const modal=document.querySelector('.modal-backdrop');if(!modal)return;const body=modal.querySelector('#import-preview-body'),previewButton=modal.querySelector('[data-import-preview]'),commitButton=modal.querySelector('[data-import-commit]');previewButton.disabled=true;commitButton.disabled=true;if(body){const tr=document.createElement('tr'),td=document.createElement('td');td.textContent='กำลังตรวจสอบ '+Number((state.importRows||[]).length).toLocaleString('th-TH')+' แถว กรุณารอสักครู่…';td.colSpan=99;tr.appendChild(td);body.replaceChildren(tr);}try{const result=await serverCall('database.previewImport',{sessionToken:state.token,entity:state.databaseEntity,headers:state.importHeaders,rows:state.importRows,mode:modal.querySelector('[data-import-mode]').value,blankPolicy:modal.querySelector('[data-import-blank]').value,errorPolicy:modal.querySelector('[data-import-error-policy]').value});state.importBatch=result;renderImportPreview(result);}catch(error){toast(friendlyMessage(error));}finally{previewButton.disabled=false;if(state.importBatch)commitButton.disabled=state.importBatch.counts.ERROR>0&&state.importBatch.errorPolicy==='ALL_OR_NONE';}}
  function renderImportPreview(result){const modal=document.querySelector('.modal-backdrop');if(!modal)return;const summary=modal.querySelector('#import-preview-summary'),head=modal.querySelector('#import-preview-head'),body=modal.querySelector('#import-preview-body'),schema=state.databaseMeta.entities[state.databaseEntity];if(!summary||!head||!body||!schema)return;const importFields=[schema.idField].concat(schema.fields);summary.replaceChildren();[['CREATE',result.counts.CREATE],['UPDATE',result.counts.UPDATE],['NO CHANGE',result.counts.NO_CHANGE],['ERROR',result.counts.ERROR]].forEach(function(item){const card=document.createElement('article');card.className='panel report-summary-card';const strong=document.createElement('strong');strong.textContent=item[1];const span=document.createElement('span');span.textContent=item[0];card.append(strong,span);summary.appendChild(card);});const hr=document.createElement('tr');['แถว','ผล','Error'].concat(importFields).forEach(function(label){const th=document.createElement('th');th.textContent=label;hr.appendChild(th);});head.replaceChildren(hr);body.replaceChildren();result.rows.forEach(function(item){const tr=document.createElement('tr');[item.rowNumber,item.operation,item.error].concat(importFields.map(function(field){return item.record[field];})).forEach(function(value){const td=document.createElement('td');td.textContent=value==null?'':value;tr.appendChild(td);});body.appendChild(tr);});if(result.previewLimited){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=importFields.length+3;td.textContent='แสดงตัวอย่าง '+result.rows.length+' จาก '+result.totalRows+' แถว — ระบบจะ Import และตรวจสอบครบทุกแถว';tr.appendChild(td);body.appendChild(tr);}modal.querySelector('[data-import-commit]').disabled=result.counts.ERROR>0&&result.errorPolicy==='ALL_OR_NONE';}
  async function commitDatabaseImport(){if(!state.importBatch||!state.importRows)return;const modal=document.querySelector('.modal-backdrop');if(!modal)return;const button=modal.querySelector('[data-import-commit]');button.disabled=true;try{const result=await serverCall('database.commitImport',{sessionToken:state.token,entity:state.databaseEntity,headers:state.importHeaders,rows:state.importRows,mode:modal.querySelector('[data-import-mode]').value,blankPolicy:modal.querySelector('[data-import-blank]').value,errorPolicy:modal.querySelector('[data-import-error-policy]').value});closeImportPreview();state.databaseMeta=await serverCall('database.meta',{sessionToken:state.token});configureDatabaseView();await loadDatabasePage(1);toast('Bulk Import สำเร็จ '+result.committed+' รายการ');}catch(error){button.disabled=false;toast(friendlyMessage(error));}}

  function parseCsv(text) {
    const rows=[]; let row=[],cell='',quoted=false; const source=String(text||'').replace(/^\uFEFF/,'');
    for(let i=0;i<source.length;i++){const ch=source[i];if(ch==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){row.push(cell);cell='';}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&source[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}else cell+=ch;}
    if(cell!==''||row.length){row.push(cell);rows.push(row);} return rows;
  }

  function downloadCsv(filename, headers, rows) {
    function quote(value){const s=String(value==null?'':value);return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
    const content='\uFEFF'+[headers.join(',')].concat(rows.map(function(row){return headers.map(function(h){return quote(row[h]);}).join(',');})).join('\r\n');
    const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'})); const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();window.setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }

  async function restoreSession() {
    render('loading-view');
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (error) { clearStoredSession(); }
    if (!stored || typeof stored.sessionToken !== 'string' || !stored.sessionToken) return renderLogin();
    state.token = stored.sessionToken;
    state.expiresAt = stored.expiresAt || null;
    try {
      const result = await serverCall('validateSession', { sessionToken: state.token });
      state.user = result.user;
      state.mustChangePassword = result.mustChangePassword === true;
      state.permissions = defaultPermissionsForRole(state.user&&state.user.roleCode);
      state.permissionScopes = {};
      state.permissionsLoaded = false;
      state.permissionsPromise = null;
      state.expiresAt = result.expiresAt || state.expiresAt;
      persistSession();
      if (state.mustChangePassword) renderPasswordChange();
      else await openDashboard();
    } catch (error) {
      expireSession();
    }
  }

  async function logout() {
    if (state.busy || !window.confirm('ต้องการออกจากระบบหรือไม่?')) return;
    state.busy = true;
    const token = state.token;
    try {
      await serverCall('logout', { sessionToken: token });
      clearAuthState();
      renderLogin();
      toast('ออกจากระบบแล้ว');
    } catch (error) {
      if (isSessionError(error)) {
        clearAuthState();
        renderLogin();
        toast('Session สิ้นสุดแล้ว');
      } else {
        toast(friendlyMessage(error));
      }
    } finally {
      state.busy = false;
    }
  }

  function acceptAuth(result) {
    state.token = result.sessionToken;
    state.expiresAt = result.expiresAt || null;
    state.user = result.user;
    state.mustChangePassword = result.mustChangePassword === true;
    state.permissions = defaultPermissionsForRole(state.user&&state.user.roleCode);
    state.permissionScopes = {};
    state.permissionsLoaded = false;
    state.permissionsPromise = null;
    persistSession();
  }

  function persistSession() {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionToken: state.token, expiresAt: state.expiresAt }));
  }

  async function openSystemMaintenance(){
    if(!state.user||!state.user.isOwner)return toast('เฉพาะ System Owner เท่านั้น');
    const requestId=renderRoute('systemMaintenance','system-maintenance-view');
    bindSystemMaintenance();
    try{await loadSystemStorage(requestId);}catch(error){if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  }

  function bindSystemMaintenance(){
    document.querySelector('[data-storage-refresh]').addEventListener('click',function(){loadSystemStorage(state.routeRequestId);});
    document.getElementById('maintenance-unlock-form').addEventListener('submit',unlockSystemMaintenance);
    document.querySelector('[data-storage-compact]').addEventListener('click',compactSystemStorage);
    document.querySelector('[data-cleanup-preview]').addEventListener('click',previewSystemCleanup);
    document.querySelector('[data-cleanup-execute]').addEventListener('click',executeSystemCleanup);
  }

  async function loadSystemStorage(requestId){
    const data=await serverCall('system.storage',{sessionToken:state.token});if(!isCurrentRoute('systemMaintenance',requestId||state.routeRequestId,'storage-sheet-body'))return;state.storageData=data;renderSystemStorage(data);if(state.maintenanceToken)renderCleanupGroups(data.groups);
  }

  function renderSystemStorage(data){
    const summary=document.getElementById('storage-summary');summary.replaceChildren();[
      ['พื้นที่จัดสรร',formatNumber(data.allocatedCells)+' ช่อง',formatPercent(data.allocatedPercent)],
      ['ช่วงข้อมูลใช้งาน',formatNumber(data.usedRangeCells)+' ช่อง',formatPercent(data.usedPercent)],
      ['พื้นที่ว่าง',formatNumber(data.freeCells)+' ช่อง',formatPercent(data.freePercent)],
      ['จำนวนชีต',formatNumber(data.sheetCount)+' ชีต','เพดาน '+formatNumber(data.limitCells)+' ช่อง']
    ].forEach(function(item){const card=document.createElement('article'),strong=document.createElement('strong'),span=document.createElement('span'),small=document.createElement('small');card.className='panel maintenance-stat';strong.textContent=item[1];span.textContent=item[0];small.textContent=item[2];card.append(strong,span,small);summary.appendChild(card);});
    document.querySelector('[data-storage-ratio]').textContent=formatNumber(data.allocatedCells)+' / '+formatNumber(data.limitCells)+' ช่อง';document.querySelector('[data-storage-progress]').style.width=Math.min(100,Number(data.allocatedPercent||0))+'%';document.querySelector('[data-storage-caption]').textContent='พื้นที่จัดสรร '+formatPercent(data.allocatedPercent)+' • ช่วงข้อมูลใช้งาน '+formatPercent(data.usedPercent)+' • พื้นที่ว่าง '+formatPercent(data.freePercent);
    const body=document.getElementById('storage-sheet-body');body.replaceChildren();data.sheets.forEach(function(item){const tr=document.createElement('tr');[item.name,formatNumber(item.allocatedRows),formatNumber(item.allocatedColumns),formatNumber(item.allocatedCells),formatNumber(item.dataRows),formatNumber(item.usedRangeCells),formatPercent(item.percentOfLimit)].forEach(function(value){const td=document.createElement('td');td.textContent=value;tr.appendChild(td);});body.appendChild(tr);});
  }

  async function unlockSystemMaintenance(event){event.preventDefault();const form=event.currentTarget,data=new FormData(form);setBusy(form,true,'กำลังยืนยัน…');try{const result=await serverCall('system.maintenanceUnlock',{sessionToken:state.token,password:data.get('password')});state.maintenanceToken=result.maintenanceToken;state.cleanupPreviewId=null;form.reset();document.querySelector('[data-maintenance-lock]').hidden=true;document.querySelector('[data-maintenance-tools]').hidden=false;renderCleanupGroups(result.groups);toast('ปลดล็อก 10 นาทีแล้ว');}catch(error){toast(friendlyMessage(error));}finally{setBusy(form,false);}}

  function renderCleanupGroups(groups){const host=document.getElementById('cleanup-groups');if(!host)return;host.replaceChildren();(groups||[]).forEach(function(group){const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small');label.className='cleanup-group';input.type='checkbox';input.value=group.code;strong.textContent=group.label;small.textContent=formatNumber(group.rowCount)+' แถว';text.append(strong,small);label.append(input,text);host.appendChild(label);});document.querySelector('[data-cleanup-preview-panel]').hidden=true;state.cleanupPreviewId=null;}

  function selectedCleanupGroups(){return Array.from(document.querySelectorAll('#cleanup-groups input:checked')).map(function(input){return input.value;});}

  async function previewSystemCleanup(){try{const result=await serverCall('system.cleanupPreview',{sessionToken:state.token,maintenanceToken:state.maintenanceToken,groups:selectedCleanupGroups()});state.cleanupPreviewId=result.previewId;const host=document.getElementById('cleanup-preview-summary');host.replaceChildren();result.groups.forEach(function(group){const row=document.createElement('div'),strong=document.createElement('strong'),span=document.createElement('span');strong.textContent=group.label;span.textContent=formatNumber(group.rowCount)+' แถว';row.append(strong,span);host.appendChild(row);});const total=document.createElement('p');total.className='cleanup-total';total.textContent='รวม '+formatNumber(result.totalRows)+' แถว';host.appendChild(total);document.querySelector('[data-cleanup-confirm]').value='';document.querySelector('[data-cleanup-preview-panel]').hidden=false;}catch(error){handleMaintenanceError(error);}}

  async function executeSystemCleanup(){const confirmation=document.querySelector('[data-cleanup-confirm]').value;if(confirmation!=='DELETE')return toast('กรุณาพิมพ์ DELETE ให้ถูกต้อง');if(!state.cleanupPreviewId||!window.confirm('ยืนยันลบข้อมูลตามรายการ Preview แบบถาวร?'))return;const button=document.querySelector('[data-cleanup-execute]');button.disabled=true;try{const result=await serverCall('system.cleanupExecute',{sessionToken:state.token,maintenanceToken:state.maintenanceToken,previewId:state.cleanupPreviewId,confirmation:confirmation});state.cleanupPreviewId=null;renderSystemStorage(result.storage);renderCleanupGroups(result.storage.groups);toast('ล้างข้อมูลแล้ว '+formatNumber(result.cleanedRows)+' แถว');}catch(error){handleMaintenanceError(error);}finally{button.disabled=false;}}

  async function compactSystemStorage(){if(!window.confirm('ยืนยันคืนพื้นที่จากแถวและคอลัมน์ว่างส่วนเกิน? ข้อมูลที่มีค่าจะไม่ถูกลบ'))return;const button=document.querySelector('[data-storage-compact]');button.disabled=true;try{const result=await serverCall('system.compactStorage',{sessionToken:state.token,maintenanceToken:state.maintenanceToken});renderSystemStorage(result.storage);renderCleanupGroups(result.storage.groups);toast('คืนพื้นที่ว่างเรียบร้อย');}catch(error){handleMaintenanceError(error);}finally{button.disabled=false;}}

  function handleMaintenanceError(error){if(error&&error.code==='MAINTENANCE_AUTH_REQUIRED'){state.maintenanceToken=null;state.cleanupPreviewId=null;document.querySelector('[data-maintenance-lock]').hidden=false;document.querySelector('[data-maintenance-tools]').hidden=true;}if(isSessionError(error))return expireSession();toast(friendlyMessage(error));}
  function formatNumber(value){return Number(value||0).toLocaleString('th-TH');}
  function formatPercent(value){return Number(value||0).toLocaleString('th-TH',{minimumFractionDigits:1,maximumFractionDigits:2})+'%';}

  function clearStoredSession() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (error) {}
  }

  function clearAuthState() {
    state.busy = false;
    state.currentRoute = 'login';
    state.routeRequestId += 1;
    state.token = null;
    state.expiresAt = null;
    state.user = null;
    state.mustChangePassword = false;
    state.permissions = [];
    state.permissionScopes = {};
    state.permissionsLoaded = false;
    state.permissionsPromise = null;
    state.users = [];
    state.usersLoaded = false;
    state.usersPromise = null;
    state.selectedUserId = null;
    state.userMode = 'edit';
    state.userImportRows = null;
    state.userImportPreview = null;
    state.databaseMeta = null;
    state.databaseEntity = 'branch';
    state.databaseItems = [];
    state.databasePage = 1;
    state.databaseTotal = 0;
    state.databaseTotalPages = 1;
    state.databaseSelected = null;
    state.databaseFilters = {};
    state.databaseSortField = '';
    state.databaseSortDirection = 'ASC';
    state.importHeaders = null;
    state.importRows = null;
    state.importBatch = null;
    state.visitPlanMeta = null;
    state.visitPlans = [];
    state.visitPlanPage = 1;
    state.visitPlanTotalPages = 1;
    state.selectedVisitPlan = null;
    state.visitPlanCustomerLines = [];
    state.visitPlanFilters = {};
    state.visitPlanSortField = '';
    state.visitPlanSortDirection = 'DESC';
    state.planImportRows = null;
    state.planImportBatch = null;
    state.visitMeta = null;
    state.visits = [];
    state.visitPage = 1;
    state.visitTotalPages = 1;
    state.selectedVisit = null;
    state.dashboardData = null;
    state.reportItems = [];
    state.reportPage = 1;
    state.reportTotalPages = 1;
    state.maintenanceToken = null;
    state.cleanupPreviewId = null;
    state.storageData = null;
    clearStoredSession();
  }

  function expireSession(message) {
    clearAuthState();
    renderLogin();
    if (message) toast(message);
  }

  function bindPasswordToggles() {
    document.querySelectorAll('[data-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        const input = document.querySelector('[name="' + button.dataset.toggle + '"]');
        if (!input) return;
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        button.textContent = showing ? 'แสดง' : 'ซ่อน';
      });
    });
  }

  function setBusy(form, busy, label) {
    state.busy = busy;
    form.setAttribute('aria-busy', String(busy));
    form.querySelectorAll('button,input,select,textarea').forEach(function (element) {
      if (busy) { element.dataset.disabledBeforeBusy = element.disabled ? '1' : '0'; element.disabled = true; }
      else { element.disabled = element.dataset.disabledBeforeBusy === '1'; delete element.dataset.disabledBeforeBusy; }
    });
    const spinner = form.querySelector('[data-spinner]');
    const labelElement = form.querySelector('[data-label]');
    if (spinner) spinner.hidden = !busy;
    if (labelElement) {
      if (!labelElement.dataset.originalLabel) labelElement.dataset.originalLabel = labelElement.textContent;
      labelElement.textContent = busy ? label : labelElement.dataset.originalLabel;
    }
  }

  function showError(form, message) {
    const element = form.querySelector('[data-error]') || (form.closest('.panel,.auth-card,.visit-editor') || form.parentElement).querySelector('[data-error]');
    if (!element) { toast(message); return; }
    element.textContent = message;
    element.hidden = false;
  }

  function clearError(form) {
    const element = form.querySelector('[data-error]') || (form.closest('.panel,.auth-card,.visit-editor') || form.parentElement).querySelector('[data-error]');
    if (!element) return;
    element.textContent = '';
    element.hidden = true;
  }

  function friendlyMessage(error) {
    const messages = {
      INVALID_CREDENTIALS: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
      ACCOUNT_LOCKED: 'บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ภายหลัง',
      PASSWORD_CONFIRMATION_MISMATCH: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน',
      PASSWORD_POLICY_FAILED: 'รหัสผ่านต้องมีอย่างน้อย 9 ตัวอักษร',
      CURRENT_PASSWORD_INVALID: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
      PASSWORD_REUSE_NOT_ALLOWED: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน',
      SESSION_EXPIRED: 'Session หมดอายุ กรุณาเข้าสู่ระบบใหม่',
      SESSION_INVALID: 'Session สิ้นสุดแล้ว กรุณาเข้าสู่ระบบใหม่',
      DATASTORE_NOT_READY: 'ระบบยังไม่ได้เตรียม Worksheet',
      CONFIG_MISSING: 'ระบบยังตั้งค่าไม่ครบ กรุณาติดต่อผู้ดูแล',
      SYSTEM_BUSY: 'ระบบกำลังประมวลผล กรุณาลองใหม่',
      FORBIDDEN: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
      USERNAME_EXISTS: 'Username นี้มีอยู่แล้ว',
      VERSION_CONFLICT: 'ข้อมูลผู้ใช้ถูกแก้ไขแล้ว กรุณาโหลดใหม่',
      LAST_ADMIN_REQUIRED: 'ระบบต้องมี Admin ที่เปิดใช้งานอย่างน้อยหนึ่งบัญชี',
      SELF_ACTION_NOT_ALLOWED: 'ไม่สามารถแก้ Role หรือปิดบัญชีที่กำลังใช้งานอยู่',
      ROLE_HIERARCHY_DENIED: 'ไม่สามารถจัดการผู้ใช้ที่มี Role ระดับเท่ากันหรือสูงกว่า',
      VISIT_NOT_FOUND: 'ไม่พบ Visit หรือคุณไม่มีสิทธิ์ดูรายการนี้',
      VISIT_STATE_INVALID: 'สถานะ Visit ไม่อนุญาตให้ทำรายการนี้',
      GPS_REQUIRED: 'กรุณาเปิด GPS และอนุญาตการเข้าถึงตำแหน่ง',
      IMPORT_INVALID: 'ข้อมูล Import ไม่ถูกต้อง',
      IMPORT_ROW_INVALID: 'พบข้อมูล Import ที่ไม่ถูกต้อง',
      IMPORT_DUPLICATE: 'พบรหัสซ้ำในข้อมูล Import',
      CODE_EXISTS: 'รหัสนี้มีอยู่แล้ว',
      NETWORK_ERROR: 'ไม่สามารถติดต่อ Server ได้ กรุณาลองใหม่'
    };
    const message = error&&error.code==='IMPORT_INVALID'&&error.message?error.message:(messages[error && error.code] || (error && error.message) || 'ไม่สามารถดำเนินการได้');
    return message + (error && error.referenceId ? ' [' + error.referenceId + ']' : '');
  }

  function isSessionError(error) {
    return error && (error.code === 'SESSION_INVALID' || error.code === 'SESSION_EXPIRED');
  }

  function clientLabel() {
    return 'SPP WebApp | ' + navigator.userAgent.slice(0, 90);
  }

  function initials(name) {
    const parts = String(name || 'SP').trim().split(/\s+/).slice(0, 2);
    return parts.map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || 'SP';
  }

  function toast(message) {
    const host = document.getElementById('toast-region');
    const element = document.createElement('div');
    element.className = 'toast';
    element.textContent = message;
    host.appendChild(element);
    window.setTimeout(function () { element.remove(); }, 4200);
  }

  restoreSession();
})();
