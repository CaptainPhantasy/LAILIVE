  const BOARD_ENDPOINT = '/api/board';
  const BOARD_STORAGE_KEY = 'legacyai_board_spun_v1';
  let boardRepeatSessions = false;
  let completedBoardReport = null;

  function setCompletedBoardReport(question, text) {
    completedBoardReport = text?.trim() ? `YOUR BOARD REPORT\n\nDecision: ${question}\n\n${text}\n` : null;
    document.getElementById('boardDownload').hidden = !completedBoardReport;
  }

  function downloadBoardReport() {
    if (!completedBoardReport) return;
    const url = URL.createObjectURL(new Blob([completedBoardReport], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'LegacyAI-Board-Report.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function applyBoardPolicy(repeatSessions) {
    boardRepeatSessions = repeatSessions === true;
    const note = document.getElementById('boardSessionNote');
    if (note && boardRepeatSessions) note.textContent = 'Bring another decision during business hours: Monday–Friday, 8am–5pm Eastern. Up to four sessions per hour, subject to availability. Your contact details stay attached to the conversation with Douglas.';
    else if (note) note.textContent = 'Bring one real decision. Share your reply details with Douglas, then get five perspectives and a practical next step.';
    const complete = document.getElementById('boardCompleteMessage');
    if (complete && boardRepeatSessions) complete.textContent = 'Your report is ready. Bring the next decision, or talk with Douglas about putting the recommendation to work.';
    else if (complete) complete.textContent = 'Your report is ready. Talk with Douglas about putting the recommendation to work for your business.';
  }

  // Render report structure only after streaming, with every source character escaped.
  function formatBoardReport(text) {
    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const inline = s => escape(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    let html = '', paragraph = [], list = '', fenced = false, code = [];
    const flush = () => { if (paragraph.length) { html += '<p>' + paragraph.map(inline).join('<br>') + '</p>'; paragraph = []; } if (list) { html += '</' + list + '>'; list = ''; } };
    for (const line of text.split(/\r?\n/)) {
      if (/^```/.test(line)) { flush(); if (fenced) { html += '<pre>' + escape(code.join('\n')) + '</pre>'; code = []; } fenced = !fenced; continue; }
      if (fenced) { code.push(line); continue; }
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/) || line.match(/^\*\*([^*]+)\*\*:?\s*$/) || line.match(/^(Majority (?:recommendation|opinion)|Dissent|Risks|Next steps|Recommendation):?\s*$/i);
      const bullet = line.match(/^\s*[-*]\s+(.+)$/), numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (heading) { flush(); html += '<h3>' + inline(heading[1]) + '</h3>'; }
      else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); html += '<hr>'; }
      else if (bullet || numbered) { const tag = bullet ? 'ul' : 'ol'; if (list !== tag) { flush(); html += '<' + tag + '>'; list = tag; } html += '<li>' + inline((bullet || numbered)[1]) + '</li>'; }
      else if (!line.trim()) flush();
      else { if (list) flush(); paragraph.push(line); }
    }
    flush(); if (code.length) html += '<pre>' + escape(code.join('\n')) + '</pre>';
    return html;
  }

  // Tiny, safe-ish markdown-ish renderer — enough for headings, bold, italics,
  // tables, horizontal rules. Escapes HTML first so the model can't inject DOM.
  function boardAlreadySpent() {
    try { return !!localStorage.getItem(BOARD_STORAGE_KEY); } catch (_) { return false; }
  }
  function markBoardSpent(question) {
    try { localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify({ q: question, at: Date.now() })); } catch (_) {}
  }

  async function runLiveBoard(question) {
    const status       = document.getElementById('boardStatus');
    const streamStatus = document.getElementById('boardStreamStatus');
    const streamLabel  = document.getElementById('boardStreamLabel');
    const output       = document.getElementById('boardOutput');
    const errorBox     = document.getElementById('boardError');
    const submitBtn    = document.getElementById('boardSubmit');
    const input        = document.getElementById('boardQuestionInput');
    const questionEcho = document.getElementById('boardQuestion');
    const spent        = document.getElementById('boardSpent');

    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Your next step…';
    input.disabled = true;
    let inquiryReceipt;
    try {
      const { requestLead } = await import('/lead-gate.js');
      inquiryReceipt = await requestLead({
        key: `board:${question}`, purpose: 'Board decision and next-steps inquiry',
        title: 'Where should Douglas follow up?',
        intro: 'Send Douglas the decision you are working through so he can discuss the next steps with you. Once your inquiry is received, the Board report appears here.',
        request: question,
      });
    } catch (error) {
      errorBox.textContent = error.message || 'The inquiry service could not connect. Please try again.';
      errorBox.classList.add('active');
    }
    if (!inquiryReceipt) { submitBtn.disabled = false; submitBtn.textContent = 'Convene the Board'; input.disabled = false; return; }

    // Lock UI
    submitBtn.disabled = true;
    submitBtn.textContent = 'Convening…';
    input.disabled = true;
    errorBox.classList.remove('active');
    errorBox.textContent = '';

    // Echo the question where the old static one lived
    questionEcho.textContent = '\u201C' + question + '\u201D';
    questionEcho.style.display = 'block';

    // Streaming UI on
    streamStatus.classList.add('active');
    streamLabel.textContent = 'Convening the board…';
    status.textContent = '◉ convening';
    status.style.color = 'var(--sig)';
    output.classList.add('active');
    output.classList.add('board-output-caret');
    output.innerHTML = '';
    output.classList.remove('report-formatted');
    setCompletedBoardReport('', '');

    let fullText = '';

    try {
      const response = await fetch(BOARD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Legacy-Inquiry': inquiryReceipt.id },
        body: JSON.stringify({ question: question, repeatSession: boardAlreadySpent() })
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error('The board could not convene. (' + response.status + ') ' + errText.slice(0, 200));
      }

      if (!response.body) throw new Error('No response stream from the board.');
      applyBoardPolicy(response.headers.get('X-Board-Repeat-Sessions') === 'true');

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();

      streamLabel.textContent = 'Deliberating…';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        fullText += decoder.decode(value, { stream: true });
        output.textContent = fullText;
        // Keep scroll pinned to latest text
        output.scrollTop = output.scrollHeight;
      }

      fullText += decoder.decode();
      if (!fullText.trim()) throw new Error('The board returned an empty report.');
      output.innerHTML = formatBoardReport(fullText);
      output.classList.add('report-formatted');
      output.scrollTop = 0;
      setCompletedBoardReport(question, fullText);

      // Done
      output.classList.remove('board-output-caret');
      streamStatus.classList.remove('active');
      status.textContent = '◉ report delivered';
      status.style.color = 'var(--moss-bright)';

      // The server decides whether repeats are active; no lifetime lock during
      // the verified low-cost window. Contact capture still runs for every decision.
      markBoardSpent(question);
      spent.classList.add('active');
      document.getElementById('boardInputBlock').style.display = boardRepeatSessions ? '' : 'none';
      if (boardRepeatSessions) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Convene the Board';
        input.disabled = false;
        input.value = '';
      }

    } catch (err) {
      output.classList.remove('board-output-caret');
      streamStatus.classList.remove('active');
      status.textContent = '◉ session aborted';
      status.style.color = 'var(--red)';

      errorBox.textContent = (err && err.message)
        ? err.message
        : 'The board could not convene. Try again, or reach out to Douglas directly.';
      errorBox.classList.add('active');

      // Re-enable input — don't burn their spin on a failure
      submitBtn.disabled = false;
      submitBtn.textContent = 'Convene the Board';
      input.disabled = false;
    }
  }

  async function initBoardSession() {
    const input       = document.getElementById('boardQuestionInput');
    const submitBtn   = document.getElementById('boardSubmit');
    const inputBlock  = document.getElementById('boardInputBlock');
    const spent       = document.getElementById('boardSpent');
    const questionEcho= document.getElementById('boardQuestion');
    document.getElementById('boardDownload').addEventListener('click', downloadBoardReport);

    // Prefill from ?q= if present (Ryan's hand-off URL)
    try {
      const params = new URLSearchParams(window.location.search);
      const q = (params.get('q') || '').trim();
      if (q) input.value = q;
    } catch (_) {}

    // Ask the server before restoring the old one-use flag, including for
    // returning visitors. This request generates nothing and costs no tokens.
    submitBtn.disabled = true;
    try {
      const response = await fetch(BOARD_ENDPOINT, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.ok) applyBoardPolicy((await response.json()).repeatSessions);
    } catch (_) { /* Keep the current one-session policy if availability cannot be checked. */ }
    submitBtn.disabled = false;

    if (boardAlreadySpent() && !boardRepeatSessions) {
      inputBlock.style.display = 'none';
      try {
        const prev = JSON.parse(localStorage.getItem(BOARD_STORAGE_KEY) || '{}');
        if (prev && prev.q) {
          questionEcho.textContent = '\u201C' + prev.q + '\u201D';
          questionEcho.style.display = 'block';
        }
      } catch (_) {}
      spent.classList.add('active');
      document.getElementById('boardStatus').textContent = '◉ session complete';
      document.getElementById('boardCompleteMessage').textContent = 'Your previous session is complete. Talk with Douglas about putting the recommendation to work for your business.';
      return;
    }

    const submit = () => {
      const q = input.value.trim();
      if (q.length < 8) {
        const errorBox=document.getElementById('boardError'); errorBox.textContent='Please describe your decision in at least 8 characters.';errorBox.classList.add('active');input.setAttribute('aria-invalid','true');input.focus();return;
      }
      input.removeAttribute('aria-invalid');
      runLiveBoard(q);
    };

    submitBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  initBoardSession();


document.getElementById("boardError").setAttribute("role","alert");document.getElementById("boardStatus").setAttribute("aria-live","polite");
