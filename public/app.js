const form = document.getElementById('checkinForm');
const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const pdfBtn = document.getElementById('pdfBtn');

const API_BASE = '';

let latestDraft = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function valuesFromNamedInputs(prefix, maxCount = 4) {
  const out = [];
  for (let i = 1; i <= maxCount; i += 1) {
    const el = form.elements[`${prefix}_${i}`];
    const value = (el?.value || '').trim();
    if (value) out.push(value);
  }
  return out;
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderDraft(draft) {
  const sections = [];
  sections.push(`<div class="section"><h3>${esc(draft.title || 'Check-in Draft')}</h3><div class="muted">${esc(draft.summary || '')}</div></div>`);

  const answers = Array.isArray(draft.section_answers) ? draft.section_answers : [];
  sections.push(`<div class="section"><h3>Section Answers</h3>` + answers.map(item => `
    <div class="section inner">
      <div><strong>Question:</strong> ${esc(item.question || '')}</div>
      <div class="answer"><strong>Answer:</strong> ${esc(item.answer || '')}</div>
      <div class="meta"><span class="tag">Evidence</span>${esc((item.evidence_used || []).join(' | ') || 'None')}</div>
      <div class="meta"><span class="tag">Needs confirmation</span>${esc((item.needs_confirmation || []).join(' | ') || 'None')}</div>
    </div>`).join('') + `</div>`);

  sections.push(`<div class="section"><h3>Achievements</h3><ul>${(draft.achievements || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li class="muted">None provided.</li>'}</ul></div>`);

  sections.push(`<div class="section"><h3>Values mapping</h3>` + (draft.value_mappings || []).map(v => `
    <div class="kv"><div><strong>${esc(v.value_name || '')}</strong></div><div>${esc(v.evidence || '')}<br/><span class="muted">Impact: ${esc(v.impact || '')} · Confidence: ${esc(v.confidence || '')}</span></div></div>`).join('') + `</div>`);

  sections.push(`<div class="section"><h3>Risks / gaps</h3><ul>${(draft.risks_or_gaps || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>`);
  sections.push(`<div class="section"><h3>Needs confirmation</h3><ul>${(draft.needs_confirmation || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>`);
  sections.push(`<div class="section"><h3>Compliance notes</h3><ul>${(draft.compliance_notes || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>`);
  sections.push(`<div class="section"><h3>Suggested next steps</h3><ul>${(draft.suggested_next_steps || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li class="muted">None</li>'}</ul></div>`);

  previewEl.classList.remove('muted');
  previewEl.innerHTML = sections.join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('Generating draft...');
  pdfBtn.disabled = true;
  latestDraft = null;
  previewEl.innerHTML = 'Working...';

  const quarter = form.elements.quarter.value || '';
  const year = form.elements.year.value || '';
  const quarterLabel = quarter && year ? `${quarter} ${year}` : (quarter || year || '');

  const fd = new FormData();
  fd.append('employee_name', form.elements.employee_name.value || '');
  fd.append('role', form.elements.role.value || '');
  fd.append('quarter', quarterLabel);
  fd.append('questions', JSON.stringify(valuesFromNamedInputs('question', 3)));
  fd.append('achievements', JSON.stringify((form.elements.achievements.value || '').split('\n').map(s => s.trim()).filter(Boolean)));
  fd.append('values', JSON.stringify(valuesFromNamedInputs('value', 4)));
  fd.append('current_notes', form.elements.current_notes.value || '');

  const files = form.elements.prior_forms.files || [];
  for (const file of files) fd.append('prior_forms', file);

  try {
    const resp = await fetch(`${API_BASE}/api/draft`, { method: 'POST', body: fd });
    const data = await resp.json();
    if (!resp.ok) {
      const detail = data.detail || data.error || 'Failed';
      throw new Error(detail);
    }
    latestDraft = data;
    setStatus(`Draft generated using ${data.source || 'Azure OpenAI'}. Review before export.`);
    renderDraft(data);
    pdfBtn.disabled = false;
  } catch (err) {
    setStatus(`Error: ${err.message}`);
    previewEl.innerHTML = `<div class="muted">${esc(err.message)}</div>`;
  }
});

pdfBtn.addEventListener('click', async () => {
  if (!latestDraft) return;
  setStatus('Creating PDF...');

  try {
    const resp = await fetch(`${API_BASE}/api/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(latestDraft),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || data.error || 'Failed to generate PDF.');
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'checkin-draft.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('PDF downloaded.');
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});
