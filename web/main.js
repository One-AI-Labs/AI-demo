(() => {
  const sectionButtons = document.querySelectorAll('nav .nav-link');
  const sections = document.querySelectorAll('.page-section');
  const errorToastEl = document.getElementById('errorToast');
  const errorToastBody = document.getElementById('errorToastBody');
  // 避免 Bootstrap CDN 未加载时整段脚本抛错，导致导航等逻辑全部失效
  let errorToast = null;
  if (errorToastEl && typeof bootstrap !== 'undefined' && bootstrap.Toast) {
    try {
      errorToast = new bootstrap.Toast(errorToastEl);
    } catch (e) {
      console.warn('Toast 初始化失败', e);
    }
  }

  function showError(message) {
    if (!errorToast) {
      alert(message);
      return;
    }
    errorToastBody.textContent = message;
    errorToast.show();
  }

  // 页面切换
  sectionButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      sectionButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-target');
      sections.forEach(sec => {
        sec.classList.toggle('active', sec.id === target);
      });
    });
  });

  // 快捷提示词芯片（含 prompt-chip、game-chip）
  document.querySelectorAll('.prompt-chip, .game-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const targetInputId = chip.getAttribute('data-target-input');
      const text = chip.getAttribute('data-text') || '';
      const input = document.getElementById(targetInputId);
      if (input) {
        input.value = text;
        input.focus();
      }
    });
  });

  // 简单表单校验辅助
  function attachValidation(form) {
    if (!form) return;
    form.addEventListener('submit', evt => {
      if (!form.checkValidity()) {
        evt.preventDefault();
        evt.stopPropagation();
      }
      form.classList.add('was-validated');
    }, false);
  }

  document.querySelectorAll('form.needs-validation').forEach(attachValidation);

  // API 封装
  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败: ${res.status}`);
    }
    return data;
  }

  async function apiGet(path) {
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败: ${res.status}`);
    }
    return data;
  }

  // ===== 总览统计 =====
  async function refreshStats() {
    try {
      const stats = await apiGet('/api/stats');
      const totalEl = document.getElementById('statTotalJobs');
      const completedEl = document.getElementById('statCompletedJobs');
      if (totalEl) totalEl.textContent = stats.totalJobs ?? 0;
      if (completedEl) completedEl.textContent = stats.completedJobs ?? 0;
    } catch (err) {
      console.warn('刷新统计失败', err);
    }
  }

  setInterval(refreshStats, 5000);
  refreshStats();

  // ===== AI 对话 =====
  const chatForm = document.getElementById('chatForm');
  const chatMessages = document.getElementById('chatMessages');
  const chatSystemPrompt = document.getElementById('chatSystemPrompt');
  const chatUserInput = document.getElementById('chatUserInput');
  const chatQuickForm = document.getElementById('chatQuickForm');
  const chatQuickInput = document.getElementById('chatQuickInput');
  const chatSettingsPanel = document.getElementById('chatSettingsPanel');
  const toggleChatSettingsBtn = document.getElementById('toggleChatSettings');

  let chatHistory = [];

  function appendChatMessage(role, content) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mb-2 d-flex ' + (role === 'user' ? 'justify-content-end' : 'justify-content-start');

    const bubble = document.createElement('div');
    bubble.className = 'p-2 px-3 small ' + (role === 'user' ? 'chat-message-user' : 'chat-message-ai');
    bubble.textContent = content;

    wrapper.appendChild(bubble);
    chatMessages.appendChild(wrapper);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function sendChatMessage(userText) {
    const text = (userText || '').trim();
    if (!text) return;
    const systemText = chatSystemPrompt.value.trim();

    chatHistory.push({ role: 'user', content: text });
    appendChatMessage('user', text);

    try {
      const payloadMessages = [];
      if (systemText) {
        payloadMessages.push({ role: 'system', content: systemText });
      }
      payloadMessages.push(...chatHistory.map(m => ({
        role: m.role,
        content: m.content
      })));

      const resp = await apiPost('/api/chat/generate', {
        messages: payloadMessages
      });

      const output = resp?.data?.output?.[0]?.content?.[0]?.text
        || resp?.data?.choices?.[0]?.message?.content
        || '[无响应内容]';

      chatHistory.push({ role: 'assistant', content: output });
      appendChatMessage('assistant', output);
      // 后端演示兜底时返回 warning，避免用户误以为已是真实模型回复
      if (resp.warning) {
        showError(resp.warning);
      }
    } catch (err) {
      console.error(err);
      showError((err.message || '对话生成失败').replace('OpenRouter 调用失败: ', ''));
    }
  }

  if (chatForm) {
    chatForm.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      if (!chatForm.checkValidity()) {
        chatForm.classList.add('was-validated');
        return;
      }
      await sendChatMessage(chatUserInput.value);
      chatUserInput.value = '';
    });
  }

  if (chatQuickForm) {
    chatQuickForm.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      await sendChatMessage(chatQuickInput.value);
      chatQuickInput.value = '';
      chatQuickInput.focus();
    });
  }

  if (toggleChatSettingsBtn && chatSettingsPanel) {
    toggleChatSettingsBtn.addEventListener('click', () => {
      chatSettingsPanel.classList.toggle('d-none');
      const isHidden = chatSettingsPanel.classList.contains('d-none');
      toggleChatSettingsBtn.textContent = isHidden ? '会话设定' : '收起设定';
    });
  }

  // 将对话内容改写为各类提示词（这里简单复用最近一轮用户输入）
  function getLastUserText() {
    const last = [...chatHistory].reverse().find(m => m.role === 'user');
    return last?.content || chatUserInput.value.trim();
  }

  const imagePromptInput = document.getElementById('imagePrompt');
  const videoPromptInput = document.getElementById('videoPrompt');
  const musicPromptInput = document.getElementById('musicPrompt');
  const gamePromptInput = document.getElementById('gamePrompt');

  const btnToImagePrompt = document.getElementById('btnToImagePrompt');
  const btnToVideoPrompt = document.getElementById('btnToVideoPrompt');
  const btnToMusicPrompt = document.getElementById('btnToMusicPrompt');
  const btnToGamePrompt = document.getElementById('btnToGamePrompt');

  if (btnToImagePrompt) {
    btnToImagePrompt.addEventListener('click', () => {
      const base = getLastUserText();
      if (!base) return showError('请先在对话里描述一个场景。');
      if (imagePromptInput) {
        imagePromptInput.value = `根据下面的场景生成一张适合投资人演示的视觉图：${base}`;
      }
    });
  }

  if (btnToVideoPrompt) {
    btnToVideoPrompt.addEventListener('click', () => {
      const base = getLastUserText();
      if (!base) return showError('请先在对话里描述一个场景。');
      if (videoPromptInput) {
        videoPromptInput.value = `根据下面的场景生成一个 5-10 秒的产品 Demo 视频：${base}`;
      }
    });
  }

  if (btnToMusicPrompt) {
    btnToMusicPrompt.addEventListener('click', () => {
      const base = getLastUserText();
      if (!base) return showError('请先在对话里描述一个场景。');
      if (musicPromptInput) {
        musicPromptInput.value = `根据下面的场景生成一段适合作为背景音乐的旋律：${base}`;
      }
    });
  }

  if (btnToGamePrompt) {
    btnToGamePrompt.addEventListener('click', () => {
      const base = getLastUserText();
      if (!base) return showError('请先在对话里描述一个场景。');
      if (gamePromptInput) {
        gamePromptInput.value = `根据下面的场景生成一个可玩的小游戏：${base}`;
        sectionButtons.forEach(b => b.classList.remove('active'));
        const gameBtn = document.querySelector('[data-target="gameSection"]');
        if (gameBtn) gameBtn.classList.add('active');
        sections.forEach(sec => sec.classList.toggle('active', sec.id === 'gameSection'));
      }
    });
  }

  // ===== 文生图 =====
  const imageForm = document.getElementById('imageForm');
  const imageResults = document.getElementById('imageResults');
  const imageStyle = document.getElementById('imageStyle');
  const imageRatio = document.getElementById('imageRatio');

  function renderImageJobCard(job) {
    const col = document.createElement('div');
    col.className = 'col-12 col-md-6 col-lg-4';

    const card = document.createElement('div');
    card.className = 'result-card';

    const cover = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'card-body small text-secondary';

    if (job.status === 'completed') {
      if (job.imageUrl) {
        cover.className = 'ratio ratio-1x1';
        const img = document.createElement('img');
        img.src = job.imageUrl;
        img.alt = 'AI 生成图片';
        img.className = 'w-100 h-100 object-fit-cover';
        cover.appendChild(img);
      } else {
        cover.className = 'ratio ratio-1x1 placeholder-art d-flex align-items-center justify-content-center text-center px-3';
        cover.textContent = '演示兜底模式已返回结果';
      }
      const usedModel = job.usedModel ? ` | 模型：${job.usedModel}` : '';
      body.textContent = `${job.prompt}${usedModel}`;
    } else if (job.status === 'failed') {
      cover.className = 'ratio ratio-1x1 placeholder-art d-flex align-items-center justify-content-center text-center px-3';
      cover.textContent = '生成失败';
      body.textContent = `任务失败：${job.error || '未知错误'}`;
    } else {
      cover.className = 'ratio ratio-1x1 placeholder-art d-flex align-items-center justify-content-center text-center px-3';
      cover.textContent = '正在生成图片...';
      body.textContent = job.prompt;
    }

    card.appendChild(cover);
    card.appendChild(body);
    col.appendChild(card);
    return col;
  }

  if (imageForm) {
    imageForm.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      if (!imageForm.checkValidity()) {
        imageForm.classList.add('was-validated');
        return;
      }

      const prompt = imagePromptInput.value.trim();
      try {
        const resp = await apiPost('/api/image/generate', {
          prompt,
          style: imageStyle.value === 'illustration' ? '<flat illustration>' : '<auto>',
          size: imageRatio.value === '16:9' ? '1280*720' : imageRatio.value === '9:16' ? '720*1280' : '1024*1024'
        });

        const jobId = resp.jobId;
        const job = { id: jobId, type: 'image', status: 'queued', prompt };
        const card = renderImageJobCard(job);
        card.classList.add(`placeholder-${jobId}`);
        imageResults.prepend(card);
        pollJob(jobId, 'image');
        refreshStats();
      } catch (err) {
        console.error(err);
        showError((err.message || '图片生成失败').replace('OpenRouter 调用失败: ', ''));
      }
    });
  }

  // ===== 文生视频（异步任务）=====
  const videoForm = document.getElementById('videoForm');
  const videoJobs = document.getElementById('videoJobs');

  const activeJobPollers = new Map();

  function renderVideoJobCard(job) {
    const col = document.createElement('div');
    col.className = 'col-12 col-md-6';

    const card = document.createElement('div');
    card.className = 'result-card';

    const body = document.createElement('div');
    body.className = 'card-body small';

    const title = document.createElement('h6');
    title.className = 'card-title';
    title.textContent = `任务 #${job.id.slice(0, 6)}`;

    const status = document.createElement('span');
    status.className = 'badge ms-2 ' + (job.status === 'completed' ? 'bg-success' : 'bg-secondary');
    status.textContent = job.status === 'completed' ? '已完成' : job.status === 'queued' ? '排队中' : '进行中';

    const desc = document.createElement('p');
    desc.className = 'mt-2 mb-2 text-secondary';
    desc.textContent = job.prompt;

    body.appendChild(title);
    body.appendChild(status);
    body.appendChild(desc);

    if (job.warning) {
      const warn = document.createElement('div');
      warn.className = 'small mt-2';
      warn.textContent = job.warning;
      body.appendChild(warn);
    }

    if (job.status === 'completed' && job.assetId) {
      const video = document.createElement('video');
      video.className = 'w-100 rounded';
      video.controls = true;
      video.src = job.mediaUrl || job.mockUrl || '#';
      video.innerText = '您的浏览器不支持 video 标签';
      body.appendChild(video);
    } else {
      const progress = document.createElement('div');
      progress.className = 'progress';
      const bar = document.createElement('div');
      bar.className = 'progress-bar progress-bar-striped progress-bar-animated';
      bar.style.width = '60%';
      bar.textContent = '生成中（约1-2分钟）…';
      progress.appendChild(bar);
      body.appendChild(progress);
    }

    if (job.status === 'completed' && (job.provider || job.usedModel)) {
      const info = document.createElement('div');
      info.className = 'small text-secondary mt-2';
      const providerText = job.provider ? `供应商：${job.provider}` : '';
      const modelText = job.usedModel ? `模型：${job.usedModel}` : '';
      info.textContent = [providerText, modelText].filter(Boolean).join(' · ');
      body.appendChild(info);
    }

    card.appendChild(body);
    col.appendChild(card);
    return col;
  }

  async function pollJob(jobId, type) {
    if (activeJobPollers.has(jobId)) return;
    const timer = setInterval(async () => {
      try {
        const job = await apiGet(`/api/jobs/${jobId}`);
        if (job.status === 'completed') {
          clearInterval(timer);
          activeJobPollers.delete(jobId);
          if (type === 'image') {
            const asset = await apiGet(`/api/assets/${job.assetId}`);
            job.imageUrl = asset.imageUrl;
            job.usedModel = job.usedModel || asset.usedModel;
            const card = renderImageJobCard(job);
            imageResults.querySelectorAll(`.placeholder-${jobId}`).forEach(el => el.remove());
            imageResults.prepend(card);
            refreshStats();
          } else if (type === 'video') {
            const asset = await apiGet(`/api/assets/${job.assetId}`);
            job.mediaUrl = asset.mediaUrl || asset.mockUrl;
            job.provider = asset.provider || job.provider;
            job.usedModel = asset.usedModel || job.usedModel;
            job.warning = asset.warning || job.warning;
            const card = renderVideoJobCard(job);
            videoJobs.querySelectorAll('.placeholder-job').forEach(el => el.remove());
            videoJobs.prepend(card);
            refreshStats();
          } else if (type === 'music') {
            const asset = await apiGet(`/api/assets/${job.assetId}`);
            job.mediaUrl = asset.mediaUrl || asset.mockUrl;
            job.provider = asset.provider || job.provider;
            job.usedModel = asset.usedModel || job.usedModel;
            job.warning = asset.warning || job.warning;
            const card = renderMusicJobCard(job);
            musicJobs.querySelectorAll('.placeholder-job').forEach(el => el.remove());
            musicJobs.prepend(card);
            refreshStats();
          } else if (type === 'game') {
            const asset = await apiGet(`/api/assets/${job.assetId}`);
            job.html = asset.html;
            job.provider = asset.provider || job.provider;
            job.usedModel = asset.usedModel || job.usedModel;
            job.warning = asset.warning || job.warning;
            const card = renderGameJobCard(job);
            gameJobs.querySelectorAll(`.placeholder-${jobId}`).forEach(el => el.remove());
            gameJobs.prepend(card);
            refreshStats();
          }
        } else if (job.status === 'failed') {
          clearInterval(timer);
          activeJobPollers.delete(jobId);
          if (type === 'image') {
            const card = renderImageJobCard(job);
            imageResults.querySelectorAll(`.placeholder-${jobId}`).forEach(el => el.remove());
            imageResults.prepend(card);
          } else if (type === 'video') {
            showError(job.error || '视频任务失败');
          } else if (type === 'music') {
            showError(job.error || '音乐任务失败');
          } else if (type === 'game') {
            const card = renderGameJobCard(job);
            gameJobs.querySelectorAll(`.placeholder-${jobId}`).forEach(el => el.remove());
            gameJobs.prepend(card);
            showError(job.error || '游戏任务失败');
          }
        }
      } catch (err) {
        console.warn('轮询任务失败', err);
      }
    }, 2000);
    activeJobPollers.set(jobId, timer);
  }

  if (videoForm) {
    videoForm.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      if (!videoForm.checkValidity()) {
        videoForm.classList.add('was-validated');
        return;
      }

      const prompt = videoPromptInput.value.trim();
      const durationVal = Number(document.getElementById('videoDuration')?.value || 5);
      const duration = Number.isFinite(durationVal) ? durationVal : 5;
      try {
        const resp = await apiPost('/api/video/generate', { prompt, duration });
        const jobId = resp.jobId;
        const job = { id: jobId, status: 'queued', prompt, duration, type: 'video' };
        const card = renderVideoJobCard(job);
        card.classList.add('placeholder-job');
        videoJobs.prepend(card);
        pollJob(jobId, 'video');
        refreshStats();
      } catch (err) {
        console.error(err);
        showError(err.message || '视频任务创建失败');
      }
    });
  }

  // ===== 文生音乐（异步任务）=====
  const musicForm = document.getElementById('musicForm');
  const musicJobs = document.getElementById('musicJobs');

  function renderMusicJobCard(job) {
    const col = document.createElement('div');
    col.className = 'col-12 col-md-6';

    const card = document.createElement('div');
    card.className = 'result-card';

    const body = document.createElement('div');
    body.className = 'card-body small';

    const title = document.createElement('h6');
    title.className = 'card-title';
    title.textContent = `任务 #${job.id.slice(0, 6)}`;

    const status = document.createElement('span');
    status.className = 'badge ms-2 ' + (job.status === 'completed' ? 'bg-success' : 'bg-secondary');
    status.textContent = job.status === 'completed' ? '已完成' : job.status === 'queued' ? '排队中' : '进行中';

    const desc = document.createElement('p');
    desc.className = 'mt-2 mb-2 text-secondary';
    desc.textContent = job.prompt;

    body.appendChild(title);
    body.appendChild(status);
    body.appendChild(desc);

    if (job.status === 'completed' && job.assetId) {
      const audio = document.createElement('audio');
      audio.className = 'w-100';
      audio.controls = true;
      audio.src = job.mediaUrl || job.mockUrl || '#';
      audio.innerText = '您的浏览器不支持 audio 标签';
      body.appendChild(audio);

      if (job.provider || job.usedModel) {
        const info = document.createElement('div');
        info.className = 'small text-secondary mt-2';
        const providerText = job.provider ? `供应商：${job.provider}` : '';
        const modelText = job.usedModel ? `模型：${job.usedModel}` : '';
        info.textContent = [providerText, modelText].filter(Boolean).join(' · ');
        body.appendChild(info);
      }
    } else {
      const progress = document.createElement('div');
      progress.className = 'progress';
      const bar = document.createElement('div');
      bar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-info';
      bar.style.width = '60%';
      bar.textContent = '生成中（约1-2分钟）…';
      progress.appendChild(bar);
      body.appendChild(progress);
    }

    if (job.warning) {
      const warn = document.createElement('div');
      warn.className = 'small mt-2 text-danger';
      warn.textContent = job.warning;
      body.appendChild(warn);
    }

    card.appendChild(body);
    col.appendChild(card);
    return col;
  }

  if (musicForm) {
    musicForm.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      if (!musicForm.checkValidity()) {
        musicForm.classList.add('was-validated');
        return;
      }

      const prompt = musicPromptInput.value.trim();
      try {
        const resp = await apiPost('/api/music/generate', { prompt });
        const jobId = resp.jobId;
        const job = { id: jobId, status: 'queued', prompt, type: 'music' };
        const card = renderMusicJobCard(job);
        card.classList.add('placeholder-job');
        musicJobs.prepend(card);
        pollJob(jobId, 'music');
        refreshStats();
      } catch (err) {
        console.error(err);
        showError(err.message || '音乐任务创建失败');
      }
    });
  }

  // ===== 文生小游戏 =====
  const gameForm = document.getElementById('gameForm');
  const gameJobs = document.getElementById('gameJobs');

  function renderGameJobCard(job) {
    const col = document.createElement('div');
    col.className = 'col-12';

    const card = document.createElement('div');
    card.className = 'result-card';

    const body = document.createElement('div');
    body.className = 'card-body p-2';

    if (job.status === 'completed' && job.assetId && job.html) {
      const iframeWrap = document.createElement('div');
      iframeWrap.className = 'ratio ratio-16x9 rounded overflow-hidden bg-light';
      const iframe = document.createElement('iframe');
      iframe.sandbox = 'allow-scripts';
      iframe.srcdoc = job.html;
      iframe.title = '生成的小游戏预览';
      iframe.className = 'w-100 h-100 border-0';
      iframe.style.minHeight = '320px';
      iframeWrap.appendChild(iframe);
      body.appendChild(iframeWrap);

      // ===== 可修改面板：通过 postMessage 控制 iframe 内的 window.GameAPI =====
      const postToGame = (payload) => {
        try {
          iframe.contentWindow && iframe.contentWindow.postMessage(payload, '*');
        } catch (e) {}
      };

      const modPanel = document.createElement('div');
      modPanel.className = 'mt-2 p-2 rounded border bg-light';
      modPanel.innerHTML = `
        <div class="d-flex flex-wrap gap-2 align-items-center">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-game-cmd="pause">暂停</button>
          <button type="button" class="btn btn-sm btn-outline-primary" data-game-cmd="start">继续</button>
          <button type="button" class="btn btn-sm btn-outline-warning" data-game-cmd="reset">重置</button>
        </div>

        <div class="row g-2 mt-2">
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1" for="gameDifficulty-${job.id}">难度（difficulty）</label>
            <select class="form-select form-select-sm" id="gameDifficulty-${job.id}">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3" selected>3</option>
              <option value="4">4</option>
              <option value="5">5</option>
            </select>
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label small mb-1" for="gameNickname-${job.id}">修改游戏（用于二次修改 HTML）</label>
            <input class="form-control form-control-sm" id="gameNickname-${job.id}" type="text"
              placeholder="例如：张三" value="玩家" />
          </div>
        </div>

        <div class="d-flex gap-2 mt-2">
          <button type="button" class="btn btn-sm btn-secondary" data-game-action="applyConfig">应用难度</button>
          <button type="button" class="btn btn-sm btn-primary" data-game-action="remixHtml">再次修改HTML</button>
        </div>
        <div class="small text-secondary mt-2">说明：再次修改会基于旧 HTML 重新生成一份“改昵称版”，并在重新加载后继续保留你选的难度。</div>
      `;

      body.appendChild(modPanel);

      // 按钮/表单事件
      modPanel.querySelectorAll('[data-game-cmd]').forEach(btn => {
        btn.addEventListener('click', () => {
          const cmd = btn.getAttribute('data-game-cmd');
          if (!cmd) return;
          postToGame({ type: 'GAME_COMMAND', command: cmd });
        });
      });

      const difficultySelect = modPanel.querySelector(`#gameDifficulty-${job.id}`);
      const nicknameInput = modPanel.querySelector(`#gameNickname-${job.id}`);
      if (difficultySelect) {
        difficultySelect.addEventListener('change', () => {
          postToGame({
            type: 'GAME_SET_CONFIG',
            config: {
              difficulty: Number(difficultySelect.value),
              nickname: nicknameInput ? String(nicknameInput.value || '').trim() : undefined
            }
          });
        });
      }

      const applyConfigBtn = modPanel.querySelector('[data-game-action="applyConfig"]');
      if (applyConfigBtn && difficultySelect) {
        applyConfigBtn.addEventListener('click', () => {
          postToGame({
            type: 'GAME_SET_CONFIG',
            config: {
              difficulty: Number(difficultySelect.value),
              nickname: nicknameInput ? String(nicknameInput.value || '').trim() : undefined
            }
          });
        });
      }

      const remixBtn = modPanel.querySelector('[data-game-action="remixHtml"]');
      if (remixBtn && nicknameInput && difficultySelect) {
        remixBtn.addEventListener('click', async () => {
          const nickname = String(nicknameInput.value || '').trim();
          if (!nickname) {
            showError('请输入昵称');
            return;
          }
          const difficulty = Number(difficultySelect.value);
          if (!Number.isFinite(difficulty) || difficulty < 1) {
            showError('难度必须是大于等于 1 的数字');
            return;
          }

          const oldText = remixBtn.textContent;
          remixBtn.disabled = true;
          remixBtn.textContent = '再次修改中...';

          try {
            // 调用后端：基于旧 HTML 重新生成一份“改昵称版”
            const resp = await apiPost('/api/game/remix', {
              assetId: job.assetId,
              nickname,
              difficulty
            });

            if (!resp || !resp.html) throw new Error('再次修改返回缺少 html');

            // 重载 iframe，并在载入后继续下发难度（难度保留）
            await new Promise(resolve => {
              const handler = () => {
                try {
                  postToGame({
                    type: 'GAME_SET_CONFIG',
                    config: { difficulty, nickname }
                  });
                } finally {
                  iframe.removeEventListener('load', handler);
                  resolve();
                }
              };
              iframe.addEventListener('load', handler, { once: true });
              iframe.srcdoc = resp.html;
            });
          } catch (err) {
            console.error(err);
            showError(err.message || '再次修改失败');
          } finally {
            remixBtn.disabled = false;
            remixBtn.textContent = oldText;
          }
        });
      }
    } else if (job.status === 'failed') {
      const errEl = document.createElement('div');
      errEl.className = 'small text-danger p-2';
      errEl.textContent = '小游戏生成失败，请重试';
      body.appendChild(errEl);
    } else {
      const progress = document.createElement('div');
      progress.className = 'progress';
      const bar = document.createElement('div');
      bar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-secondary';
      bar.style.width = '60%';
      progress.appendChild(bar);
      body.appendChild(progress);
    }

    card.appendChild(body);
    col.appendChild(card);
    return col;
  }

  if (gameForm) {
    gameForm.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      if (!gameForm.checkValidity()) {
        gameForm.classList.add('was-validated');
        return;
      }

      const prompt = gamePromptInput.value.trim();
      try {
        const resp = await apiPost('/api/game/generate', { prompt });
        const jobId = resp.jobId;
        const job = { id: jobId, status: 'queued', prompt, type: 'game' };
        const card = renderGameJobCard(job);
        card.classList.add(`placeholder-${jobId}`);
        gameJobs.prepend(card);
        pollJob(jobId, 'game');
        refreshStats();
      } catch (err) {
        console.error(err);
        showError(err.message || '游戏任务创建失败');
      }
    });
  }
})();

