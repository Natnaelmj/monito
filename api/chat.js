// Vercel Serverless Function — proxies chat turns to the Gemini API (free
// tier) so the API key never reaches the browser. No SDK dependency: uses
// the global fetch available in Vercel's Node runtime.

const MODEL = "gemini-3.5-flash";
const MAX_OUTPUT_TOKENS = 1024;
const MAX_MESSAGES = 30;

// System prompt for "Assistente Frigo". Every safety rule lives here, not
// just in the UI copy — the model must hold the line even if a user pushes
// back or asks directly for a diagnosis/guarantee. {{FRIGORISTA_CONTACT}} is
// substituted from an env var below so the number can't be misstated.
const SYSTEM_PROMPT_TEMPLATE = `Sei l'Assistente Frigo di Monito. Aiuti chi gestisce un bar, ristorante o negozio a capire cosa sta succedendo al frigorifero o congelatore in questo momento, prima che arrivi un tecnico.

REGOLE FERREE — non derogare mai, anche se l'utente insiste:

1. Non fai mai una diagnosi tecnica specifica. Non dici "è il compressore" o "è il termostato". Descrivi solo controlli di base che chiunque può fare in sicurezza: guarnizione della porta, spina e presa, interruttore/salvavita, accumulo di ghiaccio evidente, sfiati puliti.

2. Non dai mai un verdetto personale sulla sicurezza del cibo ("il tuo cibo è sicuro", "puoi tenerlo"). Riporti solo la regola standard tempo-temperatura: se il frigo torna in range entro 2 ore va bene, se resta fuori range oltre le 4 ore il contenuto va buttato. Non fai eccezioni o valutazioni caso per caso oltre questa regola.

3. Non garantisci mai che un consiglio risolverà il problema, né sostituisci un tecnico o le responsabilità HACCP del locale.

4. Se il messaggio riguarda un'emergenza medica o qualcosa che non è un problema di frigorifero/congelatore o sicurezza alimentare, non rispondere nel merito: invita gentilmente a contattare chi di dovere (118 per emergenze mediche, personale competente per altro) e torna in argomento solo se pertinente.

5. Chiudi ogni risposta sostanziale con una variazione di: "Se il problema persiste, chiama un tecnico frigorista: {{FRIGORISTA_CONTACT}}."

TONO: caldo, calmo, diretto. Stai parlando con qualcuno che magari è stressato alle 2 di notte, non con un utente di una demo. Frasi brevi. Italiano semplice, zero tono aziendale, zero hype.

STRUTTURA DI UNA RISPOSTA (quando l'utente ha descritto il problema, con o senza foto):
1. Una riga di riconoscimento calmo (es. "Ok, vediamo insieme.")
2. 2-4 controlli di base pertinenti a quanto descritto, in linguaggio semplice
3. Un'indicazione chiara: è una cosa che può controllare da solo, oppure deve fermarsi e chiamare un tecnico
4. Se rilevante, la regola tempo-temperatura sulla sicurezza alimentare (mai un verdetto personale)
5. La riga di chiusura con il contatto del frigorista

Se non hai abbastanza informazioni per i punti 2-3, fai prima una domanda breve e mirata invece di indovinare.`;

function buildSystemPrompt() {
  const contact = process.env.FRIGORISTA_CONTACT || "+39 XXX XXXXXXX";
  return SYSTEM_PROMPT_TEMPLATE.split("{{FRIGORISTA_CONTACT}}").join(contact);
}

function isValidContentBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "text") {
    return typeof block.text === "string" && block.text.length > 0 && block.text.length <= 4000;
  }
  if (block.type === "image") {
    return (
      block.source &&
      block.source.type === "base64" &&
      (block.source.media_type === "image/jpeg" || block.source.media_type === "image/png") &&
      typeof block.source.data === "string" &&
      block.source.data.length > 0
    );
  }
  return false;
}

function isValidMessage(msg) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return false;
  if (typeof msg.content === "string") return msg.content.length > 0 && msg.content.length <= 4000;
  if (Array.isArray(msg.content)) return msg.content.length > 0 && msg.content.every(isValidContentBlock);
  return false;
}

// Verifies the caller's Supabase session token and looks up their tier via
// the service-role key (bypasses RLS, so this always sees the real value
// regardless of policy). This is the actual access-control boundary — the
// UI-side gate in assistente-frigo.html is just for a good experience, not
// security, since anyone could otherwise call this endpoint directly.
async function verifyUserAndTier(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) return null;

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;

  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=tier`,
    { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } },
  );
  if (!profileRes.ok) return null;
  const rows = await profileRes.json();
  const tier = rows[0] && rows[0].tier;
  if (tier !== "standard" && tier !== "premium") return null;

  return { id: user.id, tier };
}

// The client speaks the Anthropic-style {role, content:[{type,...}]} shape
// (kept as-is so the front end doesn't care which provider is behind it).
// Convert that to Gemini's {role, parts:[...]} shape, mapping
// "assistant" -> "model" and text/image blocks to text/inlineData parts.
function toGeminiContents(messages) {
  return messages.map((msg) => {
    const role = msg.role === "assistant" ? "model" : "user";
    if (typeof msg.content === "string") {
      return { role, parts: [{ text: msg.content }] };
    }
    const parts = msg.content.map((block) => {
      if (block.type === "text") return { text: block.text };
      return {
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      };
    });
    return { role, parts };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Assistant not configured" });
    return;
  }

  const authedUser = await verifyUserAndTier(req.headers.authorization);
  if (!authedUser) {
    res.status(403).json({ error: "Accesso richiesto: piano Standard o Premium" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }

  const messages = body && body.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGES ||
    !messages.every(isValidMessage)
  ) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: { text: buildSystemPrompt() } },
        contents: toGeminiContents(messages),
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // This is a direct conversational task, not open-ended reasoning —
          // disable thinking so the token budget goes to the visible reply
          // instead of being silently consumed by hidden thought tokens.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!response.ok) {
      console.error("Gemini API error:", response.status, await response.text());
      res.status(502).json({ error: "Assistant is unavailable right now" });
      return;
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!reply) {
      res.status(502).json({ error: "Empty response" });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error("Assistente Frigo backend error:", err);
    res.status(500).json({ error: "Unexpected error" });
  }
};
