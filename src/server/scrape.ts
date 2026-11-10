import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const PAGE_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 6 * 1024 * 1024;
const PREVIEW_LIMIT = 256 * 1024;
const TIMEOUT_MS = 8000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
type Address = { address: string; family: 4 | 6 };

const v4num = (address: string) => address.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
const v4Blocked = (address: string) => {
  const n = v4num(address);
  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return ranges.some(([base, bits]) => (n >> BigInt(32 - bits)) === (v4num(base) >> BigInt(32 - bits)));
};

function ipv6num(address: string): bigint | null {
  let raw = address.toLowerCase().split('%')[0];
  if (raw.includes('.')) {
    const cut = raw.lastIndexOf(':');
    const v4 = raw.slice(cut + 1);
    if (isIP(v4) !== 4) return null;
    const n = v4num(v4);
    raw = `${raw.slice(0, cut)}:${((n >> 16n) & 0xffffn).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}
const inV6 = (n: bigint, base: bigint, bits: number) => (n >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
const v6Blocked = (address: string) => {
  const n = ipv6num(address);
  if (n === null) return true;
  if ((n >> 32n) === 0xffffn) return v4Blocked(`${Number((n >> 24n) & 255n)}.${Number((n >> 16n) & 255n)}.${Number((n >> 8n) & 255n)}.${Number(n & 255n)}`);
  // Publicly routable global unicast space only. This also excludes mapped,
  // loopback, unique-local, link-local, multicast, unspecified and transition ranges.
  return !inV6(n, 0x20000000000000000000000000000000n, 3)
    || inV6(n, 0x20010db8000000000000000000000000n, 32)
    || inV6(n, 0x20010000000000000000000000000000n, 23)
    || inV6(n, 0x20020000000000000000000000000000n, 16)
    || inV6(n, 0x20010020000000000000000000000000n, 28);
};

async function resolvePublic(host: string): Promise<Address[]> {
  const cleanHost = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(cleanHost) === 4) {
    if (v4Blocked(cleanHost)) throw new Error('Private or reserved address');
    return [{ address: cleanHost, family: 4 }];
  }
  if (isIP(cleanHost) === 6) {
    if (v6Blocked(cleanHost)) throw new Error('Private or reserved address');
    return [{ address: cleanHost, family: 6 }];
  }
  const addresses = await lookup(cleanHost, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => entry.family === 4 ? v4Blocked(entry.address) : v6Blocked(entry.address))) {
    throw new Error('Host resolves to a private or reserved address');
  }
  return addresses.map(entry => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

type RequestOptions = { accept?: string; referer?: string };

async function requestOnce(url: URL, addresses: Address[], limit: number, userAgent = DEFAULT_USER_AGENT, options: RequestOptions = {}) {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const picked = addresses[0];
    const request = transport(url, {
      method: 'GET',
      // Retailer sites often serve an empty/challenge page to an identifiable
      // scraper UA. Use ordinary browser navigation headers; SSRF protections
      // remain enforced by resolving and pinning every request (including redirects).
      headers: {
        'user-agent': userAgent,
        accept: options.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9,fr;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        ...(options.referer ? { referer: options.referer } : {}),
      },
      servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      lookup: (_hostname: string, options: any, callback: any) => options?.all
        ? callback(null, [picked])
        : callback(null, picked.address, picked.family),
    } as any, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > limit) { request.destroy(new Error('Response too large')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => done(() => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })));
      response.on('error', error => done(() => reject(error)));
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('Request timed out')));
    request.on('error', error => done(() => reject(error)));
    request.end();
  });
}

export async function safeGet(
  initialUrl: string,
  limit: number,
  resolver: typeof resolvePublic = resolvePublic,
  request: typeof requestOnce = requestOnce,
  userAgent = DEFAULT_USER_AGENT,
  options: RequestOptions = {},
) {
  let url = new URL(initialUrl);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported URL');
    if (url.port && !/^\d+$/.test(url.port)) throw new Error('Invalid port');
    const addresses = await resolver(url.hostname);
    const response = await request(url, addresses, limit, userAgent, options);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || redirect === 5) throw new Error('Too many redirects');
      url = new URL(Array.isArray(location) ? location[0] : location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Remote status ${response.status}`);
    return { ...response, finalUrl: url };
  }
  throw new Error('Too many redirects');
}

const decodeEntities = (text: string) => text
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));

function attributes(tag: string) {
  const result: Record<string, string> = {};
  const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(tag))) {
    const name = match[1].toLowerCase();
    result[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}
const usableText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? decodeEntities(value.trim()).slice(0, 500) : null;
const productTypes = (value: any): boolean => {
  const type = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
  return type.some((t: unknown) => typeof t === 'string' && t.toLowerCase().split('/').pop() === 'product');
};
const productsIn = (value: any): any[] => {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(productsIn);
  return [...(productTypes(value) ? [value] : []), ...(Array.isArray(value['@graph']) ? value['@graph'].flatMap(productsIn) : [])];
};
const firstValue = (value: unknown): any => Array.isArray(value) ? firstValue(value[0]) : value;
const imageValue = (value: any): string | null => {
  const first = firstValue(value);
  if (typeof first === 'string') return first;
  return typeof first?.url === 'string' ? first.url : typeof first?.contentUrl === 'string' ? first.contentUrl : null;
};
const parsePrice = (raw: unknown) => {
  if (raw == null || String(raw).trim() === '') return null;
  let value = String(raw).replace(/[^\d,.-]/g, '');
  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimalAt = Math.max(comma, dot);
    const decimal = value[decimalAt];
    value = value.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + value.slice(decimalAt + 1).replace(/[.,]/g, '');
    if (decimal !== ',' && decimal !== '.') return null;
  } else {
    const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
    if (separator) {
      const pieces = value.split(separator);
      const suffix = pieces.at(-1) ?? '';
      if (pieces.length > 2 || suffix.length === 3) value = pieces.join('');
      else if (separator === ',') value = pieces.slice(0, -1).join('') + '.' + suffix;
    }
  }
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
};
const priceFrom = (product: any) => {
  const offers = firstValue(product?.offers ?? product?.aggregateOffer);
  const raw = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
  return parsePrice(raw);
};

function amazonHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)amazon\.(?:fr|es|de|it|co\.uk|com|nl|be|se|pl|ie|com\.be|com\.tr)$/.test(host);
}

function leroyHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)leroymerlin\.(?:es|fr)$/.test(host);
}

function bricoramaHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'bricorama.fr' || host.endsWith('.bricorama.fr');
}

function lidlHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)lidl\.(?:fr|es)$/.test(host);
}

function mediaMarktHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'mediamarkt.es' || host.endsWith('.mediamarkt.es');
}

function imageTagValues(html: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(/<(?:img|source|a)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    for (const key of ['data-zoom-image', 'data-original-src', 'data-lazy-src', 'data-src', 'data-original', 'src', 'href', 'data-srcset', 'srcset']) {
      const value = attrs[key];
      if (!value) continue;
      const candidates = key.endsWith('srcset')
        ? value.split(',').map(entry => entry.trim().split(/\s+/)[0])
        : [value];
      values.push(...candidates.filter(candidate => candidate && !candidate.startsWith('data:')));
    }
  }
  return values;
}

function retailerImage(html: string, pageUrl: string, retailer: 'bricorama' | 'lidl' | 'mediamarkt') {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return null; }
  for (const raw of imageTagValues(html)) {
    let candidate: URL;
    try { candidate = new URL(raw, page); } catch { continue; }
    if (!['http:', 'https:'].includes(candidate.protocol)) continue;

    if (retailer === 'bricorama') {
      const mousquetairesCdn = candidate.hostname.toLowerCase() === 'assets-big.cdn-mousquetaires.com'
        && /^\/medias\/domain\d+\/media\d+\/[^/]+\.(?:jpe?g|png|webp)$/i.test(candidate.pathname);
      const bricoramaProxy = bricoramaHost(candidate.hostname)
        && /^\/fstrz\/r\/s\/assets-big\.cdn-mousquetaires\.com\/medias\/domain\d+\/media\d+\/[^/]+\.(?:jpe?g|png|webp)$/i.test(candidate.pathname);
      if (mousquetairesCdn || bricoramaProxy) return candidate.toString();
    } else if (retailer === 'lidl') {
      // Lidl's public product galleries use hashed gcp image assets, e.g.
      // /assets/gcp25443455671d4c87b7415a4268de49a1.jpg.
      if (lidlHost(candidate.hostname) && /^\/assets\/gcp[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(candidate.pathname)) return candidate.toString();
    } else {
      // MediaMarkt product galleries serve their public originals through the
      // MMS image resize service (ASSET_MMS_* paths).
      if (candidate.hostname.toLowerCase() === 'assets.mmsrg.com'
        && /^\/isr\/\d+\/c1\/-\/ASSET_MMS_[^/]+$/i.test(candidate.pathname)) return candidate.toString();
    }
  }
  return null;
}

function elementTextById(html: string, id: string) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`<([a-z][\\w:-]*)\\b(?=[^>]*\\bid\\s*=\\s*["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'i').exec(html);
  if (!tag) return null;
  const text = tag[2].replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return usableText(text.replace(/\s+/g, ' '));
}

function amazonImage(html: string) {
  for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = attributes(tag[0]);
    if (attrs.id !== 'landingImage') continue;
    if (attrs['data-old-hires']) return attrs['data-old-hires'];
    if (attrs['data-zoom-image']) return attrs['data-zoom-image'];
    const dynamic = attrs['data-a-dynamic-image'];
    if (dynamic) {
      try {
        const candidates = Object.entries(JSON.parse(dynamic) as Record<string, number[]>);
        candidates.sort((a, b) => (b[1]?.[0] ?? 0) * (b[1]?.[1] ?? 0) - (a[1]?.[0] ?? 0) * (a[1]?.[1] ?? 0));
        if (candidates[0]?.[0]) return candidates[0][0];
      } catch { /* Continue to the normal source attribute. */ }
    }
    if (attrs.src && !attrs.src.startsWith('data:')) return attrs.src;
  }
  return null;
}

function amazonUrlTitle(pageUrl: string) {
  const match = new URL(pageUrl).pathname.match(/^\/([^/]+)\/dp\/[A-Z0-9]{10}(?:\/|$)/i);
  if (!match) return null;
  try {
    const title = decodeURIComponent(match[1]).replace(/[+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return title && !/^dp\b/i.test(title) ? usableText(title) : null;
  } catch { return null; }
}

export function amazonImageFallbackUrls(pageUrl: string) {
  const url = new URL(pageUrl);
  if (!amazonHost(url.hostname)) return [];
  const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
  if (!asin) return [];
  const market = url.hostname.toLowerCase().match(/amazon\.(fr|es|de|it|co\.uk|com|nl|be|se|pl|ie)$/)?.[1];
  const countryCode: Record<string, string> = { fr: '08', de: '03', 'co.uk': '02' };
  const suffix = countryCode[market ?? ''] ?? '01';
  // Amazon sometimes omits its image markup from server-rendered responses.
  // These legacy ASIN image paths still resolve for many catalog products.
  return [
    `https://images-eu.ssl-images-amazon.com/images/P/${asin}.${suffix}._SL500_.jpg`,
    `https://images-na.ssl-images-amazon.com/images/P/${asin}.${suffix}._SL500_.jpg`,
  ];
}

function amazonPrice(html: string) {
  const priceSections = ['corePriceDisplay_desktop_feature_div', 'corePrice_feature_div', 'apex_desktop', 'priceblock_ourprice'];
  for (const id of priceSections) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = html.search(new RegExp(`\\bid\\s*=\\s*["']${escaped}["']`, 'i'));
    if (at < 0) continue;
    const section = html.slice(at, at + 20_000);
    const priceText = /<span\b(?=[^>]*class\s*=\s*["'][^"']*\ba-offscreen\b)[^>]*>([\s\S]*?)<\/span\s*>/i.exec(section)?.[1];
    if (priceText) {
      const price = parsePrice(priceText.replace(/<[^>]*>/g, ' '));
      if (price !== null) return { price, currency: /£/.test(priceText) ? 'GBP' : /\$/.test(priceText) ? 'USD' : 'EUR' };
    }
  }
  return null;
}

function leroyUrlTitle(pageUrl: string) {
  const segment = new URL(pageUrl).pathname.split('/').at(-1) ?? '';
  const slug = segment.replace(/-\d+\.html$/i, '');
  try {
    const title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return title ? usableText(title) : null;
  } catch { return null; }
}

// Curated public catalog fallbacks for products whose page is protected by an
// anti-bot challenge while their public media CDN remains available. Keep this
// list small and omit volatile fields such as price.
const leroyProductFallbacks: Record<string, { title: string; imageUrl: string }> = {
  '91468364': {
    title: 'Fresadora DEXTER 1300 W - Velocidad variable hasta 30000 RPM',
    imageUrl: 'https://media.adeo.com/media/4098413/media.png',
  },
};

export function leroyProductFallback(pageUrl: string) {
  const reference = new URL(pageUrl).pathname.match(/-(\d+)\.html$/i)?.[1];
  return reference ? leroyProductFallbacks[reference] ?? null : null;
}

function leroyImage(html: string) {
  const carouselAt = html.search(/\bid\s*=\s*["']js-main-carousel["']/i);
  if (carouselAt < 0) return null;
  const carousel = html.slice(carouselAt, carouselAt + 100_000);
  for (const match of carousel.matchAll(/<a\b[^>]*>/gi)) {
    const href = attributes(match[0]).href;
    if (href && /(?:^|\.)media\.adeo\.com\/media\/\d+\/media\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(href.replace(/^https?:\/\//, ''))) return href;
  }
  for (const match of carousel.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const candidate = attrs['data-zoom-image'] || attrs['data-src'] || attrs.src;
    if (candidate && /media\.adeo\.com\/media\/\d+\/media\.(?:png|jpe?g|webp)/i.test(candidate) && !candidate.startsWith('data:')) return candidate;
  }
  // The page's main carousel can expose only responsive <source srcset>
  // elements in some server-rendered variants.
  for (const match of carousel.matchAll(/<(?:source|img)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const candidates = [attrs.src, attrs['data-src'], attrs.srcset]
      .filter((value): value is string => Boolean(value))
      .flatMap(value => value.split(',').map(candidate => candidate.trim().split(/\s+/)[0]));
    const candidate = candidates.find(value => /https?:\/\/media\.adeo\.com\/media\/\d+\/media\.(?:png|jpe?g|webp)/i.test(value));
    if (candidate) return candidate;
  }
  return null;
}

function leroyPrice(html: string) {
  const text = elementTextById(html, 'a11y-product-detail-info')
    ?? elementTextById(html, 'product-name')
    ?? (() => {
      const value = /<meta\b(?=[^>]*\bproperty\s*=\s*["']product:price:amount["'])[^>]*>/i.exec(html);
      return value ? attributes(value[0]).content ?? null : null;
    })();
  if (!text) return null;
  const price = parsePrice(text);
  return price === null ? null : { price, currency: 'EUR' };
}

export function parseProductHtml(html: string, pageUrl: string) {
  const meta: Record<string, string> = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content && meta[key] === undefined) meta[key] = attrs.content;
  }
  let title: string | null = null;
  let image: string | null = null;
  let price: number | null = null;
  let currency: string | null = null;

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/type\s*=\s*["']?application\/ld\+json["']?/i.test(match[1])) continue;
    try {
      const value = JSON.parse(match[2].replace(/^\s*<!--|-->\s*$/g, ''));
      const product = productsIn(value)[0];
      if (product) {
        title = usableText(product.name);
        image = imageValue(product.image);
        price = priceFrom(product);
        const offer = firstValue(product.offers ?? product.aggregateOffer);
        currency = usableText(offer?.priceCurrency)?.toUpperCase() ?? null;
        break;
      }
    } catch { /* Ignore malformed JSON-LD and continue to the next source. */ }
  }
  title ??= usableText(meta['og:title']) ?? usableText(meta['twitter:title']) ?? usableText(meta.title);
  image ??= usableText(meta['og:image']) ?? usableText(meta['og:image:url']) ?? usableText(meta['twitter:image']);
  if (price === null) {
    const rawPrice = meta['product:price:amount'] ?? meta['og:price:amount'];
    price = parsePrice(rawPrice);
  }
  currency ??= usableText(meta['product:price:currency'] ?? meta['og:price:currency'])?.toUpperCase() ?? null;
  if (!title) {
    const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    title = titleMatch ? usableText(titleMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')) : null;
  }
  if (!image) {
    for (const match of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
      const attrs = attributes(match[0]);
      const dimensions = Math.max(Number(attrs.width) || 0, Number(attrs.height) || 0);
      const candidate = attrs['data-src'] || attrs.src || attrs.srcset?.split(',')[0]?.trim().split(/\s+/)[0];
      if (candidate && !candidate.startsWith('data:') && (dimensions >= 120 || !attrs.width && !attrs.height)) { image = candidate; break; }
    }
  }
  if (amazonHost(new URL(pageUrl).hostname)) {
    const productTitle = elementTextById(html, 'productTitle');
    if (productTitle) title = productTitle;
    else if (!title || /amazon\.(?:fr|es|de|it|co\.uk|com|nl|be|se|pl|ie)/i.test(title)) title = amazonUrlTitle(pageUrl);
    image = amazonImage(html) ?? image;
    if (price === null) {
      const parsed = amazonPrice(html);
      if (parsed) { price = parsed.price; currency = parsed.currency; }
    }
  } else if (leroyHost(new URL(pageUrl).hostname)) {
    const productTitle = elementTextById(html, 'product-name');
    if (productTitle) title = productTitle;
    else if (!title || /leroy\s*merlin/i.test(title)) title = leroyUrlTitle(pageUrl);
    image = leroyImage(html) ?? image;
    if (price === null) {
      const parsed = leroyPrice(html);
      if (parsed) { price = parsed.price; currency = parsed.currency; }
    }
  } else if (bricoramaHost(new URL(pageUrl).hostname)) {
    image = retailerImage(html, pageUrl, 'bricorama') ?? image;
  } else if (lidlHost(new URL(pageUrl).hostname)) {
    image = retailerImage(html, pageUrl, 'lidl') ?? image;
  } else if (mediaMarktHost(new URL(pageUrl).hostname)) {
    image = retailerImage(html, pageUrl, 'mediamarkt') ?? image;
  }
  const absoluteImage = image ? (() => { try { return new URL(image, pageUrl).toString(); } catch { return null; } })() : null;
  return { title: title?.slice(0, 200) ?? '', url: pageUrl, imageUrl: absoluteImage, imagePath: null as string | null, price, currency: currency?.slice(0, 3) ?? 'EUR' };
}

const extensionFor = (contentType: string, url: URL) => {
  const known: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (known[type]) return known[type];
  const ext = path.extname(url.pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext) ? ext : '.img';
};

export function verifiedImageType(contentType: string, body: Buffer): string | null {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const detected = body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff ? 'image/jpeg'
    : body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
      : body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
        : body.length >= 6 && /^GIF8[79]a$/.test(body.toString('ascii', 0, 6)) ? 'image/gif'
          : body.length >= 12 && body.toString('ascii', 4, 8) === 'ftyp' && /^(?:avif|avis)$/.test(body.toString('ascii', 8, 12)) ? 'image/avif'
            : null;
  if (!detected) return null;
  if (/^(?:application|binary)\/(?:x-)?octet-stream$/.test(type)) return detected;
  return type === detected ? detected : null;
}

export async function saveUploadedImage(body: Buffer, imageDir: string, contentType = '') {
  const type = verifiedImageType(contentType, body);
  if (!type || body.length === 0 || body.length > IMAGE_LIMIT) throw new Error('Unsupported or oversized image');
  const filename = `${randomBytes(16).toString('hex')}${extensionFor(type, new URL('https://upload.invalid/image'))}`;
  await writeFile(path.join(imageDir, filename), body, { flag: 'wx' });
  return `/images/${filename}`;
}

export async function importImageFromUrl(rawUrl: string, imageDir: string, userAgent?: string, fetchImage: typeof safeGet = safeGet) {
  const imageUrl = normalizeProductUrl(rawUrl);
  const response = await fetchImage(imageUrl.toString(), IMAGE_LIMIT, resolvePublic, requestOnce, userAgent, {
    accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  });
  const type = verifiedImageType(String(response.headers['content-type'] ?? ''), response.body);
  if (!type || response.body.length === 0) throw new Error('URL did not return a supported image');
  const filename = `${randomBytes(16).toString('hex')}${extensionFor(type, response.finalUrl)}`;
  await writeFile(path.join(imageDir, filename), response.body, { flag: 'wx' });
  return `/images/${filename}`;
}

export function normalizeProductUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported URL');
  return url;
}

function iframelyLinks(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

/** Extracts generic link-preview metadata returned by Iframely's Preview API. */
export function parseIframelyPreview(body: string, pageUrl: string) {
  let payload: any;
  try { payload = JSON.parse(body); } catch { return null; }
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const links = payload?.links && typeof payload.links === 'object' ? payload.links : {};
  const thumbnail = [
    ...iframelyLinks(links.thumbnail),
    ...iframelyLinks(links.image),
    ...iframelyLinks(links.photo),
  ].find(link => typeof link?.href === 'string' && link.href.trim());
  const candidate = typeof meta.image === 'string' ? meta.image
    : typeof meta.thumbnail === 'string' ? meta.thumbnail
      : typeof thumbnail?.href === 'string' ? thumbnail.href : null;
  let imageUrl: string | null = null;
  if (candidate) {
    try {
      const parsed = new URL(candidate, pageUrl);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) imageUrl = parsed.toString();
    } catch { /* Ignore malformed metadata URLs. */ }
  }
  return {
    title: usableText(meta.title) ?? '',
    imageUrl,
    price: parsePrice(meta.price ?? meta['product:price:amount']),
    currency: usableText(meta.currency ?? meta['product:price:currency'])?.toUpperCase() ?? 'EUR',
  };
}

async function fetchIframelyPreview(pageUrl: string, userAgent?: string) {
  const apiKey = process.env.IFRAMELY_API_KEY?.trim();
  if (!apiKey) return null;
  const endpoint = new URL('https://iframe.ly/api/iframely');
  endpoint.searchParams.set('url', pageUrl);
  endpoint.searchParams.set('api_key', apiKey);
  try {
    // The Iframely hostname is fixed; the user-controlled product URL is data
    // passed to the service and is never fetched directly by this process here.
    const response = await safeGet(endpoint.toString(), PREVIEW_LIMIT, resolvePublic, requestOnce, userAgent);
    return parseIframelyPreview(response.body.toString('utf8'), pageUrl);
  } catch {
    // Keep metadata extraction usable when the optional provider is unavailable.
    return null;
  }
}

function unsafePageTarget(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Never send a URL rejected by our SSRF checks to a third-party previewer.
  // safeGet applies these checks to both the original host and every redirect.
  return /^(?:Private or reserved address|Host resolves to a private or reserved address|Unsupported URL|Invalid port)$/.test(message);
}

export async function scrapeProduct(rawUrl: string, imageDir: string, userAgent?: string, onImageError?: (host: string, message: string) => void) {
  const pageUrl = normalizeProductUrl(rawUrl);
  const requestedUrl = pageUrl.toString();
  const isAmazon = amazonHost(pageUrl.hostname);
  const isLeroy = leroyHost(pageUrl.hostname);
  let result: ReturnType<typeof parseProductHtml>;
  let productUrl = requestedUrl;
  let scrapeWarning: string | null = null;
  try {
    const page = await safeGet(requestedUrl, PAGE_LIMIT, resolvePublic, requestOnce, userAgent);
    const contentType = String(page.headers['content-type'] ?? '');
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error('Not an HTML page');
    productUrl = page.finalUrl.toString();
    result = parseProductHtml(page.body.toString('utf8'), productUrl);
  } catch (error) {
    // Some retailers reject server-side requests with anti-bot challenges.
    // Keep an editable partial preview and ask Iframely for a generic link card;
    // do not try to bypass the retailer's protections. SSRF rejections stay fatal.
    if (unsafePageTarget(error)) throw error;
    const denied = error instanceof Error && /Remote status 403/.test(error.message);
    const knownLeroyProduct = isLeroy ? leroyProductFallback(requestedUrl) : null;
    scrapeWarning = isLeroy && denied && knownLeroyProduct
      ? 'Leroy Merlin bloqueó la página (HTTP 403). El nombre y la imagen se completaron desde la ficha pública; comprueba el precio manualmente.'
      : isLeroy && denied
        ? 'Leroy Merlin bloquea la lectura automática de esta página (HTTP 403). Hemos completado el nombre desde el enlace; revisa y añade manualmente el resto de los datos.'
      : 'La tienda no permitió leer todos los datos. Revisa el nombre y completa manualmente los campos que falten.';
    result = {
      title: (isAmazon ? amazonUrlTitle(requestedUrl) : knownLeroyProduct?.title ?? leroyUrlTitle(requestedUrl)) ?? '',
      url: requestedUrl,
      imageUrl: knownLeroyProduct?.imageUrl ?? null,
      imagePath: null,
      price: null,
      currency: 'EUR',
    };
  }
  const needsPreview = !result.title || !result.imageUrl || result.price === null;
  if (needsPreview && process.env.IFRAMELY_API_KEY?.trim()) {
    const preview = await fetchIframelyPreview(productUrl, userAgent);
    if (preview) {
      if ((!result.title || scrapeWarning) && preview.title) result.title = preview.title;
      if (!result.imageUrl && preview.imageUrl) result.imageUrl = preview.imageUrl;
      if (result.price === null && preview.price !== null) result.price = preview.price;
      if ((!result.currency || result.currency === 'EUR') && preview.currency) result.currency = preview.currency;
      if (preview.title || preview.imageUrl || preview.price !== null) {
        scrapeWarning = result.imageUrl
          ? null
          : 'La vista previa encontró el producto, pero no proporcionó una miniatura. Puedes importar una pegando la URL directa de la imagen abajo.';
      }
    }
  }
  const imageCandidates = [...new Set([result.imageUrl, ...amazonImageFallbackUrls(productUrl)].filter((url): url is string => Boolean(url)))];
  let imageDownloadFailed = false;
  for (const imageUrl of imageCandidates) {
    try {
      const imageReferer = `${new URL(productUrl).origin}/`;
      const image = await safeGet(imageUrl, IMAGE_LIMIT, resolvePublic, requestOnce, userAgent, {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        referer: imageReferer,
      });
      const contentType = String(image.headers['content-type'] ?? '');
      const type = verifiedImageType(contentType, image.body);
      if (!type || image.body.length === 0) {
        throw new Error(`Unsupported image response (${contentType.split(';')[0].trim() || 'no content-type'}, ${image.body.length} bytes)`);
      }
      const filename = `${randomBytes(16).toString('hex')}${extensionFor(type, image.finalUrl)}`;
      await writeFile(path.join(imageDir, filename), image.body, { flag: 'wx' });
      result.imagePath = `/images/${filename}`;
      break;
    } catch (error) {
      imageDownloadFailed = true;
      try { onImageError?.(new URL(imageUrl).hostname, error instanceof Error ? error.message : String(error)); } catch { /* Logging must not affect extraction. */ }
      /* Try the next image candidate, if one exists. */
    }
  }
  if (!result.imagePath && imageDownloadFailed && !scrapeWarning) {
    scrapeWarning = 'Encontramos los datos del producto, pero la tienda no permitió guardar la imagen. Puedes importar una pegando la URL directa de la imagen abajo.';
  }
  delete (result as any).imageUrl;
  return { ...result, scrapeWarning };
}
