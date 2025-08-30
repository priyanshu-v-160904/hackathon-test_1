/* Minimal full client app: data model + scheduler + UI (localStorage) */

const store = {
  cfg: { periods: 6, days: 6, lunchAt: 3, weekStart: isoMonday(new Date()) },
  teachers: [],        // {id,name,code,maxPerDay,maxPerWeek,avoidConsec}
  subjects: [],        // {id,name,code}
  classes: [],         // {id,name}
  loads: [],           // {classId,subjectId,ppw}
  canTeach: [],        // {teacherId,subjectId}
  availability: []     // {teacherId, day, period, available}
};

// ---------- Utilities ----------
function save() { localStorage.setItem('tt-data', JSON.stringify(store)); }
function load() {
  const raw = localStorage.getItem('tt-data');
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    Object.assign(store, data);
  } catch {}
}
function nextId(arr){ return arr.length ? Math.max(...arr.map(x=>x.id||0))+1 : 1; }
function isoMonday(d){
  const dd = new Date(d); const day = (dd.getDay()+6)%7; dd.setDate(dd.getDate()-day);
  dd.setHours(0,0,0,0); return dd.toISOString().slice(0,10);
}
function dayName(d){ return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][d] }
function availabilityKey(tid, d, p){ return `${tid}-${d}-${p}` }

// ---------- Bootstrap ----------
load();
initDefaultsIfEmpty();
hookUI();
renderAll();

function initDefaultsIfEmpty(){
  if (!store.cfg) store.cfg = { periods:6, days:6, lunchAt:3, weekStart: isoMonday(new Date()) };
  // Ensure availability matrix exists for each teacher
  for (const t of store.teachers) ensureDefaultAvailabilityForTeacher(t.id);
}

// ---------- Availability helpers ----------
function ensureDefaultAvailabilityForTeacher(teacherId){
  const set = new Set(store.availability.map(a=>availabilityKey(a.teacherId,a.day,a.period)));
  for (let d=0; d<store.cfg.days; d++){
    for (let p=0; p<store.cfg.periods; p++){
      if (store.cfg.lunchAt!=null && p===store.cfg.lunchAt) continue;
      const k = availabilityKey(teacherId,d,p);
      if (!set.has(k)){
        store.availability.push({ teacherId, day:d, period:p, available:true });
      }
    }
  }
}

// ---------- Scheduler (backtracking with heuristics) ----------
function generateSchedule(opts){
  const cfg = store.cfg;
  const hard = { noDoubleBooking: opts.hDouble, honorAvailability: opts.hAvail };
  const soft = { avoidConsecutive: opts.sConsec, balanceTeacherLoad: opts.sBalance };

  // demands: per class & subject, remaining periods this week
  const demand = store.loads.map(l => ({ classId:l.classId, subjectId:l.subjectId, remaining:l.ppw }));
  if (demand.length === 0) throw new Error("No class loads defined.");

  // Slots per class
  const slots = [];
  for (const c of store.classes){
    for (let d=0; d<cfg.days; d++){
      for (let p=0; p<cfg.periods; p++){
        if (cfg.lunchAt!=null && p===cfg.lunchAt) continue;
        slots.push({day:d, period:p, classId:c.id});
      }
    }
  }

  // Availability lookup
  const avail = new Set();
  for (const a of store.availability) if (a.available) avail.add(availabilityKey(a.teacherId,a.day,a.period));

  // Can-teach map
  const canTeach = new Map();
  for (const ts of store.canTeach){
    if (!canTeach.has(ts.teacherId)) canTeach.set(ts.teacherId, new Set());
    canTeach.get(ts.teacherId).add(ts.subjectId);
  }

  const teachersById = new Map(store.teachers.map(t=>[t.id,t]));
  const assigned = new Map(); // key: `${day}-${period}-${classId}` -> {subjectId, teacherId}
  const tDayLoad = new Map(); // `${tId}-${day}` -> n
  const tWeekLoad = new Map(); // tId -> n
  const lastPeriodByTeacherClass = new Map(); // `${tId}-${classId}-${day}` -> last period

  function kSlot(s){ return `${s.day}-${s.period}-${s.classId}` }

  function teacherOK(tId, day, period, classId, subjectId){
    const t = teachersById.get(tId);
    if (!t) return false;

    // subject skill
    if (!canTeach.get(tId) || !canTeach.get(tId).has(subjectId)) return false;

    // hard: availability
    if (hard.honorAvailability && !avail.has(availabilityKey(tId,day,period))) return false;

    // hard: no double booking same time
    if (hard.noDoubleBooking){
      for (const [k,v] of assigned){
        const [d,p] = k.split('-').map(Number);
        if (d===day && p===period && v.teacherId===tId) return false;
      }
    }

    // caps
    const dlKey = `${tId}-${day}`;
    const dLoad = (tDayLoad.get(dlKey)||0);
    const wLoad = (tWeekLoad.get(tId)||0);
    if (dLoad + 1 > t.maxPerDay) return false;
    if (wLoad + 1 > t.maxPerWeek) return false;

    // soft: avoid consecutive for same class/day
    if (soft.avoidConsecutive && t.avoidConsec){
      const lpKey = `${tId}-${classId}-${day}`;
      const last = lastPeriodByTeacherClass.get(lpKey);
      if (last!=null && Math.abs(last-period)===1) return false;
    }
    return true;
  }

  // heuristic: sort most demanding first
  demand.sort((a,b)=> b.remaining - a.remaining);

  function backtrack(i){
    if (i===demand.length) return true;
    if (demand[i].remaining===0) return backtrack(i+1);

    const { classId, subjectId } = demand[i];

    // free slots for this class
    const cSlots = slots.filter(s => s.classId===classId && !assigned.has(kSlot(s)));
    // prefer earlier in the week, then earlier periods
    cSlots.sort((a,b)=> a.day-b.day || a.period-b.period);

    // candidate teachers who can teach this subject
    let pool = store.teachers.filter(t => canTeach.get(t.id)?.has(subjectId)).map(t=>t.id);

    // balance week load (ascending)
    if (soft.balanceTeacherLoad){
      pool.sort((a,b)=> (tWeekLoad.get(a)||0) - (tWeekLoad.get(b)||0));
    }

    for (const slot of cSlots){
      for (const tId of pool){
        if (!teacherOK(tId, slot.day, slot.period, classId, subjectId)) continue;

        // place
        assigned.set(kSlot(slot), { subjectId, teacherId: tId });
        const dKey = `${tId}-${slot.day}`;
        tDayLoad.set(dKey, (tDayLoad.get(dKey)||0) + 1);
        tWeekLoad.set(tId, (tWeekLoad.get(tId)||0) + 1);
        lastPeriodByTeacherClass.set(`${tId}-${classId}-${slot.day}`, slot.period);
        demand[i].remaining--;

        if (backtrack(i)) return true;

        // undo
        demand[i].remaining++;
        assigned.delete(kSlot(slot));
        tDayLoad.set(dKey, (tDayLoad.get(dKey)||1) - 1);
        tWeekLoad.set(tId, (tWeekLoad.get(tId)||1) - 1);
      }
    }
    return false;
  }

  const ok = backtrack(0);
  if (!ok) throw new Error("Could not satisfy all constraints. Try relaxing limits or increasing availability.");

  // Return rows for rendering
  const byClass = new Map(store.classes.map(c=>[c.id,c.name]));
  const bySub = new Map(store.subjects.map(s=>[s.id,s.name]));
  const byTeacher = new Map(store.teachers.map(t=>[t.id,t.name]));
  const rows = [];
  for (const [k,v] of assigned){
    const [day, period, classId] = k.split('-').map(Number);
    rows.push({ day, period, className: byClass.get(classId), subject: bySub.get(v.subjectId), teacher: byTeacher.get(v.teacherId) });
  }
  return rows;
}

// ---------- UI ----------
function hookUI(){
  // Config
  const d = document;
  const cfgW = d.getElementById('cfgWeekStart');
  cfgW.value = store.cfg.weekStart;
  d.getElementById('cfgPeriods').value = store.cfg.periods;
  d.getElementById('cfgDays').value = store.cfg.days;
  d.getElementById('cfgLunch').value = store.cfg.lunchAt ?? -1;

  d.getElementById('btnSaveCfg').onclick = () => {
    const periods = +d.getElementById('cfgPeriods').value;
    const days = +d.getElementById('cfgDays').value;
    const lunchVal = +d.getElementById('cfgLunch').value;
    const weekStart = d.getElementById('cfgWeekStart').value || isoMonday(new Date());
    store.cfg.periods = Math.max(1, Math.min(12, periods));
    store.cfg.days = Math.max(1, Math.min(7, days));
    store.cfg.lunchAt = (isNaN(lunchVal) || lunchVal < 0) ? null : lunchVal;
    store.cfg.weekStart = weekStart;
    for (const t of store.teachers) ensureDefaultAvailabilityForTeacher(t.id);
    save(); msg('cfgMsg', 'Saved.', 1500); renderAvailability(); renderAllTimetable([]);
  };

  // Teachers
  d.getElementById('btnAddTeacher').onclick = () => {
    const name = d.getElementById('tName').value.trim();
    const code = d.getElementById('tCode').value.trim();
    const maxPerDay = +d.getElementById('tMaxDay').value || 4;
    const maxPerWeek = +d.getElementById('tMaxWeek').value || 18;
    const avoidConsec = d.getElementById('tAvoid').checked;
    if (!name || !code) return;
    const id = nextId(store.teachers);
    store.teachers.push({ id, name, code, maxPerDay, maxPerWeek, avoidConsec });
    ensureDefaultAvailabilityForTeacher(id);
    save(); renderTeachers(); renderAvailability(); renderSelectors();
    d.getElementById('tName').value=''; d.getElementById('tCode').value='';
  };

  // Subjects
  d.getElementById('btnAddSubject').onclick = () => {
    const name = d.getElementById('sName').value.trim();
    const code = d.getElementById('sCode').value.trim();
    if (!name || !code) return;
    const id = nextId(store.subjects);
    store.subjects.push({ id, name, code });
    save(); renderSubjects(); renderSelectors();
    d.getElementById('sName').value=''; d.getElementById('sCode').value='';
  };

  // Classes & loads
  d.getElementById('btnAddClass').onclick = () => {
    const name = d.getElementById('cName').value.trim();
    if (!name) return;
    const id = nextId(store.classes);
    store.classes.push({ id, name });
    save(); renderClasses(); renderSelectors();
    d.getElementById('cName').value='';
  };

  d.getElementById('btnAddLoad').onclick = () => {
    const classId = +document.getElementById('loadClass').value;
    const subjectId = +document.getElementById('loadSubject').value;
    const ppw = +document.getElementById('loadPPW').value;
    if (!classId || !subjectId || !ppw) return;
    store.loads.push({ classId, subjectId, ppw });
    save(); renderClasses();
  };

  // Teacher skills
  d.getElementById('btnAddTS').onclick = () => {
    const teacherId = +document.getElementById('tsTeacher').value;
    const subjectId = +document.getElementById('tsSubject').value;
    if (!teacherId || !subjectId) return;
    if (!store.canTeach.some(x=>x.teacherId===teacherId && x.subjectId===subjectId)){
      store.canTeach.push({ teacherId, subjectId });
      save(); renderTeachSkill();
    }
  };

  // Generate
  d.getElementById('btnSchedule').onclick = () => {
    try {
      const rows = generateSchedule({
        hDouble: document.getElementById('hDouble').checked,
        hAvail: document.getElementById('hAvail').checked,
        sConsec: document.getElementById('sConsec').checked,
        sBalance: document.getElementById('sBalance').checked
      });
      msg('schedMsg', '✅ Schedule created.', 2000);
      renderAllTimetable(rows);
    } catch(e){
      msg('schedMsg', '❌ ' + (e.message||e), 4000, true);
      renderAllTimetable([]);
    }
  };

  // Export / Import / Seed / Clear
  document.getElementById('btnExport').onclick = () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'timetable.json'; a.click();
  };
  document.getElementById('importFile').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        Object.assign(store, data); save(); renderAll();
        msg('schedMsg', '✅ Imported.', 1500);
      } catch { msg('schedMsg','❌ Import failed.',2500,true); }
    };
    reader.readAsText(file);
  };
  document.getElementById('btnSeed').onclick = () => { seedDemo(); save(); renderAll(); msg('schedMsg','Demo data loaded.',1500); };
  document.getElementById('btnClear').onclick = () => { localStorage.removeItem('tt-data'); location.reload(); };
}

function msg(id, text, ms=1500, bad=false){
  const el = document.getElementById(id);
  el.textContent = text; el.className = 'small ' + (bad ? 'bad':'ok');
  setTimeout(()=>{ el.textContent=''; el.className='small'; }, ms);
}

// ---------- Renderers ----------
function renderAll(){
  renderSelectors();
  renderTeachers();
  renderSubjects();
  renderClasses();
  renderTeachSkill();
  renderAvailability();
  renderAllTimetable([]);
  // write cfg to inputs if needed
  document.getElementById('cfgPeriods').value = store.cfg.periods;
  document.getElementById('cfgDays').value = store.cfg.days;
  document.getElementById('cfgLunch').value = store.cfg.lunchAt ?? -1;
  document.getElementById('cfgWeekStart').value = store.cfg.weekStart;
}

function renderSelectors(){
  const loadClass = document.getElementById('loadClass');
  loadClass.innerHTML = store.classes.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  const loadSubject = document.getElementById('loadSubject');
  loadSubject.innerHTML = store.subjects.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');

  const tsTeacher = document.getElementById('tsTeacher');
  tsTeacher.innerHTML = store.teachers.map(t=>`<option value="${t.id}">${t.name}</option>`).join('');
  const tsSubject = document.getElementById('tsSubject');
  tsSubject.innerHTML = store.subjects.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
}

function renderTeachers(){
  const div = document.getElementById('teacherList');
  if (store.teachers.length===0){ div.innerHTML = '<span class="muted">No teachers yet.</span>'; return; }
  div.innerHTML = store.teachers.map(t => `
    <div class="row" style="justify-content:space-between; border-top:1px dashed #e5e7eb; padding-top:6px; margin-top:6px;">
      <div><b>${t.name}</b> <span class="muted">(${t.code})</span>
        <span class="pill">Max/Day ${t.maxPerDay}</span>
        <span class="pill">Max/Week ${t.maxPerWeek}</span>
        <span class="pill">${t.avoidConsec?'Avoid consec':'Consec ok'}</span>
      </div>
      <button class="ghost" onclick="removeTeacher(${t.id})">Delete</button>
    </div>
  `).join('');
}
window.removeTeacher = (id) => {
  store.teachers = store.teachers.filter(t=>t.id!==id);
  store.canTeach = store.canTeach.filter(x=>x.teacherId!==id);
  store.availability = store.availability.filter(a=>a.teacherId!==id);
  save(); renderTeachers(); renderTeachSkill(); renderAvailability(); renderSelectors();
};

function renderSubjects(){
  const div = document.getElementById('subjectList');
  if (store.subjects.length===0){ div.innerHTML = '<span class="muted">No subjects yet.</span>'; return; }
  div.innerHTML = store.subjects.map(s => `
    <div class="row" style="justify-content:space-between; border-top:1px dashed #e5e7eb; padding-top:6px; margin-top:6px;">
      <div><b>${s.name}</b> <span class="muted">(${s.code})</span></div>
      <button class="ghost" onclick="removeSubject(${s.id})">Delete</button>
    </div>
  `).join('');
}
window.removeSubject = (id) => {
  store.subjects = store.subjects.filter(s=>s.id!==id);
  store.canTeach = store.canTeach.filter(x=>x.subjectId!==id);
  store.loads = store.loads.filter(x=>x.subjectId!==id);
  save(); renderSubjects(); renderTeachSkill(); renderClasses(); renderSelectors();
};

function renderClasses(){
  const div = document.getElementById('classList');
  if (store.classes.length===0){ div.innerHTML = '<span class="muted">No classes yet.</span>'; return; }
  const loadsByClass = new Map();
  for (const l of store.loads){
    const key = l.classId;
    if (!loadsByClass.has(key)) loadsByClass.set(key, []);
    const subject = store.subjects.find(s=>s.id===l.subjectId)?.name || '?';
    loadsByClass.get(key).push(`${subject}: ${l.ppw} /wk`);
  }
  div.innerHTML = store.classes.map(c => `
    <div class="row" style="justify-content:space-between; border-top:1px dashed #e5e7eb; padding-top:6px; margin-top:6px;">
      <div><b>${c.name}</b><div class="small muted">${(loadsByClass.get(c.id)||[]).join(', ') || 'No loads defined'}</div></div>
      <div class="row">
        <button class="ghost" onclick="removeClass(${c.id})">Delete</button>
      </div>
    </div>
  `).join('');
}
window.removeClass = (id) => {
  store.classes = store.classes.filter(c=>c.id!==id);
  store.loads = store.loads.filter(l=>l.classId!==id);
  save(); renderClasses(); renderSelectors();
};

function renderTeachSkill(){
  const div = document.getElementById('teachSkill');
  if (store.canTeach.length===0){ div.innerHTML = '<span class="muted">No mappings yet.</span>'; return; }
  div.innerHTML = store.canTeach.map(x=>{
    const t = store.teachers.find(t=>t.id===x.teacherId)?.name || '?';
    const s = store.subjects.find(s=>s.id===x.subjectId)?.name || '?';
    return `<span class="pill">${t} → ${s} <a href="#" onclick="delTS(${x.teacherId},${x.subjectId});return false;" title="remove">×</a></span>`;
  }).join(' ');
}
window.delTS = (tid,sid) => {
  store.canTeach = store.canTeach.filter(x=> !(x.teacherId===tid && x.subjectId===sid));
  save(); renderTeachSkill();
};

function renderAvailability(){
  const wrap = document.getElementById('availabilityGrid');
  if (store.teachers.length===0){ wrap.innerHTML = '<span class="muted">Add teachers to edit availability.</span>'; return; }
  let html = '';
  const days = store.cfg.days, periods = store.cfg.periods, lunch = store.cfg.lunchAt;
  for (const t of store.teachers){
    html += `<div style="margin-bottom:10px;"><b>${t.name}</b> <span class="muted">(${t.code})</span>`;
    html += `<table style="margin-top:6px;"><thead><tr><th>Day/Period</th>`;
    for (let p=0;p<periods;p++){
      if (lunch!=null && p===lunch) html += `<th>Lunch</th>`;
      else html += `<th>${p+1}</th>`;
    }
    html += `</tr></thead><tbody>`;
    for (let d=0; d<days; d++){
      html += `<tr><th>${dayName(d)}</th>`;
      for (let p=0;p<periods;p++){
        if (lunch!=null && p===lunch){
          html += `<td class="small muted" style="text-align:center">—</td>`;
          continue;
        }
        const a = store.availability.find(a=>a.teacherId===t.id && a.day===d && a.period===p);
        const on = !!(a && a.available);
        const cls = 'avail-btn ' + (on?'avail-on':'avail-off');
        html += `<td><button class="${cls}" onclick="toggleAvail(${t.id},${d},${p})">${on?'On':'Off'}</button></td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  }
  wrap.innerHTML = html;
}
window.toggleAvail = (tid,d,p) => {
  let rec = store.availability.find(a=>a.teacherId===tid && a.day===d && a.period===p);
  if (!rec){ rec = { teacherId:tid, day:d, period:p, available:true }; store.availability.push(rec); }
  rec.available = !rec.available; save(); renderAvailability();
};

function renderAllTimetable(rows){
  const wrap = document.getElementById('gridWrap');
  if (!rows || rows.length===0){
    wrap.innerHTML = '<div class="muted">No timetable yet. Click Generate.</div>';
    return;
  }
  const days = store.cfg.days, periods = store.cfg.periods, lunch = store.cfg.lunchAt;
  const classes = Array.from(new Set(rows.map(r=>r.className)));
  let html = '';
  for (const cls of classes){
    html += `<div style="margin-bottom:16px;"><h3 style="margin:6px 0;">${cls}</h3><table><thead><tr><th>Day/Period</th>`;
    for (let p=0;p<periods;p++){
      if (lunch!=null && p===lunch) html += `<th>Lunch</th>`; else html += `<th>${p+1}</th>`;
    }
    html += `</tr></thead><tbody>`;
    for (let d=0; d<days; d++){
      html += `<tr><th>${dayName(d)}</th>`;
      for (let p=0;p<periods;p++){
        if (lunch!=null && p===lunch){ html += `<td class="small muted" style="text-align:center">—</td>`; continue; }
        const cell = rows.find(r=> r.className===cls && r.day===d && r.period===p);
        html += `<td>${cell ? `<b>${cell.subject}</b><div class="small muted">${cell.teacher}</div>` : ''}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  }
  wrap.innerHTML = html;
}

// ---------- Demo seed ----------
function seedDemo(){
  store.cfg = { periods:6, days:6, lunchAt:3, weekStart: isoMonday(new Date()) };
  store.teachers = [
    { id:1, name:'Alice', code:'T-A', maxPerDay:4, maxPerWeek:18, avoidConsec:true },
    { id:2, name:'Bob',   code:'T-B', maxPerDay:5, maxPerWeek:22, avoidConsec:true },
    { id:3, name:'Carol', code:'T-C', maxPerDay:4, maxPerWeek:18, avoidConsec:false }
  ];
  store.subjects = [
    { id:1, name:'Mathematics', code:'MATH' },
    { id:2, name:'Science',     code:'SCI' },
    { id:3, name:'English',     code:'ENG' }
  ];
  store.classes = [
    { id:1, name:'Class A' },
    { id:2, name:'Class B' }
  ];
  store.loads = [
    { classId:1, subjectId:1, ppw:4 },
    { classId:1, subjectId:2, ppw:3 },
    { classId:1, subjectId:3, ppw:3 },
    { classId:2, subjectId:1, ppw:4 },
    { classId:2, subjectId:2, ppw:3 },
    { classId:2, subjectId:3, ppw:3 }
  ];
  store.canTeach = [
    { teacherId:1, subjectId:1 }, { teacherId:1, subjectId:3 },
    { teacherId:2, subjectId:2 }, { teacherId:2, subjectId:1 },
    { teacherId:3, subjectId:3 }
  ];
  store.availability = [];
  for (const t of store.teachers) ensureDefaultAvailabilityForTeacher(t.id);
  // make Alice unavailable on Mon P1 and Tue P2
  const a1 = store.availability.find(a=>a.teacherId===1 && a.day===0 && a.period===0); if (a1) a1.available=false;
  const a2 = store.availability.find(a=>a.teacherId===1 && a.day===1 && a.period===1); if (a2) a2.available=false;
}
