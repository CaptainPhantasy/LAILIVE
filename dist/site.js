
  /* ============================================================
     PAIN INTAKE ENGINE
     ============================================================ */
  const PAINS = [
    { id: 'calls',     text: "Missed calls are costing me money",            solutions: ["Receptionist Who Never Calls In", "Missed-Call Recovery", "Silent Closer"] },
    { id: 'paperwork', text: "Paperwork is eating my Sundays",                solutions: ["Report Writer", "Talk-To-Type Field Tool", "Digital Sign-Off"] },
    { id: 'leads',     text: "Leads keep slipping through the cracks",        solutions: ["Follow-Up Machine", "Lead Catcher", "Sales Outreach On Autopilot"] },
    { id: 'website',   text: "My website looks like 2014",                    solutions: ["A Real Custom Website", "Website Rescue", "High-Converting Landing Pages"] },
    { id: 'search',    text: "I can't get found on Google",                   solutions: ["A Page For Every Neighborhood", "Top Of Google For Your Town", "The Map Pack", "Get Recommended By ChatGPT"] },
    { id: 'reviews',   text: "My reviews are mediocre (or invisible)",        solutions: ["The Review Ladder", "Bad-Review Interception", "Review Response Handling"] },
    { id: 'paid',      text: "Chasing invoices is ruining my week",           solutions: ["The Invoice Chaser", "On-Site Card Processing", "The Upsell Menu"] },
    { id: 'content',   text: "I have no time to post / write / market",       solutions: ["The Writer Who Never Sleeps", "Social Media Sidekick", "Blog From A Voice Memo", "Long-To-Short Video"] },
    { id: 'bloat',     text: "I'm paying for twelve tools that don't talk",   solutions: ["Subscription Bloat Audit", "Make Your Tools Talk", "Move Off The System You Hate"] },
    { id: 'numbers',   text: "I don't actually know what's working",          solutions: ["The Owner's Dashboard", "Where The Money Came From", "Sales Alerts On Your Phone"] },
    { id: 'big',       text: "I'm facing a decision I can't think through",   solutions: ["Executive Board · Counsel", "Executive Board · Boardroom", "Executive Board · Standing Seat"] },
    { id: 'security',  text: "I worry about getting hacked / sued / shut down", solutions: ["Locked Doors On Your Website", "Backups That Actually Work", "Lawyer-Proof Setup", "Disaster Recovery Plan"] },
  ];

  const serviceNames=["The Silent Closer", "The Receptionist Who Never Calls In", "The Live Booking Calendar", "The Daily Hunter", "The Lead Catcher", "The Missed-Call Recovery", "The Follow-Up Machine", "The Traffic Tattletale", "The Review Harvester", "The Report Writer", "The Talk-To-Type Field Tool", "The Technician Dashboard", "The Digital Sign-Off", "On-Site Card Processing", "The Upsell Menu", "The Invoice Chaser", "Books That Balance Themselves", "The Dispatcher", "A Real Custom Website", "High-Converting Landing Pages", "Website Rescue", "The Customer Portal", "A Page For Every Neighborhood", "Top Of Google For Your Town", "Get Recommended By ChatGPT", "The Map Pack", "The Review Ladder", "Bad-Review Interception", "Review Response Handling", "Social Proof Everywhere", "The Writer Who Never Sleeps", "The Social Media Sidekick", "Long-To-Short Video", "Blog From A Voice Memo", "Done-For-You Ad Campaigns", "Email &amp; Text Campaigns", "Seasonal Automation", "Sales Outreach On Autopilot", "The Quote-From-Photo Tool", "The Q&amp;A Specialist", "Outbound Reminder Calls", "Multilingual Customer Capture", "Locked Doors On Your Website", "Backups That Actually Work", "Lawyer-Proof Setup", "Disaster Recovery Plan", "The Owner's Dashboard", "Where The Money Came From", "Competitor Watch", "Sales Alerts On Your Phone", "Subscription Bloat Audit", "Make Your Tools Talk", "Move Off The System You Hate", "Customer List That Actually Works"];
  const grid = document.getElementById('painGrid');
  const selected = new Set();

const painIcons = ["M8 3H5a2 2 0 0 0-2 2c0 9 7 16 16 16a2 2 0 0 0 2-2v-3l-5-2-2 3a14 14 0 0 1-7-7l3-2Z", "M6 2h8l4 4v16H6Z M14 2v5h4 M9 11h6 M9 15h6 M9 19h4", "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M17 12a5 5 0 1 1-10 0a5 5 0 1 1 10 0", "M3 4h18v13H3Z M8 21h8 M12 17v4", "M16 10a6 6 0 1 1-12 0a6 6 0 1 1 12 0 M15 15l6 6", "m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z", "M6 2h12v20l-3-2-3 2-3-2-3 2Z M9 7h6 M9 11h6 M9 15h4", "m4 16 12-12 4 4L8 20H4Z M14 6l4 4", "M10 8 7 5a4 4 0 0 0-5 6l4 4a4 4 0 0 0 6 0 M14 16l3 3a4 4 0 0 0 5-6l-4-4a4 4 0 0 0-6 0 M8 12l8 0", "M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4", "M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0 M15 9l-2 5-4 1 2-5Z", "M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6Z M8 12l3 3 5-6"];
  if(grid){
  PAINS.forEach((p, i) => {
    const chip = document.createElement('button');
    chip.className = 'pain-chip';chip.type='button';chip.setAttribute('aria-pressed','false');
    chip.dataset.id = p.id;
    chip.innerHTML = `
      <span class="chip-num">${String(i + 1).padStart(2, '0')}</span>
      <svg class="pain-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${painIcons[i]}"></path></svg>
      <span class="chip-text">${p.text}</span>
      <span class="chip-check"></span>
    `;
    chip.addEventListener('click', () => togglePain(p.id, chip));
    grid.appendChild(chip);
  });

  function togglePain(id, el) {
    if (selected.has(id)) {
      selected.delete(id);
      el.classList.remove('active');
    } else {
      selected.add(id);
      el.classList.add('active');
    }
    el.setAttribute('aria-pressed',String(selected.has(id)));
    updateResults();
  }

  function updateResults() {
    const results = document.getElementById('intakeResults');
    const counter = document.getElementById('intakeCounter');
    const headline = document.getElementById('intakeHeadline');
    const matches = document.getElementById('intakeMatches');

    if (selected.size === 0) {
      results.classList.remove('visible');
      counter.textContent = 'Select one or more pain points above';
      headline.textContent = "We'll map your picks to the solutions that fix them.";
      matches.innerHTML = '';
      return;
    }

    const matched = new Set();
    PAINS.forEach(p => {
      if (selected.has(p.id)) p.solutions.forEach(s => matched.add(s));
    });

    const n = selected.size;
    const m = matched.size;

    results.classList.add('visible');
    counter.textContent = `▸ ${n} pain point${n > 1 ? 's' : ''} selected · ${m} matching solution${m > 1 ? 's' : ''}`;

    const headlines = [
      "Here's exactly what we'd deploy for you:",
      "These are the pieces that map to your pain:",
      "Start with these. Every one is already built:",
      "This is the shortlist we'd bring to your first call:",
    ];
    headline.textContent = headlines[Math.min(n - 1, headlines.length - 1)];

    matches.innerHTML = '';
    Array.from(matched).forEach(s => {
      const pill = document.createElement('a');
      pill.className = 'match-pill';
      const name=serviceNames.find(n=>n.toLowerCase().replace(/^the /,'')===s.toLowerCase().replace(/^the /,''));
      pill.href = s.startsWith('Executive Board')?'/board/':'/solutions/#'+(name||s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      pill.textContent = s;
      matches.appendChild(pill);
    });
  }


document.getElementById("intakeCounter").setAttribute("aria-live","polite");
if(document.modelContext?.registerTool){const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});try{Promise.resolve(document.modelContext.registerTool({name:'select_pain_points',description:'Select business pain points and update the visible matching solutions.',inputSchema:{type:'object',properties:{painIds:{type:'array',uniqueItems:true,items:{type:'string',enum:PAINS.map(p=>p.id)}}},required:['painIds'],additionalProperties:false},annotations:{readOnlyHint:false},execute(input){if(!input||!Array.isArray(input.painIds)||Object.keys(input).some(k=>k!=='painIds')||input.painIds.some(id=>!PAINS.some(p=>p.id===id))||new Set(input.painIds).size!==input.painIds.length)throw new Error('Supply unique supported pain IDs.');const want=new Set(input.painIds);[...grid.querySelectorAll('button')].forEach((b,i)=>{if(selected.has(PAINS[i].id)!==want.has(PAINS[i].id))b.click()});return {selected:[...selected],solutions:[...document.querySelectorAll('.match-pill')].map(a=>({name:a.textContent,url:a.getAttribute('href')}))}}},{signal:lifecycle.signal})).catch(()=>{});}catch{}}
}

// Accessible file tabs preview each existing chapter; links keep the full catalog reachable.
const folderTabs = [...document.querySelectorAll('.folder-tabs [role="tab"]')];
function selectFolder(tab) {
  folderTabs.forEach(t => { const active = t === tab; t.setAttribute('aria-selected', String(active)); t.tabIndex = active ? 0 : -1; document.getElementById(t.getAttribute('aria-controls')).hidden = !active; });
}
folderTabs.forEach((tab,i) => {
  tab.addEventListener('click', () => selectFolder(tab));
  tab.addEventListener('keydown', e => { let n; if(e.key==='ArrowRight') n=(i+1)%folderTabs.length; if(e.key==='ArrowLeft') n=(i+folderTabs.length-1)%folderTabs.length; if(e.key==='Home') n=0; if(e.key==='End') n=folderTabs.length-1; if(n!==undefined){e.preventDefault();selectFolder(folderTabs[n]);folderTabs[n].focus();} });
});
