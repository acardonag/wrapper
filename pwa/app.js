const DEBUG_PREFIX = '[SmartWrapper]';
const RecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
const WRAPPER_API_BASE =
  window.localStorage.getItem('smart_wrapper_api_base') ||
  window.SMART_WRAPPER_API_BASE ||
  'https://wrapper-channel-1003987130329.us-central1.run.app';
let clientSessionId = window.localStorage.getItem('smart_wrapper_session_id') || `smart-wrapper-${crypto.randomUUID()}`;

window.localStorage.setItem('smart_wrapper_session_id', clientSessionId);

let recognition = null;
let microphoneReady = false;
let isListening = false;
let isProcessing = false;
let lastHandledTranscript = '';
let restartTimer = null;
let recognitionRunning = false;
let inConversation = false;
let conversationTimer = null;
let speechInProgress = false;
let sessionResultPoller = null;
let sessionResultAttempts = 0;
let lastSessionResultText = '';
let sessionResultMode = '';
let preferredVoice = null;
let lastProductResults = [];
let lastAuthenticatedCedula = window.localStorage.getItem('smart_wrapper_authenticated_cedula') || '';
let pendingPurchaseRequestKey = '';
let purchaseRequestInFlight = false;

const WAKE_PHRASE = 'bbva compras';
const CONVERSATION_WINDOW_MS = 45000;
const CHANNEL_WAKE_SIGNAL = '__wrapper_channel_wake__';
const SESSION_RESULT_POLL_MS = 2500;
const SESSION_RESULT_MAX_ATTEMPTS = 24;

const speakButton = document.getElementById('speak-button');
const speakButtonWrap = document.getElementById('speak-button-wrap');
const statusText = document.getElementById('status-text');
const transcriptText = document.getElementById('transcript-text');
const responseText = document.getElementById('response-text');
const installBanner = document.getElementById('install-banner');
const installButton = document.getElementById('install-button');
const installDismiss = document.getElementById('install-dismiss');

let deferredInstallPrompt = null;

function debugLog(step, payload) {
  if (payload === undefined) {
    console.log(`${DEBUG_PREFIX} ${step}`);
    return;
  }
  console.log(`${DEBUG_PREFIX} ${step}`, payload);
}

function debugError(step, error) {
  console.error(`${DEBUG_PREFIX} ${step}`, error);
}

function setStatus(text) {
  statusText.textContent = text;
}

function setButtonLabel(text) {
  speakButton.textContent = text;
}

function setSpeakingVisualState(active) {
  speakButtonWrap?.classList.toggle('speaking', active);
}

function setTranscript(text) {
  transcriptText.textContent = text || 'Di "BBVA Compras" y luego tu comando.';
}

function setResponse(text) {
  responseText.textContent = text || 'Aqui aparecera la respuesta del asistente.';
}

function showInstallBanner() {
  if (installBanner) {
    installBanner.hidden = false;
  }
}

function hideInstallBanner() {
  if (installBanner) {
    installBanner.hidden = true;
  }
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  showInstallBanner();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  hideInstallBanner();
  debugLog('app installed');
});

installButton?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    debugLog('install prompt missing');
    return;
  }

  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
  debugLog('install prompt choice', choice);
  deferredInstallPrompt = null;
  hideInstallBanner();
});

installDismiss?.addEventListener('click', () => {
  deferredInstallPrompt = null;
  hideInstallBanner();
});

function createClientSessionId() {
  return `smart-wrapper-${crypto.randomUUID()}`;
}

function rotateClientSessionId(reason) {
  stopSessionResultPolling('session-rotated');
  clientSessionId = createClientSessionId();
  window.localStorage.setItem('smart_wrapper_session_id', clientSessionId);
  lastProductResults = [];
  lastAuthenticatedCedula = '';
  pendingPurchaseRequestKey = '';
  purchaseRequestInFlight = false;
  window.localStorage.removeItem('smart_wrapper_authenticated_cedula');
  debugLog('client session rotated', { reason, clientSessionId });
}

function isFollowUpReply(text) {
  return /autenticaci[oó]n en proceso|solicitud de pago|apru[eé]bala|revisa la direccion de envio|esperando confirmaci[oó]n|te envi[eé] una solicitud de pago/i.test(text || '');
}

function hasPendingProductSelection() {
  return Array.isArray(lastProductResults) && lastProductResults.length > 0;
}

function isPurchaseSelectionCommand(command) {
  const normalized = normalizeTranscript(command);
  return (
    /\b(si|sí)\b.*\b(comprar|comprarla|comprarlo|quiero|me la llevo|me lo llevo)\b/i.test(normalized)
    || /\b(quiero|me llevo|la compro|lo compro|comprarla|comprarlo)\b/i.test(normalized)
    || /\b(esa|ese|esa misma|ese mismo|la primera|el primero|primer[oa]|primero|primera)\b/i.test(normalized)
  );
}

function getSessionResultMode(text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return '';

  if (
    normalized.includes('solicitud de pago')
    || normalized.includes('revisa la direccion de envio')
    || normalized.includes('esperando confirmacion')
    || normalized.includes('tu pedido')
    || normalized.includes('pago')
  ) {
    return 'payment';
  }

  if (
    normalized.includes('autenticacion en proceso')
    || normalized.includes('autenticacion aprobada')
    || normalized.includes('ya estas autenticada')
    || normalized.includes('ya estas autenticado')
    || normalized.includes('iniciar sesion')
  ) {
    return 'auth';
  }

  return '';
}

function isPaymentRequestedText(text) {
  const normalized = normalizeTranscript(text);
  return /solicitud de pago|revisa la confirmacion|apruebala para finalizar tu pedido|pedido/i.test(normalized);
}

function stopSessionResultPolling(reason) {
  if (sessionResultPoller) {
    window.clearInterval(sessionResultPoller);
    sessionResultPoller = null;
  }
  sessionResultAttempts = 0;
  sessionResultMode = '';
  debugLog('session result polling stopped', { reason });
}

function clearConversationTimer() {
  if (conversationTimer) {
    window.clearTimeout(conversationTimer);
    conversationTimer = null;
  }
}

function openConversationWindow() {
  inConversation = true;
  clearConversationTimer();
  conversationTimer = window.setTimeout(() => {
    inConversation = false;
    setStatus('Sesión cerrada. Di "BBVA Compras" para volver a activarme.');
    debugLog('conversation window expired');
  }, CONVERSATION_WINDOW_MS);
  debugLog('conversation window opened', { ms: CONVERSATION_WINDOW_MS });
}

function setUiState() {
  speakButton.disabled = isProcessing;
  setSpeakingVisualState(speechInProgress);

  if (isProcessing) {
    setButtonLabel('Pensando...');
    setStatus('Procesando tu solicitud...');
    return;
  }

  if (isListening) {
    setButtonLabel('Escuchando');
    setStatus('Escuchando. Di "BBVA Compras" y luego tu comando.');
    return;
  }

  setButtonLabel('Hablar');
  setStatus('Pulsa "Hablar" para activar la escucha.');
}

function normalizeTextForSpeech(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/([.!?])(?=[A-ZÁÉÍÓÚÑ])/g, '$1 ')
    .replace(/Precio:/g, ' Precio:')
    .replace(/Producto:/g, ' Producto:')
    .replace(/Tienda:/g, ' Tienda:')
    .replace(/\. Tienda:/g, '.  Tienda:')
    .trim();
}

function getVoiceRank(voice) {
  const name = (voice.name || '').toLowerCase();
  const lang = (voice.lang || '').toLowerCase();

  if (lang.startsWith('es-co') && name.includes('google')) return 110;
  if (lang.startsWith('es-mx') && name.includes('google')) return 108;
  if (lang.startsWith('es-us') && name.includes('google')) return 106;
  if (lang.startsWith('es-419') && name.includes('google')) return 105;
  if (lang.startsWith('es-ar') && name.includes('google')) return 104;
  if (lang.startsWith('es-cl') && name.includes('google')) return 103;
  if (lang.startsWith('es-mx')) return 100;
  if (lang.startsWith('es-co')) return 99;
  if (lang.startsWith('es-us')) return 98;
  if (lang.startsWith('es-419')) return 97;
  if (name.includes('monica')) return 96;
  if (name.includes('paulina')) return 95;
  if (name.includes('sabina')) return 94;
  if (name.includes('helena')) return 93;
  if (name.includes('jorge')) return 92;
  if (lang.startsWith('es-es') && name.includes('google')) return 90;
  if (lang.startsWith('es-')) return 85;
  if (name.includes('monica')) return 78;
  if (name.includes('paulina')) return 76;
  if (name.includes('jorge')) return 74;
  return 0;
}

function selectPreferredVoice() {
  if (!('speechSynthesis' in window)) return null;

  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  preferredVoice = [...voices]
    .sort((a, b) => getVoiceRank(b) - getVoiceRank(a))[0] || null;

  debugLog('speech voice selected', preferredVoice
    ? {
        name: preferredVoice.name,
        lang: preferredVoice.lang,
        localService: preferredVoice.localService
      }
    : { found: false });

  return preferredVoice;
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) {
    debugLog('speech skipped', {
      hasSpeechSynthesis: 'speechSynthesis' in window,
      hasText: Boolean(text)
    });
    return;
  }

  const speechText = normalizeTextForSpeech(text);
  const voice = preferredVoice || selectPreferredVoice();

  debugLog('speech start', { text: speechText });
  speechInProgress = true;
  setSpeakingVisualState(true);
  if (recognition && isListening) {
    try {
      debugLog('recognition stop for speech');
      recognition.stop();
    } catch (error) {
      debugError('recognition stop for speech failed', error);
    }
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(speechText);
  utterance.lang = voice?.lang || 'es-CO';
  utterance.voice = voice || null;
  utterance.rate = 1.15;
  utterance.pitch = 1;
  utterance.onstart = () => debugLog('speech onstart');
  utterance.onend = () => {
    debugLog('speech onend');
    speechInProgress = false;
    setSpeakingVisualState(false);
    if (isListening && !isProcessing) {
      scheduleRestart();
    }
  };
  utterance.onerror = (event) => {
    debugError('speech onerror', event);
    speechInProgress = false;
    setSpeakingVisualState(false);
    if (isListening && !isProcessing) {
      scheduleRestart();
    }
  };
  window.speechSynthesis.speak(utterance);
}

async function ensureMicrophoneAccess() {
  if (microphoneReady) {
    debugLog('microphone already authorized');
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador no soporta acceso al microfono.');
  }

  debugLog('microphone permission request');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const tracks = stream.getAudioTracks();
  debugLog('microphone permission granted', {
    tracks: tracks.map((track) => ({
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState
    }))
  });

  microphoneReady = tracks.length > 0;
  tracks.forEach((track) => track.stop());
}

async function sendVoiceCommand(prompt) {
  debugLog('chat request', { prompt, clientSessionId });
  const response = await fetch(`${WRAPPER_API_BASE}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt, sessionId: clientSessionId })
  });

  debugLog('chat response meta', {
    ok: response.ok,
    status: response.status
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    debugError('chat request failed', error);
    throw new Error(error.error || 'No se pudo obtener respuesta del asistente.');
  }

  const payload = await response.json();
  debugLog('chat response payload', payload);
  return payload.response;
}

async function fetchSessionResult() {
  const response = await fetch(`${WRAPPER_API_BASE}/api/session-result?sessionId=${encodeURIComponent(clientSessionId)}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'No se pudo consultar el resultado de la sesión.');
  }

  return response.json();
}

async function fetchPurchaseResult() {
  const response = await fetch(`${WRAPPER_API_BASE}/api/purchase-result?sessionId=${encodeURIComponent(clientSessionId)}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'No se pudo consultar el resultado de la compra.');
  }

  return response.json();
}

async function requestPurchaseFromBridge({ cedula, selection }) {
  const purchaseKey = [
    clientSessionId,
    cedula || '',
    selection?.product || '',
    selection?.store || '',
    selection?.price || ''
  ].join('|');

  if (purchaseRequestInFlight && pendingPurchaseRequestKey === purchaseKey) {
    debugLog('request purchase skipped by lock', {
      clientSessionId,
      cedula,
      product: selection?.product || '',
      store: selection?.store || ''
    });
    return {
      resultado: 'Solicitud de compra ya en curso.'
    };
  }

  pendingPurchaseRequestKey = purchaseKey;
  purchaseRequestInFlight = true;
  const payload = {
    cedula,
    sessionId: clientSessionId,
    productName: selection?.product || '',
    storeName: selection?.store || '',
    amount: selection?.price || '',
    imageUrl: selection?.imageUrl || ''
  };

  debugLog('request purchase proxy', payload);
  const response = await fetch(`${WRAPPER_API_BASE}/api/request-purchase`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  debugLog('request purchase proxy meta', {
    ok: response.ok,
    status: response.status
  });

  if (!response.ok) {
    pendingPurchaseRequestKey = '';
    purchaseRequestInFlight = false;
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || error.resultado || 'No se pudo preparar la compra.');
  }

  const result = await response.json();
  return result;
}

function maybeStartSessionResultPolling(triggerText) {
  if (!isFollowUpReply(triggerText)) {
    stopSessionResultPolling('reply-does-not-require-follow-up');
    return;
  }

  stopSessionResultPolling('restart-polling');
  lastSessionResultText = triggerText;
  sessionResultMode = getSessionResultMode(triggerText);
  sessionResultAttempts = 0;

  sessionResultPoller = window.setInterval(async () => {
    sessionResultAttempts += 1;
    debugLog('session result polling tick', {
      sessionId: clientSessionId,
      attempt: sessionResultAttempts
    });

    if (sessionResultAttempts > SESSION_RESULT_MAX_ATTEMPTS) {
      stopSessionResultPolling('max-attempts-reached');
      return;
    }

    try {
      const payload = await fetchSessionResult();
      debugLog('session result payload', payload);

      const sessionResult = payload?.result || {};
      if (sessionResultMode !== 'payment' && sessionResult.status === 'APROBADO' && sessionResult.cedula) {
        lastAuthenticatedCedula = String(sessionResult.cedula);
        window.localStorage.setItem('smart_wrapper_authenticated_cedula', lastAuthenticatedCedula);
        debugLog('authenticated cedula stored', {
          cedula: lastAuthenticatedCedula,
          userName: sessionResult.userName || ''
        });
      }

      const resultText = payload?.result?.text?.trim();
      if (!resultText || resultText === lastSessionResultText || isFollowUpReply(resultText)) {
        return;
      }

      const resultMode = getSessionResultMode(resultText);
      if (sessionResultMode === 'payment' && resultMode === 'auth') {
        debugLog('session result ignored because payment mode should not consume auth replies', {
          sessionId: clientSessionId,
          expectedMode: sessionResultMode,
          receivedMode: resultMode,
          resultText
        });
        return;
      }
      if (sessionResultMode && resultMode && resultMode !== sessionResultMode) {
        debugLog('session result ignored by mode', {
          sessionId: clientSessionId,
          expectedMode: sessionResultMode,
          receivedMode: resultMode,
          resultText
        });
        return;
      }

      lastSessionResultText = resultText;
      lastProductResults = parseProductResults(resultText);
      stopSessionResultPolling('fresh-follow-up-received');
      setResponse(resultText);
      speak(resultText);
    } catch (error) {
      debugError('session result polling failed', error);
    }
  }, SESSION_RESULT_POLL_MS);

  debugLog('session result polling started', {
    sessionId: clientSessionId,
    intervalMs: SESSION_RESULT_POLL_MS,
    mode: sessionResultMode
  });
}

function maybeStartPurchaseResultPolling(triggerText) {
  if (!triggerText || !isPaymentRequestedText(triggerText)) {
    return;
  }

  stopSessionResultPolling('restart-polling');
  lastSessionResultText = triggerText;
  sessionResultMode = 'payment';
  sessionResultAttempts = 0;

  sessionResultPoller = window.setInterval(async () => {
    sessionResultAttempts += 1;
    debugLog('purchase result polling tick', {
      sessionId: clientSessionId,
      attempt: sessionResultAttempts
    });

    if (sessionResultAttempts > SESSION_RESULT_MAX_ATTEMPTS) {
      stopSessionResultPolling('max-attempts-reached');
      return;
    }

    try {
      const payload = await fetchPurchaseResult();
      debugLog('purchase result payload', payload);

      const resultText = payload?.result?.text?.trim();
      const resultStatus = String(payload?.result?.status || '').toUpperCase();
      if (resultStatus === 'APROBADO' && payload?.result?.orderId) {
        lastSessionResultText = resultText || lastSessionResultText;
        purchaseRequestInFlight = false;
        pendingPurchaseRequestKey = '';
        stopSessionResultPolling('fresh-purchase-result-approved');
        setResponse(resultText || 'Pago aprobado. La compra quedó confirmada y seguirá el proceso.');
        speak(resultText || 'Pago aprobado. La compra quedó confirmada y seguirá el proceso.');
        return;
      }

      if (!resultText || resultText === lastSessionResultText) {
        return;
      }

      const resultMode = getSessionResultMode(resultText);
      if (resultMode && resultMode !== 'payment') {
        debugLog('purchase result ignored by mode', {
          sessionId: clientSessionId,
          expectedMode: 'payment',
          receivedMode: resultMode,
          resultText
        });
        return;
      }

      lastSessionResultText = resultText;
      stopSessionResultPolling('fresh-purchase-result-received');
      purchaseRequestInFlight = false;
      pendingPurchaseRequestKey = '';
      setResponse(resultText);
      speak(resultText);
    } catch (error) {
      debugError('purchase result polling failed', error);
    }
  }, SESSION_RESULT_POLL_MS);

  debugLog('purchase result polling started', {
    sessionId: clientSessionId,
    intervalMs: SESSION_RESULT_POLL_MS,
    mode: sessionResultMode
  });
}

function normalizeTranscript(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isCedulaTurn() {
  const response = normalizeTranscript(responseText.textContent || '');
  return /c[eé]dula|ingresa tu cedula|validar tu cedula|numero de cedula|tu cedula/i.test(response);
}

function normalizeCedulaTranscript(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits;
}

function parseProductResults(text) {
  const results = [];
  const lines = String(text || '').split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !/^Tienda:\s*/i.test(line)) continue;

    const storeMatch = line.match(/^Tienda:\s*(.+?)\.\s*Producto:/i);
    const productMatch = line.match(/Producto:\s*(.+?)\.\s*Precio:/i);
    const priceMatch = line.match(/Precio:\s*(.+?)(?:\.\s*|$)/i);

    const store = storeMatch?.[1]?.trim() || '';
    const product = productMatch?.[1]?.trim() || '';
    const price = priceMatch?.[1]?.trim() || '';

    if (store && product) {
      results.push({ store, product, price, raw: line });
    }
  }

  return results;
}

function resolveOrdinalSelection(command) {
  if (!lastProductResults.length) return null;

  const normalized = normalizeTranscript(command);
  const ordinalIndex = (
    /\bprimer[oa]?\b/.test(normalized) || /\bprimero\b/.test(normalized)
      ? 0
      : /\bsegundo[oa]?\b/.test(normalized) || /\bsegundo\b/.test(normalized)
        ? 1
        : /\btercer[oa]?\b/.test(normalized) || /\btercero\b/.test(normalized)
          ? 2
          : -1
  );

  if (ordinalIndex < 0 || ordinalIndex >= lastProductResults.length) return null;

  const selected = lastProductResults[ordinalIndex];
  return {
    original: command,
    mapped: `quiero comprar ${selected.product}`,
    selected
  };
}

function resolveConfirmationSelection(command) {
  if (!lastProductResults.length) return null;

  const normalized = normalizeTranscript(command);
  if (!isPurchaseSelectionCommand(normalized)) return null;

  const selected = lastProductResults[0];
  return {
    original: command,
    mapped: `quiero comprar ${selected.product}`,
    selected,
    assumed: lastProductResults.length > 1
  };
}

function buildPurchasePrompt(command, selection) {
  if (!selection) return command;

  const parts = [
    `quiero comprar ${selection.product}`,
    `tienda: ${selection.store}`,
    selection.price ? `precio: ${selection.price}` : ''
  ].filter(Boolean);

  return parts.join('. ');
}

function extractCommand(text) {
  const normalized = normalizeTranscript(text);
  const index = normalized.indexOf(WAKE_PHRASE);
  const cedulaTurn = isCedulaTurn();

  debugLog('extract command inspection', {
    heard: text,
    normalized,
    cedulaTurn,
    wakeIndex: index,
    inConversation
  });

  if (cedulaTurn) {
    const cedulaDigits = normalizeCedulaTranscript(text);
    if (cedulaDigits) {
      debugLog('cedula normalized', {
        original: text,
        cedulaDigits
      });
      return {
        heard: text.trim(),
        command: cedulaDigits
      };
    }
  }

  if (index === -1) {
    if (hasPendingProductSelection() && isPurchaseSelectionCommand(normalized)) {
      debugLog('purchase follow-up extracted without wake phrase', {
        command: normalized,
        results: lastProductResults.length
      });
      return {
        heard: text.trim(),
        command: normalized
      };
    }
    if (!inConversation) return null;
    return {
      heard: text.trim(),
      command: normalized
    };
  }

  const command = normalized.slice(index + WAKE_PHRASE.length).trim();
  debugLog('wake command extracted', { command });
  return {
    heard: text.trim(),
    command
  };
}

function clearRestartTimer() {
  if (restartTimer) {
    window.clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestart() {
  clearRestartTimer();
  if (!isListening || isProcessing || speechInProgress || !recognition || document.hidden) return;
  if (recognitionRunning) return;

  restartTimer = window.setTimeout(() => {
    try {
      if (!isListening || isProcessing || speechInProgress || !recognition || document.hidden || recognitionRunning) return;
      debugLog('recognition restart');
      recognition.start();
    } catch (error) {
      if (error?.name === 'InvalidStateError') return;
      debugError('recognition restart failed', error);
    }
  }, 850);
}

function ensureRecognition() {
  if (!RecognitionClass) {
    throw new Error('Este navegador no soporta reconocimiento de voz.');
  }

  if (recognition) return recognition;

  debugLog('speech recognition create');
  recognition = new RecognitionClass();
  recognition.lang = 'es-CO';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    debugLog('recognition onstart');
    recognitionRunning = true;
    setUiState();
  };

  recognition.onresult = async (event) => {
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const chunk = event.results[i][0]?.transcript?.trim() || '';
      if (event.results[i].isFinal) {
        finalTranscript += ` ${chunk}`;
      } else {
        interimTranscript += ` ${chunk}`;
      }
    }

    const combined = `${finalTranscript} ${interimTranscript}`.trim();
    if (!combined) return;

    debugLog('recognition transcript', {
      finalTranscript: finalTranscript.trim(),
      interimTranscript: interimTranscript.trim(),
      combined
    });

    setTranscript(combined);

    if (!finalTranscript.trim() || isProcessing) return;

    const extracted = extractCommand(finalTranscript);
    if (!extracted) {
      setStatus(inConversation
        ? 'Te escucho. Di tu siguiente comando.'
        : 'Esperando la palabra clave "BBVA Compras"...');
      return;
    }

    if (extracted.heard === lastHandledTranscript) {
      debugLog('recognition duplicate ignored', extracted);
      return;
    }

    lastHandledTranscript = extracted.heard;
    isProcessing = true;
    setUiState();

    try {
      openConversationWindow();
      if (!extracted.command) {
        const reply = await sendVoiceCommand(CHANNEL_WAKE_SIGNAL);
        lastProductResults = parseProductResults(reply);
        setResponse(reply);
        maybeStartSessionResultPolling(reply);
        speak(reply);
        return;
      }

      const ordinalSelection = resolveOrdinalSelection(extracted.command);
      const confirmationSelection = ordinalSelection ? null : resolveConfirmationSelection(extracted.command);
      const selectedChoice = ordinalSelection || confirmationSelection;
      const commandToSend = selectedChoice
        ? buildPurchasePrompt(extracted.command, selectedChoice.selected)
        : extracted.command;
      const reply = await sendVoiceCommand(commandToSend);
      lastProductResults = parseProductResults(reply) || lastProductResults;
      setResponse(reply);
      if (selectedChoice && lastAuthenticatedCedula) {
        debugLog('purchase selection resolved', {
          clientSessionId,
          assumed: Boolean(confirmationSelection?.assumed),
          product: selectedChoice.selected?.product || '',
          store: selectedChoice.selected?.store || ''
        });
        try {
          const purchaseResult = await requestPurchaseFromBridge({
            cedula: lastAuthenticatedCedula,
            selection: selectedChoice.selected
          });
          const purchaseText = purchaseResult?.resultado || purchaseResult?.response || purchaseResult?.reply || '';
          if (purchaseText) {
            maybeStartPurchaseResultPolling(purchaseText);
          }
        } catch (error) {
          debugError('request purchase failed', error);
        }
      } else {
        maybeStartSessionResultPolling(reply);
      }
      speak(reply);
    } catch (error) {
      debugError('chat pipeline failed', error);
      setResponse('Hubo un problema generando la respuesta.');
      setStatus(error.message);
    } finally {
      isProcessing = false;
      setUiState();
    }
  };

  recognition.onerror = (event) => {
    debugError('recognition onerror', event);

    if (event.error === 'no-speech') {
      setStatus(inConversation
        ? 'Te escucho. Di tu siguiente comando.'
        : 'Escuchando. Di "BBVA Compras" seguido de tu comando.');
      return;
    }

    if (event.error === 'not-allowed') {
      isListening = false;
      setUiState();
      setStatus('El navegador no tiene permiso para usar el microfono.');
      return;
    }

    setStatus(`Error de voz: ${event.error}`);
  };

  recognition.onend = () => {
    recognitionRunning = false;
    debugLog('recognition onend', {
      isListening,
      isProcessing,
      hidden: document.hidden,
      speechInProgress
    });
    scheduleRestart();
  };

  return recognition;
}

async function toggleListening() {
  debugLog('speak button clicked', {
    hasRecognition: Boolean(RecognitionClass),
    isListening,
    isProcessing
  });

  if (isProcessing) return;

  try {
    await ensureMicrophoneAccess();
    const instance = ensureRecognition();

    if (isListening) {
      isListening = false;
      clearRestartTimer();
      clearConversationTimer();
      stopSessionResultPolling('manual-stop');
      inConversation = false;
      speechInProgress = false;
      window.speechSynthesis.cancel();
      instance.stop();
      setUiState();
      setStatus('Escucha desactivada.');
      return;
    }

    lastHandledTranscript = '';
    isListening = true;
    inConversation = false;
    lastProductResults = [];
    rotateClientSessionId('manual-listen-start');
    setTranscript('');
    setResponse('');
    setUiState();
    instance.start();
  } catch (error) {
    debugError('toggle listening failed', error);
    isListening = false;
    setUiState();
    setStatus(error.message);
  }
}

document.addEventListener('visibilitychange', () => {
  debugLog('visibilitychange', { hidden: document.hidden, isListening });

  if (document.hidden) {
    clearRestartTimer();
    window.speechSynthesis.cancel();
    speechInProgress = false;
    return;
  }

  if (isListening && !isProcessing) {
    scheduleRestart();
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  debugLog('beforeinstallprompt fired');
  event.preventDefault();
});

window.addEventListener('appinstalled', () => {
  debugLog('appinstalled fired');
});

window.addEventListener('DOMContentLoaded', () => {
  debugLog('DOMContentLoaded', {
    hasRecognition: Boolean(RecognitionClass),
    standalone: window.matchMedia('(display-mode: standalone)').matches
  });

  speakButton.addEventListener('click', toggleListening);
  setUiState();
  setTranscript('');
  setResponse('');

  if ('speechSynthesis' in window) {
    selectPreferredVoice();
    window.speechSynthesis.onvoiceschanged = () => {
      selectPreferredVoice();
    };
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        debugLog('service worker registered', { scope: registration.scope });
      })
      .catch((error) => {
        debugError('service worker registration failed', error);
      });
  }
});
