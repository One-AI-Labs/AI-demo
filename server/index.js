import express from 'express';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DEMO_SAFE_MODE = String(process.env.DEMO_SAFE_MODE || 'true').toLowerCase() === 'true';

// GitHub Webhook：须在 express.json 之前，使用原始 body 验签（X-Hub-Signature-256）
app.post(
  '/api/deploy/hook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    const secret = process.env.DEPLOY_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'webhook 未配置 DEPLOY_WEBHOOK_SECRET' });
    }

    const sigHeader = req.headers['x-hub-signature-256'];
    if (!sigHeader || typeof sigHeader !== 'string' || !sigHeader.startsWith('sha256=')) {
      return res.status(401).json({ error: 'missing signature' });
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(raw);
    const expected = Buffer.from(`sha256=${hmac.digest('hex')}`, 'utf8');
    const received = Buffer.from(sigHeader, 'utf8');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return res.status(401).json({ error: 'bad signature' });
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }

    const expectedRepo = process.env.DEPLOY_REPO_FULL_NAME;
    if (expectedRepo) {
      const fullName = payload?.repository?.full_name;
      if (fullName && fullName !== expectedRepo) {
        return res.status(403).json({ error: 'repository mismatch' });
      }
    }

    const event = req.headers['x-github-event'] || '';
    if (event === 'ping') {
      return res.status(200).json({ ok: true, message: 'pong' });
    }

    if (event !== 'push') {
      return res.status(200).json({ skipped: true, reason: 'ignored event', event });
    }

    const ref = payload?.ref;
    if (ref && ref !== 'refs/heads/main') {
      return res.status(200).json({ skipped: true, reason: 'not main branch', ref });
    }

    const root = path.join(__dirname, '..');
    const script = path.join(root, 'scripts', 'deploy-vps.sh');
    const child = spawn('bash', [script], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });
    child.unref();

    return res.status(202).json({ ok: true, message: 'deploy started' });
  }
);

app.use(express.json({ limit: '2mb' }));
// Vercel 上 morgan 写 stdout 可能带来额外开销；本地保留详细日志
if (!process.env.VERCEL) {
  app.use(morgan('dev'));
}

// 简单内存任务与资源存储（Demo 用，生产请换成 Redis/DB + 对象存储）
const jobs = new Map();
const assets = new Map();
const seedanceTaskToJobId = new Map();
const sunoTaskToJobId = new Map();

// 静态前端：根路径提供 index.html / main.js；/web/* 与生产 Vercel 路径一致，避免误用 /web/main.js 时 404
const webStatic = path.join(__dirname, '..', 'web');
app.use('/web', express.static(webStatic));
app.use(express.static(webStatic));

// 避免页面自动请求 favicon 造成无意义 404
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// OpenRouter 通用调用封装
async function callOpenRouter({ model, input, extra = {} }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 OPENROUTER_API_KEY 环境变量');
  }

  const res = await fetch('https://openrouter.ai/api/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input,
      ...extra
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter 调用失败: ${res.status} ${text}`);
  }

  return res.json();
}

async function callDashscopeApp({ prompt }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const appId = process.env.DASHSCOPE_APP_ID;
  if (!apiKey || !appId) {
    throw new Error('缺少 DASHSCOPE_API_KEY 或 DASHSCOPE_APP_ID 环境变量');
  }

  const res = await fetch(`https://dashscope.aliyuncs.com/api/v1/apps/${appId}/completion`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: { prompt },
      parameters: {},
      debug: {}
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DashScope 调用失败: ${res.status} ${text}`);
  }

  return res.json();
}

async function createDashscopeImageTask({ prompt, style = '<auto>', size = '1024*1024' }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const model = process.env.DASHSCOPE_IMAGE_MODEL || 'wanx-v1';
  if (!apiKey) {
    throw new Error('缺少 DASHSCOPE_API_KEY 环境变量');
  }

  const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify({
      model,
      input: { prompt },
      parameters: {
        style,
        size,
        n: 1
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DashScope 图像任务创建失败: ${res.status} ${text}`);
  }
  return res.json();
}

async function getDashscopeTask(taskId) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const res = await fetch(`https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DashScope 任务查询失败: ${res.status} ${text}`);
  }
  return res.json();
}

async function waitForDashscopeTask(taskId, maxWaitMs = 45000, intervalMs = 2000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const taskData = await getDashscopeTask(taskId);
    const status = taskData?.output?.task_status;
    if (status === 'SUCCEEDED') return taskData;
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(`DashScope 图像任务失败，状态: ${status}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('DashScope 图像任务超时');
}

app.post('/api/suno/callback', (req, res) => {
  try {
    const payload = req.body || {};
    const theirTaskId = payload?.task_id || null;
    if (!theirTaskId) {
      return res.json({ ok: true });
    }

    const jobId = sunoTaskToJobId.get(String(theirTaskId));
    if (!jobId) {
      return res.json({ ok: true });
    }

    const job = jobs.get(jobId);
    if (!job) {
      sunoTaskToJobId.delete(String(theirTaskId));
      return res.json({ ok: true });
    }

    if (payload.success === true) {
      const list = payload.data || [];
      const first = Array.isArray(list) ? list[0] : null;
      const audioUrl = first?.audio_url || first?.output?.audio_url || null;
      const usedModel = first?.model || process.env.SUNO_MODEL || 'suno';
      if (audioUrl) {
        const assetId = uuidv4();
        assets.set(assetId, {
          type: 'music',
          mediaUrl: audioUrl,
          provider: 'suno',
          usedModel,
          raw: payload
        });
        jobs.set(jobId, { ...job, status: 'completed', assetId, usedModel });
      } else {
        jobs.set(jobId, { ...job, status: 'failed', error: 'Suno 回调缺少 audio_url' });
      }
    } else {
      jobs.set(jobId, { ...job, status: 'failed', error: payload?.error?.message || 'Suno 任务失败' });
    }

    sunoTaskToJobId.delete(String(theirTaskId));
    return res.json({ ok: true });
  } catch (err) {
    console.error('Suno callback 处理失败', err);
    return res.json({ ok: true });
  }
});

async function createReplicatePrediction({ model, input }) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error('缺少 REPLICATE_API_TOKEN 环境变量');
  }
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Replicate 任务创建失败: ${res.status} ${text}`);
  }
  return res.json();
}

async function getReplicatePrediction(id) {
  const token = process.env.REPLICATE_API_TOKEN;
  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    method: 'GET',
    headers: { 'Authorization': `Token ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Replicate 任务查询失败: ${res.status} ${text}`);
  }
  return res.json();
}

async function waitForReplicatePrediction(id, maxWaitMs = 120000, intervalMs = 2500) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const data = await getReplicatePrediction(id);
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(`Replicate 任务失败，状态: ${data.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Replicate 任务超时');
}

function extractFirstUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output[0];
    return typeof first === 'string' ? first : null;
  }
  return null;
}

async function createSunoTask({ prompt, callbackUrl }) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 SUNO_API_KEY 环境变量');
  }

  // AceDataCloud Suno Audios API
  const res = await fetch('https://api.acedata.cloud/suno/audios', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'accept': 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      prompt,
      callback_url: callbackUrl || undefined
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Suno 任务创建失败: ${res.status} ${text}`);
  }
  return res.json();
}

function clampExecutionExpiresAfter(value, min = 3600, max = 259200) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(num, max));
}

async function createSeedanceVideoTask({ prompt, duration, callbackUrl }) {
  const apiKey = process.env.SEEDANCE_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 SEEDANCE_API_KEY 环境变量');
  }
  const model = process.env.SEEDANCE_VIDEO_MODEL || 'doubao-seedance-1-0-pro-fast-251015';

  const dur = Math.max(4, Math.min(Math.round(Number(duration) || 5), 20));
  // SeeDance 示例里使用类似命令行参数的方式控制时长，这里把 dur 追加到 prompt 末尾
  const text = `${prompt} --dur ${dur} --rt 16:9`;

  const executionExpiresAfter = clampExecutionExpiresAfter(
    process.env.SEEDANCE_EXECUTION_EXPIRES_AFTER || 3600
  );

  const payload = {
    content: [{ type: 'text', text }],
    model,
    execution_expires_after: executionExpiresAfter,
    return_last_frame: true,
    service_tier: 'default'
  };

  if (callbackUrl) {
    payload.callback_url = callbackUrl;
  }

  const res = await fetch('https://api.acedata.cloud/seedance/videos', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'accept': 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const textBody = await res.text();
    throw new Error(`Seedance 视频任务创建失败: ${res.status} ${textBody}`);
  }

  return res.json();
}

function parseModelList(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const models = value.split(',').map(v => v.trim()).filter(Boolean);
  return models.length > 0 ? models : fallback;
}

function isModelUnavailableError(message) {
  if (!message) return false;
  const text = String(message).toLowerCase();
  return text.includes('not available in your region')
    || text.includes('"code":403')
    || text.includes('model not found')
    || text.includes('no endpoints found');
}

async function callOpenRouterWithFallback({ models, input, extra = {} }) {
  const errors = [];
  for (const model of models) {
    try {
      const data = await callOpenRouter({ model, input, extra });
      return { data, usedModel: model };
    } catch (err) {
      errors.push({ model, message: err.message });
      // 403/地区不可用/模型不可用时继续尝试其他模型，其他错误也保留继续试，提升 Demo 稳定性
      if (!isModelUnavailableError(err.message)) {
        console.warn(`模型 ${model} 调用异常，尝试下一个模型。`);
      }
    }
  }
  const detail = errors.map(e => `${e.model}: ${e.message}`).join(' | ');
  throw new Error(`所有候选模型都不可用。${detail}`);
}

function buildMockChatResponse(messages) {
  const latestUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const prompt = typeof latestUserMessage?.content === 'string'
    ? latestUserMessage.content
    : '这个创意项目';
  const text = [
    '这是演示模式下的智能回答（网络/地区受限时自动兜底）。',
    `我理解你的核心需求是：${prompt}`,
    '给投资人的展示建议：1) 先讲痛点；2) 展示 AI 生成结果；3) 展示可扩展商业化路径。',
    '如果你愿意，我可以继续把这段话改写成图片、视频和音乐的提示词。'
  ].join('\n');
  return {
    output: [
      {
        content: [{ text }]
      }
    ]
  };
}

function buildMockImageResponse() {
  return {
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: '演示模式：未调用真实绘图服务，仅返回占位结果（提示词仅保存在任务记录中）。'
          }
        ]
      }
    ]
  };
}

// AI 对话
app.post('/api/chat/generate', async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages 必须为非空数组' });
    }

    const prompt = messages
      .map(m => `${m.role || 'user'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n');

    const dashResp = await callDashscopeApp({ prompt });
    const outputText = dashResp?.output?.text || '[无响应内容]';

    const data = {
      output: [
        {
          content: [{ text: outputText }]
        }
      ]
    };

    res.json({
      data,
      usedModel: dashResp?.usage?.models?.[0]?.model_id || 'dashscope-app',
      provider: 'dashscope'
    });
  } catch (err) {
    console.error(err);
    if (DEMO_SAFE_MODE) {
      const mockData = buildMockChatResponse(req.body?.messages || []);
      return res.json({
        data: mockData,
        usedModel: 'demo/mock-chat',
        fallbackUsed: true,
        warning: '当前模型服务不可用，已自动切换到演示兜底模式'
      });
    }
    res.status(500).json({ error: err.message || 'Chat 生成失败，请检查 DashScope 配置或网络可用性' });
  }
});

// 文生图（异步任务：与视频/音乐一致，避免长时阻塞）
app.post('/api/image/generate', async (req, res) => {
  const { prompt, style = '<auto>', size = '1024*1024' } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'prompt 不能为空' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    id: jobId,
    type: 'image',
    status: 'queued',
    prompt,
    provider: 'dashscope'
  });

  (async () => {
    try {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'running' });
      const createResp = await createDashscopeImageTask({ prompt, style, size });
      const taskId = createResp?.output?.task_id;
      if (!taskId) {
        throw new Error('DashScope 未返回 task_id');
      }

      const taskData = await waitForDashscopeTask(taskId);
      const imageUrl = taskData?.output?.results?.[0]?.url || null;
      const assetId = uuidv4();
      assets.set(assetId, {
        type: 'image',
        raw: taskData,
        usedModel: process.env.DASHSCOPE_IMAGE_MODEL || 'wanx-v1',
        provider: 'dashscope',
        imageUrl
      });
      jobs.set(jobId, {
        ...jobs.get(jobId),
        status: 'completed',
        assetId,
        usedModel: process.env.DASHSCOPE_IMAGE_MODEL || 'wanx-v1'
      });
    } catch (err) {
      console.error(err);
      if (DEMO_SAFE_MODE) {
        const mockData = buildMockImageResponse();
        const assetId = uuidv4();
        assets.set(assetId, {
          type: 'image',
          raw: mockData,
          usedModel: 'demo/mock-image',
          provider: 'demo',
          fallbackUsed: true,
          imageUrl: null
        });
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'completed',
          assetId,
          usedModel: 'demo/mock-image',
          warning: '当前地区图片模型不可用，已自动切换到演示兜底模式'
        });
      } else {
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'failed',
          error: err.message || '图片生成失败'
        });
      }
    }
  })();

  res.json({ jobId });
});

app.post('/api/seedance/callback', (req, res) => {
  try {
    const payload = req.body || {};
    const theirTaskId = payload?.data?.task_id || payload?.task_id || null;
    const jobIdFromQuery = req.query?.jobId;
    const jobId = jobIdFromQuery || (theirTaskId ? seedanceTaskToJobId.get(String(theirTaskId)) : null);

    const job = jobId ? jobs.get(jobId) : null;
    if (!job) return res.json({ ok: true });

    const status = payload?.data?.status;
    const videoUrl = payload?.data?.video_url;
    const usedModel = payload?.data?.model || job.usedModel || process.env.SEEDANCE_VIDEO_MODEL || 'seedance';

    if (payload?.success === true && status === 'succeeded' && videoUrl) {
      const assetId = uuidv4();
      assets.set(assetId, {
        type: 'video',
        mediaUrl: videoUrl,
        provider: 'seedance',
        usedModel,
        raw: payload
      });

      jobs.set(jobId, { ...job, status: 'completed', assetId, usedModel });
      if (theirTaskId) seedanceTaskToJobId.delete(String(theirTaskId));
    } else {
      jobs.set(jobId, {
        ...job,
        status: 'failed',
        error: payload?.error?.message || `Seedance 任务状态: ${status || 'unknown'}`
      });
      if (theirTaskId) seedanceTaskToJobId.delete(String(theirTaskId));
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Seedance callback 处理失败', err);
    return res.json({ ok: true });
  }
});

// 文生视频（异步任务：立刻返回 jobId，后台等待 Seedance 返回 video_url）
app.post('/api/video/generate', (req, res) => {
  const { prompt, duration = 5 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt 不能为空' });

  const jobId = uuidv4();
  jobs.set(jobId, {
    id: jobId,
    type: 'video',
    status: 'queued',
    prompt,
    provider: 'seedance'
  });

  (async () => {
    try {
      // 本地演示更稳定：默认不依赖 callback_url（避免 Seedance 回调打不到 localhost）
      const taskResp = await createSeedanceVideoTask({
        prompt,
        duration,
        callbackUrl: null
      });

      const success = taskResp?.success === true;
      const data = taskResp?.data || {};
      const status = String(data?.status || data?.task_status || '').toLowerCase();
      const videoUrl = data?.video_url || data?.output?.video_url || data?.output || null;
      const theirTaskId = data?.task_id || taskResp?.task_id || null;

      if (success && (status === 'succeeded' || status === 'completed') && videoUrl) {
        const assetId = uuidv4();
        const usedModel = data?.model || process.env.SEEDANCE_VIDEO_MODEL || 'seedance';
        assets.set(assetId, {
          type: 'video',
          mediaUrl: videoUrl,
          provider: 'seedance',
          usedModel,
          raw: taskResp
        });
        jobs.set(jobId, { ...jobs.get(jobId), status: 'completed', assetId, usedModel });
      } else {
        throw new Error(`Seedance 未返回 succeeded video_url，status=${status}, task_id=${theirTaskId || 'n/a'}`);
      }
    } catch (err) {
      console.error(err);
      const msg = err?.message || String(err || '');
      const usedUp = msg.toLowerCase().includes('used_up') || msg.toLowerCase().includes('balance');
      const warning = usedUp
        ? 'Seedance 额度不足（used_up）。请在 Ace Data Cloud 给 Seedance 视频生成充值/申请额度后重试。'
        : (msg || '视频生成失败');
      if (DEMO_SAFE_MODE) {
        const assetId = uuidv4();
        assets.set(assetId, {
          type: 'video',
          mediaUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
          provider: 'demo',
          usedModel: 'demo/mock-video',
          fallbackUsed: true,
          warning
        });
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'completed',
          assetId,
          usedModel: 'demo/mock-video',
          error: null,
          warning
        });
      } else {
        jobs.set(jobId, {
          ...jobs.get(jobId),
          status: 'failed',
          error: err.message || '视频生成失败'
        });
      }
    }
  })();

  res.json({ jobId });
});

// 文生音乐（异步任务：Suno API，失败可兜底）
app.post('/api/music/generate', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'prompt 不能为空' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, type: 'music', status: 'queued', prompt, provider: 'suno' });

  (async () => {
    try {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'running' });

      const useCallback = String(process.env.SUNO_USE_CALLBACK || 'false').toLowerCase() === 'true';
      const callbackBase = process.env.SUNO_CALLBACK_BASE_URL || `http://localhost:${PORT}/api/suno/callback`;
      const callbackUrl = useCallback ? `${callbackBase}?jobId=${jobId}` : null;

      const createData = await createSunoTask({ prompt, callbackUrl });

      // 如果接口直接返回 success + data，则立即完成
      if (createData?.success === true && createData?.data) {
        const list = createData.data;
        const first = Array.isArray(list) ? list[0] : null;
        const audioUrl = first?.audio_url || null;
        const usedModel = first?.model || process.env.SUNO_MODEL || 'suno';
        if (!audioUrl) throw new Error('Suno 直接返回缺少 audio_url');

        const assetId = uuidv4();
        assets.set(assetId, {
          type: 'music',
          mediaUrl: audioUrl,
          provider: 'suno',
          usedModel,
          raw: createData
        });
        jobs.set(jobId, { ...jobs.get(jobId), status: 'completed', assetId, usedModel });
      } else {
        if (!useCallback) {
          throw new Error('Suno 未直接返回音频 data，且未启用 callback_url，因此无法继续。若你要走回调，请将 SUNO_USE_CALLBACK=true，并提供可被外网访问的回调地址。');
        }
        // 否则通过回调回填
        const theirTaskId = createData?.task_id || createData?.data?.task_id;
        if (!theirTaskId) throw new Error('Suno 未返回 task_id，无法回调跟踪');
        sunoTaskToJobId.set(String(theirTaskId), jobId);
      }
    } catch (err) {
      console.error(err);
      if (DEMO_SAFE_MODE) {
        const assetId = uuidv4();
        assets.set(assetId, {
          type: 'music',
          mediaUrl: 'https://www.w3schools.com/html/horse.mp3',
          provider: 'demo',
          usedModel: 'demo/mock-music'
        });
        jobs.set(jobId, { ...jobs.get(jobId), status: 'completed', assetId, usedModel: 'demo/mock-music' });
      } else {
        jobs.set(jobId, { ...jobs.get(jobId), status: 'failed', error: err.message || '音乐生成失败' });
      }
    }
  })();

  res.json({ jobId });
});

// 查询任务状态
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: '任务不存在' });
  }
  res.json(job);
});

// 查询资源
app.get('/api/assets/:assetId', (req, res) => {
  const asset = assets.get(req.params.assetId);
  if (!asset) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.json(asset);
});

// 简单统计看板数据
app.get('/api/stats', (req, res) => {
  const totalJobs = jobs.size;
  const completedJobs = Array.from(jobs.values()).filter(j => j.status === 'completed').length;
  res.json({
    totalJobs,
    completedJobs
  });
});

// 本地 node 启动；Vercel 通过 api/index.mjs 加载本文件，禁止 listen
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`AI Demo server listening on http://localhost:${PORT}`);
  });
}

export default app;
