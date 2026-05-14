const token = localStorage.getItem('secureexam_token');
const savedUser = JSON.parse(localStorage.getItem('secureexam_user') || 'null');

if (!token || !savedUser) window.location.href = '/';

const state = {
  user: savedUser,
  exams: [],
  submissions: [],
  currentExam: null,
  socket: null,
  mediaStream: null,
  cameraFrameTimer: null,
  monitorHeartbeatTimer: null,
  examSecurityCleanups: [],
  examSecurityActive: false,
  warningLastSent: {},
  voiceRecorder: null,
  voiceChunks: [],
  voiceStream: null,
  voiceTimer: null,
  voiceStartedAt: null,
  isExamFinished: false,
  timer: null,
  startedSubmission: null
};

const app = document.querySelector('#app');
const sidebar = document.querySelector('#sidebar');
const toast = document.querySelector('#toast');
const avatar = document.querySelector('#avatarButton');

document.body.className = themeClass(state.user.theme);
avatar.textContent = initials(state.user.name);
document.querySelector('#menuButton').addEventListener('click', () => sidebar.classList.toggle('open'));
avatar.addEventListener('click', () => navigate('profile'));
window.addEventListener('hashchange', () => route());

function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(path, { ...options, headers }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.message || 'Request failed');
    return data;
  });
}

function setupSocket() {
  state.socket = io({ auth: { token } });
  state.socket.on('warning', (event) => {
    showToast(`${event.name || 'Student'}: ${event.type}`);
    appendMonitorWarning(event);
  });
  state.socket.on('chat_message', (event) => handleIncomingChat(event));
  state.socket.on('student_finished', () => {
    if (location.hash.includes('monitor')) route();
  });
  state.socket.on('camera_frame', (event) => {
    const preview = document.querySelector(`[data-camera-student="${event.studentId}"]`);
    const stamp = document.querySelector(`[data-camera-time="${event.studentId}"]`);
    if (!preview || preview.closest('.camera-feed')?.classList.contains('finished')) return;
    preview.src = event.frame;
    preview.classList.remove('empty');
    if (stamp) stamp.textContent = `Camera updated ${new Date(event.timestamp).toLocaleTimeString()}`;
  });
}

function setupNav() {
  const role = state.user.role;
  const items = [
    ['dashboard', 'Dashboard'],
    ...(role !== 'student' ? [['exams', 'My Exams'], ['create', 'Create Exam'], ['monitor', 'Monitor Students'], ['submissions', 'Grade Submissions']] : []),
    ...(role === 'student' ? [['access', 'Access Exam'], ['submissions', 'My Submissions']] : []),
    ...(role === 'admin' ? [['users', 'Users'], ['logs', 'Activity Logs']] : []),
    ['profile', 'Profile']
  ];
  sidebar.innerHTML = `
    <div class="nav-section">
      ${items.map(([key, label]) => `<button class="nav-button" data-route="${key}">${label}</button>`).join('')}
    </div>
    <div class="nav-footer">
      <button class="nav-button logout-button" data-route="logout">Logout</button>
    </div>
  `;
  sidebar.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.route === 'logout') return logout();
      navigate(button.dataset.route);
    });
  });
}

function navigate(key) {
  location.hash = key;
  sidebar.classList.remove('open');
}

async function route() {
  const key = location.hash.replace('#', '') || 'dashboard';
  sidebar.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.route === key));
  try {
    if (key === 'dashboard') return renderDashboard();
    if (key === 'exams') return renderExams();
    if (key === 'create') return renderExamBuilder();
    if (key.startsWith('edit:')) return renderExamBuilder(key.split(':')[1]);
    if (key.startsWith('exam:')) return renderExamDetails(key.split(':')[1]);
    if (key === 'access') return renderAccessExam();
    if (key.startsWith('take:')) return renderTakeExam(key.split(':')[1]);
    if (key === 'monitor') return renderMonitorPicker();
    if (key.startsWith('monitor:')) return renderMonitor(key.split(':')[1]);
    if (key === 'submissions') return renderSubmissions();
    if (key.startsWith('submission:')) return renderSubmission(key.split(':')[1]);
    if (key === 'users') return renderUsers();
    if (key === 'logs') return renderLogs();
    if (key === 'profile') return renderProfile();
  } catch (error) {
    app.innerHTML = `<section class="card"><h2>Something went wrong</h2><p>${escapeHtml(error.message)}</p></section>`;
  }
}

async function renderDashboard() {
  if (state.user.role === 'admin') {
    const stats = await api('/api/admin/stats');
    app.innerHTML = hero('Admin Dashboard', 'Manage users, oversee exams, review logs, and track system activity.') +
      metrics([
        ['Total Users', stats.totalUsers || 0],
        ['Teachers', stats.teachers || 0],
        ['Students', stats.students || 0],
        ['Submissions', stats.totalSubmissions || 0]
      ]) +
      `<div class="grid two"><section class="card"><h2>User Growth</h2><canvas id="userChart"></canvas></section><section class="card"><h2>Exam Activity</h2><canvas id="examChart"></canvas></section></div>`;
    drawChart('userChart', stats.userGrowth || []);
    drawChart('examChart', stats.examActivity || []);
    return;
  }

  if (state.user.role === 'teacher') {
    const exams = await api('/api/exams');
    const submissions = await api('/api/submissions');
    app.innerHTML = hero('Teacher Dashboard', 'Create, publish, monitor, chat, and grade secure exams.') +
      metrics([
        ['Total Exams', exams.length],
        ['Published', exams.filter((exam) => exam.is_published).length],
        ['Recent Submissions', submissions.length],
        ['Needs Grading', submissions.filter((item) => item.status === 'submitted').length]
      ]) +
      `<div class="section-title"><h2>Recent Exams</h2><button class="primary" onclick="navigate('create')">Create Exam</button></div>` +
      examTable(exams.slice(0, 6));
    return;
  }

  const submissions = await api('/api/submissions');
  app.innerHTML = hero('Student Dashboard', 'Access exams only through the code or direct link provided by your teacher.') +
    metrics([
      ['Submissions', submissions.length],
      ['Graded', submissions.filter((item) => item.status === 'graded').length],
      ['Submitted', submissions.filter((item) => item.status === 'submitted').length],
      ['Timed Out', submissions.filter((item) => item.status === 'timed_out').length]
    ]) +
    `<div class="actions"><button class="primary" onclick="navigate('access')">Access Exam</button><button class="secondary" onclick="navigate('submissions')">My Submissions</button></div>`;
}

async function renderExams() {
  const exams = await api('/api/exams');
  app.innerHTML = hero('My Exams', 'Open exam details, publish access methods, and manage monitoring.') +
    `<div class="section-title"><h2>Exams</h2><button class="primary" onclick="navigate('create')">Create Exam</button></div>` +
    examTable(exams);
}

function examTable(exams) {
  return `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Access</th><th>Status</th><th>Questions</th><th>Submissions</th><th>Actions</th></tr></thead><tbody>
    ${exams.map((exam) => `<tr>
      <td><strong>${escapeHtml(exam.title)}</strong><br><small>${escapeHtml(exam.teacher_name || '')}</small></td>
      <td>${exam.access_method === 'code' ? escapeHtml(exam.access_code) : escapeHtml(location.origin + '/dashboard.html#take:' + exam.direct_link_token)}</td>
      <td>${badge(exam.is_published ? 'Published' : 'Draft', exam.is_published ? 'good' : 'warn')}</td>
      <td>${exam.question_count || exam.questions?.length || 0}</td>
      <td>${exam.submission_count || 0}</td>
      <td class="actions"><button type="button" class="secondary" onclick="navigate('exam:${exam.id}')">Open</button><button type="button" class="secondary" onclick="navigate('monitor:${exam.id}')">Monitor</button><button type="button" class="icon-action delete-action small-action" data-tooltip="Delete Exam" aria-label="Delete Exam" onclick="deleteExam(${exam.id})">&times;</button></td>
    </tr>`).join('') || '<tr><td colspan="6">No exams yet.</td></tr>'}
  </tbody></table></div>`;
}

async function renderExamBuilder(id) {
  const exam = id ? await api(`/api/exams/${id}`) : null;
  const draftKey = id ? `secureexam_exam_draft_${id}` : 'secureexam_exam_draft_new';
  const draft = loadExamDraft(draftKey);
  let questions = draft?.questions?.length
    ? draft.questions
    : exam?.questions?.length
      ? exam.questions
      : [blankQuestion()];
  const values = draft?.fields || {};
  app.innerHTML = hero(id ? 'Edit Exam' : 'Create Exam', 'Build questions, configure security controls, then publish from exam details.') +
    `<form id="examForm" class="card">
      <div class="form-grid">
        <label>Title<input name="title" required value="${escapeAttr(values.title ?? exam?.title ?? '')}"></label>
        <label>Duration in minutes<input name="duration" type="number" min="1" required value="${values.duration ?? exam?.duration ?? 60}"></label>
        <label class="full">Description<textarea name="description">${escapeHtml(values.description ?? exam?.description ?? '')}</textarea></label>
        <label>Access Method<select name="accessMethod"><option value="code">Access Code</option><option value="link">Direct Link</option></select></label>
        <label>Optional Schedule<input name="scheduledAt" type="datetime-local" value="${values.scheduledAt ?? toLocalDateTime(exam?.scheduled_at)}"></label>
      </div>
      <div class="section-title"><h2>Exam Controls</h2></div>
      <div class="switches">
        ${check('requireAllQuestions', 'Require all questions', exam?.require_all_questions ?? true)}
        ${check('enableCamera', 'Enable camera', exam?.enable_camera)}
        ${check('enableMicrophone', 'Enable microphone', exam?.enable_microphone)}
        ${check('disableCopyPaste', 'Disable copy/paste', exam?.disable_copy_paste ?? true)}
        ${check('screenshotDetection', 'Screenshot detection', exam?.screenshot_detection ?? true)}
        ${check('phoneDetection', 'Phone detection', exam?.phone_detection ?? true)}
      </div>
      <div class="section-title"><h2>Questions</h2></div>
      <div id="questions"></div>
      <div class="actions"><button type="button" class="icon-action add-action" id="addQuestion" data-tooltip="Add Question" aria-label="Add Question">+</button><button class="primary">Save Exam</button></div>
    </form>`;
  document.querySelector('[name="accessMethod"]').value = values.accessMethod ?? exam?.access_method ?? 'code';
  const form = document.querySelector('#examForm');
  form.requireAllQuestions.checked = values.requireAllQuestions ?? Boolean(exam?.require_all_questions ?? true);
  form.enableCamera.checked = values.enableCamera ?? Boolean(exam?.enable_camera);
  form.enableMicrophone.checked = values.enableMicrophone ?? Boolean(exam?.enable_microphone);
  form.disableCopyPaste.checked = values.disableCopyPaste ?? Boolean(exam?.disable_copy_paste ?? true);
  form.screenshotDetection.checked = values.screenshotDetection ?? Boolean(exam?.screenshot_detection ?? true);
  form.phoneDetection.checked = values.phoneDetection ?? Boolean(exam?.phone_detection ?? true);
  const holder = document.querySelector('#questions');
  const renderQuestions = () => {
    holder.innerHTML = questions.map((q, index) => questionForm(q, index)).join('');
    holder.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
      questions = readQuestions();
      const index = Number(button.dataset.index);
      if (button.dataset.action === 'remove') questions.splice(index, 1);
      if (button.dataset.action === 'option') questions[index].options.push({ option_text: '', is_correct: false });
      if (button.dataset.action === 'remove-option') {
        questions[Number(button.dataset.q)].options.splice(Number(button.dataset.o), 1);
      }
      renderQuestions();
      saveExamDraft(draftKey);
    }));
    holder.querySelectorAll('input, textarea, select').forEach((field) => {
      field.addEventListener('input', () => saveExamDraft(draftKey));
      field.addEventListener('change', () => {
        if (field.dataset.field === 'type') {
          questions = readQuestions();
          renderQuestions();
        }
        saveExamDraft(draftKey);
      });
    });
  };
  renderQuestions();
  document.querySelector('#addQuestion').addEventListener('click', () => {
    questions = readQuestions();
    questions.push(blankQuestion());
    renderQuestions();
    saveExamDraft(draftKey);
  });
  form.addEventListener('input', () => saveExamDraft(draftKey));
  form.addEventListener('change', () => saveExamDraft(draftKey));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const form = event.currentTarget;
      const payload = Object.fromEntries(new FormData(form).entries());
      payload.requireAllQuestions = form.requireAllQuestions.checked;
      payload.enableCamera = form.enableCamera.checked;
      payload.enableMicrophone = form.enableMicrophone.checked;
      payload.disableCopyPaste = form.disableCopyPaste.checked;
      payload.screenshotDetection = form.screenshotDetection.checked;
      payload.phoneDetection = form.phoneDetection.checked;
      payload.questions = readQuestions();
      validateExamPayload(payload);
      const saveButton = form.querySelector('button[type="submit"], button.primary');
      if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
      }
      const saved = await api(id ? `/api/exams/${id}` : '/api/exams', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      localStorage.removeItem(draftKey);
      showToast('Exam saved');
      navigate(`exam:${saved.id}`);
    } catch (error) {
      showToast(error.message || 'Unable to save exam');
      const saveButton = event.currentTarget.querySelector('button[type="submit"], button.primary');
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Exam';
      }
    }
  });
}

function questionForm(q, index) {
  const type = q.type || q.type_name || 'mcq';
  const objectiveTypes = ['mcq', 'dropdown', 'checkbox'];
  const usesOptions = objectiveTypes.includes(type);
  const optionList = q.options?.length ? q.options : [{ optionText: '', isCorrect: false }, { optionText: '', isCorrect: false }];
  const options = optionList.map((option, optionIndex) => `<div class="option-row">
    <input data-q="${index}" data-o="${optionIndex}" data-field="optionText" placeholder="Option" value="${escapeAttr(option.option_text || option.optionText || '')}">
    <label class="check"><input data-q="${index}" data-o="${optionIndex}" data-field="isCorrect" type="checkbox" ${option.is_correct || option.isCorrect ? 'checked' : ''}> Correct</label>
    <button type="button" class="icon-action delete-action small-action" data-action="remove-option" data-q="${index}" data-o="${optionIndex}" data-tooltip="Remove Option" aria-label="Remove Option">&times;</button>
  </div>`).join('');
  const answerArea = usesOptions
    ? `<div class="answer-type-area"><div>${options}</div><div class="actions"><button type="button" class="icon-action add-action" data-action="option" data-index="${index}" data-tooltip="Add Option" aria-label="Add Option">+</button></div></div>`
    : type === 'short_answer'
      ? `<div class="answer-type-area"><label>Correct Answer for Auto Check<input data-q="${index}" data-field="correctAnswer" placeholder="Exact answer" value="${escapeAttr(q.correct_answer || q.correctAnswer || '')}"></label></div>`
      : `<div class="answer-type-area answer-note">${answerTypeNote(type)}</div>`;
  return `<section class="card question-card">
    <div class="form-grid">
      <label>Type<select data-q="${index}" data-field="type">
        ${['mcq','dropdown','checkbox','short_answer','paragraph','file_upload','image_upload'].map((value) => `<option value="${value}" ${type === value ? 'selected' : ''}>${labelType(value)}</option>`).join('')}
      </select></label>
      <label>Points<input data-q="${index}" data-field="points" type="number" min="0" step="0.01" value="${q.points || 1}"></label>
      <label class="full">Question<textarea data-q="${index}" data-field="questionText">${escapeHtml(q.question_text || q.questionText || '')}</textarea></label>
      <label class="check"><input data-q="${index}" data-field="isRequired" type="checkbox" ${q.is_required ?? q.isRequired ?? true ? 'checked' : ''}> Required</label>
    </div>
    ${answerArea}
    <div class="actions"><button type="button" class="icon-action delete-action" data-action="remove" data-index="${index}" data-tooltip="Delete Question" aria-label="Delete Question">&times;</button></div>
  </section>`;
}

function readQuestions() {
  const cards = [...document.querySelectorAll('.question-card')];
  return cards.map((card, index) => {
    const fields = card.querySelectorAll(`[data-q="${index}"][data-field]`);
    const question = { options: [] };
    fields.forEach((field) => {
      if (field.dataset.o !== undefined) {
        const optionIndex = Number(field.dataset.o);
        question.options[optionIndex] ||= {};
        question.options[optionIndex][field.dataset.field] = field.type === 'checkbox' ? field.checked : field.value;
      } else {
        question[field.dataset.field] = field.type === 'checkbox' ? field.checked : field.value;
      }
    });
    const objectiveTypes = ['mcq', 'dropdown', 'checkbox'];
    if (objectiveTypes.includes(question.type)) {
      question.options = question.options
        .filter(Boolean)
        .map((option) => ({
          optionText: String(option.optionText || '').trim(),
          isCorrect: Boolean(option.isCorrect)
        }))
        .filter((option) => option.optionText);
      question.correctAnswer = null;
    } else {
      question.options = [];
      if (question.type !== 'short_answer') question.correctAnswer = null;
    }
    question.questionText = String(question.questionText || '').trim();
    return question;
  });
}

function validateExamPayload(payload) {
  if (!String(payload.title || '').trim()) throw new Error('Exam title is required');
  if (!payload.questions.length) throw new Error('Add at least one question');
  const validTypes = ['mcq', 'dropdown', 'checkbox', 'short_answer', 'paragraph', 'file_upload', 'image_upload'];
  payload.questions.forEach((question, index) => {
    if (!validTypes.includes(question.type)) throw new Error(`Question ${index + 1} needs a valid answer type`);
    if (!question.questionText) throw new Error(`Question ${index + 1} needs question text`);
    if (['mcq', 'dropdown', 'checkbox'].includes(question.type) && question.options.length < 2) {
      throw new Error(`Question ${index + 1} needs at least two options`);
    }
    if (['mcq', 'dropdown', 'checkbox'].includes(question.type) && !question.options.some((option) => option.isCorrect)) {
      throw new Error(`Question ${index + 1} needs at least one correct option`);
    }
  });
}

async function renderExamDetails(id) {
  const exam = await api(`/api/exams/${id}`);
  app.innerHTML = hero(exam.title, escapeHtml(exam.description || 'Review details and publish access for students.')) +
    `<section class="card">
      <div class="grid three">
        <div><span class="badge">${exam.duration} minutes</span></div>
        <div>${badge(exam.is_published ? 'Published' : 'Draft', exam.is_published ? 'good' : 'warn')}</div>
        <div>${badge(exam.access_method === 'code' ? 'Access Code' : 'Direct Link')}</div>
      </div>
      <p><strong>Access:</strong> ${exam.access_method === 'code' ? escapeHtml(exam.access_code) : escapeHtml(location.origin + '/dashboard.html#take:' + exam.direct_link_token)}</p>
      <div class="actions">
        <button type="button" class="primary" id="publish">${exam.is_published ? 'Unpublish Exam' : 'Publish Exam'}</button>
        <button type="button" class="icon-action edit-action" data-tooltip="Edit Exam" aria-label="Edit Exam" onclick="navigate('edit:${exam.id}')">&#9998;</button>
        <button type="button" class="secondary" onclick="navigate('monitor:${exam.id}')">Monitor</button>
        <button type="button" class="icon-action delete-action" data-tooltip="Delete Exam" aria-label="Delete Exam" onclick="deleteExam(${exam.id})">&times;</button>
      </div>
    </section>
    <div class="section-title"><h2>Questions</h2></div>
    <div class="grid">${exam.questions.map((q, i) => `<section class="card"><strong>${i + 1}. ${escapeHtml(q.question_text)}</strong><p>${labelType(q.type)} · ${q.points} points</p></section>`).join('')}</div>`;
  document.querySelector('#publish').addEventListener('click', async () => {
    await api(`/api/exams/${id}/publish`, { method: 'PATCH', body: JSON.stringify({ isPublished: !exam.is_published }) });
    showToast(exam.is_published ? 'Exam unpublished' : 'Exam published');
    route();
  });
}

function renderAccessExam() {
  app.innerHTML = hero('Access Exam', 'Use the access code or direct link token sent by your teacher.') +
    `<section class="card"><form id="accessForm" class="form-grid"><label class="full">Access Code or Link<input name="key" required placeholder="Example: A1B2C3D4 or full exam link"></label><button class="primary">Open Exam</button></form></section>`;
  document.querySelector('#accessForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = new FormData(event.currentTarget).get('key').trim();
    const key = raw.includes('#take:') ? raw.split('#take:').pop() : raw.split('/').pop();
    navigate(`take:${key}`);
  });
}

async function renderTakeExam(key) {
  const exam = await api(`/api/exams/access/${key}`);
  const submission = await api('/api/submissions/start', { method: 'POST', body: JSON.stringify({ examId: exam.id }) });
  state.currentExam = exam;
  state.startedSubmission = submission;
  state.isExamFinished = false;
  state.socket.emit('join_exam', { examId: exam.id });
  app.innerHTML = `<section class="exam-room">
    <form id="takeForm" class="grid">
      ${hero(exam.title, escapeHtml(exam.description || 'Answer every required question before submitting.'))}
      ${exam.questions.map((question, index) => renderQuestionTake(question, index)).join('')}
      <button class="primary">Submit Exam</button>
    </form>
    <aside class="card session-panel">
      <div class="timer" id="timer">--:--</div>
      <video id="cameraPreview" autoplay muted playsinline></video>
      <div id="monitorStatus" class="message"></div>
      <h3>Teacher Chat</h3>
      <div id="chatBox" class="chat-box"></div>
      <div class="chat-actions"><input id="chatInput" placeholder="Message teacher"><button class="icon-action chat-action send-action" id="sendChat" type="button" data-tooltip="Send Message" aria-label="Send Message">></button><button class="icon-action chat-action voice-button" id="voiceChat" type="button" data-tooltip="Record Voice" aria-label="Record Voice">●</button></div>
    </aside>
  </section>`;
  await setupExamMonitoring(exam);
  setupExamSecurityControls(exam);
  state.examSecurityActive = true;
  startTimer(exam.duration * 60, () => finishExam(true));
  document.querySelector('#takeForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await finishExam(false);
  });
  document.querySelector('#sendChat').addEventListener('click', () => sendChat(exam.created_by));
  document.querySelector('#voiceChat').addEventListener('click', () => recordVoice(exam.created_by, 'voiceChat'));
  await loadChatHistory(exam.id, exam.created_by, 'chatBox');
}

function renderQuestionTake(question, index) {
  const name = `q_${question.id}`;
  const required = question.is_required ? 'required' : '';
  let body = '';
  if (question.type === 'mcq' || question.type === 'dropdown') {
    body = question.type === 'dropdown'
      ? `<select name="${name}" ${required}><option value="">Select</option>${question.options.map((o) => `<option>${escapeHtml(o.option_text)}</option>`).join('')}</select>`
      : question.options.map((o) => `<label class="check"><input type="radio" name="${name}" value="${escapeAttr(o.option_text)}" ${required}> ${escapeHtml(o.option_text)}</label>`).join('');
  } else if (question.type === 'checkbox') {
    body = question.options.map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${escapeAttr(o.option_text)}"> ${escapeHtml(o.option_text)}</label>`).join('');
  } else if (question.type === 'paragraph') {
    body = `<textarea name="${name}" ${required}></textarea>`;
  } else if (question.type === 'file_upload' || question.type === 'image_upload') {
    body = `<input type="file" name="file_${question.id}" ${question.type === 'image_upload' ? 'accept="image/*"' : ''} ${required}>`;
  } else {
    body = `<input name="${name}" ${required}>`;
  }
  return `<section class="card"><h3>${index + 1}. ${escapeHtml(question.question_text)}</h3><p>${question.points} points</p>${body}</section>`;
}

async function setupExamMonitoring(exam) {
  if (exam.enable_camera || exam.enable_microphone) {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: !!exam.enable_camera, audio: !!exam.enable_microphone });
      document.querySelector('#cameraPreview').srcObject = state.mediaStream;
      startCameraFrames(exam.id);
      if (state.monitorHeartbeatTimer) clearInterval(state.monitorHeartbeatTimer);
      state.monitorHeartbeatTimer = setInterval(() => {
        if (state.isExamFinished) return;
        state.socket.emit('monitor_update', { examId: exam.id, cameraOn: !!exam.enable_camera, micOn: !!exam.enable_microphone, status: 'active' });
      }, 5000);
    } catch (_error) {
      document.querySelector('#monitorStatus').textContent = 'Media permission denied.';
      sendWarning(exam.id, 'media_permission_denial', 'Camera or microphone permission denied', { force: true });
    }
  }
}

function setupExamSecurityControls(exam) {
  cleanupExamSecurityControls();
  state.warningLastSent = {};
  let focusLossTimer = null;

  const addSecurityListener = (target, eventName, handler, options = true) => {
    target.addEventListener(eventName, handler, options);
    state.examSecurityCleanups.push(() => target.removeEventListener(eventName, handler, options));
  };

  addSecurityListener(document, 'visibilitychange', () => {
    if (state.examSecurityActive && !state.isExamFinished && document.hidden) {
      sendWarning(exam.id, 'tab_switch', 'Student switched tabs or minimized the window');
    }
  });

  addSecurityListener(window, 'blur', () => {
    if (!state.examSecurityActive || state.isExamFinished) return;
    clearTimeout(focusLossTimer);
    focusLossTimer = setTimeout(() => {
      if (!document.hasFocus() && !state.isExamFinished) {
        sendWarning(exam.id, 'tab_switch', 'Exam window lost focus for more than 1 second');
      }
    }, 1200);
  });

  addSecurityListener(window, 'focus', () => {
    clearTimeout(focusLossTimer);
  });

  addSecurityListener(window, 'pagehide', () => {
    if (state.examSecurityActive && !state.isExamFinished) {
      sendWarning(exam.id, 'tab_switch', 'Student navigated away from the exam page');
    }
  });

  if (exam.screenshot_detection) {
    const screenshotHandler = (event) => {
      const key = String(event.key || '').toLowerCase();
      const code = String(event.code || '').toLowerCase();
      const looksLikeScreenshot =
        key === 'printscreen' ||
        code === 'printscreen' ||
        (event.metaKey && event.shiftKey && ['3', '4', '5'].includes(key)) ||
        (event.ctrlKey && event.shiftKey && ['s', 'i'].includes(key)) ||
        (event.ctrlKey && key === 'p') ||
        (event.keyCode === 44);
      if (state.examSecurityActive && !state.isExamFinished && looksLikeScreenshot) {
        event.preventDefault();
        sendWarning(exam.id, 'screenshot_attempt', 'Screenshot-related keyboard shortcut detected');
        showToast('Screenshot attempt detected');
      }
    };
    addSecurityListener(window, 'keydown', screenshotHandler, true);
    addSecurityListener(window, 'keyup', screenshotHandler, true);
    addSecurityListener(window, 'beforeprint', (event) => {
      event.preventDefault();
      sendWarning(exam.id, 'screenshot_attempt', 'Print or screen capture flow detected');
    });
  }

  if (exam.disable_copy_paste) {
    const blockClipboard = (event) => {
      if (state.isExamFinished) return;
      event.preventDefault();
      sendWarning(exam.id, 'copy_paste', `${event.type} was blocked`);
      showToast(`${event.type === 'paste' ? 'Paste' : event.type === 'cut' ? 'Cut' : 'Copy'} is disabled for this exam`);
    };
    ['copy', 'paste', 'cut', 'drop', 'dragstart'].forEach((eventName) => {
      addSecurityListener(document, eventName, blockClipboard, true);
    });
    addSecurityListener(document, 'contextmenu', blockClipboard, true);
  }

  if (exam.phone_detection) {
    const phoneTimer = setInterval(() => {
      if (!state.examSecurityActive || state.isExamFinished) return;
      const narrow = Math.min(window.innerWidth, window.innerHeight) < 430;
      if (narrow) sendWarning(exam.id, 'phone_detection', 'Very small viewport detected during exam');
    }, 30000);
    state.examSecurityCleanups.push(() => clearInterval(phoneTimer));
  }
}

async function finishExam(timedOut) {
  if (state.isExamFinished) return;
  state.isExamFinished = true;
  clearInterval(state.timer);
  const form = document.querySelector('#takeForm');
  const formData = new FormData(form);
  const answers = {};
  state.currentExam.questions.forEach((question) => {
    const key = `q_${question.id}`;
    const values = formData.getAll(key);
    if (values.length > 1) answers[question.id] = values;
    else if (values[0]) answers[question.id] = values[0];
  });
  formData.set('examId', state.currentExam.id);
  formData.set('status', timedOut ? 'timed_out' : 'submitted');
  formData.set('answers', JSON.stringify(answers));
  await api('/api/submissions/submit', { method: 'POST', body: formData });
  stopMedia();
  [...document.querySelectorAll('input, textarea, select, button')].forEach((el) => { el.disabled = true; });
  showToast(timedOut ? 'Time ended. Exam submitted as timed out.' : 'Exam submitted');
  setTimeout(() => navigate('submissions'), 900);
}

async function renderMonitorPicker() {
  const exams = await api('/api/exams');
  app.innerHTML = hero('Monitor Students', 'Choose an exam to view live status, warning banners, and chat.') + examTable(exams);
}

async function renderMonitor(examId) {
  try {
    const [exam, monitoring] = await Promise.all([api(`/api/exams/${examId}`), api(`/api/monitoring/exam/${examId}`)]);
    state.socket.emit('join_exam', { examId });
    app.innerHTML = hero(`Monitor: ${exam.title}`, 'Student camera status, microphone status, warnings, and chat stay visible while the exam runs.') +
      `<div class="grid two">${monitoring.sessions.map((session) => monitorCard(exam, session, monitoring.warnings.filter((w) => w.student_id === session.student_id))).join('') || '<section class="card">No active students yet. Student cards appear after students check in or start the exam.</section>'}</div>`;
    document.querySelectorAll('[data-hide]').forEach((button) => button.addEventListener('click', async () => {
      await api(`/api/monitoring/exam/${examId}/student/${button.dataset.hide}/hide`, { method: 'PATCH', body: '{}' });
      route();
    }));
    document.querySelectorAll('[data-chat]').forEach((button) => button.addEventListener('click', () => sendChat(button.dataset.chat, button.dataset.input)));
    document.querySelectorAll('[data-voice]').forEach((button) => button.addEventListener('click', () => recordVoice(button.dataset.voice, button.id)));
    monitoring.sessions.forEach((session) => loadChatHistory(examId, session.student_id, `chatBox-${session.student_id}`));
  } catch (error) {
    app.innerHTML = hero('Monitor Students', 'Unable to open the monitoring page right now.') +
      `<section class="card"><p>${escapeHtml(error.message || 'Monitor failed to load')}</p><button type="button" class="primary" onclick="route()">Try Again</button></section>`;
  }
}

function monitorCard(exam, session, warnings) {
  const isFinished = ['submitted', 'timed_out', 'graded'].includes(session.status);
  return `<section class="card" data-monitor-student="${session.student_id}">
    <div class="section-title"><h2>${escapeHtml(session.name)}</h2><button class="danger" data-hide="${session.student_id}">Hide</button></div>
    <p>${badge(session.status, session.status === 'active' ? 'good' : 'warn')} ${badge(session.camera_on ? 'Camera On' : 'Camera Off')} ${badge(session.mic_on ? 'Mic On' : 'Mic Off')}</p>
    <div class="camera-feed ${isFinished ? 'finished' : ''}">
      ${isFinished
        ? '<div class="camera-finished">Finished Exam</div>'
        : `<img class="camera-feed-image empty" data-camera-student="${session.student_id}" alt="${escapeAttr(session.name)} camera preview">`}
      <span data-camera-time="${session.student_id}">${isFinished ? 'Student has submitted or ended the exam.' : session.camera_on ? 'Waiting for camera preview...' : 'Camera is off'}</span>
    </div>
    <p>Last seen: ${formatDate(session.last_seen)} · Warnings: <span data-warning-count="${session.student_id}">${session.warning_count}</span></p>
    <div data-warning-list="${session.student_id}">
      ${warnings.slice(0, 4).map((w) => warningBanner(w)).join('')}
    </div>
    <div id="chatBox-${session.student_id}" class="chat-box monitor-chat"></div>
    <div class="chat-actions"><input id="chatInput-${session.student_id}" placeholder="Message ${escapeAttr(session.name)}"><button class="icon-action chat-action send-action" data-chat="${session.student_id}" data-input="chatInput-${session.student_id}" data-tooltip="Send Message" aria-label="Send Message">></button><button class="icon-action chat-action voice-button" id="voiceChat-${session.student_id}" data-voice="${session.student_id}" type="button" data-tooltip="Record Voice" aria-label="Record Voice">●</button></div>
  </section>`;
}

function warningBanner(warning) {
  return `<p class="card warning-banner">${escapeHtml(warning.type)}<br><small>${formatDate(warning.timestamp)}</small></p>`;
}

function appendMonitorWarning(event) {
  const routeKey = location.hash.replace('#', '');
  if (!routeKey.startsWith('monitor:') || routeKey.split(':')[1] !== String(event.examId)) return;
  const list = document.querySelector(`[data-warning-list="${event.studentId}"]`);
  const count = document.querySelector(`[data-warning-count="${event.studentId}"]`);
  if (!list) return;
  list.insertAdjacentHTML('afterbegin', warningBanner({
    type: event.type,
    timestamp: event.timestamp || new Date().toISOString()
  }));
  [...list.children].slice(4).forEach((child) => child.remove());
  if (count) count.textContent = String(Number(count.textContent || 0) + 1);
}

async function renderSubmissions() {
  const rows = await api('/api/submissions');
  app.innerHTML = hero(state.user.role === 'student' ? 'My Submissions' : 'Grade Submissions', 'Review results, scores, uploaded files, and feedback.') +
    `<div class="table-wrap"><table><thead><tr><th>Exam</th><th>Student</th><th>Status</th><th>Auto</th><th>Manual</th><th>Total</th><th>Action</th></tr></thead><tbody>
      ${rows.map((row) => `<tr><td>${escapeHtml(row.exam_title)}</td><td>${escapeHtml(row.student_name)}</td><td>${badge(row.status)}</td><td>${row.auto_score}</td><td>${row.manual_score}</td><td>${row.score}</td><td><button class="secondary" onclick="navigate('submission:${row.id}')">Open</button></td></tr>`).join('') || '<tr><td colspan="7">No submissions yet.</td></tr>'}
    </tbody></table></div>`;
}

async function deleteExam(id) {
  const confirmed = window.confirm('Delete this exam? This will also remove its questions, options, submissions, answers, warnings, and monitoring records.');
  if (!confirmed) return;
  try {
    await api(`/api/exams/${id}`, { method: 'DELETE' });
    showToast('Exam deleted');
    navigate('exams');
  } catch (error) {
    showToast(error.message || 'Unable to delete exam');
  }
}

async function renderSubmission(id) {
  const submission = await api(`/api/submissions/${id}`);
  const canGrade = state.user.role !== 'student';
  app.innerHTML = hero(`${submission.exam_title}`, `${submission.student_name} · ${formatStatus(submission.status)}`) +
    `<form id="gradeForm" class="grid">
      ${submission.answers.map((answer) => `<section class="card">
        <h3>${escapeHtml(answer.question_text)}</h3>
        <p><strong>Answer:</strong> ${escapeHtml(answer.answer_text || '')}</p>
        ${answer.file_path ? `<p><a class="secondary" href="${answer.file_path}" target="_blank">Open Upload</a></p>` : ''}
        <p>Auto: ${answer.auto_score} · Manual: ${answer.manual_score} · Max: ${answer.points}</p>
        ${canGrade ? `<div class="form-grid"><label>Manual Score<input type="number" step="0.01" min="0" max="${answer.points}" name="score_${answer.id}" value="${answer.manual_score || 0}"></label><label>Feedback<input name="feedback_${answer.id}" value="${escapeAttr(answer.feedback || '')}"></label></div>` : `<p>${escapeHtml(answer.feedback || '')}</p>`}
      </section>`).join('')}
      <section class="card"><p><strong>Total:</strong> ${submission.score}</p><p><strong>Teacher Feedback:</strong> ${escapeHtml(submission.feedback || '')}</p>${canGrade ? '<label>Overall Feedback<textarea name="overall"></textarea></label><button class="primary">Save Grade</button>' : ''}</section>
    </form>`;
  if (canGrade) {
    document.querySelector('#gradeForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const answerGrades = {};
      submission.answers.forEach((answer) => {
        answerGrades[answer.id] = {
          manualScore: form[`score_${answer.id}`].value,
          feedback: form[`feedback_${answer.id}`].value
        };
      });
      await api(`/api/submissions/${id}/grade`, {
        method: 'PUT',
        body: JSON.stringify({ answerGrades, feedback: form.overall.value })
      });
      showToast('Grade saved');
      route();
    });
  }
}

async function renderUsers() {
  const users = await api('/api/admin/users');
  app.innerHTML = hero('User Management', 'Create, update, suspend, or delete Admin, Teacher, and Student accounts.') +
    `<section class="card"><form id="userForm" class="form-grid">
      <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
      <label>Password<input name="password" type="password" value="password123"></label><label>Role<select name="role"><option value="student">Student</option><option value="teacher">Teacher</option><option value="admin">Admin</option></select></label>
      <button class="primary">Create User</button>
    </form></section>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Theme</th></tr></thead><tbody>${users.map((u) => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${u.role}</td><td>${badge(u.status, u.status === 'active' ? 'good' : 'bad')}</td><td>${u.theme}</td></tr>`).join('')}</tbody></table></div>`;
  document.querySelector('#userForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await api('/api/admin/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    showToast('User created');
    route();
  });
}

async function renderLogs() {
  const logs = await api('/api/admin/logs');
  app.innerHTML = hero('Activity Logs', 'Track logins, exam actions, submissions, grading, monitoring events, and warnings.') +
    `<div class="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>${logs.map((log) => `<tr><td>${formatDate(log.created_at)}</td><td>${escapeHtml(log.name || 'System')}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.details || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderProfile() {
  const themes = [
    ['default', 'Default', '#246bfe'],
    ['green', 'Light Green', '#1b8f65'],
    ['blue', 'Light Blue', '#1476a8'],
    ['pink', 'Baby Pink', '#cc4f83'],
    ['violet', 'Violet Tech', '#7c3aed'],
    ['teal', 'Aqua Teal', '#0f9f9a'],
    ['dark', 'Dark Mode', '#65a7ff']
  ];
  app.innerHTML = hero('Profile', 'Manage your account details and personalize your SecureExam workspace.') +
    `<section class="card profile-card"><form id="profileForm" class="profile-form">
      <div class="form-grid">
        <label>Name<input name="name" value="${escapeAttr(state.user.name)}"></label>
        <label>Email<input disabled value="${escapeAttr(state.user.email)}"></label>
        <label>Role<input disabled value="${state.user.role}"></label>
      </div>
      <input type="hidden" name="theme" value="${escapeAttr(state.user.theme || 'default')}">
      <div class="section-title"><h2>Theme Customization</h2></div>
      <div class="theme-grid">
        ${themes.map(([value, label, color]) => `<button type="button" class="theme-choice ${value === (state.user.theme || 'default') ? 'active' : ''}" data-theme="${value}" style="--swatch:${color}" aria-label="${label}">
          <span class="theme-swatch"></span>
          <span>${label}</span>
        </button>`).join('')}
      </div>
      <button class="primary">Save Profile</button>
    </form></section>`;
  document.querySelectorAll('.theme-choice').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.theme-choice').forEach((choice) => choice.classList.remove('active'));
      button.classList.add('active');
      document.querySelector('[name="theme"]').value = button.dataset.theme;
      document.body.className = themeClass(button.dataset.theme);
    });
  });
  document.querySelector('#profileForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const user = await api('/api/auth/profile', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    state.user = user;
    localStorage.setItem('secureexam_user', JSON.stringify(user));
    document.body.className = themeClass(user.theme);
    avatar.textContent = initials(user.name);
    showToast('Profile saved');
  });
}

function startTimer(seconds, done) {
  const timer = document.querySelector('#timer');
  const end = Date.now() + seconds * 1000;
  state.timer = setInterval(() => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    timer.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    if (left <= 0) done();
  }, 1000);
}

function sendWarning(examId, type, details, options = {}) {
  if (!options.force && (!state.examSecurityActive || state.isExamFinished)) return;
  const key = `${examId}:${type}:${details}`;
  const now = Date.now();
  const cooldown = type === 'tab_switch' ? 5000 : 2500;
  if (!options.force && now - (state.warningLastSent[key] || 0) < cooldown) return;
  state.warningLastSent[key] = now;
  state.socket.emit('warning', { examId, type, details });
}

function warnPrevent(type, details) {
  return (event) => {
    event.preventDefault();
    sendWarning(state.currentExam.id, type, details);
  };
}

function sendChat(receiverId, inputId = 'chatInput') {
  const input = document.querySelector(`#${inputId}`);
  if (!input?.value.trim()) return;
  state.socket.emit('chat_message', { examId: state.currentExam?.id || location.hash.split(':')[1], receiverId, message: input.value.trim(), type: 'text' });
  input.value = '';
}

async function loadChatHistory(examId, otherUserId, boxId) {
  try {
    const messages = await api(`/api/chat/exam/${examId}/user/${otherUserId}`);
    const box = document.querySelector(`#${boxId}`);
    if (!box) return;
    box.innerHTML = '';
    messages.forEach((message) => appendChatMessage(box, {
      senderId: message.sender_id,
      senderName: message.sender_name,
      message: message.message,
      type: message.type,
      createdAt: message.created_at
    }));
  } catch (error) {
    showToast(error.message || 'Unable to load chat');
  }
}

function handleIncomingChat(event) {
  const routeKey = location.hash.replace('#', '');
  if (routeKey.startsWith('take:') && state.currentExam?.id === Number(event.examId)) {
    appendChatMessage(document.querySelector('#chatBox'), event);
    return;
  }
  if (routeKey.startsWith('monitor:') && routeKey.split(':')[1] === String(event.examId)) {
    const otherUserId = Number(event.senderId) === Number(state.user.id) ? event.receiverId : event.senderId;
    appendChatMessage(document.querySelector(`#chatBox-${otherUserId}`), event);
    return;
  }
  showToast(`New message from ${event.senderName || 'user'}`);
}

function appendChatMessage(box, event) {
  if (!box) return;
  const mine = Number(event.senderId) === Number(state.user.id);
  const line = document.createElement('div');
  line.className = `chat-line ${mine ? 'mine' : 'theirs'}`;
  const sender = mine ? 'You' : event.senderName || 'User';
  if (event.type === 'voice') {
    line.innerHTML = `<strong>${escapeHtml(sender)}</strong><audio controls src="${escapeAttr(event.message)}"></audio>`;
  } else {
    line.innerHTML = `<strong>${escapeHtml(sender)}</strong><span>${escapeHtml(event.message)}</span>`;
  }
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

async function recordVoice(receiverId, buttonId = 'voiceChat') {
  if (state.voiceRecorder?.state === 'recording') {
    state.voiceRecorder.stop();
    return;
  }

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    return showToast('Voice recording is not supported in this browser');
  }

  const button = document.querySelector(`#${buttonId}`);
  try {
    state.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.voiceChunks = [];
    state.voiceRecorder = new MediaRecorder(state.voiceStream);
    state.voiceStartedAt = Date.now();

    state.voiceRecorder.ondataavailable = (event) => {
      if (event.data?.size) state.voiceChunks.push(event.data);
    };

    state.voiceRecorder.onstop = async () => {
      clearInterval(state.voiceTimer);
      const duration = Math.round((Date.now() - state.voiceStartedAt) / 1000);
      if (button) {
        button.classList.remove('recording');
        button.textContent = '●';
        button.dataset.tooltip = 'Record Voice';
      }
      state.voiceStream?.getTracks().forEach((track) => track.stop());
      state.voiceStream = null;

      if (duration < 1 || state.voiceChunks.length === 0) {
        showToast('Voice recording was too short');
        return;
      }

      const blob = new Blob(state.voiceChunks, { type: state.voiceChunks[0].type || 'audio/webm' });
      const dataUrl = await blobToDataUrl(blob);
      state.socket.emit('chat_message', {
        examId: state.currentExam?.id || location.hash.split(':')[1],
        receiverId,
        message: dataUrl,
        type: 'voice'
      });
      showToast('Voice message sent');
    };

    state.voiceRecorder.start();
    if (button) {
      button.classList.add('recording');
      button.textContent = '■';
      button.dataset.tooltip = 'Stop Recording 0:00';
      state.voiceTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.voiceStartedAt) / 1000);
        button.dataset.tooltip = `Stop Recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
      }, 500);
    }
    showToast('Recording voice. Click Stop when done.');
  } catch (_error) {
    showToast('Microphone permission denied');
  }
}

function stopMedia() {
  if (state.voiceRecorder?.state === 'recording') state.voiceRecorder.stop();
  clearInterval(state.voiceTimer);
  if (state.cameraFrameTimer) {
    clearInterval(state.cameraFrameTimer);
    state.cameraFrameTimer = null;
  }
  if (state.monitorHeartbeatTimer) {
    clearInterval(state.monitorHeartbeatTimer);
    state.monitorHeartbeatTimer = null;
  }
  cleanupExamSecurityControls();
  if (state.mediaStream) state.mediaStream.getTracks().forEach((track) => track.stop());
}

function cleanupExamSecurityControls() {
  state.examSecurityCleanups.forEach((cleanup) => cleanup());
  state.examSecurityCleanups = [];
  state.examSecurityActive = false;
}

function startCameraFrames(examId) {
  if (!state.currentExam?.enable_camera) return;
  const video = document.querySelector('#cameraPreview');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (state.cameraFrameTimer) clearInterval(state.cameraFrameTimer);
  state.cameraFrameTimer = setInterval(() => {
    if (!video || video.readyState < 2 || !state.socket?.connected) return;
    canvas.width = 320;
    canvas.height = Math.max(180, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * canvas.width));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    state.socket.emit('camera_frame', {
      examId,
      frame: canvas.toDataURL('image/jpeg', 0.5)
    });
  }, 1800);
}

function drawChart(id, rows) {
  const canvas = document.querySelector(`#${id}`);
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = 180 * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const values = rows.map((row) => Number(row.value));
  const max = Math.max(...values, 1);
  const width = canvas.clientWidth;
  ctx.clearRect(0, 0, width, 180);
  rows.forEach((row, index) => {
    const barWidth = Math.max(16, (width - 30) / Math.max(rows.length, 1) - 8);
    const height = (Number(row.value) / max) * 130;
    const x = 15 + index * (barWidth + 8);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--primary');
    ctx.fillRect(x, 150 - height, barWidth, height);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    ctx.fillText(String(row.value), x, 145 - height);
  });
}

function hero(title, body) {
  const routeKey = location.hash.replace('#', '') || 'dashboard';
  const backButton = routeKey === 'dashboard'
    ? ''
    : '<button type="button" class="icon-action back-button" data-tooltip="Back" aria-label="Back" onclick="goBack()">&#8592;</button>';
  return `<section class="hero"><div><div class="hero-title-row">${backButton}<h1>${escapeHtml(title)}</h1></div><p>${body}</p></div><span class="logo-mark small">SE</span></section>`;
}

function metrics(items) {
  return `<div class="grid metrics">${items.map(([label, value]) => `<section class="metric"><span>${label}</span><strong>${value}</strong></section>`).join('')}</div>`;
}

function badge(text, tone = '') {
  return `<span class="badge ${tone}">${escapeHtml(formatStatus(text))}</span>`;
}

function check(name, label, checked) {
  return `<label class="check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}> ${label}</label>`;
}

function blankQuestion() {
  return {
    type: 'mcq',
    questionText: '',
    points: 1,
    isRequired: true,
    options: [{ optionText: '', isCorrect: false }, { optionText: '', isCorrect: false }]
  };
}

function labelType(value) {
  if (value === 'mcq') return 'Multiple Choice';
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatStatus(value) {
  return String(value ?? '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function answerTypeNote(type) {
  const notes = {
    paragraph: 'Paragraph answers are graded manually after submission.',
    file_upload: 'Students will upload a file for manual review.',
    image_upload: 'Students will upload an image for manual review.'
  };
  return notes[type] || '';
}

function loadExamDraft(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch (_error) {
    return null;
  }
}

function saveExamDraft(key) {
  const form = document.querySelector('#examForm');
  if (!form) return;
  const fields = Object.fromEntries(new FormData(form).entries());
  fields.requireAllQuestions = form.requireAllQuestions.checked;
  fields.enableCamera = form.enableCamera.checked;
  fields.enableMicrophone = form.enableMicrophone.checked;
  fields.disableCopyPaste = form.disableCopyPaste.checked;
  fields.screenshotDetection = form.screenshotDetection.checked;
  fields.phoneDetection = form.phoneDetection.checked;
  localStorage.setItem(key, JSON.stringify({ fields, questions: readQuestions(), savedAt: new Date().toISOString() }));
}

function initials(name) {
  return String(name || 'U').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function themeClass(theme) {
  return theme && theme !== 'default' ? `theme-${theme}` : '';
}

function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function goBack() {
  if (history.length > 1) {
    history.back();
    return;
  }
  navigate('dashboard');
}

function logout() {
  stopMedia();
  localStorage.removeItem('secureexam_token');
  localStorage.removeItem('secureexam_user');
  window.location.href = '/';
}

setupNav();
setupSocket();
route();
