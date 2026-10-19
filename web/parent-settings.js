/* Parent settings: one pane per task, with the business context owned by parent.js. */
(()=>{
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const paths={child:'<circle cx="12" cy="8" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3"/>',family:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a6 6 0 0 1 3 5"/>',mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',task:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v4H9zM9 12h6m-6 4h4"/>',category:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',backup:'<path d="M4 8V4m0 0h4M4 4l3 3a8 8 0 1 1-2 9M12 8v5l3 2"/>',key:'<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-5-5 3-3m-1 5 3-3"/>',logout:'<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4m6-13 5 5-5 5M9 12h11"/>',arrow:'<path d="m9 5 7 7-7 7"/>'};
  const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.child}</svg>`;
  const date=value=>new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const initial=value=>esc(Array.from(String(value||'').trim())[0]||'家');
  const empty=(title,copy,type='mail')=>`<div class="settings-empty"><span>${icon(type)}</span><strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;
  const feedback=id=>`<p id="${id}" class="settings-feedback" role="status" aria-live="polite"></p>`;
  function create(deps){
    const ui=window.LeleParentUI.createSettings(deps);
    let epoch=0,pendingWrite=null;
    const context=()=>deps.context();
    function invalidate(){epoch++;ui.invalidate()}
    function reset(){epoch++;pendingWrite=null;ui.reset()}
    const render=()=>ui.render();
    function panelError(panel,error,retry){
      if(error.kind==='stale'||error.kind==='unauthorized')return;
      panel.innerHTML=`<div class="settings-empty settings-load-error"><strong>暂时无法读取</strong><p>${esc(error.message)}</p><button class="btn" type="button" id="retrySettings">重新加载</button></div>`;
      panel.querySelector('#retrySettings').onclick=retry;
    }
    async function mutate(panel,active,button,work,finish){
      if(pendingWrite||ui.pending||!active())return;
      const write={};pendingWrite=write;ui.pending=write;
      const fieldset=button.closest('fieldset'),oldText=button.textContent;
      if(fieldset)fieldset.disabled=true;else button.disabled=true;
      button.textContent='正在处理…';
      const errorBox=panel.querySelector('.settings-feedback');
      if(errorBox){errorBox.textContent='';errorBox.classList.remove('success')}
      try{const result=await work();if(active())await finish(result)}
      catch(error){if(active()&&error.kind!=='stale'&&error.kind!=='unauthorized'&&errorBox)errorBox.textContent=error.message}
      finally{if(pendingWrite===write)pendingWrite=null;if(ui.pending===write)ui.pending=null;if(button.isConnected){if(fieldset)fieldset.disabled=false;else button.disabled=false;button.textContent=oldText}}
    }
    function renderOnboarding(main){
      const token=++epoch,user=context().user;
      main.innerHTML=`<section class="onboarding" id="onboarding" aria-labelledby="onboardingTitle"><header class="onboarding-heading"><span class="onboarding-greeting">你好，${esc(user.nickname)}</span><h1 id="onboardingTitle">从陪伴的第一步开始</h1></header><div class="onboarding-columns"><section class="onboarding-card" aria-labelledby="onboardingCreateTitle"><header><span class="onboarding-icon">${icon('child')}</span><h2 id="onboardingCreateTitle">创建孩子</h2><p>为孩子安排任务，记录努力，积累成长的点滴。</p></header><div id="onboardingCreatePanel"></div></section><section class="onboarding-card" aria-labelledby="onboardingInvitationsTitle"><header><span class="onboarding-icon">${icon('mail')}</span><h2 id="onboardingInvitationsTitle">家人的邀请</h2><p>家人已经创建了孩子？接受邀请后，就能一起管理。</p></header><div id="onboardingInvitationsPanel"></div></section></div></section>`;
      const active=()=>epoch===token&&main.querySelector('#onboarding')?.isConnected&&!context().child;
      renderCreateChild(main.querySelector('#onboardingCreatePanel'),active);
      renderInvitations(main.querySelector('#onboardingInvitationsPanel'),active);
    }
    function renderCreateChild(panel,active){
      panel.innerHTML=`<form id="createChildForm" class="settings-form"><fieldset><div class="settings-field"><label for="newChildName">孩子昵称</label><input id="newChildName" required maxlength="40" autocomplete="off" placeholder="请输入孩子昵称"><p class="settings-help">每个孩子都有独立的任务、积分和礼品。</p></div>${feedback('childrenError')}<div class="settings-form-footer"><button class="btn primary" type="submit">创建孩子</button></div></fieldset></form>`;
      panel.querySelector('#createChildForm').onsubmit=event=>{event.preventDefault();mutate(panel,active,event.submitter,()=>deps.api('/api/children','POST',{name:panel.querySelector('#newChildName').value.trim()}),async result=>{await deps.sync(false);if(active())deps.selectChild(result.child.id)})};
    }
    async function renderInvitations(panel,active){
      panel.innerHTML='<p class="settings-loading" role="status">正在读取我的邀请…</p>';
      try{
        const result=await deps.api('/api/invitations');if(!active())return;
        panel.innerHTML=`${feedback('invitationError')}<div class="settings-invitation-list">${result.invitations.length?result.invitations.map(inv=>`<article class="settings-invitation-card"><div class="settings-person-row"><span class="settings-large-avatar">${initial(inv.childName)}</span><div class="settings-person-copy"><strong>${esc(inv.childName)}</strong><p>邀请你成为共同管理家长</p></div><span class="settings-status is-owner">待处理</span></div><p class="settings-help">接受后，可以查看和管理这个孩子的任务、积分与礼品。</p><div class="settings-invitation-footer"><span>${esc(date(inv.expiresAt))} 前有效</span><div><button class="btn" type="button" data-reject-invite="${esc(inv.id)}">拒绝邀请</button><button class="btn primary" type="button" data-accept-invite="${esc(inv.id)}">接受邀请</button></div></div></article>`).join(''):empty('暂无待处理邀请',`请让家人使用你的登录名「${context().user.loginName}」发送邀请，收到后可在这里接受。`)}</div>`;
        for(const answer of ['accept','reject'])panel.querySelectorAll(`[data-${answer}-invite]`).forEach(button=>button.onclick=()=>{
          const inviteId=button.dataset[answer+'Invite'];
          mutate(panel,active,button,()=>deps.api(`/api/invitations/${inviteId}/${answer}`,'POST',{}),async result=>{
            await deps.sync(false);if(!active())return;
            if(answer==='accept'){await deps.selectChild(result.childId)}else{await renderInvitations(panel,active)}
          });
        });
      }catch(error){if(active())panelError(panel,error,()=>renderInvitations(panel,active))}
    }
    return {render,open:page=>ui.open(page),invalidate,reset,refresh:()=>ui.refresh(),renderOnboarding};
  }
  window.LeleParentSettings={create};
})();
