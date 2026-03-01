// ================================================================
// PipePal ZA — Production Backend  (server.js)
// Deploy: Railway / Render / any Node.js host
// npm install express body-parser axios crypto
// ================================================================

"use strict";
const express    = require("express");
const bodyParser = require("body-parser");
const axios      = require("axios");
const crypto     = require("crypto");

const app = express();
app.use(bodyParser.json());

// ================================================================
// ENV — set ALL of these in Railway/Render environment variables
// ================================================================
const {
  WA_PHONE_NUMBER_ID,      // Meta Cloud API phone number ID
  WA_ACCESS_TOKEN,         // Meta permanent System User token
  WA_VERIFY_TOKEN = "PIPEPAL_SECRET_2026",
  LEMON_SECRET,            // LemonSqueezy webhook signing secret
  BASE44_API_KEY,          // Base44 App Settings → API Keys
  BASE44_APP_ID,           // Base44 App Settings → App ID
} = process.env;

// ================================================================
// BASE44 DATABASE HELPERS
// Every entity operation goes through the Base44 REST API.
// ================================================================
const B44 = axios.create({
  baseURL: `https://app.base44.com/api/apps/${BASE44_APP_ID}/entities`,
  headers: { "api-key": BASE44_API_KEY, "Content-Type": "application/json" },
  timeout: 8000,
});

const b44List   = async (entity, params = {}) => {
  const qs = new URLSearchParams({ limit: "50", ...params }).toString();
  const r  = await B44.get(`/${entity}?${qs}`);
  return r.data;
};
const b44Create = async (entity, data)      => (await B44.post(`/${entity}`, data)).data;
const b44Update = async (entity, id, data)  => (await B44.put(`/${entity}/${id}`, data)).data;
const b44Find   = async (entity, params)    => (await b44List(entity, params))[0] || null;

// ================================================================
// SUBSCRIPTION GUARD
// Returns the plumber's active Subscription record or null.
// Call this before every auto-reply.
// ================================================================
async function getActiveSub(plumberId) {
  const sub = await b44Find("Subscription", { plumber_id: plumberId });
  if (!sub) return null;
  if (sub.subscription_status === "expired") return null;
  // Auto-expire trials past their end date
  if (sub.subscription_status === "trial" && sub.trial_end_date) {
    if (new Date(sub.trial_end_date) < new Date()) {
      await b44Update("Subscription", sub.id, { subscription_status: "expired" });
      return null;
    }
  }
  return sub;
}

// ================================================================
// PLUMBER LOOKUP
// Match the receiving WA phone number to a plumber account.
// In production each plumber registers their own WA number.
// Fallback: first user record in the database.
// ================================================================
async function resolvePlumber(receivingPhoneNumberId) {
  // Try exact match on phone field
  let plumber = await b44Find("User", { phone: receivingPhoneNumberId });
  if (!plumber) {
    const all = await b44List("User", {});
    plumber   = all[0] || null;
  }
  return plumber;
}

// ================================================================
// CONVERSATION STATE — persisted in Base44 Conversation entity
// Replaces in-memory sessions completely.
// ================================================================
const STEPS = ["greeting","problem","photo","location","timing","callout","done"];

async function loadConversation(customerPhone, plumber) {
  let conv = await b44Find("Conversation", { customer_phone: customerPhone });
  if (!conv) {
    conv = await b44Create("Conversation", {
      plumber_id:     plumber?.id || null,
      customer_phone: customerPhone,
      step:           "greeting",
      language:       "en",
    });
  }
  // Attach plumber rates for convenience (not stored on Conversation)
  conv._plumber = plumber;
  return conv;
}

async function saveConversation(conv) {
  const { id, _plumber, ...fields } = conv;
  fields.last_message_at = new Date().toISOString();
  return b44Update("Conversation", id, fields);
}

async function resetConversation(conv) {
  await b44Update("Conversation", conv.id, {
    step: "done",
    last_message_at: new Date().toISOString(),
  });
}

// ================================================================
// LANGUAGE & INTENT DETECTION
// ================================================================
const detectLanguage = (text) =>
  /\b(hallo|dankie|asseblief|verstop|gebars|probleem|loodgieter|water|pyp)\b/i.test(text) ? "af" : "en";

const detectProblem = (text) => {
  const t = text.toLowerCase();
  if (/block|verstop|drain|drein|clog/.test(t))        return "blockage";
  if (/burst|gebars|broke|explod/.test(t))              return "burst_pipe";
  if (/geyser|hot water|warm water|boiler/.test(t))     return "geyser";
  if (/install|installeer|new tap|nuwe|fit new/.test(t))return "installation";
  if (/leak|lek|drip|druppel/.test(t))                  return "leak";
  return null;
};

const isUrgent = (text) =>
  /burst|flooding|everywhere|emergency|ceiling.*leak|dringend|nood|oorstroom/i.test(text);

// ================================================================
// PRICING ENGINE  (mirrors components/pricingEngine.js)
// ================================================================
const LABOUR_HOURS = { blockage:1.5, leak:2, burst_pipe:3, geyser:2.5, installation:4, other:2 };
const ITEM_KW = {
  blockage:     ["drain","snake","rod","plunger","pipe"],
  leak:         ["tape","sealant","washer","fitting","valve"],
  burst_pipe:   ["pipe","fitting","coupling","clamp"],
  geyser:       ["geyser","element","thermostat","valve","anode"],
  installation: ["pipe","fitting","fixture","valve"],
};

async function buildEstimate(conv) {
  const type        = conv.problem_type || "other";
  const plumber     = conv._plumber     || {};
  const labourRate  = parseFloat(plumber.labour_rate_per_hour) || 450;
  const calloutFee  = parseFloat(plumber.callout_fee)          || 350;
  const travelFee   = parseFloat(plumber.travel_fee)           || 0;
  const labourHours = LABOUR_HOURS[type] || 2;
  const labourCost  = +(labourHours * labourRate).toFixed(2);

  let partsCost = 0, itemsUsed = [];
  const allItems = await b44List("Item", { plumber_id: plumber.id || "" });
  const kws      = ITEM_KW[type] || [];
  const matched  = allItems
    .filter(i => kws.some(kw => (i.item_name || "").toLowerCase().includes(kw)))
    .slice(0, 3);
  partsCost = matched.reduce((s,i) => s + (i.item_price || 0), 0);
  itemsUsed = matched.map(i => ({
    item_id: i.id, item_name: i.item_name,
    quantity: 1, unit_price: i.item_price, total: i.item_price,
  }));

  const total = +(calloutFee + travelFee + labourCost + partsCost).toFixed(2);
  return { labourHours, labourCost, partsCost, calloutFee, travelFee, total, itemsUsed };
}

// ================================================================
// MESSAGES (EN / AF)
// ================================================================
const MSG = {
  en: {
    greeting : (biz) => `Hi 👋 Thanks for contacting ${biz || "PipePal ZA"}. I'm here to help while the team is busy. What seems to be the problem?`,
    clarify  : "Just to check — is it a blocked drain, leak, burst pipe, geyser issue, or something else?",
    photo    : "Thanks! Could you send a photo of the problem so we can get a better idea?",
    location : "Got it. Please send your address and suburb (or share your WhatsApp location pin).",
    timing   : "Almost done! When would suit you best — morning, afternoon, or evening?",
    callout  : (fee) => `Great. Just so you know, there's a R${fee} call-out fee. Is that okay?`,
    urgent   : "That sounds urgent! 🚨 The plumber will call you as soon as possible.",
    estimate : (total, biz) =>
      `Thanks! Based on what you've described, the estimated cost is around *R${total.toLocaleString()}* (including labour, parts & call-out). ${biz || "The plumber"} will confirm before starting any work. ✅`,
    declined : "No problem. The plumber will contact you to discuss pricing before any work starts.",
    fallback : "Thanks! The plumber will be in touch soon.",
  },
  af: {
    greeting : (biz) => `Hallo 👋 Dankie dat jy ${biz || "PipePal ZA"} kontak. Ek is hier om te help terwyl die span besig is. Wat is die probleem?`,
    clarify  : "Net om seker te maak — is dit 'n verstopte drein, lek, gebarste pyp, geyser, of iets anders?",
    photo    : "Dankie! Kan jy 'n foto van die probleem stuur sodat ons beter kan sien?",
    location : "Goed. Stuur asseblief jou adres en dorp (of deel jou WhatsApp liggingpen).",
    timing   : "Amper klaar! Wanneer sal dit die beste pas — oggend, middag, of aand?",
    callout  : (fee) => `Goed. Net om jou in kennis te stel, is daar 'n R${fee} oproepfooi. Is dit reg?`,
    urgent   : "Dit klink dringend! 🚨 Die loodgieter sal jou so gou moontlik skakel.",
    estimate : (total, biz) =>
      `Dankie! Gebaseer op jou beskrywing is die geskatte koste ongeveer *R${total.toLocaleString()}* (insluitend arbeid, onderdele en oproepfooi). ${biz || "Die loodgieter"} sal bevestig voor enige werk begin. ✅`,
    declined : "Geen probleem. Die loodgieter sal jou kontak om pryse te bespreek.",
    fallback : "Dankie! Die loodgieter sal gou in verbinding tree.",
  },
};

// ================================================================
// CONVERSATION STATE MACHINE
// ================================================================
async function processMessage(customerPhone, text, hasMedia, plumber) {
  const conv = await loadConversation(customerPhone, plumber);
  const biz  = plumber?.business_name || "PipePal ZA";

  // Detect language on first real message
  if (conv.step === "greeting" || conv.step === "problem") {
    conv.language = detectLanguage(text);
  }
  const L = MSG[conv.language] || MSG.en;

  // Always check for urgency
  if (!conv.urgency && isUrgent(text)) conv.urgency = true;

  // Always try to extract name
  if (!conv.customer_name) {
    const m = text.match(/(?:my name is|i'?m|i am|ek is|naam is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
    if (m) conv.customer_name = m[1];
  }

  let reply;

  // Urgency bypass — jump straight to finalise
  if (conv.urgency && conv.step !== "done") {
    await finaliseQuote(conv, null);
    reply = L.urgent;
    await saveConversation(conv);
    return reply;
  }

  switch (conv.step) {

    case "greeting":
      conv.step = "problem";
      reply = L.greeting(biz);
      break;

    case "problem": {
      const detected = detectProblem(text);
      if (!detected) {
        reply = L.clarify;
      } else {
        conv.problem_type = detected;
        conv.step         = "photo";
        reply = L.photo;
      }
      break;
    }

    case "photo":
      conv.has_photo = hasMedia || /photo|foto|picture|pic|sent|gestuur/i.test(text);
      conv.step = "location";
      reply = L.location;
      break;

    case "location":
      conv.location = text;
      conv.step     = "timing";
      reply = L.timing;
      break;

    case "timing":
      conv.timing = text;
      conv.step   = "callout";
      reply = L.callout(parseFloat(plumber?.callout_fee) || 350);
      break;

    case "callout":
      if (/yes|ja|ok|fine|reg|sure|sounds good|no problem|np/i.test(text)) {
        conv.callout_confirmed = true;
        conv.step = "done";
        const est = await buildEstimate(conv);
        await finaliseQuote(conv, est);
        reply = L.estimate(est.total, biz);
      } else {
        conv.step = "done";
        reply = L.declined;
        await resetConversation(conv);
      }
      break;

    case "done":
    default:
      reply = L.fallback;
      break;
  }

  await saveConversation(conv);
  return reply;
}

// ================================================================
// FINALISE — Create Quote record in Base44
// ================================================================
async function finaliseQuote(conv, est) {
  const plumber = conv._plumber || {};
  const quoteData = {
    plumber_id:          plumber.id || null,
    customer_name:       conv.customer_name || "WhatsApp Customer",
    customer_phone:      conv.customer_phone,
    address:             conv.location || "Pending",
    problem_type:        conv.problem_type || "other",
    problem_description: [
      conv.timing  ? `Timing: ${conv.timing}`  : null,
      conv.urgency ? "URGENT"                   : null,
      conv.has_photo ? "Photo provided"         : "No photo",
    ].filter(Boolean).join(" | "),
    callout_fee:      est?.calloutFee      || parseFloat(plumber.callout_fee)          || 350,
    travel_fee:       est?.travelFee       || parseFloat(plumber.travel_fee)           || 0,
    labour_hours:     est?.labourHours     || 0,
    labour_cost:      est?.labourCost      || 0,
    materials_cost:   est?.partsCost       || 0,
    estimated_total:  est?.total           || 0,
    items_used:       est?.itemsUsed       || [],
    status:           "pending",
    notes:            `Lang: ${conv.language} | Photo: ${conv.has_photo ? "yes" : "no"}`,
  };

  const quote = await b44Create("Quote", quoteData);

  // Link quote back to conversation
  conv.quote_id = quote.id;
  conv.step = "done";
}

// ================================================================
// WHATSAPP WEBHOOK — Verify (GET)
// ================================================================
app.get("/webhook/whatsapp", (req, res) => {
  if (
    req.query["hub.mode"]         === "subscribe" &&
    req.query["hub.verify_token"] === WA_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ================================================================
// WHATSAPP WEBHOOK — Receive messages (POST)
// ================================================================
app.post("/webhook/whatsapp", async (req, res) => {
  // Acknowledge immediately (Meta requires < 5 s)
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return;

    // Resolve plumber from the receiving phone number
    const plumber = await resolvePlumber(value.metadata?.phone_number_id);

    for (const msg of value.messages) {
      const from     = msg.from;
      const text     = msg.text?.body || msg.caption || "";
      const hasMedia = !!(msg.image || msg.video || msg.document || msg.audio);

      // ── Subscription guard ─────────────────────────────────
      const sub = await getActiveSub(plumber?.id);
      if (!sub) {
        console.log(`[BLOCKED] Sub expired/missing for plumber ${plumber?.id}`);
        continue; // don't reply — subscription inactive
      }

      // ── Save inbound message ───────────────────────────────
      await b44Create("Message", {
        plumber_id:   plumber?.id || null,
        customer_phone: from,
        sender:       "customer",
        message_text: text || (hasMedia ? "[media]" : "[no text]"),
      });

      // ── Run conversation state machine ─────────────────────
      const reply = await processMessage(from, text, hasMedia, plumber);

      // ── Send WhatsApp reply ────────────────────────────────
      await sendWA(from, reply);

      // ── Save outbound message ──────────────────────────────
      await b44Create("Message", {
        plumber_id:   plumber?.id || null,
        customer_phone: from,
        sender:       "ai",
        message_text: reply,
      });
    }
  } catch (err) {
    console.error("[WA webhook]", err.response?.data || err.message);
  }
});

// ================================================================
// LEMON SQUEEZY WEBHOOK — subscription lifecycle (POST)
// ================================================================
app.post("/webhook/lemonsqueezy", async (req, res) => {
  // Verify HMAC-SHA256 signature
  const rawBody = JSON.stringify(req.body);
  const sig     = req.headers["x-signature"] || "";
  const expected = crypto.createHmac("sha256", LEMON_SECRET || "")
    .update(rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.sendStatus(403);
  }

  const eventName      = req.body?.meta?.event_name;
  const customerId     = req.body?.data?.attributes?.customer_id?.toString();
  const subscriptionId = req.body?.data?.id?.toString();

  if (!customerId) return res.sendStatus(200);

  const subs = await b44List("Subscription", {});
  const sub  = subs.find(s => s.lemonsqueezy_customer_id === customerId);
  if (!sub)  return res.sendStatus(200);

  const statusMap = {
    subscription_created : "active",
    order_created        : "active",
    subscription_resumed : "active",
    subscription_unpaused: "active",
    subscription_cancelled: "expired",
    subscription_expired : "expired",
  };

  const newStatus = statusMap[eventName];
  if (newStatus) {
    await b44Update("Subscription", sub.id, {
      subscription_status:          newStatus,
      lemonsqueezy_subscription_id: subscriptionId,
    });
    console.log(`[LS] ${eventName} → ${sub.id} = ${newStatus}`);
  }

  res.sendStatus(200);
});

// ================================================================
// HEALTH CHECK
// ================================================================
app.get("/health", (_, res) =>
  res.json({ status: "ok", service: "PipePal ZA", ts: new Date().toISOString() })
);

// ================================================================
// SEND WHATSAPP MESSAGE
// ================================================================
async function sendWA(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${WA_PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } }
  );
}

app.listen(3000, () =>
  console.log("✅  PipePal ZA backend running on :3000")
);
app.get("/webhook", (req, res) => {
  const verify_token = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === verify_token) {
      console.log("Webhook verified!");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});