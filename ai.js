/*
 * Простая правило-ориентированная имитация AI-классификатора (ТЗ п.3).
 * В боевой версии этот модуль вызывал бы LLM (например, Claude API) с
 * системным промптом + релевантным контекстом дома (см. ТЗ п.7: не слать
 * всю базу в каждый запрос). Здесь — детерминированная логика, чтобы демо
 * работало офлайн, без ключей API, и предсказуемо проигрывало сценарии ТЗ.
 * Каждое решение уходит в AuditLog — см. app.js: logAI().
 */

const CATEGORY_KEYWORDS = {
  'сантехника': ['кран', 'труба', 'сантех', 'унитаз', 'засор', 'раковин'],
  'вода': ['течёт вода', 'течет вода', 'потоп', 'затопил', 'протеч', 'вода в подвале', 'прорвало'],
  'отопление': ['батаре', 'отоплен', 'холодно в квартире', 'не топят', 'радиатор'],
  'электрика': ['свет не горит', 'электрик', 'розетк', 'проводк', 'искрит', 'напряжен', 'выбило автомат', 'не горит свет'],
  'лифт': ['лифт'],
  'домофон': ['домофон', 'не открывает дверь', 'трубка домофон'],
  'камеры': ['камера', 'видеонаблюден'],
  'ворота/шлагбаум': ['шлагбаум', 'ворота', 'кпп не работает', 'въезд'],
  'уборка': ['не убран', 'грязно', 'мусор в подъезде', 'уборка', 'убрать'],
  'безопасность': ['посторонн', 'взлом', 'подозрительн', 'кража', 'украли', 'драка', 'пожар', 'дым', 'горит', 'запах газа', 'газом пахнет'],
  'благоустройство': ['лавочк', 'детская площадка', 'газон', 'дерево упало', 'освещение двора', 'клумб'],
  'платежи/документы': ['квитанц', 'оплат', 'справк', 'долг', 'счёт', 'счет'],
};

const EMERGENCY_KEYWORDS = [
  'течёт', 'течет', 'потоп', 'затопил', 'прорвало', 'пожар', 'горит',
  'дым', 'запах газа', 'газом пахнет', 'искрит', 'застрял в лифте',
  'застряли в лифте', 'никто не открывает', 'взлом', 'обрушил',
];

const HIGH_KEYWORDS = ['срочно', 'давно не работает', 'вторые сутки', 'третий день', 'не работает уже'];

const ORDINALS = {
  'перв': 1, 'втор': 2, 'трет': 3, 'четверт': 4, 'пят': 5,
  'шест': 6, 'седьм': 7, 'восьм': 8, 'девят': 9, 'десят': 10,
};

const DUTY_ROLE_WORDS = {
  'сантехник': 'сантехник', 'слесар': 'сантехник',
  'электрик': 'электрик',
  'уборщи': 'уборщица', 'клинер': 'уборщица',
  'охран': 'охрана', 'кпп': 'охрана', 'консьерж': 'охрана',
  'лифт': 'лифт',
  'домофон': 'домофон',
  'председател': 'председатель',
};

function findNumberNear(text, anchorWord) {
  // "2 подъезд", "во 2-м подъезде", "второй подъезд", "подъезд 2"
  const digitPattern = new RegExp(`(\\d{1,2})\\s*[-]?\\w{0,3}\\s*${anchorWord}|${anchorWord}\\w*\\s*(\\d{1,2})`, 'i');
  const m = text.match(digitPattern);
  if (m) return parseInt(m[1] || m[2], 10);

  if (text.includes(anchorWord)) {
    for (const root in ORDINALS) {
      if (text.includes(root)) return ORDINALS[root];
    }
  }
  return null;
}

function extractEntities(rawText) {
  const text = rawText.toLowerCase();
  const entrance = findNumberNear(text, 'подъезд');
  const floor = findNumberNear(text, 'этаж');
  let apartment = null;
  const aptMatch = text.match(/кв\.?\s*(\d{1,4})|квартир\w*\s*№?\s*(\d{1,4})/);
  if (aptMatch) apartment = parseInt(aptMatch[1] || aptMatch[2], 10);
  return { entrance, floor, apartment };
}

function detectCategory(text) {
  let best = null;
  let bestHits = 0;
  for (const cat in CATEGORY_KEYWORDS) {
    const hits = CATEGORY_KEYWORDS[cat].filter((kw) => text.includes(kw)).length;
    if (hits > bestHits) { bestHits = hits; best = cat; }
  }
  return { category: best, confidence: bestHits > 0 ? Math.min(0.95, 0.6 + bestHits * 0.15) : 0 };
}

function detectUrgency(text, category) {
  if (EMERGENCY_KEYWORDS.some((kw) => text.includes(kw))) return 'аварийная';
  if (category === 'вода' || category === 'безопасность') return 'аварийная';
  if (HIGH_KEYWORDS.some((kw) => text.includes(kw))) return 'высокая';
  if (category === 'лифт' || category === 'отопление') return 'высокая';
  return 'обычная';
}

function detectIntent(rawText) {
  const text = rawText.toLowerCase();
  const role = matchRole(text);

  const asksMyRequest = /(мо[яю]|где)\s+заявк|что\s+с\s+(моей\s+)?заявк|статус\s+заявк/.test(text);
  if (asksMyRequest) return { intent: 'my_requests' };

  if (/объявлен/.test(text)) return { intent: 'announcements' };

  const asksPhone = /тел(ефон)?|номер|контакт/.test(text);
  const asksWho = /кто|график|дежур|на смене/.test(text);

  if (role && asksWho) return { intent: 'duty', role };
  if (role && asksPhone) return { intent: 'contact', role };
  if (asksWho && /дежур/.test(text)) return { intent: 'duty', role: null };

  return null;
}

function matchRole(text) {
  for (const key in DUTY_ROLE_WORDS) {
    if (text.includes(key)) return DUTY_ROLE_WORDS[key];
  }
  return null;
}

function searchFAQ(rawText, faqList) {
  const text = rawText.toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const item of faqList) {
    const hits = item.keywords.filter((kw) => text.includes(kw)).length;
    if (hits > bestHits) { bestHits = hits; best = item; }
  }
  return bestHits > 0 ? best : null;
}

/**
 * Главная точка входа классификатора.
 * Возвращает структуру решения + запись для AuditLog.
 */
function classify(rawText, faqList) {
  const text = rawText.toLowerCase().trim();

  const intent = detectIntent(text);
  if (intent) {
    return { type: 'intent', ...intent, confidence: 0.9, rawText };
  }

  const faqHit = searchFAQ(text, faqList);
  const { category, confidence } = detectCategory(text);

  if (category && confidence >= 0.6) {
    const entities = extractEntities(text);
    const urgency = detectUrgency(text, category);
    return { type: 'request', category, urgency, ...entities, confidence, rawText };
  }

  if (faqHit) {
    return { type: 'faq', faq: faqHit, confidence: 0.85, rawText };
  }

  return { type: 'unknown', confidence: 0.2, rawText };
}
