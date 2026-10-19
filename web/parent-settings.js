/* Parent settings: one pane per task, with the business context owned by parent.js. */
(()=>{
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const paths={child:'<circle cx="12" cy="8" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3"/>',family:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a6 6 0 0 1 3 5"/>',mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',task:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 12h6m-6 4h4"/>',category:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',backup:'<path d="M4 8V4m0 0h4M4 4l3 3a8 8 0 1 1-2 9M12 8v5l3 2"/>',key:'<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-5-5 3-3m-1 5 3-3"/>',logout:'<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m6-13 5 5-5 5M9 12h11"/>',arrow:'<path d="m9 5 7 7-7 7"/>'};
  const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.child}</svg>`;
  const groups=[
    {title:'孩子管理',items:[['child/profile','孩子昵称','child','openChildNicknameSettings'],['child/family','邀请家人','family','openFamilySettings'],['child/invitations','我的邀请','mail','openMyInvitationsSettings']]},
    {title:'任务设置',items:[['tasks/presets','常用任务配置','task','openTaskPresetsSettings'],['tasks/categories','任务类型配置','category','openCategorySettings'],['tasks/backup','数据备份','backup','openBackupSettings']]},
    {title:'账号管理',items:[['account/profile','修改账号昵称','child','openAccountManagement'],['account/password','修改密码','key','openPasswordSettings'],['account/logout','退出登录','logout','settingsLogout']]}
  ];
  const descriptions={
    'child/profile':'为孩子设置一个熟悉的称呼，让每一步成长都属于他。',
    'child/family':'邀请家人一起陪伴，共同管理当前孩子的成长记录。',
    'child/invitations':'查看发给你的邀请，选择要一起陪伴的孩子。',
    'tasks/presets':'把经常安排的任务保存下来，下次创建更轻松。',
    'tasks/categories':'用名称和颜色区分任务，让每天的安排更清晰。',
    'tasks/backup':'导出一份当前孩子的数据，妥善保存成长记录。',
    'account/profile':'设置家人容易识别的昵称。',
    'account/password':'定期更新密码，保护账号和孩子的成长记录。'
  };
  const statusNames={pending:'待接受',accepted:'已接受',rejected:'已拒绝',revoked:'已撤销',expired:'已过期'};
  const date=value=>new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const initial=value=>esc(Array.from(String(value||'').trim())[0]||'家');
  const empty=(title,copy,type='mail')=>`<div class="settings-empty"><span>${icon(type)}</span><strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;
  const notice=message=>`<p class="settings-notice">${esc(message)}</p>`;
  const feedback=id=>`<p id="${id}" class="settings-feedback" role="status" aria-live="polite"></p>`;
  const passwordMarkup=forced=>`<form id="passwordForm" class="settings-form"><fieldset><div class="settings-field"><label for="passwordCurrent">当前密码</label><input id="passwordCurrent" type="password" required maxlength="128" autocomplete="current-password" placeholder="${forced?'输入初始或重置密码':'输入当前登录密码'}"></div><div class="settings-field"><label for="passwordNew">新密码</label><input id="passwordNew" type="password" required minlength="6" maxlength="128" pattern="(?=.*[A-Za-z])(?=.*[0-9]).{6,128}" title="至少 6 位，且同时包含字母和数字" autocomplete="new-password" placeholder="设置新密码" aria-describedby="passwordHelp"></div><div class="settings-field"><label for="passwordRepeat">再次输入新密码</label><input id="passwordRepeat" type="password" required minlength="6" maxlength="128" pattern="(?=.*[A-Za-z])(?=.*[0-9]).{6,128}" title="至少 6 位，且同时包含字母和数字" autocomplete="new-password" placeholder="再次输入新密码"></div><p id="passwordHelp" class="settings-help">密码至少 6 位，且同时包含字母和数字，最多 128 位。</p>${feedback('profileError')}<div class="settings-form-footer"><span>修改后，所有已登录页面需要重新登录。</span><button class="btn primary" type="submit">修改密码</button></div></fieldset></form>`;

  function create(deps){
    let selected='child/profile',epoch=0,pendingWrite=null,invitationNotice=null;
    const context=()=>deps.context();
    function invalidate(){epoch++}
    function reset(){invalidate();selected='child/profile';pendingWrite=null;invitationNotice=null}
    function open(page){if(groups.some(group=>group.items.some(item=>item[0]===page))&&page!=='account/logout')selected=page;deps.show()}
    function panelError(panel,error,retry){
      if(error.kind==='stale'||error.kind==='unauthorized')return;
      panel.innerHTML=`<div class="settings-empty settings-load-error"><strong>暂时无法读取</strong><p>${esc(error.message)}</p><button class="btn" type="button" id="retrySettings">重新加载</button></div>`;
      panel.querySelector('#retrySettings').onclick=retry;
    }
    async function mutate(panel,active,button,work,finish){
      if(pendingWrite||!active())return;
      const write={};pendingWrite=write;
      const fieldset=button.closest('fieldset'),oldText=button.textContent;
      if(fieldset)fieldset.disabled=true;else button.disabled=true;
      button.textContent='正在处理…';
      const errorBox=panel.querySelector('.settings-feedback');
      if(errorBox){errorBox.textContent='';errorBox.classList.remove('success')}
      try{const result=await work();if(active())await finish(result)}
      catch(error){if(active()&&error.kind!=='stale'&&error.kind!=='unauthorized'&&errorBox)errorBox.textContent=error.message}
      finally{if(pendingWrite===write)pendingWrite=null;if(button.isConnected){if(fieldset)fieldset.disabled=false;else button.disabled=false;button.textContent=oldText}}
    }
    function bindPassword(panel,active){
      panel.querySelector('#passwordForm').onsubmit=event=>{
        event.preventDefault();const q=selector=>panel.querySelector(selector);
        if(q('#passwordNew').value!==q('#passwordRepeat').value){q('#profileError').textContent='两次输入的新密码不一致。';q('#passwordRepeat').focus();return}
        const values={currentPassword:q('#passwordCurrent').value,newPassword:q('#passwordNew').value};
        mutate(panel,active,event.submitter,()=>deps.changePassword(values),()=>{});
      };
    }
    function requiredPassword(panel){
      const token=++epoch;panel.classList.add('settings-required-password');
      panel.innerHTML=`${notice('当前使用初始或重置密码，请先设置自己的密码。')}${passwordMarkup(true)}`;
      bindPassword(panel,()=>epoch===token&&panel.isConnected);
    }
    function render(){
      const main=document.querySelector('#main');if(!main)return;
      const token=++epoch,{child,user}=context(),childId=child?.id;
      const visibleGroups=child?groups:groups.filter(group=>group.title==='账号管理');
      if(!child&&!selected.startsWith('account/'))selected='account/profile';
      const group=visibleGroups.find(group=>group.items.some(item=>item[0]===selected)),item=group.items.find(item=>item[0]===selected);
      main.innerHTML=`<section class="settings-workspace" aria-labelledby="settingsTitle"><header class="settings-page-heading"><div><h1 id="settingsTitle">设置</h1><p>照顾好每一份成长，也照顾好你的使用习惯。</p></div>${child?'':'<button class="btn settings-back-home" id="backToOnboarding" type="button">返回开始页</button>'}</header><div class="settings-columns"><aside class="settings-sidebar"><nav aria-label="设置导航">${visibleGroups.map(group=>`<div class="settings-nav-group"><h2>${group.title}</h2>${group.items.map(([key,label,type,id])=>`<button type="button" id="${id}" data-settings-page="${key}" class="settings-nav-item ${key===selected?'is-active':''} ${key==='account/logout'?'settings-signout':''}" ${key===selected?'aria-current="page"':''}>${icon(type)}<span>${label}</span>${key===selected?icon('arrow'):''}</button>`).join('')}</div>`).join('')}</nav><div class="settings-sidebar-account"><span class="settings-mini-avatar">${initial(user.nickname)}</span><div><strong>${esc(user.nickname)}</strong><small>${esc(user.loginName)}</small></div></div></aside><section class="settings-detail" aria-labelledby="settingsDetailTitle"><header class="settings-detail-heading"><h2 id="settingsDetailTitle" tabindex="-1">${item[1]}</h2><div>${descriptions[selected]}</div></header><div id="settingsContent" class="settings-detail-body"></div></section></div></section>`;
      const panel=main.querySelector('#settingsContent');
      if(main.querySelector('#backToOnboarding'))main.querySelector('#backToOnboarding').onclick=deps.home;
      const active=()=>token===epoch&&panel.isConnected&&context().child?.id===childId;
      main.querySelectorAll('[data-settings-page]').forEach(button=>button.onclick=()=>{
        if(button.dataset.settingsPage==='account/logout'){deps.logout();return}
        selected=button.dataset.settingsPage;render();document.querySelector('#settingsDetailTitle')?.focus({preventScroll:true});
      });
      if(selected==='child/profile')renderChildProfile(panel,active,child);
      if(selected==='child/family')renderFamily(panel,active,child);
      if(selected==='child/invitations')renderInvitations(panel,active);
      if(selected==='tasks/presets'){
        panel.innerHTML=`${child.archived?notice('孩子已归档，常用任务配置仅可查看。'):''}<div class="settings-section-bar"><p id="settingsPresetCount">共 ${context().data.taskPresets.length} 项配置</p><button id="settingsAddPreset" type="button" class="btn primary" ${child.archived?'disabled':''}>＋ 添加常用任务</button></div><div id="settingsTaskPresetsList" class="task-preset-cards"></div>${feedback('settingsTaskPresetsError')}`;
        deps.renderPresets();panel.querySelector('#settingsAddPreset').onclick=()=>deps.editPreset();
      }
      if(selected==='tasks/categories'){
        panel.innerHTML=`${child.archived?notice('孩子已归档，任务类型仅可查看。'):''}<div class="settings-section-bar"><p>拖动左侧图标调整顺序</p><button id="settingsAddCategory" type="button" class="btn primary" ${child.archived?'disabled':''}>＋ 添加类型</button></div><div id="settingsCategoryList"></div><p class="settings-help">被任务或历史记录使用的类型，删除后会停用并保留历史。</p>`;
        deps.renderCategories();panel.querySelector('#settingsAddCategory').onclick=deps.addCategory;
      }
      if(selected==='tasks/backup')renderBackup(panel,child);
      if(selected==='account/profile')renderProfile(panel,active,user);
      if(selected==='account/password'){panel.innerHTML=passwordMarkup(false);bindPassword(panel,active)}
    }
    function renderOnboarding(main){
      const token=++epoch,user=context().user;
      main.innerHTML=`<section class="onboarding" id="onboarding" aria-labelledby="onboardingTitle"><header class="onboarding-heading"><span class="onboarding-greeting">你好，${esc(user.nickname)}</span><h1 id="onboardingTitle">从陪伴的第一步开始</h1><p>创建孩子的成长记录，或接受家人的邀请，一起见证每一份努力。</p></header><div class="onboarding-columns"><section class="onboarding-card" aria-labelledby="onboardingCreateTitle"><header><span class="onboarding-icon">${icon('child')}</span><h2 id="onboardingCreateTitle">创建孩子</h2><p>为孩子安排任务，记录努力，积累成长的点滴。</p></header><div id="onboardingCreatePanel"></div></section><section class="onboarding-card" aria-labelledby="onboardingInvitationsTitle"><header><span class="onboarding-icon">${icon('mail')}</span><h2 id="onboardingInvitationsTitle">家人的邀请</h2><p>家人已经创建了孩子？接受邀请后，就能一起管理。</p></header><div id="onboardingInvitationsPanel"></div></section></div></section>`;
      const active=()=>epoch===token&&main.querySelector('#onboarding')?.isConnected&&!context().child;
      renderCreateChild(main.querySelector('#onboardingCreatePanel'),active);
      renderInvitations(main.querySelector('#onboardingInvitationsPanel'),active,true);
    }
    function renderCreateChild(panel,active){
      panel.innerHTML=`<form id="createChildForm" class="settings-form"><fieldset><div class="settings-field"><label for="newChildName">孩子昵称</label><input id="newChildName" required maxlength="40" autocomplete="off" placeholder="请输入孩子昵称"><p class="settings-help">每个孩子都有独立的任务、积分和礼品。</p></div>${feedback('childrenError')}<div class="settings-form-footer"><button class="btn primary" type="submit">创建孩子</button></div></fieldset></form>`;
      panel.querySelector('#createChildForm').onsubmit=event=>{event.preventDefault();mutate(panel,active,event.submitter,()=>deps.api('/api/children','POST',{name:panel.querySelector('#newChildName').value.trim()}),async result=>{await deps.sync(false);if(active())deps.selectChild(result.child.id)})};
    }
    function renderChildProfile(panel,active,child){
      const owner=child.role==='owner',editable=owner&&!child.archived;
      panel.innerHTML=`<div class="settings-child-summary"><span class="settings-large-avatar">${initial(child.name)}</span><div><strong>${esc(child.name)}</strong><p>${owner?'我是负责人':'共同管理家长'}${child.archived?' · 已归档':''}</p></div></div>${!editable?notice(child.archived?'孩子已归档，恢复后可以修改昵称。':'孩子昵称由负责人修改，你可以共同管理任务、积分和礼品。'):''}<form id="renameChildForm" class="settings-form"><fieldset ${editable?'':'disabled'}><div class="settings-field"><label for="renameChild">孩子昵称</label><input id="renameChild" value="${esc(child.name)}" required maxlength="40" placeholder="请输入孩子昵称" autocomplete="off"><p class="settings-help">用于孩子卡片、日历和导出记录，最多 40 个字。</p></div>${feedback('childManageError')}<div class="settings-form-footer"><button class="btn primary" type="submit">保存昵称</button></div></fieldset></form><details class="settings-more"><summary>更多孩子管理</summary><div><p>${owner?(child.archived?'恢复后，可以继续安排任务并记录成长。':'归档后仅可查看和导出，已有成长记录会保留。'):'退出管理后，你将无法查看这个孩子的成长记录。其他家长的数据会保留。'}</p><button class="btn ${owner?'':'danger'}" type="button" id="${owner?'archiveChild':'leaveChild'}">${owner?(child.archived?'恢复孩子':'归档孩子'):'退出管理该孩子'}</button></div></details>`;
      panel.querySelector('#renameChildForm').onsubmit=event=>{event.preventDefault();if(!editable)return;
        mutate(panel,active,event.submitter,()=>deps.api(`/api/children/${child.id}`,'PATCH',{name:panel.querySelector('#renameChild').value.trim()}),async()=>{if(await deps.sync(true)&&active()){deps.repaint();deps.toast('孩子昵称已更新')}});
      };
      const more=panel.querySelector('#archiveChild,#leaveChild');
      more.onclick=()=>{
        const message=owner?(child.archived?'恢复后可以继续安排任务，确认恢复孩子？':'归档后只能查看和导出，成长记录会保留。确认归档孩子？'):'退出后将失去这个孩子的数据访问权限。确认退出管理？';
        if(!confirm(message))return;
        mutate(panel,active,more,()=>owner?deps.api(`/api/children/${child.id}`,'PATCH',{archived:!child.archived}):deps.api(`/api/children/${child.id}/members/${context().user.id}`,'DELETE'),async()=>{const available=await deps.sync(true);if(!available){deps.home();return}if(active())deps.repaint()});
      };
    }
    async function renderFamily(panel,active,child){
      panel.innerHTML='<p class="settings-loading" role="status">正在读取家人信息…</p>';
      try{
        const owner=child.role==='owner',editable=owner&&!child.archived;
        const [members,sent]=await Promise.all([deps.api(`/api/children/${child.id}/members`),owner?deps.api(`/api/children/${child.id}/invitations`):Promise.resolve({invitations:[]})]);
        if(!active())return;
        sent.invitations=sent.invitations.filter(inv=>inv.status!=='revoked');
        panel.innerHTML=`${editable?`<form id="inviteParentForm" class="settings-invite-form"><fieldset><div class="settings-field"><label for="inviteLogin">家人的登录名</label><div class="settings-inline-field"><input id="inviteLogin" required minlength="3" maxlength="32" autocomplete="off" autocapitalize="none" placeholder="输入已开通账号的登录名"><button type="submit" class="btn primary">发送邀请</button></div><p class="settings-help">家人需要先由管理员开通账号。接受邀请后，仅共享当前孩子的任务、积分和礼品。</p></div>${feedback('childManageError')}</fieldset></form>`:notice(child.archived?'孩子已归档，家人管理暂不可修改。':'只有孩子负责人可以邀请家人和调整共同管理权限。')}${!editable?feedback('childManageError'):''}<section class="settings-section"><div class="settings-section-title"><h3>共同管理家长</h3><span>${members.members.length} 人</span></div><div class="settings-member-list">${members.members.map(member=>`<article class="settings-person-row"><span class="settings-mini-avatar">${initial(member.nickname)}</span><div class="settings-person-copy"><strong>${esc(member.nickname)}${member.userId===context().user.id?' <small>我</small>':''}</strong><p>${esc(member.loginName)}</p></div><span class="settings-status ${member.role==='owner'?'is-owner':''}">${member.role==='owner'?'负责人':'共同管理'}</span>${editable&&member.role!=='owner'?`<details class="settings-member-actions"><summary aria-label="管理 ${esc(member.nickname)}">管理</summary><div><button type="button" data-transfer="${esc(member.userId)}">转让负责身份</button><button type="button" class="danger" data-remove="${esc(member.userId)}">移除家长</button></div></details>`:''}</article>`).join('')}</div></section>${owner?`<section class="settings-section"><div class="settings-section-title"><h3>已发邀请</h3><span>${sent.invitations.filter(inv=>inv.status==='pending').length} 份待接受</span></div>${sent.invitations.length?`<div class="settings-member-list">${sent.invitations.map(inv=>`<article class="settings-person-row"><span class="settings-mini-avatar muted-avatar">${initial(inv.nickname)}</span><div class="settings-person-copy"><strong>${esc(inv.nickname)}</strong><p>${esc(inv.loginName)}${inv.status==='pending'?'<span> · 待接受</span>':''}</p><small class="settings-invitation-sent-at">发出于 <time datetime="${esc(inv.createdAt)}">${esc(date(inv.createdAt))}</time></small></div>${inv.status==='pending'?`<button type="button" class="btn settings-small-btn" data-revoke="${esc(inv.id)}" ${editable?'':'disabled'}>撤销邀请</button>`:`<span class="settings-status">${esc(statusNames[inv.status]||'已处理')}</span>`}</article>`).join('')}</div>`:empty('暂无已发邀请','邀请家人，共同记录孩子的成长。')}</section>`:''}`;
        const action=(button,path,method,body)=>mutate(panel,active,button,()=>deps.api(path,method,body),async()=>{if(!await deps.sync(false)){deps.home();return}if(active())render()});
        const form=panel.querySelector('#inviteParentForm');
        if(form)form.onsubmit=event=>{event.preventDefault();action(event.submitter,`/api/children/${child.id}/invitations`,'POST',{loginName:panel.querySelector('#inviteLogin').value.trim()})};
        panel.querySelectorAll('[data-revoke]').forEach(button=>button.onclick=()=>action(button,`/api/children/${child.id}/invitations/${button.dataset.revoke}`,'DELETE'));
        panel.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{if(confirm('移除后，该家长将无法访问这个孩子的成长记录。确认移除？'))action(button,`/api/children/${child.id}/members/${button.dataset.remove}`,'DELETE')});
        panel.querySelectorAll('[data-transfer]').forEach(button=>button.onclick=()=>{if(confirm('转让后，你将成为共同管理家长。确认转让负责身份？'))action(button,`/api/children/${child.id}/transfer`,'POST',{userId:button.dataset.transfer})});
      }catch(error){if(active())panelError(panel,error,render)}
    }
    async function renderInvitations(panel,active,onboarding=false){
      panel.innerHTML='<p class="settings-loading" role="status">正在读取我的邀请…</p>';
      try{
        const result=await deps.api('/api/invitations');if(!active())return;
        panel.innerHTML=`${feedback('invitationError')}<div class="settings-invitation-list">${result.invitations.length?result.invitations.map(inv=>`<article class="settings-invitation-card"><div class="settings-person-row"><span class="settings-large-avatar">${initial(inv.childName)}</span><div class="settings-person-copy"><strong>${esc(inv.childName)}</strong><p>邀请你成为共同管理家长</p></div><span class="settings-status is-owner">待处理</span></div><p class="settings-help">接受后，可以查看和管理这个孩子的任务、积分与礼品。</p><div class="settings-invitation-footer"><span>${esc(date(inv.expiresAt))} 前有效</span><div><button class="btn" type="button" data-reject-invite="${esc(inv.id)}">拒绝邀请</button><button class="btn primary" type="button" data-accept-invite="${esc(inv.id)}">接受邀请</button></div></div></article>`).join(''):empty('暂无待处理邀请',onboarding?`请让家人使用你的登录名「${context().user.loginName}」发送邀请，收到后可在这里接受。`:'收到家人的邀请后，会在这里显示。')}</div>`;
        for(const answer of ['accept','reject'])panel.querySelectorAll(`[data-${answer}-invite]`).forEach(button=>button.onclick=()=>{
          const inviteId=button.dataset[answer+'Invite'];
          mutate(panel,active,button,()=>deps.api(`/api/invitations/${inviteId}/${answer}`,'POST',{}),async result=>{
            await deps.sync(false);if(!active())return;
            if(onboarding){if(answer==='accept'){await deps.selectChild(result.childId)}else{await renderInvitations(panel,active,true)}return}
            invitationNotice={answer,childId:result.childId};render();
          });
        });
        if(invitationNotice){
          const saved=invitationNotice;invitationNotice=null;
          const banner=document.createElement('div');banner.className='settings-success-banner';banner.setAttribute('role','status');
          banner.innerHTML=`<span>${saved.answer==='accept'?'已接受邀请，可以一起记录成长了。':'已拒绝这份邀请。'}</span>${saved.answer==='accept'?'<button type="button" class="btn" data-enter-invited-child>进入孩子</button>':''}`;
          panel.prepend(banner);const enter=banner.querySelector('button');if(enter)enter.onclick=()=>deps.selectChild(saved.childId);
        }
      }catch(error){if(active())panelError(panel,error,onboarding?()=>renderInvitations(panel,active,true):render)}
    }
    function renderBackup(panel,child){
      const restore=child.role==='owner'&&!child.archived,{updatedAt}=context();
      panel.innerHTML=`<div class="settings-backup-card"><span class="settings-feature-icon">${icon('backup')}</span><div><h3>${esc(child.name)}的成长备份</h3><p>包含当前孩子的任务、完成记录、积分流水、礼品和配置。</p><small>${updatedAt?'最近保存：'+esc(date(updatedAt)):'尚无保存记录'}</small></div></div><div class="settings-backup-actions"><div><strong>导出备份</strong><p>下载完整 JSON 文件，保存一份成长记录。</p></div><button class="btn primary" id="settingsExportBtn" type="button">导出备份</button></div><div class="settings-backup-actions"><div><strong>从备份恢复</strong><p>${restore?'恢复会替换当前孩子的业务数据，孩子昵称和家长权限保持不变。':child.archived?'孩子已归档，恢复孩子后由负责人导入。':'只有孩子负责人可以导入并恢复数据。'}</p></div><button class="btn" id="settingsImportBtn" type="button" ${restore?'':'disabled'}>导入并恢复</button></div><p class="settings-help">每次保存前自动保留旧版本，最多保留最近 30 份。建议定期另行导出备份。</p>`;
      panel.querySelector('#settingsExportBtn').onclick=deps.exportBackup;
      panel.querySelector('#settingsImportBtn').onclick=deps.importBackup;
    }
    function renderProfile(panel,active,user){
      panel.innerHTML=`<form id="profileForm" class="settings-form"><fieldset><div class="settings-field"><label for="profileLogin">登录名</label><input id="profileLogin" value="${esc(user.loginName)}" readonly autocomplete="username" aria-describedby="loginNameHelp"><p id="loginNameHelp" class="settings-help">登录名由管理员开通，不支持修改。</p></div><div class="settings-field"><label for="profileNickname">账号昵称</label><input id="profileNickname" value="${esc(user.nickname)}" required maxlength="40" autocomplete="nickname" placeholder="请输入你的昵称"><p class="settings-help">家人会通过这个昵称识别你，最多 40 个字。</p></div>${feedback('profileError')}<div class="settings-form-footer"><button class="btn primary" type="submit">保存昵称</button></div></fieldset></form>`;
      panel.querySelector('#profileForm').onsubmit=event=>{event.preventDefault();mutate(panel,active,event.submitter,()=>deps.api('/api/account/profile','PATCH',{nickname:panel.querySelector('#profileNickname').value.trim()}),result=>{deps.updateUser(result.user);render();const message=document.querySelector('#profileError');message.classList.add('success');message.textContent='账号昵称已更新。'})};
    }
    return {render,open,invalidate,reset,requiredPassword,renderOnboarding};
  }
  window.LeleParentSettings={create};
})();
