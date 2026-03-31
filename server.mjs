import express from 'express';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Agent as UndiciAgent } from 'undici';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pwaDir = path.join(__dirname, 'pwa');
const port = process.env.PORT || 8080;
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const agentProvider = process.env.AGENT_PROVIDER || 'ces-session-bridge';
const agentHttpUrl = process.env.AGENT_HTTP_URL || '';
const agentHttpBearer = process.env.AGENT_HTTP_BEARER || '';
const agentHttpTimeoutMs = Number(process.env.AGENT_HTTP_TIMEOUT_MS || 20000);
const agentAllowInsecureTls = process.env.AGENT_ALLOW_INSECURE_TLS === 'true';
const n8nWebhookUrl = process.env.N8N_BLUE_AGENT_WEBHOOK_URL || 'https://nuketownlabs-n8n.ko2m0t.easypanel.host/webhook/blue-agent-chat';
const cesApp = process.env.CES_APP || 'projects/team-blue-agents/locations/us/apps/4c1de0e5-214f-49fb-ab6b-d98773e942e9';
const cesDeployment = process.env.CES_DEPLOYMENT || `${cesApp}/deployments/7285295e-facd-434e-a2cb-5722c29e873e`;
const cesVersion = process.env.CES_APP_VERSION || `${cesApp}/versions/737e65fa-7c1f-4be9-b1e5-abbcb58c57cf`;
const cesApiBase = process.env.CES_API_BASE || 'https://ces.googleapis.com/v1beta';
const cesSessionBridgeBase = process.env.CES_SESSION_BRIDGE_BASE || 'https://ces-session-bridge-bla4v7hs7a-uc.a.run.app';
const voiceCommerceBridgeUrl = process.env.VOICE_COMMERCE_BRIDGE_URL || 'https://voice-commerce-bridge-1003987130329.us-central1.run.app';
const CHANNEL_WAKE_SIGNAL = '__wrapper_channel_wake__';
const LOG_PREFIX = '[SmartWrapperServer]';
const execFileAsync = promisify(execFile);

const app = express();

app.use(express.json({ limit: '25mb' }));
app.use(express.static(pwaDir));

app.use((req, _res, next) => {
  console.log(`${LOG_PREFIX} ${req.method} ${req.url}`);
  next();
});

app.get('/api/health', (_req, res) => {
  console.log(`${LOG_PREFIX} health`, {
    hasGeminiKey: Boolean(apiKey),
    model,
    agentProvider,
    agentHttpUrl: agentHttpUrl || null,
    agentAllowInsecureTls,
    cesApp: agentProvider === 'ces-runsession' ? cesApp : null
  });
  res.json({
    ok: true,
    hasGeminiKey: Boolean(apiKey),
    model,
    agentProvider,
    agentHttpUrl: agentHttpUrl || null,
    agentAllowInsecureTls,
    cesApp: agentProvider === 'ces-runsession' ? cesApp : null
  });
});

async function generateAssistantReply(prompt) {
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: [
              'Responde siempre en espanol.',
              'No uses markdown.',
              'No muestres pensamiento interno.',
              'No hables en ingles salvo que el usuario lo pida.',
              'Responde en maximo dos frases cortas.',
              'Actua como un asistente de compras claro y amable.',
              `Comando del usuario: ${prompt}`
            ].join(' ')
          }
        ]
      }
    ]
  });

  return response.text?.trim() || 'No pude generar una respuesta.';
}

function parseAgentReply(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.trim() || null;

  const direct =
    data.response ||
    data.reply ||
    data.message ||
    data.text ||
    data.output ||
    data.answer ||
    data.fulfillmentText ||
    null;

  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  const dfcxText = data?.queryResult?.responseMessages
    ?.flatMap((message) => message?.text?.text || [])
    ?.filter(Boolean)
    ?.join(' ')
    ?.trim();

  if (dfcxText) return dfcxText;

  const cesText = data?.outputs
    ?.flatMap((output) => {
      if (typeof output?.text === 'string') return [output.text];
      return [];
    })
    ?.filter(Boolean)
    ?.join(' ')
    ?.trim();

  if (cesText) return cesText;

  return null;
}

function sanitizeSessionId(sessionId) {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || `wrapper${Date.now()}`;
}

function buildCesChannelPrompt(prompt, sessionId) {
  const normalizedPrompt = prompt === CHANNEL_WAKE_SIGNAL ? 'hola' : prompt;
  const safeSessionId = sanitizeSessionId(sessionId);
  const purchaseIntent = /compr(a|ar)|lo quiero|quiero ese|quiero el|quiero comprar/i.test(normalizedPrompt);

  return [
    'Contexto de canal: wrapper-pwa-voice.',
    'Este canal es de voz, con respuesta hablada.',
    'No uses emojis en este canal.',
    'No hagas saludo comercial largo.',
    'Si el usuario aun no esta autenticado, tu primera prioridad es pedir la cedula y avanzar autenticacion.',
    'No preguntes primero que quiere comprar si aun no tienes la cedula.',
    `SessionId de este canal: ${safeSessionId}.`,
    'Regla critica: si llamas cualquier tool que requiera sessionId, debes usar exactamente el SessionId de este canal.',
    'No inventes otro sessionId. No uses numeros cortos. No uses ids de otros canales.',
    purchaseIntent
      ? 'Si el mensaje del usuario expresa compra o confirmacion de compra, interpreta eso como un paso de compra concreto. Usa el producto, la tienda y el precio mencionados en el mensaje como referencia. No vuelvas a pedir al usuario que elija entre productos ya listados salvo que el mensaje sea ambiguo de verdad. Si existe una herramienta de compra, llamala con la informacion disponible y continua el flujo hasta preparar la orden o solicitar el siguiente dato indispensable.'
      : '',
    `Mensaje del usuario: ${normalizedPrompt}`
  ].join(' ');
}

function stripEmojis(text) {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeCesChannelReply(prompt, reply) {
  const cleanReply = stripEmojis(reply);

  if (prompt === CHANNEL_WAKE_SIGNAL && /c[eé]dula/i.test(cleanReply)) {
    return 'Por favor, ingresa tu cédula para iniciar sesión.';
  }

  return cleanReply;
}

async function postJson(url, body, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agentHttpTimeoutMs);
  const dispatcher = agentAllowInsecureTls
    ? new UndiciAgent({
        connect: {
          rejectUnauthorized: false
        }
      })
    : undefined;

  try {
    console.log(`${LOG_PREFIX} postJson request`, {
      url,
      hasDispatcher: Boolean(dispatcher),
      timeoutMs: agentHttpTimeoutMs
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher
    });

    const text = await response.text();
    let json = null;

    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      text,
      json
    };
  } catch (error) {
    console.error(`${LOG_PREFIX} postJson error`, {
      url,
      message: error?.message,
      cause: error?.cause?.message || error?.cause || null,
      code: error?.cause?.code || error?.code || null
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getGcloudAccessToken() {
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'], {
    timeout: agentHttpTimeoutMs
  });
  const token = stdout.trim();
  if (!token) {
    throw new Error('No fue posible obtener un access token con gcloud.');
  }
  return token;
}

async function callHttpAgent({ prompt, sessionId }) {
  if (!agentHttpUrl) {
    throw new Error('AGENT_HTTP_URL no esta configurado.');
  }

  const headers = agentHttpBearer
    ? { Authorization: `Bearer ${agentHttpBearer}` }
    : {};

  const payload = {
    prompt,
    text: prompt,
    sessionId,
    userId: sessionId,
    channel: 'wrapper-pwa-voice',
    metadata: {
      source: 'wrapper',
      locale: 'es-CO',
      timestamp: new Date().toISOString()
    }
  };

  console.log(`${LOG_PREFIX} http agent request`, {
    url: agentHttpUrl,
    sessionId
  });

  const response = await postJson(agentHttpUrl, payload, headers);
  console.log(`${LOG_PREFIX} http agent response`, {
    ok: response.ok,
    status: response.status
  });

  if (!response.ok) {
    throw new Error(`El backend del agente respondio HTTP ${response.status}.`);
  }

  const reply = parseAgentReply(response.json ?? response.text);
  if (!reply) {
    throw new Error('El backend del agente no devolvio una respuesta conversacional util.');
  }

  return reply;
}

async function callN8nWebhookAgent({ prompt, sessionId }) {
  const payload = {
    message: { text: prompt },
    userId: sessionId,
    userName: 'Wrapper Voice User',
    cedula: '',
    sessionId,
    timestamp: new Date().toISOString(),
    channel: 'wrapper-pwa-voice'
  };

  console.log(`${LOG_PREFIX} n8n agent request`, {
    url: n8nWebhookUrl,
    sessionId
  });

  const response = await postJson(n8nWebhookUrl, payload);
  console.log(`${LOG_PREFIX} n8n agent response`, {
    ok: response.ok,
    status: response.status,
    body: response.json ?? response.text
  });

  if (!response.ok) {
    throw new Error(`El webhook del agente respondio HTTP ${response.status}.`);
  }

  const reply = parseAgentReply(response.json ?? response.text);
  if (reply && reply !== 'Workflow was started') {
    return reply;
  }

  throw new Error(
    'El webhook actual del agente es asincrono y no devuelve la respuesta en el mismo request. ' +
    'Necesitamos un endpoint sincrono del agente para este canal.'
  );
}

async function callCesRunSessionAgent({ prompt, sessionId }) {
  const safeSessionId = sanitizeSessionId(sessionId);
  const session = `${cesApp}/sessions/${safeSessionId}`;
  const url = `${cesApiBase}/${session}:runSession`;
  const token = await getGcloudAccessToken();

  const payload = {
    config: {
      session,
      app_version: cesVersion,
      deployment: cesDeployment
    },
    inputs: [
      {
        text: buildCesChannelPrompt(prompt, safeSessionId)
      }
    ]
  };

  console.log(`${LOG_PREFIX} ces runSession request`, {
    url,
    session,
    deployment: cesDeployment,
    version: cesVersion
  });

  const response = await postJson(url, payload, {
    Authorization: `Bearer ${token}`
  });

  console.log(`${LOG_PREFIX} ces runSession response`, {
    ok: response.ok,
    status: response.status
  });

  if (!response.ok) {
    throw new Error(`CES respondio HTTP ${response.status}.`);
  }

  const reply = parseAgentReply(response.json ?? response.text);
  if (!reply) {
    throw new Error('CES no devolvio una respuesta conversacional util.');
  }

  return normalizeCesChannelReply(prompt, reply);
}

async function callCesSessionBridgeAgent({ prompt, sessionId }) {
  const safeSessionId = sanitizeSessionId(sessionId);
  const response = await postJson(`${cesSessionBridgeBase}/chat`, {
    prompt,
    sessionId: safeSessionId,
    clientSessionId: safeSessionId,
    message: {
      text: prompt
    },
    text: prompt
  });

  console.log(`${LOG_PREFIX} ces session bridge response`, {
    ok: response.ok,
    status: response.status
  });

  if (!response.ok) {
    throw new Error(`CES bridge respondio HTTP ${response.status}.`);
  }

  const reply = parseAgentReply(response.json ?? response.text);
  if (!reply) {
    throw new Error('CES bridge no devolvio una respuesta conversacional util.');
  }

  return normalizeCesChannelReply(prompt, reply);
}

async function callVoiceCommerceBridgePurchase(payload) {
  const response = await postJson(`${voiceCommerceBridgeUrl}/request-purchase`, payload);
  console.log(`${LOG_PREFIX} voice-commerce purchase response`, {
    ok: response.ok,
    status: response.status,
    body: response.json ?? response.text
  });

  if (!response.ok) {
    throw new Error(`El bridge de compras respondio HTTP ${response.status}.`);
  }

  return response.json ?? response.text;
}

async function generateChannelReply({ prompt, sessionId }) {
  if (agentProvider === 'ces-runsession') {
    return callCesRunSessionAgent({ prompt, sessionId });
  }

  if (agentProvider === 'http-json') {
    return callHttpAgent({ prompt, sessionId });
  }

  if (agentProvider === 'ces-session-bridge') {
    return callCesSessionBridgeAgent({ prompt, sessionId });
  }

  if (agentProvider === 'n8n-webhook') {
    return callN8nWebhookAgent({ prompt, sessionId });
  }

  if (agentProvider !== 'gemini-local') {
    throw new Error(`AGENT_PROVIDER no soportado: ${agentProvider}`);
  }

  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en el entorno local.');
  }

  return generateAssistantReply(prompt);
}

app.post('/api/chat', async (req, res) => {
  const prompt = req.body?.prompt?.trim();
  const sessionId = req.body?.sessionId?.trim() || `wrapper-${Date.now()}`;
  if (!prompt) {
    res.status(400).json({
      error: 'Falta el prompt de voz.'
    });
    return;
  }

  try {
    console.log(`${LOG_PREFIX} chat start`, {
      prompt,
      sessionId,
      agentProvider
    });
    const text = await generateChannelReply({ prompt, sessionId });
    console.log(`${LOG_PREFIX} chat success`, {
      sessionId,
      agentProvider,
      text
    });
    res.json({ response: text });
  } catch (error) {
    console.error(`${LOG_PREFIX} chat error`, error);
    res.status(500).json({
      error: error?.message || 'No se pudo generar la respuesta.'
    });
  }
});

app.post('/api/request-purchase', async (req, res) => {
  const payload = {
    ...req.body,
    sessionId: sanitizeSessionId(String(req.body?.sessionId || ''))
  };

  if (!payload.cedula || !payload.sessionId) {
    res.status(400).json({
      error: 'cedula y sessionId son obligatorios.'
    });
    return;
  }

  try {
    console.log(`${LOG_PREFIX} request-purchase proxy`, {
      cedula: payload.cedula,
      sessionId: payload.sessionId,
      productName: payload.productName || '',
      storeName: payload.storeName || '',
      productId: payload.productId || '',
      storeId: payload.storeId || ''
    });

    const result = await callVoiceCommerceBridgePurchase(payload);
    res.json(result);
  } catch (error) {
    console.error(`${LOG_PREFIX} request-purchase proxy error`, error);
    res.status(500).json({
      error: error?.message || 'No se pudo preparar la compra.'
    });
  }
});

app.get('/api/session-result', async (req, res) => {
  const sessionId = req.query?.sessionId?.toString().trim();

  if (!sessionId) {
    res.status(400).json({
      error: 'Falta sessionId.'
    });
    return;
  }

  try {
    const safeSessionId = sanitizeSessionId(sessionId);
    const dispatcher = agentAllowInsecureTls
      ? new UndiciAgent({
          connect: {
            rejectUnauthorized: false
          }
        })
      : undefined;

    const response = await fetch(`${cesSessionBridgeBase}/session-result/${safeSessionId}`, {
      dispatcher
    });
    const payload = await response.json();

    if (!response.ok) {
      res.status(response.status).json(payload);
      return;
    }

    res.json(payload);
  } catch (error) {
    console.error(`${LOG_PREFIX} session-result error`, error);
    res.status(500).json({
      error: error?.message || 'No se pudo consultar el estado de la sesion.'
    });
  }
});

app.get('/api/purchase-result', async (req, res) => {
  const sessionId = req.query?.sessionId?.toString().trim();

  if (!sessionId) {
    res.status(400).json({
      error: 'Falta sessionId.'
    });
    return;
  }

  try {
    const safeSessionId = sanitizeSessionId(sessionId);
    const dispatcher = agentAllowInsecureTls
      ? new UndiciAgent({
          connect: {
            rejectUnauthorized: false
          }
        })
      : undefined;

    const response = await fetch(`${voiceCommerceBridgeUrl}/purchase-result/${safeSessionId}`, {
      dispatcher
    });
    const payload = await response.json();

    if (!response.ok) {
      res.status(response.status).json(payload);
      return;
    }

    res.json(payload);
  } catch (error) {
    console.error(`${LOG_PREFIX} purchase-result error`, error);
    res.status(500).json({
      error: error?.message || 'No se pudo consultar el estado de compra.'
    });
  }
});

app.post('/api/voice-chat', async (req, res) => {
  if (!apiKey) {
    console.error(`${LOG_PREFIX} voice-chat failed: missing GEMINI_API_KEY`);
    res.status(500).json({
      error: 'Falta GEMINI_API_KEY en el entorno local.'
    });
    return;
  }

  const audioBase64 = req.body?.audioBase64;
  const mimeType = req.body?.mimeType || 'audio/webm';

  if (!audioBase64) {
    res.status(400).json({
      error: 'Falta el audio de entrada.'
    });
    return;
  }

  try {
    console.log(`${LOG_PREFIX} voice-chat start`, {
      mimeType,
      bytes: audioBase64.length
    });

    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Escucha este audio y responde siempre en espanol.',
                'Primero transcribe lo que dijo el usuario.',
                'Luego responde como un asistente de compras claro y amable.',
                'No uses markdown.',
                'No hables en ingles salvo que el usuario lo pida.',
                'No muestres pensamiento interno.',
                'La respuesta debe ser breve, maxima dos frases.'
              ].join(' ')
            },
            {
              inlineData: {
                mimeType,
                data: audioBase64
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            transcript: { type: 'STRING' },
            response: { type: 'STRING' }
          },
          required: ['transcript', 'response']
        }
      }
    });

    const rawText = response.text?.trim() || '{}';
    console.log(`${LOG_PREFIX} voice-chat raw`, { rawText });
    const parsed = JSON.parse(rawText);

    res.json({
      transcript: parsed.transcript || '',
      response: parsed.response || 'No pude generar una respuesta.'
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} voice-chat error`, error);
    res.status(500).json({
      error: error?.message || 'No se pudo procesar el audio.'
    });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(pwaDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`${LOG_PREFIX} listening`, {
    url: `http://localhost:${port}`,
    hasGeminiKey: Boolean(apiKey),
    model,
    agentProvider,
    agentHttpUrl: agentHttpUrl || null,
    agentAllowInsecureTls,
    cesApp: agentProvider === 'ces-runsession' ? cesApp : null,
    cesDeployment: agentProvider === 'ces-runsession' ? cesDeployment : null,
    cesSessionBridgeBase,
    n8nWebhookUrl: agentProvider === 'n8n-webhook' ? n8nWebhookUrl : null
  });
});
