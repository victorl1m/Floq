// WhatsApp is built into Floq (Settings > Integrations). The id, scope, setting keys and secret names are those of the former catalog plugin
// "waha" (floq-plugin-waha 3.x), so an install that used the plugin keeps its data, settings and credentials in place.
export const manifest = {
  "id": "waha",
  "name": "WhatsApp",
  "version": "4.0.0",
  "apiVersion": 1,
  "tier": "core",
  "description": "WhatsApp in Floq: several accounts side by side, chats, media, voice notes, reactions, groups and login by QR, on the WhatsApp server that runs beside Floq or on your own WAHA. The AI can read it and message you freely on your own number; messages to other people need your approval.",
  "icon": "IconBrandWhatsapp",
  "scope": "install",
  "access": "owner",
  "secrets": [
    {
      "name": "WAHA_API_KEY",
      "description": "API key of your own WAHA server (sent as X-Api-Key). Not needed for the WhatsApp server that runs beside Floq.",
      "required": false
    },
    {
      "name": "WAHA_WEBHOOK_HMAC",
      "description": "HMAC key configured in WAHA for webhooks. When set, every webhook is verified.",
      "required": false
    }
  ],
  "network": {
    "allow": [
      "pps.whatsapp.net",
      "*.whatsapp.net"
    ]
  },
  "settings": [
    {
      "key": "baseUrl",
      "type": "url",
      "label": "WAHA address",
      "description": "Only for a WAHA server of your own, for example https://waha.example.com. Leave it empty to use the WhatsApp server that runs beside Floq. Only this address is ever contacted.",
      "required": false
    },
    {
      "key": "session",
      "type": "text",
      "label": "First session",
      "description": "WAHA session of the first account, read once. Defaults to \"default\". Add, attach and remove accounts from the account menu of the inbox.",
      "required": false
    },
    {
      "key": "historyPerChat",
      "type": "number",
      "label": "History: messages per chat",
      "description": "How many of the newest messages of each chat the history import brings in. Default 1000.",
      "required": false
    },
    {
      "key": "historyTotal",
      "type": "number",
      "label": "History: messages per import",
      "description": "Upper limit of one history import over all chats of an account. Default 50000. Media files are not downloaded by the import, only on demand.",
      "required": false
    },
    {
      "key": "messageMe",
      "type": "boolean",
      "label": "Let the AI message me freely",
      "description": "On by default once your number is saved below. The AI can then send you any message on WhatsApp, no approval needed. It only ever writes to your own number.",
      "required": false
    },
    {
      "key": "alwaysAllowSend",
      "type": "boolean",
      "label": "Always allow AI to send messages",
      "description": "WARNING: when on, agents send WhatsApp messages to ANY chat as your account without asking you first, and a message cannot be unsent. Off by default: each message then needs your approval in Floq. Turn on only if you accept that risk.",
      "required": false
    }
  ],
  "contributes": {
    "views": [
      {
        "id": "inbox",
        "label": "WhatsApp",
        "icon": "IconBrandWhatsapp"
      }
    ],
    "routes": true,
    "internalRoutes": true,
    "webhooks": [
      "events"
    ],
    "skills": [
      "waha"
    ],
    "migrations": true,
    "settingsPanel": true
  }
};
