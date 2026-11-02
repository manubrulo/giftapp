import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amazonImageFallbackUrls, leroyProductFallback, normalizeProductUrl, parseIframelyPreview, parseProductHtml, safeGet, verifiedImageType } from './scrape.js';

test('normalizes pasted retailer links without a scheme while rejecting non-web protocols', () => {
  assert.equal(normalizeProductUrl('  lidl.es/p/parkside/p100411299  ').toString(), 'https://lidl.es/p/parkside/p100411299');
  assert.equal(normalizeProductUrl('//lidl.es/p/parkside/p100411299').toString(), 'https://lidl.es/p/parkside/p100411299');
  assert.throws(() => normalizeProductUrl('file:///etc/passwd'), /Unsupported URL/);
});

test('extracts JSON-LD product details and falls back to Open Graph and page title', () => {
  const jsonLd = parseProductHtml(`<html><script type="application/ld+json">{"@type":"Product","name":"Taza","image":"/taza.jpg","offers":{"price":"12.50","priceCurrency":"eur"}}</script><title>Otro</title></html>`, 'https://shop.example/a');
  assert.equal(jsonLd.title, 'Taza');
  assert.equal(jsonLd.imageUrl, 'https://shop.example/taza.jpg');
  assert.equal(jsonLd.price, 12.5);
  assert.equal(jsonLd.currency, 'EUR');
  const openGraph = parseProductHtml('<meta property="og:title" content="Juguete &amp; tren"><meta property="og:image" content="/tren.webp"><meta property="product:price:amount" content="22,99">', 'https://shop.example/toy');
  assert.equal(openGraph.title, 'Juguete & tren');
  assert.equal(openGraph.price, 22.99);
  assert.equal(parseProductHtml('<meta property="product:price:amount" content="1.234,56">', 'https://shop.example/eu').price, 1234.56);
  assert.equal(parseProductHtml('<meta property="product:price:amount" content="1,234.56">', 'https://shop.example/us').price, 1234.56);
  const fallback = parseProductHtml('<title>Producto sencillo</title><img src="/main.jpg">', 'https://shop.example/simple');
  assert.equal(fallback.title, 'Producto sencillo');
  assert.equal(fallback.imageUrl, 'https://shop.example/main.jpg');
  const incomplete = parseProductHtml('<main>Contenido sin metadatos</main>', 'https://shop.example/blocked');
  assert.equal(incomplete.title, '');
  assert.equal(incomplete.imagePath, null);
  assert.equal(incomplete.price, null);
});

test('reads generic title, product price and thumbnail from Iframely preview metadata', () => {
  const preview = parseIframelyPreview(JSON.stringify({
    meta: { title: 'Producto genérico', price: '19,95', currency: 'EUR' },
    links: { thumbnail: { href: 'https://cdn.example/product.webp', type: 'image' } },
  }), 'https://shop.example/product');
  assert.deepEqual(preview, {
    title: 'Producto genérico', imageUrl: 'https://cdn.example/product.webp', price: 19.95, currency: 'EUR',
  });
  assert.equal(parseIframelyPreview('{broken', 'https://shop.example/product'), null);
  assert.equal(parseIframelyPreview(JSON.stringify({ links: { thumbnail: { href: 'javascript:alert(1)' } } }), 'https://shop.example/product')?.imageUrl, null);
});

test('accepts generic octet-stream image responses only when their bytes are a supported image', () => {
  assert.equal(verifiedImageType('application/octet-stream', Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(verifiedImageType('binary/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(verifiedImageType('application/octet-stream', Buffer.from('<html>blocked</html>')), null);
  assert.equal(verifiedImageType('text/html', Buffer.from([0xff, 0xd8, 0xff])), null);
});

test('uses Amazon product-page fields and URL slug fallbacks on Amazon marketplaces', () => {
  const page = parseProductHtml(`<html>
    <title>Amazon.fr: Cuisine et Maison</title>
    <span id="productTitle"> Tefal Easy Cook &amp; Clean Marmite </span>
    <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/test.jpg" src="https://m.media-amazon.com/images/I/small.jpg">
    <div id="corePriceDisplay_desktop_feature_div"><span class="a-offscreen">29,99 €</span></div>
  </html>`, 'https://www.amazon.fr/Tefal-test/dp/B0862RFPTD/');
  assert.equal(page.title, 'Tefal Easy Cook & Clean Marmite');
  assert.equal(page.imageUrl, 'https://m.media-amazon.com/images/I/test.jpg');
  assert.equal(page.price, 29.99);
  assert.equal(page.currency, 'EUR');

  const fallback = parseProductHtml('<title>Amazon.es</title>', 'https://www.amazon.es/Juguete-para-ninos/dp/B0862RFPTD/');
  assert.equal(fallback.title, 'Juguete para ninos');
  const unrelated = parseProductHtml('<title>Amazonian puzzle</title>', 'https://notamazon.fr.example.com/product');
  assert.equal(unrelated.title, 'Amazonian puzzle');
  assert.deepEqual(amazonImageFallbackUrls('https://www.amazon.fr/Tefal/dp/B0862RFPTD/'), [
    'https://images-eu.ssl-images-amazon.com/images/P/B0862RFPTD.08._SL500_.jpg',
    'https://images-na.ssl-images-amazon.com/images/P/B0862RFPTD.08._SL500_.jpg',
  ]);
  assert.equal(amazonImageFallbackUrls('https://notamazon.fr.example.com/dp/B0862RFPTD').length, 0);
});

test('extracts Leroy Merlin Spain product title, gallery image, and price', () => {
  const page = parseProductHtml(`<html>
    <title>Producto | Leroy Merlin</title>
    <div id="js-main-carousel"><a href="https://media.adeo.com/media/4098413/media.png?fit=bounds&amp;width=125"><img alt="Fresadora DEXTER" src="https://media.adeo.com/media/4098413/media.png"></a></div>
    <h1 id="product-name">Fresadora DEXTER 1300 W - Velocidad variable hasta 30000 RPM</h1>
    <h2 id="a11y-product-detail-info">68,99 EUR</h2>
  </html>`, 'https://www.leroymerlin.es/productos/fresadora-dexter-1300-w-velocidad-variable-hasta-30000-rpm-91468364.html');
  assert.equal(page.title, 'Fresadora DEXTER 1300 W - Velocidad variable hasta 30000 RPM');
  assert.equal(page.imageUrl, 'https://media.adeo.com/media/4098413/media.png?fit=bounds&width=125');
  assert.equal(page.price, 68.99);
  assert.equal(page.currency, 'EUR');
  assert.deepEqual(leroyProductFallback('https://www.leroymerlin.es/productos/fresadora-dexter-1300-w-velocidad-variable-hasta-30000-rpm-91468364.html'), {
    title: 'Fresadora DEXTER 1300 W - Velocidad variable hasta 30000 RPM',
    imageUrl: 'https://media.adeo.com/media/4098413/media.png',
  });
  assert.equal(leroyProductFallback('https://www.leroymerlin.es/productos/otro-producto-12345678.html'), null);
});

test('extracts the public Bricorama gallery image from its Mousquetaires image proxy', () => {
  const page = parseProductHtml(`<html>
    <title>Ensemble pour murs et plafonds NUANCE</title>
    <img src="/assets/logo.svg" alt="Bricorama">
    <div class="product-gallery"><a href="/fstrz/r/s/assets-big.cdn-mousquetaires.com/medias/domain11440/media1402/210463-58xtllvmd8-epreview.jpg"><img src="/assets/placeholder.jpg" alt="NUANCE - Ensemble pour murs et plafonds - large"></a></div>
  </html>`, 'https://www.bricorama.fr/p/ensemble-pour-murs-et-plafonds/3505391032076');
  assert.equal(page.title, 'Ensemble pour murs et plafonds NUANCE');
  assert.equal(page.imageUrl, 'https://www.bricorama.fr/fstrz/r/s/assets-big.cdn-mousquetaires.com/medias/domain11440/media1402/210463-58xtllvmd8-epreview.jpg');

  const directCdn = parseProductHtml('<img src="https://assets-big.cdn-mousquetaires.com/medias/domain11440/media1402/item-main.jpg">', 'https://www.bricorama.fr/p/item/123');
  assert.equal(directCdn.imageUrl, 'https://assets-big.cdn-mousquetaires.com/medias/domain11440/media1402/item-main.jpg');
});

test('extracts hashed product gallery assets on Lidl France and Spain', () => {
  const france = parseProductHtml(`<html>
    <img src="/assets/lidl-logo.svg" alt="Lidl">
    <h1>Dénudeur PARKSIDE</h1>
    <img data-src="/assets/gcpaa71cf6efe1f4795a2c9a5bfb5db2ba8.jpg" alt="Un dénudeur de fils vert avec un couteau et un levier">
  </html>`, 'https://www.lidl.fr/p/parkside-denudeur/p100386044');
  assert.equal(france.imageUrl, 'https://www.lidl.fr/assets/gcpaa71cf6efe1f4795a2c9a5bfb5db2ba8.jpg');

  const spain = parseProductHtml(`<html>
    <h1>Juego de herramientas PARKSIDE</h1>
    <picture><source srcset="/assets/gcp25443455671d4c87b7415a4268de49a1.jpg 640w, /assets/gcp25443455671d4c87b7415a4268de49a1-large.jpg 1200w"><img src="/assets/placeholder.png"></picture>
  </html>`, 'https://www.lidl.es/p/parkside-juego-de-herramientas/p100396298');
  assert.equal(spain.imageUrl, 'https://www.lidl.es/assets/gcp25443455671d4c87b7415a4268de49a1.jpg');
});

test('extracts MediaMarkt Spain gallery image-service URLs', () => {
  const page = parseProductHtml(`<html>
    <title>Samsung Galaxy S26, Negro, 256 GB</title>
    <img src="/assets/logo.svg" alt="MediaMarkt">
    <div class="product-gallery"><img src="https://assets.mmsrg.com/isr/166325/c1/-/ASSET_MMS_171732933?align=center&amp;format=webp&amp;quality=60"></div>
  </html>`, 'https://www.mediamarkt.es/es/product/_movil-samsung-galaxy-s26-1620261.html');
  assert.equal(page.title, 'Samsung Galaxy S26, Negro, 256 GB');
  assert.equal(page.imageUrl, 'https://assets.mmsrg.com/isr/166325/c1/-/ASSET_MMS_171732933?align=center&format=webp&quality=60');
});

test('forwards the requesting browser User-Agent to retailer fetches', async () => {
  let receivedUserAgent: string | undefined;
  let receivedOptions: { accept?: string; referer?: string } | undefined;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36';
  await safeGet('https://shop.example/', 1024,
    async () => [{ address: '93.184.216.34', family: 4 }],
    async (_url, _addresses, _limit, forwardedUserAgent, options) => {
      receivedUserAgent = forwardedUserAgent;
      receivedOptions = options;
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    },
    userAgent,
    { accept: 'image/avif,image/*,*/*;q=0.8', referer: 'https://shop.example/' },
  );
  assert.equal(receivedUserAgent, userAgent);
  assert.deepEqual(receivedOptions, { accept: 'image/avif,image/*,*/*;q=0.8', referer: 'https://shop.example/' });
});

test('rejects private IPs and validates redirect targets before making a second request', async () => {
  let requests = 0;
  await assert.rejects(() => safeGet('https://shop.example/', 1024,
    async host => {
      if (host === 'shop.example') return [{ address: '93.184.216.34', family: 4 }];
      throw new Error('Private redirect target');
    },
    async () => { requests++; return { status: 302, headers: { location: 'http://127.0.0.1/internal' }, body: Buffer.alloc(0) }; },
  ));
  assert.equal(requests, 1);
});
