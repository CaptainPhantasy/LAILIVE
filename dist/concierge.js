import { readCatalog, selectedServices, composeBrief, readChatResponse, buildInquiry, readReceipt, MAX_SERVICES } from './concierge-core.js';
import { readLeadContact, rememberLeadContact } from './lead-gate.js';

function mountGuide() {
  if (document.getElementById('legacy-guide')) return;
  const root = document.createElement('div');
  root.className = 'cg-root';
  // This template is constant. All catalog, visitor, and model text uses textContent.
  root.innerHTML = `
    <button class="cg-launcher" id="cg-launcher" type="button" aria-haspopup="dialog" aria-controls="legacy-guide">Compare &amp; plan <span aria-hidden="true">↗</span></button>
    <dialog id="legacy-guide" class="cg-dialog" aria-labelledby="cg-title">
      <div class="cg-header"><div><span class="cg-kicker">YOUR NEXT STEP</span><h2 id="cg-title">Let's make work easier.</h2></div><button type="button" class="cg-close" aria-label="Close Legacy AI guide">×</button></div>
      <div class="cg-tabs" role="tablist" aria-label="Legacy AI guide tools">
        <button type="button" role="tab" id="cg-tab-guide" hidden aria-controls="cg-panel-guide" aria-selected="true" tabindex="0" data-tab="guide">Ask the guide</button>
        <button type="button" role="tab" id="cg-tab-compare" aria-controls="cg-panel-compare" aria-selected="false" tabindex="-1" data-tab="compare">Compare services <span id="cg-count"></span></button>
        <button type="button" role="tab" id="cg-tab-brief" aria-controls="cg-panel-brief" aria-selected="false" tabindex="-1" data-tab="brief">Tell Douglas what I need</button>
      </div>
      <div class="cg-content">
        <div class="cg-catalog-state" role="status" aria-live="polite"><span id="cg-catalog-status">Open a tool to load the service catalog.</span> <button id="cg-reload" class="cg-link-button" type="button" hidden>Try loading again</button></div>
        <section class="cg-panel" id="cg-panel-guide" role="tabpanel" aria-labelledby="cg-tab-guide">
          <h3>What would you like to make easier?</h3>
          <p class="cg-intro">Ask about a service, explain your workflow, or find the next useful page. This is an AI guide; scope and terms are agreed with Douglas.</p>
          <p class="cg-note">Your questions are sent to the AI guide. Avoid private customer information. Identifying details you enter may be added to a visitor contact record. Sending an inquiry and agreeing to marketing are separate choices.</p>
          <div id="cg-chat-log" class="cg-chat-log" role="log" aria-label="Conversation with the AI guide" aria-live="polite" aria-relevant="additions"></div>
          <div id="cg-suggestions" class="cg-suggestions"></div>
          <form id="cg-chat-form">
            <label for="cg-question">Your question</label>
            <textarea id="cg-question" rows="3" maxlength="2000" required placeholder="What is taking too much time in your business?"></textarea>
            <div class="cg-actions"><button id="cg-ask" class="cg-primary" type="submit" disabled>Ask the guide</button><button id="cg-cancel" class="cg-secondary" type="button" hidden>Cancel answer</button><button class="cg-link-button" type="button" data-open-tab="compare">Browse the services</button></div>
          </form>
          <p id="cg-chat-status" class="cg-status" role="status" aria-live="polite"></p>
        </section>
        <section class="cg-panel" id="cg-panel-compare" role="tabpanel" aria-labelledby="cg-tab-compare" hidden>
          <h3>Find the right conversation to start.</h3><p class="cg-intro">Compare up to three services, then tell Douglas which parts fit your business and what you need them to do.</p>
          <div id="cg-selectors" class="cg-selectors"></div>
          <p id="cg-selection-status" class="cg-status" role="status" aria-live="polite"></p>
          <div id="cg-comparison" class="cg-comparison"></div>
          <p class="cg-note">Fit, integrations, pricing and timing are confirmed with Douglas for your business.</p>
          <button type="button" class="cg-primary" data-open-tab="brief">Discuss my shortlist with Douglas <span aria-hidden="true">→</span></button>
        </section>
        <section class="cg-panel" id="cg-panel-brief" role="tabpanel" aria-labelledby="cg-tab-brief" hidden>
          <h3>Tell Douglas what you want to get done.</h3><p class="cg-intro">Describe the work, review your request, and send it to Douglas with a reply address. The brief helps him understand your business before the conversation.</p>
          <form id="cg-brief-form" class="cg-brief-form">
            <div class="cg-field"><label for="cg-company">Business name <span>(optional)</span></label><input id="cg-company" name="company" maxlength="160" autocomplete="organization"></div>
            <div class="cg-field"><label for="cg-challenge">What would you like to make easier?</label><textarea id="cg-challenge" name="challenge" rows="3" maxlength="1500" required></textarea></div>
            <details class="cg-context"><summary>Add context (optional)</summary>
            <div class="cg-field"><label for="cg-phone">Phone (optional)</label><input id="cg-phone" name="phone" type="tel" maxlength="80" autocomplete="tel"></div>
            <div class="cg-field"><label for="cg-address">Business address (optional)</label><input id="cg-address" name="address" maxlength="300" autocomplete="street-address"></div>
            <div class="cg-field"><label for="cg-goal">What would a useful result look like? <span>(optional)</span></label><textarea id="cg-goal" name="goal" rows="2" maxlength="1000"></textarea></div>
            <div class="cg-field"><label for="cg-tools">Tools or process you use now <span>(optional)</span></label><textarea id="cg-tools" name="tools" rows="2" maxlength="700"></textarea></div>
            <div class="cg-field"><label for="cg-timing">Timing <span>(optional)</span></label><input id="cg-timing" name="timing" maxlength="250"></div>
            <div class="cg-field"><label for="cg-questions">Questions to discuss <span>(optional)</span></label><textarea id="cg-questions" name="questions" rows="2" maxlength="1000"></textarea></div>
            </details>
            <div class="cg-field" id="cg-next-step-field" hidden><label for="cg-next-steps">AI-suggested next steps — review or remove</label><textarea id="cg-next-steps" name="suggestions" rows="3" maxlength="1500"></textarea></div>
            <p id="cg-brief-shortlist" class="cg-note">No services selected yet. A shortlist is optional.</p>
            <div><button id="cg-build" class="cg-primary" type="submit">Review my inquiry</button><p id="cg-rebuild-note" class="cg-note" hidden>Reviewing again replaces the draft below with these fields and your current shortlist.</p></div>
          </form>
          <div id="cg-draft-block" class="cg-draft-block" hidden>
            <label for="cg-draft">Review what Douglas will receive</label><textarea id="cg-draft" rows="12" maxlength="8000" spellcheck="true"></textarea>
            <p class="cg-note">Edit the request before sending. Identifying details entered in these fields may be saved to help Douglas understand visitors; permission to reply is a separate choice below.</p>
          </div>
          <p id="cg-brief-status" class="cg-status" role="status" aria-live="polite"></p>
          <details id="cg-share" class="cg-share" hidden open><summary>Send this inquiry to Douglas</summary>
            <p>Give Douglas a way to follow up about this work. Your chat history is not included.</p>
            <form id="cg-inquiry-form"><fieldset id="cg-share-fields"><legend class="cg-sr-only">Details and choices for sharing this inquiry</legend>
              <div class="cg-field"><label for="cg-name">Your name</label><input id="cg-name" maxlength="120" autocomplete="name" required></div>
              <div class="cg-field"><label for="cg-email">Email for a reply about this inquiry</label><input id="cg-email" type="email" maxlength="254" autocomplete="email" required></div>
              <div class="cg-field"><label for="cg-share-company">Business name to share <span>(optional)</span></label><input id="cg-share-company" maxlength="160" autocomplete="organization"></div>
              <p class="cg-note">The current editable brief above is what will be sent, together with your selected service names and these contact details. Remove anything you do not want to share.</p>
              <label class="cg-choice"><input id="cg-confirm" type="checkbox" required><span id="cg-inquiry-notice">The current sharing notice must load before sending.</span></label>
              <label class="cg-choice"><input id="cg-marketing" type="checkbox"><span id="cg-marketing-notice">Optional email updates — the current notice must load first.</span></label>
              <p class="cg-note">Reply about this inquiry and optional email marketing are separate choices. Email is the only contact channel offered here.</p>
              <button id="cg-send" class="cg-primary" type="submit" disabled>Send my request to Douglas</button>
            </fieldset></form>
            <p id="cg-save-status" class="cg-status" role="status" aria-live="polite"></p>
            <div id="cg-receipt" class="cg-receipt" hidden><h4>Inquiry received.</h4><p id="cg-receipt-text"></p><p>Your inquiry is saved for Douglas to review. This is not an appointment confirmation.</p><button id="cg-saved-download" type="button" class="cg-secondary">Download the saved brief</button></div>
          </details>
        </section>
      </div>
    </dialog>`;
  document.body.append(root);
  const $ = id => root.querySelector(`#${id}`);
  const state = { catalog: null, ids: [], messages: [], nextSteps: [], loading: false, loaded: false, chatBusy: false, controller: null, failedBubble: null, attempt: null, receipt: null, savedText: '', opener: null, needsReview: false };
  const dialog = $('legacy-guide');
  const node = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
  const status = (id, text, error = false) => { const item = $(id); item.textContent = text; item.classList.toggle('cg-error', error); };

  function switchTab(name, focus = true) {
    if (!['guide', 'compare', 'brief'].includes(name)) name = 'compare';
    if (name === 'guide' && !state.catalog?.capabilities.chat) name = 'compare';
    root.querySelectorAll('[role="tab"]').forEach(button => {
      const active = button.dataset.tab === name;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      $(button.getAttribute('aria-controls')).hidden = !active;
    });
    if (focus) $(`cg-tab-${name}`).focus();
  }
  async function openGuide(tab = 'compare') {
    if (!dialog.open) { state.opener = document.activeElement; dialog.showModal(); }
    switchTab(tab);
    if (!state.loaded && !state.loading) await loadCatalog();
  }
  function closeGuide() { dialog.close(); if (state.opener?.isConnected) state.opener.focus(); }
  $('cg-launcher').addEventListener('click', () => openGuide());
  root.querySelector('.cg-close').addEventListener('click', closeGuide);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeGuide(); });
  root.querySelectorAll('[data-tab]').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
    button.addEventListener('keydown', event => {
      const tabs = [...root.querySelectorAll('[data-tab]')].filter(tab => !tab.hidden); let index = tabs.indexOf(button);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault(); switchTab(tabs[index].dataset.tab);
    });
  });
  root.querySelectorAll('[data-open-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.openTab)));
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-open-guide]');
    if (trigger) { event.preventDefault(); openGuide(trigger.dataset.openGuide); }
  });

  async function requestJSON(url, options = {}) {
    const controller = options.controller || new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, { ...options, controller: undefined, signal: controller.signal, credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
      let data; try { data = await response.json(); } catch { throw new Error('The service returned an unreadable response. Please try again.'); }
      if (!response.ok) {
        if (response.status === 429) throw new Error('The guide is busy. Please wait a moment before trying again.');
        if (response.status === 409 && url === '/api/inquiries') throw new Error('The sharing notice changed. Reload the catalog, review the notice and send again.');
        if (response.status === 400 || response.status === 422) throw new Error('Please check your details and try again. The service did not accept this request.');
        throw new Error(url === '/api/inquiries' ? 'Saving could not be confirmed. Your request is still here; please try again.' : 'The guide could not connect. Please try again or email douglas@legacyai.space.');
      }
      return data;
    } finally { window.clearTimeout(timeout); }
  }

  async function loadCatalog() {
    if (state.loading) return;
    state.loading = true; $('cg-reload').hidden = true; status('cg-catalog-status', 'Loading the service catalog…');
    try {
      let data; try { data = await requestJSON('/api/concierge/catalog'); } catch { data = await requestJSON('/service-catalog.json'); }
      const catalog = readCatalog(data);
      if (state.catalog?.consent?.version !== catalog.consent?.version) { $('cg-confirm').checked = false; $('cg-marketing').checked = false; }
      state.catalog = catalog; state.loaded = true;
      $('cg-tab-guide').hidden = !catalog.capabilities.chat;
      $('cg-share').hidden = !$('cg-draft').value.trim();
      if (catalog.capabilities.chat) $('cg-launcher').firstChild.textContent = 'Ask Legacy AI ';
      state.ids = state.ids.filter(id => catalog.services.some(service => service.id === id));
      $('cg-inquiry-notice').textContent = catalog.consent?.inquiryText || 'The current inquiry notice is unavailable. Please reconnect before sending.';
      $('cg-marketing-notice').textContent = catalog.consent?.marketingText || 'Optional email updates are unavailable.';
      $('cg-send').disabled = !catalog.capabilities.inquiries || !catalog.consent || !!state.receipt;
      $('cg-ask').disabled = state.chatBusy;
      status('cg-catalog-status', `${catalog.services.length} services from the Legacy AI catalog.`);
      renderComparison();
      if (!catalog.capabilities.inquiries) { status('cg-save-status', 'The inquiry service is not connected right now. Please try again or email douglas@legacyai.space.', true); $('cg-reload').hidden = false; }
    } catch (error) { status('cg-catalog-status', error.message || 'The catalog could not load.', true); $('cg-reload').hidden = false; }
    finally { state.loading = false; }
  }
  $('cg-reload').addEventListener('click', loadCatalog);

  function serviceLink(service, text = 'Read the service ↗') {
    const link = node('a', text, 'cg-service-link');
    link.href = `/solutions/#${service.id}`; link.target = '_blank'; link.rel = 'noopener';
    link.setAttribute('aria-label', `${text.replace('↗', '').trim()}: ${service.name} (opens in a new tab)`);
    return link;
  }
  function invalidateApproval() { if (!state.receipt) { $('cg-confirm').checked = false; $('cg-marketing').checked = false; } }
  function renderComparison() {
    if (!state.catalog) return;
    const selectors = $('cg-selectors'); selectors.replaceChildren();
    for (let index = 0; index < MAX_SERVICES; index++) {
      const field = node('div', undefined, 'cg-field'); const label = node('label', `Service ${index + 1}`); const select = node('select');
      select.id = `cg-service-${index}`; label.htmlFor = select.id;
      const none = node('option', 'Choose a service'); none.value = ''; select.append(none);
      state.catalog.services.forEach(service => { const option = node('option', service.name); option.value = service.id; option.disabled = state.ids.includes(service.id) && state.ids[index] !== service.id; select.append(option); });
      select.value = state.ids[index] || '';
      select.addEventListener('change', () => {
        const next = [...state.ids]; next[index] = select.value;
        state.ids = [...new Set(next.filter(Boolean))]; invalidateApproval(); renderComparison();
        const nextFocus = $(`cg-service-${Math.min(index, state.ids.length)}`); nextFocus?.focus();
        status('cg-selection-status', `${state.ids.length} ${state.ids.length === 1 ? 'service' : 'services'} in your shortlist.`);
      });
      field.append(label, select); selectors.append(field);
    }
    const selected = selectedServices(state.ids, state.catalog.services);
    $('cg-count').textContent = selected.length ? `(${selected.length})` : '';
    $('cg-brief-shortlist').textContent = selected.length ? `My shortlist: ${selected.map(service => service.name).join(' · ')}` : 'No services selected yet. A shortlist is optional.';
    const comparison = $('cg-comparison'); comparison.replaceChildren();
    if (!selected.length) comparison.append(node('p', 'Select services above to compare their purpose and description.', 'cg-empty'));
    selected.forEach(service => {
      const article = node('article', undefined, 'cg-service');
      article.append(node('p', service.tag, 'cg-service-tag'), node('h4', service.name), node('p', service.body), serviceLink(service));
      comparison.append(article);
    });
  }
  function addService(id) {
    if (state.ids.includes(id)) { switchTab('compare'); return; }
    if (state.ids.length >= MAX_SERVICES) { switchTab('compare'); status('cg-selection-status', 'Your shortlist has three services. Replace one above to add another.', true); return; }
    state.ids.push(id); invalidateApproval(); renderComparison(); switchTab('compare');
    status('cg-selection-status', 'Added to your shortlist.');
  }

  function appendMessage(speaker, content) {
    const article = node('article', undefined, speaker === 'You' ? 'cg-message cg-message-user' : 'cg-message');
    article.append(node('strong', speaker, 'cg-message-speaker'), node('p', content)); $('cg-chat-log').append(article); return article;
  }
  function renderSuggestions(response) {
    const container = $('cg-suggestions'); container.replaceChildren();
    response.serviceIds.forEach(id => {
      const service = state.catalog.services.find(item => item.id === id);
      const row = node('div', undefined, 'cg-suggestion'); const add = node('button', `Compare ${service.name}`, 'cg-secondary'); add.type = 'button';
      add.addEventListener('click', () => addService(id)); row.append(add, serviceLink(service)); container.append(row);
    });
    state.nextSteps = response.nextSteps;
    if (response.nextSteps.length) {
      const button = node('button', 'Add suggested next steps to my brief', 'cg-link-button'); button.type = 'button';
      button.addEventListener('click', () => {
        $('cg-next-step-field').hidden = false; $('cg-next-steps').value = response.nextSteps.map(step => `- ${step}`).join('\n');
        switchTab('brief'); $('cg-next-steps').focus(); status('cg-brief-status', 'Suggested steps added to the fields. Review them, then build your brief.');
      }); container.append(button);
    }
  }
  $('cg-chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.chatBusy || !state.catalog) return;
    const question = $('cg-question').value.trim(); if (!question) return;
    state.chatBusy = true; $('cg-ask').disabled = true; $('cg-question').disabled = true; $('cg-cancel').hidden = false;
    if (state.failedBubble) { state.failedBubble.remove(); state.failedBubble = null; }
    const bubble = appendMessage('You', question); const controller = new AbortController(); state.controller = controller;
    status('cg-chat-status', 'The guide is preparing an answer…');
    try {
      const messages = [...state.messages.slice(-12), { role: 'user', content: question }];
      const response = readChatResponse(await requestJSON('/api/concierge', { method: 'POST', body: JSON.stringify({ messages, serviceIds: state.ids }), controller }), state.catalog.services);
      state.messages = [...messages, { role: 'assistant', content: response.reply }];
      appendMessage('AI guide', response.reply); renderSuggestions(response); $('cg-question').value = ''; status('cg-chat-status', 'Answer received.');
    } catch (error) { state.failedBubble = bubble; status('cg-chat-status', error.name === 'AbortError' ? 'The answer was stopped. Your question is still here.' : error.message, true); }
    finally { state.chatBusy = false; state.controller = null; $('cg-ask').disabled = false; $('cg-question').disabled = false; $('cg-cancel').hidden = true; if (dialog.open && !$('cg-panel-guide').hidden) $('cg-question').focus(); }
  });
  $('cg-cancel').addEventListener('click', () => state.controller?.abort());

  $('cg-brief-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      const selected = state.catalog ? selectedServices(state.ids, state.catalog.services) : [];
      $('cg-draft').value = composeBrief(fields, selected); $('cg-draft-block').hidden = false;
      $('cg-share-company').value = fields.company || $('cg-share-company').value; $('cg-build').textContent = 'Update inquiry from fields'; $('cg-rebuild-note').hidden = false;
      $('cg-share').hidden = false; $('cg-share').open = true;
      const contact = readLeadContact(); for (const key of ['name', 'email', 'company']) { const input = $(key === 'company' ? 'cg-share-company' : `cg-${key}`); if (!input.value) input.value = contact[key]; }
      invalidateApproval(); $('cg-draft').focus(); status('cg-brief-status', 'Review your request, then add your reply details and send it to Douglas.');
    } catch (error) { status('cg-brief-status', error.message, true); }
  });
  $('cg-draft').addEventListener('input', invalidateApproval);
  ['cg-name', 'cg-email', 'cg-share-company'].forEach(id => $(id).addEventListener('input', () => { invalidateApproval(); rememberLeadContact({ name: $('cg-name').value, email: $('cg-email').value, company: $('cg-share-company').value }); }));
  function download(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('cg-share').addEventListener('toggle', () => { if ($('cg-share').open && !$('cg-draft').value.trim()) status('cg-save-status', 'Build and review your brief above before sending.', true); });
  $('cg-inquiry-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.receipt || $('cg-send').disabled) return;
    let payload;
    try {
      payload = buildInquiry({ name: $('cg-name').value, email: $('cg-email').value, company: $('cg-share-company').value, message: $('cg-draft').value, confirmed: $('cg-confirm').checked, marketingOptIn: $('cg-marketing').checked }, state.ids, state.catalog?.services || [], state.catalog?.consent);
    } catch (error) { status('cg-save-status', error.message, true); return; }
    const serialized = JSON.stringify(payload);
    if (!state.attempt || state.attempt.serialized !== serialized) state.attempt = { serialized, key: crypto.randomUUID() };
    $('cg-send').disabled = true; $('cg-share-fields').disabled = true; status('cg-save-status', 'Saving the details you chose to share…');
    try {
      const receipt = readReceipt(await requestJSON('/api/inquiries', { method: 'POST', headers: { 'Idempotency-Key': state.attempt.key }, body: serialized }));
      state.receipt = receipt; state.savedText = receipt.brief || payload.message;
      rememberLeadContact(payload);
      root.querySelectorAll('#cg-brief-form input,#cg-brief-form textarea,#cg-brief-form button,#cg-selectors select').forEach(input => { input.disabled = true; }); $('cg-draft').readOnly = true;
      $('cg-receipt-text').textContent = `Reference ${receipt.id} · Saved ${new Date(receipt.createdAt).toLocaleString()}`;
      $('cg-receipt').hidden = false; status('cg-save-status', 'Your inquiry is saved.');
      $('cg-send').textContent = 'Inquiry received';
    } catch (error) {
      status('cg-save-status', error.name === 'AbortError' ? 'The save timed out. Receipt is not confirmed; retrying the unchanged inquiry uses the same reference.' : error.message, true);
      $('cg-share-fields').disabled = false; $('cg-send').disabled = false;
      if (error.message.includes('sharing notice changed')) { $('cg-confirm').checked = false; $('cg-marketing').checked = false; $('cg-reload').hidden = false; $('cg-send').disabled = true; }
    }
  });
  $('cg-saved-download').addEventListener('click', () => { if (state.receipt) download(state.savedText, `legacy-ai-inquiry-${state.receipt.id}.txt`); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountGuide, { once: true });
else mountGuide();
