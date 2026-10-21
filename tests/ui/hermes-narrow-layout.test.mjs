import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const widths = [320, 375, 390, 1280];
const css = await readFile('src/web/styles.css', 'utf8');
const appSource = await readFile('src/web/app.tsx', 'utf8');
const brainSource = await readFile('src/web/components/BrainPreview.tsx', 'utf8');

// Deliberately an offline mock layout: source CSS and class/markup contracts are
// checked against the repository, while static recommendation/review/preference
// content is rendered with page.setContent. The app, server, APIs, and DB do not run.
const markup = `
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<div class="shell shop-pad">
  <header class="top">
    <form class="search-field">
      <span class="field-ico"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>
      <input placeholder="상품 검색" value="">
    </form>
    <button class="icon-btn" aria-label="내 쇼핑"><svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
    <button class="icon-btn" aria-label="장바구니"><svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M3 4h2l2.3 11.2a2 2 0 0 0 2 1.6h8.9a2 2 0 0 0 1.9-1.5L22 8H6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </header>
</div>
<aside class="agent-panel brain-panel" aria-label="토스쇼핑 AI Brain">
  <div class="agent-head"><div class="brain-brand"><span class="brain-avatar" aria-hidden="true">✦</span><div><b>토스쇼핑 AI Brain</b><div class="muted sm">나만의 쇼핑 전담 AI 비서</div></div></div><button class="link">닫기</button></div>
  <div class="agent-body">
    <div class="brain-turn">
      <div class="brain-assistant-message"><span class="brain-avatar" aria-hidden="true">✦</span><div class="msg ai"><p>조건에 맞는 상품을 비교했어요.</p></div></div>
      <section class="brain-products" aria-label="상품 비교 결과">
        <p class="muted sm">1개 상품 표시</p>
        <article class="brain-recommendation"><div class="brain-product-card">
          <header class="brain-product-card-header"><span class="brain-rank">1순위</span><span class="muted sm">나에게 맞춤</span></header>
          <div class="brain-product-main"><div class="brain-product-image"><span>상품 이미지</span></div>
          <div class="brain-product-info"><div class="brain-product-heading"><div class="brain-product-summary"><b class="brain-product-name">가벼운 무선 이어폰 추천 상품</b><dl class="brain-price-breakdown" aria-label="상품 가격 구성"><div><dt>상품가</dt><dd>119,000원</dd></div><div><dt>배송비</dt><dd>무료</dd></div><div class="brain-price-total"><dt>배송비 포함 합계</dt><dd>119,000원</dd></div></dl></div><button class="link brain-product-open">상품 보기<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"></svg></button></div></div></div>
        </div><div class="brain-assistant-message brain-product-explanation"><span class="brain-avatar" aria-hidden="true">✦</span><div class="msg ai"><div class="brain-product-reason">확인한 상품 정보와 요청 조건을 기준으로 정리했어요.</div></div></div></article>
      </section>
      <section class="brain-review-summary state-box" aria-label="해당 상품 리뷰 요약"><div class="brain-review-summary-header"><b>무선 이어폰 사용 후기 요약</b><p class="muted sm">확인한 리뷰 3건</p></div><details class="brain-review-citations"><summary>확인한 리뷰 근거 보기 (3건)</summary><ul><li>착용감이 편하고 오래 사용해도 부담이 적어요.<small>구매 후기 · 2026</small></li></ul></details></section>
      <section class="brain-preference-save state-box"><div class="brain-preference-intro"><h3>가격 선호 저장</h3><p>다음 추천부터 반영할 가격 기준을 선택하세요.</p></div><div class="brain-preference-field"><label for="price-priority">가격 기준</label><select id="price-priority"><option>가성비 중심</option></select></div><div class="brain-preference-actions"><button class="btn primary">저장하기</button><button class="btn">취소</button></div><button class="link brain-preference-retry">저장된 선호 다시 확인</button><p class="brain-preference-note">원할 때 저장하고, 나중에 바꿀 수 있어요.</p></section>
    </div>
  </div>
  <div class="agent-input"><input aria-label="메시지 또는 원하는 조건" placeholder="쇼핑 조건을 입력하세요"><button class="btn primary brain-send" aria-label="보내기"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"></svg></button></div>
</aside>`;

test('offline mock layout keeps repository header and Brain fixtures within narrow viewports', { timeout: 30000 }, async () => {
  assert.ok(appSource.includes('<header className={"top" + (miniTop ? " mini" : "")}>'));
  assert.ok(appSource.includes('className="search-field"'));
  assert.ok(appSource.includes('<span className="field-ico">'));
  assert.ok(appSource.includes('placeholder="상품 검색"'));
  assert.ok(appSource.includes('aria-label="내 쇼핑"'));
  assert.ok(appSource.includes('aria-label="장바구니"'));
  assert.match(appSource, /className="icon-btn"/);
  assert.match(brainSource, /className="brain-product-card"/);
  assert.match(brainSource, /className="brain-review-summary state-box"/);
  assert.ok(brainSource.includes('className="state-box brain-preference-save"'));
  for (const className of [
    'brain-products', 'brain-product-image', 'brain-product-info', 'brain-product-heading',
    'brain-product-summary', 'brain-product-name', 'brain-price-breakdown', 'brain-price-total',
    'brain-product-open', 'brain-product-reason', 'brain-review-summary-header',
    'brain-review-citations', 'brain-preference-intro', 'brain-preference-field',
    'brain-preference-actions', 'brain-preference-retry', 'brain-preference-note',
    'agent-panel', 'agent-head', 'agent-body', 'agent-input', 'brain-send',
  ]) {
    assert.ok(
      new RegExp(`className="[^"]*\\b${className}\\b[^"]*"`).test(`${appSource}\n${brainSource}`),
      `fixture class is missing from repository JSX: ${className}`,
    );
  }

  const browser = await chromium.launch({ headless: true });
  const run = process.env.LAYOUT_RUN ?? 'manual';
  await mkdir('.local-data/e2e-fixes', { recursive: true });
  const measurements = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      await page.setContent(markup, { waitUntil: 'load' });
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        const controls = [...document.querySelectorAll(
          '.brain-preference-field select, .brain-preference-actions .btn, .brain-preference-retry, .brain-send'
        )].map((element) => ({
          selector: element.className || element.tagName.toLowerCase(),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }));
        return {
          viewport: root.clientWidth,
          document: root.scrollWidth,
          body: document.body.scrollWidth,
          header: document.querySelector('.top').getBoundingClientRect().width,
          searchField: document.querySelector('.search-field').getBoundingClientRect().width,
          controls,
        };
      });
      measurements.push({ width, ...metrics });
      await page.screenshot({ path: `.local-data/e2e-fixes/layout-${run}-${width}.png`, fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log('layout measurements:', JSON.stringify(measurements));
  for (const result of measurements) {
    assert.ok(
      result.document <= result.viewport,
      `document overflow at ${result.width}px: scrollWidth=${result.document}, clientWidth=${result.viewport}`,
    );
    for (const control of result.controls) {
      assert.ok(
        control.height >= 44,
        `44px control shrank at ${result.width}px: ${control.selector} height=${control.height}`,
      );
    }
  }
});



test('actual React app shell keeps header and Brain results within narrow viewports (mock APIs, real bundle)', { timeout: 120000 }, async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { writeFile } = await import('node:fs/promises');

  const conversationId = '11111111-1111-4111-8111-111111111111';
  const messageId = '22222222-2222-4222-8222-222222222222';
  const reply = {
    conversation_id: conversationId,
    message_id: messageId,
    read_only: true,
    intent_kind: 'SHOPPING_SEARCH',
    shopping_plan: { query: '무선 이어폰', maxTotalWon: 200000, requiredConditions: [], revision: 1 },
    agent_ui: null,
    shopping_handoffs: [],
    review_summary: {
      productId: 'fixture-product',
      name: '무선 이어폰 사용 후기 요약',
      sampled: 3,
      totalMatching: 5,
      citations: [{
        sourceId: 'fixture-review-1',
        quote: '착용감이 편하고 오래 사용해도 부담이 적어요.',
        sourceKind: 'SYNTHETIC',
        sourceVariantId: null,
      }],
    },
    explanation: {
      text: '조건에 맞는 상품을 비교했어요.',
      kind: 'SHOPPING_SEARCH',
      items: [{
        productId: 'fixture-product',
        variantId: 'fixture-variant',
        evidenceIds: ['fixture-review-1'],
        reason: '배송비 포함 119,000원으로 말씀하신 예산 안에서 고를 수 있어요. 표시한 상품 중 배송비 포함 가격이 가장 낮아요. 구성: 1개',
      }],
      limitations: [],
    },
    ranking: {
      ranked: [{
        candidate: {
          productId: 'fixture-product',
          productName: '가벼운 무선 이어폰 추천 상품',
          variantId: 'fixture-variant',
          unitPriceWon: 119000,
          shippingFeeWon: 0,
          rating: 4.6,
          ratingScale: 5,
          wholeReviewCount: 120,
          wholeReviewCountVerified: true,
          commerceVerified: true,
          keywords: ['무선', '가벼운'],
        },
        score: 0.91,
        evidenceCoverage: 1,
        recommendationRole: 'PERSONALIZED',
      }],
      referenceOnly: [],
      rejected: [],
      evaluatedCount: 1,
    },
    trace: { totalMs: 12 },
  };
  reply.ranking.ranked.push({
    ...reply.ranking.ranked[0],
    candidate: { ...reply.ranking.ranked[0].candidate, productId: 'fixture-product-2', variantId: 'fixture-variant-2', productName: '두 번째 비교 상품', unitPriceWon: 129000 },
  });
  reply.explanation.items.push({ productId: 'fixture-product-2', variantId: 'fixture-variant-2', evidenceIds: [], reason: '배송비 포함 129,000원이에요. 구성: 1개' });
  const historyPayload = {
    ok: true,
    data: {
      conversationId,
      entries: [{
        text: '무선 이어폰 추천해줘',
        clientActionId: 'fixture-action',
        conversationId,
        status: 'completed',
        reply,
      }],
    },
  };
  const mockPayloads = new Map([
    ['GET /api/brain/status', { ok: true, data: { enabled: true, read_only: true, mode: 'grounded_research' } }],
    ['GET /api/brain/history', historyPayload],
    ['GET /api/brain/conversations', { ok: true, data: { conversations: [] } }],
    ['GET /api/brain/preferences', { ok: true, data: [] }],
    ['GET /api/catalog/context', { ok: true, data: {
      read_only: true, is_simulated: true, cart_enabled: false, wishlist_enabled: false, checkout_enabled: false,
    } }],
    ['GET /api/products', { ok: true, data: { items: [], has_more: false, next_cursor: null } }],
  ]);

  // REAL UI: serve the repository's app shell, built React bundle, and stylesheet.
  // MOCK API: all /api/* replies come from this isolated in-process server; unknown paths fail closed.
  const staticFiles = new Map([
    ['/', { body: await readFile('index.html'), type: 'text/html; charset=utf-8' }],
    ['/web/app.js', { body: await readFile('web/app.js'), type: 'text/javascript; charset=utf-8' }],
    ['/web/styles.css', { body: await readFile('src/web/styles.css'), type: 'text/css; charset=utf-8' }],
  ]);
  assert.ok(staticFiles.get('/web/app.js').body.length > 100000, 'built web/app.js must be present');
  const apiRequests = [];
  const unknownApiRequests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const method = req.method || 'GET';
      apiRequests.push(method + ' ' + url.pathname);
      if (url.pathname === '/api/session' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, user: { id: 'playwright-owner', display_name: 'UI fixture' } }));
        return;
      }
      const key = method + ' ' + url.pathname;
      if (mockPayloads.has(key)) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(mockPayloads.get(key)));
        return;
      }
      unknownApiRequests.push(key);
      res.writeHead(501, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: 'UNMOCKED_API', message: 'No fixture for ' + key } }));
      return;
    }
    const asset = staticFiles.get(url.pathname);
    if (!asset) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
    res.end(asset.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const run = (process.env.LAYOUT_RUN || 'manual') + '-' + Date.now();
  const artifactBase = '.local-data/e2e-fixes/layout-react-' + run;
  await mkdir('.local-data/e2e-fixes', { recursive: true });
  const measurements = [];
  const pageErrors = [];
  let browser;
  let failure = null;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of widths) for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 960 }, colorScheme, isMobile: true, hasTouch: true });
      page.on('pageerror', error => pageErrors.push(String(error)));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        return route.abort();
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.locator('.top .search-field').waitFor({ state: 'visible' });
      await page.locator('.bottom-nav button[title="AI 쇼핑 도우미"]').click();
      await page.locator('.brain-panel').waitFor({ state: 'visible' });
      await page.locator('.brain-product-card').first().waitFor({ state: 'visible' });
      await page.locator('.brain-review-summary').waitFor({ state: 'visible' });
      await page.locator('.brain-preference-save').waitFor({ state: 'visible' });
      const groups = page.locator('.brain-recommendation');
      assert.equal(await groups.count(), 2, 'each product and explanation form one ordered recommendation');
      assert.deepEqual(await groups.locator('.brain-product-card-header .brain-rank').allTextContents(), ['1순위', '2순위']);
      assert.equal(await page.locator('.brain-product-image .brain-rank').count(), 0, 'rank must not cover the product image');
      assert.equal(await groups.first().locator('.brain-product-card .brain-product-reason').count(), 0);
      assert.equal(await groups.first().locator('.brain-product-explanation .brain-product-reason .brain-answer p').count(), 3, 'budget, comparison and composition use separate paragraphs');
      assert.equal(await groups.locator('.brain-product-exclude, .brain-product-footer').count(), 0, 'no exclusion control or empty footer');
      const separation = await groups.first().evaluate(group => {
        const card=group.querySelector('.brain-product-card'), header=group.querySelector('.brain-product-card-header'), image=group.querySelector('.brain-product-image');
        return { badgeAboveImage: header.getBoundingClientRect().bottom <= image.getBoundingClientRect().top,
          explanationBelowCard: card.getBoundingClientRect().bottom <= group.querySelector('.brain-product-explanation').getBoundingClientRect().top };
      });
      assert.ok(separation.badgeAboveImage && separation.explanationBelowCard, 'rank, product and explanation occupy separate vertical regions');

      const metrics = await page.evaluate(() => {
        const rect = selector => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height, right: box.right };
        };
        const root = document.documentElement;
        const controls = [...document.querySelectorAll(
          '.brain-preference-field select, .brain-preference-actions .btn, .brain-send, .brain-product-open'
        )].map(element => ({
          selector: element.id || element.className || element.tagName.toLowerCase(),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }));
        return {
          viewport: window.innerWidth,
          documentClientWidth: root.clientWidth,
          documentScrollWidth: root.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          header: rect('.top'),
          searchField: rect('.top .search-field'),
          brainPanel: rect('.brain-panel'),
          productCard: rect('.brain-product-card'),
          reviewCard: rect('.brain-review-summary'),
          preferenceCard: rect('.brain-preference-save'),
          controls,
        };
      });
      measurements.push({ width, colorScheme, ...metrics });
      await page.screenshot({ path: artifactBase + '-' + width + '-' + colorScheme + '.png', fullPage: true });
      await page.close();
    }

    assert.deepEqual(unknownApiRequests, [], 'browser must use only the declared mock API payloads');
    assert.ok(apiRequests.includes('GET /api/brain/status'), 'mock Brain status API was used');
    assert.ok(apiRequests.includes('GET /api/brain/history'), 'mock Brain history payload rendered through React');
    assert.deepEqual(pageErrors, [], 'real React bundle should render without browser errors');
    for (const result of measurements) {
      assert.equal(result.documentClientWidth, result.width, 'viewport CSS width at ' + result.width + 'px');
      assert.ok(result.documentScrollWidth <= result.documentClientWidth,
        'actual app document overflow at ' + result.width + 'px: scrollWidth=' + result.documentScrollWidth);
      assert.ok(result.bodyScrollWidth <= result.documentClientWidth,
        'actual app body overflow at ' + result.width + 'px: scrollWidth=' + result.bodyScrollWidth);
      assert.ok(result.header && result.searchField && result.searchField.width > 0,
        'actual header search field must render at ' + result.width + 'px');
      assert.ok(result.brainPanel && result.productCard && result.reviewCard && result.preferenceCard,
        'real Brain recommendation, review, and preference cards must render at ' + result.width + 'px');
      for (const control of result.controls) {
        assert.ok(control.height >= 44,
          '44px Brain control shrank at ' + result.width + 'px: ' + control.selector + ' height=' + control.height);
      }
    }
  } catch (error) {
    failure = String(error && error.stack || error);
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const report = {
      mode: 'real React render from index.html + web/app.js + src/web/styles.css; API payloads mocked in isolated in-process HTTP server',
      productionServer: false,
      database: false,
      externalNetwork: false,
      measurements,
      mockedApiRequests: apiRequests,
      unknownApiRequests,
      pageErrors,
      failure,
    };
    await writeFile(artifactBase + '.log', JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('actual React layout evidence:', artifactBase, JSON.stringify(measurements));
  }
});
