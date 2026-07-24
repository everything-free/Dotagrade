// api/skins.js
// Серверная функция Vercel: парсит Steam Community Market (Dota 2, appid=570).
// Запрос к Steam идёт с сервера, поэтому браузерный CORS тут ни при чём —
// никакие сторонние corsproxy.io больше не нужны.

const APPID = 570; // Dota 2
const PAGE_SIZE = 100; // максимум за один запрос к Steam
const PAGES_TO_FETCH = 3; // 100 * 3 = до 300 предметов
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 минут

// "Тёплый" инстанс функции переживает несколько вызовов подряд,
// поэтому простой кэш в памяти реально экономит запросы к Steam
// и спасает от бана по рейт-лимиту (Steam банит очень быстро).
let cache = { data: null, ts: 0 };

function detectRarity(hashName, typeField) {
  const src = `${hashName} ${typeField || ''}`;
  if (/Arcana/i.test(src)) return 'Arcana';
  if (/Immortal/i.test(src)) return 'Immortal';
  if (/Legendary/i.test(src)) return 'Legendary';
  if (/Mythical/i.test(src)) return 'Mythical';
  if (/Ancient/i.test(src)) return 'Ancient';
  if (/Rare/i.test(src)) return 'Rare';
  if (/Uncommon/i.test(src)) return 'Uncommon';
  if (/Common/i.test(src)) return 'Common';
  return 'Mythical';
}

async function fetchSteamPage(start) {
  const url =
    `https://steamcommunity.com/market/search/render/?query=&start=${start}` +
    `&count=${PAGE_SIZE}&search_descriptions=0&sort_column=popular&sort_dir=desc` +
    `&appid=${APPID}&norender=1`;

  const res = await fetch(url, {
    headers: {
      // Steam иногда режет запросы без "браузерных" заголовков
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/json,text/javascript,*/*;q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://steamcommunity.com/market/search?appid=570',
    },
  });

  if (!res.ok) {
    throw new Error(`Steam market вернул статус ${res.status}`);
  }

  const json = await res.json();
  if (!json || !json.success || !Array.isArray(json.results)) {
    throw new Error('Некорректный ответ Steam market');
  }
  return json.results;
}

async function loadFromSteam() {
  const all = [];
  for (let i = 0; i < PAGES_TO_FETCH; i++) {
    if (i > 0) {
      // небольшая пауза между страницами, чтобы не словить 429
      await new Promise((r) => setTimeout(r, 350));
    }
    const results = await fetchSteamPage(i * PAGE_SIZE);
    if (results.length === 0) break;
    all.push(...results);
  }
  return all;
}

function normalize(rawItems) {
  return rawItems
    .filter((item) => item && item.asset_description && item.asset_description.icon_url)
    .map((item, idx) => {
      const desc = item.asset_description;
      const hashName = item.hash_name || desc.market_hash_name || desc.name;
      const cents = item.sell_price;
      const price = typeof cents === 'number' ? Math.round(cents) / 100 : null;

      return {
        id: idx,
        name: hashName,
        price: price ?? 0,
        priceKnown: price !== null && price > 0,
        rarity: detectRarity(hashName, desc.type),
        img: `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}/360fx360f`,
      };
    })
    .filter((item) => item.priceKnown);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS) {
    return res.status(200).json({ items: cache.data, cached: true });
  }

  try {
    const raw = await loadFromSteam();
    const items = normalize(raw);

    if (items.length === 0) {
      throw new Error('Steam вернул пустой список предметов');
    }

    cache = { data: items, ts: now };
    return res.status(200).json({ items, cached: false });
  } catch (err) {
    // Если есть протухший, но живой кэш — лучше вернуть его, чем ничего
    if (cache.data) {
      return res.status(200).json({
        items: cache.data,
        cached: true,
        warning: String(err && err.message ? err.message : err),
      });
    }
    return res.status(502).json({ items: [], error: String(err && err.message ? err.message : err) });
  }
};
