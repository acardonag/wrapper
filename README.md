# Smart Wrapper Demo

Demo 100% PWA, instalada desde el navegador y pensada como canal de voz. Esta version mantiene la interfaz simple de `Hablar`, conserva la sesion local del usuario y ahora deja el backend desacoplado para poder apuntarlo a un agente real sin meter logica bancaria en el canal.

## Estructura

- `pwa/`: interfaz de voz instalada como PWA.
- `server.mjs`: backend local del canal.
- `package.json`: dependencias del servidor local.

## Modo actual del canal

La PWA hace tres cosas:

- escucha con palabra clave `BBVA Compras`;
- envia el texto al backend local junto con un `sessionId` persistente;
- reproduce la respuesta recibida.

El backend local no debe ejecutar autenticacion ni push. Su responsabilidad es solo enrutar el turno conversacional a un backend de agente.

## Backends soportados

El servidor local soporta estos proveedores mediante variables de entorno:

- `AGENT_PROVIDER=gemini-local`
  Usa Gemini local como fallback simple. Es el modo por defecto y el mas seguro para no romper la demo.

- `AGENT_PROVIDER=http-json`
  Hace `POST` a `AGENT_HTTP_URL` con un payload JSON simple del turno conversacional.

- `AGENT_PROVIDER=n8n-webhook`
  Hace `POST` al webhook actual del ecosistema. Hoy ese webhook es asincrono y no devuelve la respuesta del agente en el mismo request, asi que este modo sirve para diagnostico, no para una conversacion usable.

## Payload esperado para `http-json`

El canal envia este contrato:

```json
{
  "prompt": "quiero pedir mi almuerzo habitual",
  "text": "quiero pedir mi almuerzo habitual",
  "sessionId": "smart-wrapper-...",
  "userId": "smart-wrapper-...",
  "channel": "wrapper-pwa-voice",
  "metadata": {
    "source": "wrapper",
    "locale": "es-CO",
    "timestamp": "2026-03-22T..."
  }
}
```

El backend del agente puede responder con cualquiera de estos campos:

- `response`
- `reply`
- `message`
- `text`
- `output`
- `answer`

## Como correr la demo

Desde `wrapper`:

```bash
cd /Users/C810865/Documents/W/CODEX_BLUE_AGENTS/wrapper
npm install
PORT=8092 GEMINI_API_KEY="tu_api_key" npm start
```

Luego abre:

- `http://localhost:8092`

## Repos separados

Este proyecto ya vive en un repo distinto de la BBVA demo.

- Wrapper: `https://github.com/acardonag/wrapper`
- BBVA demo: `https://github.com/acardonag/blue-agents-demo`

## Comandos para Cloud Shell

Si vas a trabajar desde Cloud Shell, baja cada proyecto por separado:

```bash
git clone https://github.com/acardonag/wrapper.git
git clone https://github.com/acardonag/blue-agents-demo.git
```

Para levantar el wrapper localmente:

```bash
cd wrapper
npm install
PORT=8095 AGENT_PROVIDER=ces-session-bridge CES_SESSION_BRIDGE_BASE=https://ces-session-bridge-1003987130329.us-central1.run.app AGENT_ALLOW_INSECURE_TLS=true npm start
```

Para desplegar la BBVA demo en Firebase Hosting:

```bash
cd blue-agents-demo
npx --yes firebase-tools deploy --only hosting --project team-blue-agents
```

Para desplegar los bridges de GCP desde el directorio local correspondiente:

```bash
gcloud run deploy ces-session-bridge \
  --source /Users/C810865/Documents/W/CODEX_BLUE_AGENTS/gcp/ces-session-bridge \
  --region us-central1 \
  --allow-unauthenticated \
  --project team-blue-agents
```

```bash
gcloud run deploy voice-commerce-bridge \
  --source /Users/C810865/Documents/W/CODEX_BLUE_AGENTS/gcp/voice-commerce-bridge \
  --region us-central1 \
  --allow-unauthenticated \
  --project team-blue-agents
```

## Ejemplos de configuracion

Fallback local:

```bash
PORT=8092 \
GEMINI_API_KEY="tu_api_key" \
AGENT_PROVIDER=gemini-local \
npm start
```

Backend HTTP de agente:

```bash
PORT=8092 \
AGENT_PROVIDER=http-json \
AGENT_HTTP_URL="https://tu-endpoint-del-agente" \
AGENT_HTTP_BEARER="token-opcional" \
npm start
```

Webhook actual del ecosistema:

```bash
PORT=8092 \
AGENT_PROVIDER=n8n-webhook \
AGENT_ALLOW_INSECURE_TLS=true \
N8N_BLUE_AGENT_WEBHOOK_URL="https://nuketownlabs-n8n.ko2m0t.easypanel.host/webhook/blue-agent-chat" \
npm start
```

## Rollback local

Snapshot local ya creado en:

- `/Users/C810865/Documents/W/CODEX_BLUE_AGENTS/backups/wrapper-pre-gcp-agent`

Para restaurarlo:

```bash
rm -rf /Users/C810865/Documents/W/CODEX_BLUE_AGENTS/wrapper
cp -R /Users/C810865/Documents/W/CODEX_BLUE_AGENTS/backups/wrapper-pre-gcp-agent /Users/C810865/Documents/W/CODEX_BLUE_AGENTS/wrapper
```

## Rollback operativo de GCP

Tambien deje una fotografia local del estado actual de Cloud Run en:

- `/Users/C810865/Documents/W/CODEX_BLUE_AGENTS/backups/gcp-pre-agent-integration/cloud-run`

Incluye:

- `*.service.json`: definicion del servicio;
- `*.revisions.json`: revisiones disponibles antes de la integracion.

Servicios capturados:

- `validar-cedula-push`
- `merchant-discovery-orchestrator`
- `motorescalamiento`
- `procesarlogether`

Si mas adelante decides mover trafico o desplegar un nuevo adaptador en Cloud Run, estas capturas permiten volver a la revision previa con `gcloud run services update-traffic` sin depender de memoria manual.

## Estado real de la integracion

Hoy el canal ya esta preparado para enrutar a un agente externo, pero el webhook actual `blue-agent-chat` no devuelve la respuesta conversacional en el mismo request. Para una UX de voz natural, el siguiente paso es exponer un endpoint sincrono del agente real y apuntar `AGENT_HTTP_URL` a ese entrypoint.
