const NAV_ITEMS = [
  { href: '#why-different', label: 'Why' },
  { href: '#how', label: 'How' },
  { href: '#demo', label: 'Demo' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#articles', label: 'Articles' },
];

const START_HERE = [
  {
    label: 'Docs',
    title: 'Documentation',
    description: 'Installation, APIs, and calibration guidance for teams moving toward production.',
    linkLabel: 'Open docs',
    href: 'https://github.com/passiveintent/core/tree/main/packages/core',
  },
  {
    label: 'Demo',
    title: 'Live demo',
    description:
      'Run the guided lab and see hesitation, entropy, exit intent, and trajectory signals in motion.',
    linkLabel: 'Open demo',
    href: '#demo',
  },
  {
    label: 'GitHub',
    title: 'Source code',
    description:
      'Review the core package, React package, demo apps, and calibration guide in the public repo.',
    linkLabel: 'View GitHub',
    href: 'https://github.com/passiveintent/core',
  },
  {
    label: 'Pricing',
    title: 'Pricing and licensing',
    description:
      'See the AGPL path, commercial tiers, and the brief used for legal and procurement review.',
    linkLabel: 'See pricing',
    href: '#pricing',
  },
];

const PRODUCTS = [
  {
    status: 'Shipping now',
    statusClass: '',
    title: 'PassiveIntent Core Library',
    description:
      'The shipping library for in-session intent detection across checkout, pricing, billing, and support-sensitive flows.',
    chips: ['JavaScript', 'React', 'Guided demo'],
    warmChips: [],
  },
  {
    status: 'Planned',
    statusClass: 'product-status-warm',
    title: 'Sentinel',
    description:
      'A future SDK for higher-sensitivity behavioral signals and insider-risk use cases. It is mentioned here only so the product family has shape.',
    chips: ['Future SDK'],
    warmChips: ['Insider-risk focus'],
  },
  {
    status: 'Planned',
    statusClass: 'product-status-warm',
    title: 'Integration Layer',
    description:
      'Packaged integrations for commerce, CRM, and SaaS surfaces so teams can bring the core library into real environments faster.',
    chips: ['Commerce', 'CRM'],
    warmChips: ['Shopify', 'BigCommerce', 'Salesforce'],
  },
];

const INTEGRATIONS = {
  available: [
    {
      title: 'Core SDK + React Package',
      status: 'Available',
      warm: false,
      description:
        'Shipping packages for browser apps and React teams adopting the library directly.',
      linkLabel: 'Open packages',
      href: 'https://www.npmjs.com/package/@passiveintent/core',
    },
    {
      title: 'Guided demos',
      status: 'Live',
      warm: false,
      description:
        'Two public demos with matching UI shells so teams can evaluate the product quickly in either implementation style.',
      linkLabel: 'Launch demo',
      href: '#demo',
    },
    {
      title: 'Docs + calibration',
      status: 'Available',
      warm: false,
      description:
        'Implementation docs and tuning guidance for teams moving from evaluation into production logic.',
      linkLabel: 'Open guide',
      href: 'https://github.com/passiveintent/core/blob/main/CALIBRATION_GUIDE.md',
    },
  ],
};

const ARTICLES = [
  {
    source: 'Medium',
    title: 'Why zero-egress intent detection belongs in the browser',
    description:
      'A category piece on why privacy-first intent modeling should happen close to the session.',
    live: false,
    linkLabel: 'Medium post coming soon',
  },
  {
    source: 'dev.to',
    title: 'Implementation notes from the guided lab',
    description:
      'A developer walkthrough of the core package, signal model, and intervention patterns shown in the lab.',
    live: false,
    linkLabel: 'dev.to post coming soon',
  },
  {
    source: 'Substack',
    title: 'A note on product direction',
    description:
      'Product thinking, launch context, and occasional notes on where the platform is heading.',
    live: false,
    linkLabel: 'Substack post coming soon',
  },
  {
    source: 'Hacker News',
    title: 'Launch thread or technical discussion',
    description:
      'A Show HN, launch post, or public technical thread worth sending curious visitors to.',
    live: false,
    linkLabel: 'HN thread coming soon',
  },
];

function renderNav() {
  const nav = document.getElementById('site-nav');
  if (!nav || nav.children.length > 0) return; // Skip if nav already has pre-rendered content
  nav.innerHTML = NAV_ITEMS.map((item) => `<a href="${item.href}">${item.label}</a>`).join('');
}

function getLinkAttributes(href) {
  return /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

function renderProducts() {
  const container = document.getElementById('products-grid');
  if (!container || container.children.length > 0) return; // Skip if products already pre-rendered

  container.innerHTML = PRODUCTS.map(
    (product, index) => `
      <article class="product-card ${index === 0 ? 'product-card-featured-main' : ''}">
        <span class="product-status ${product.statusClass}">${product.status}</span>
        <h3>${product.title}</h3>
        <p>${product.description}</p>
        <div class="product-card-foot">
          ${product.chips.map((chip) => `<span class="product-chip">${chip}</span>`).join('')}
          ${product.warmChips.map((chip) => `<span class="product-chip warm">${chip}</span>`).join('')}
        </div>
      </article>
    `,
  ).join('');
}

function renderStartHere() {
  const container = document.getElementById('start-grid');
  if (!container || container.children.length > 0) return; // Skip if start here already pre-rendered

  container.innerHTML = START_HERE.map(
    (item) => `
      <article class="start-card start-card-compact">
        <span class="article-source">${item.label}</span>
        <h3>${item.title}</h3>
        <p>${item.description}</p>
        <a class="start-link" href="${item.href}"${getLinkAttributes(item.href)}>${item.linkLabel}</a>
      </article>
    `,
  ).join('');
}

function renderIntegrations() {
  const available = document.getElementById('integrations-available');
  if (!available || available.children.length > 0) return; // Skip if integrations already pre-rendered

  available.innerHTML = INTEGRATIONS.available
    .map(
      (item) => `
      <article class="integration-item">
        <div class="integration-head">
          <h4>${item.title}</h4>
          <span class="integration-pill ${item.warm ? 'warm' : ''}">${item.status}</span>
        </div>
        <p>${item.description}</p>
        <a class="integration-link" href="${item.href}"${getLinkAttributes(item.href)}>${item.linkLabel}</a>
      </article>
    `,
    )
    .join('');
}

function renderArticles() {
  const container = document.getElementById('articles-grid');
  if (!container || container.children.length > 0) return; // Skip if articles already pre-rendered

  container.innerHTML = ARTICLES.map((article) => {
    const linkMarkup = article.live
      ? `<a class="article-link" href="${article.href}"${getLinkAttributes(article.href)}>${article.linkLabel}</a>`
      : `<span class="article-link article-link-disabled">${article.linkLabel}</span>`;

    return `
      <article class="article-card article-card-row">
        <div>
          <span class="article-source">${article.source}</span>
          <h3>${article.title}</h3>
          <p>${article.description}</p>
        </div>
        ${linkMarkup}
      </article>
    `;
  }).join('');
}

function setupReveal() {
  const revealItems = document.querySelectorAll('.reveal');
  if (!revealItems.length) return;

  // Progressive enhancement: hide elements after JS loads so page is readable if JS fails.
  revealItems.forEach((item) => item.classList.add('reveal-hidden'));

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.remove('reveal-hidden');
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }
    },
    // Keep oversized mobile sections eligible for reveal; tall panels like Art of Possible
    // can never hit a higher intersection ratio on smaller viewports.
    { threshold: 0.08 },
  );

  revealItems.forEach((item) => observer.observe(item));
}

function getStackBlitzDemoSupport() {
  const userAgent = navigator.userAgent || '';
  const isMobileDevice =
    window.matchMedia('(max-width: 900px)').matches ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  const iframe = document.createElement('iframe');
  const supportsEmbeddedPreview = 'credentialless' in iframe;

  if (isMobileDevice) {
    return {
      supported: false,
      status: 'Open on a laptop in Chrome or Edge',
      message:
        'This interactive demo is intentionally desktop-only. Open it on a laptop or desktop in Chrome, Edge, or another Chromium-based browser.',
    };
  }

  if (!supportsEmbeddedPreview) {
    return {
      supported: false,
      status: 'Open on desktop Chrome or Edge',
      message:
        'Embedded StackBlitz previews are not supported in this browser. Open the full demo on a laptop or desktop in Chrome, Edge, or another Chromium-based browser.',
    };
  }

  return {
    supported: true,
    status: 'Feature lab parity',
    message: '',
  };
}

function setupDemoTabs() {
  const demoTabs = Array.from(document.querySelectorAll('.demo-tab'));
  const demoPanels = Array.from(document.querySelectorAll('.demo-panel'));
  if (!demoTabs.length || !demoPanels.length) return;

  const demoSupport = getStackBlitzDemoSupport();
  if (!demoSupport.supported) {
    const status = document.querySelector('.demo-status');
    if (status) status.textContent = demoSupport.status;

    demoPanels.forEach((panel) => {
      panel.classList.add('demo-panel-fallback');

      const iframe = panel.querySelector('iframe');
      if (iframe) {
        iframe.hidden = true;
        iframe.setAttribute('aria-hidden', 'true');
      }

      if (!panel.querySelector('.demo-fallback')) {
        const fallback = document.createElement('p');
        fallback.className = 'demo-fallback';
        fallback.textContent = demoSupport.message;

        const link = panel.querySelector('.demo-open-link');
        panel.insertBefore(fallback, link ?? null);
      }
    });
  }

  const activateTab = (nextTab) => {
    const targetId = nextTab.dataset.target;
    demoTabs.forEach((tab) => {
      const active = tab === nextTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });

    demoPanels.forEach((panel) => {
      const active = panel.id === targetId;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', active ? 'false' : 'true');

      // Lazy-load iframe on first tab activation
      if (active && demoSupport.supported) {
        const iframe = panel.querySelector('iframe');
        if (iframe && !iframe.src && iframe.dataset.src) {
          iframe.src = iframe.dataset.src;
        }
      }
    });
  };

  demoTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(event.key)) return;

      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % demoTabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + demoTabs.length) % demoTabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = demoTabs.length - 1;

      const nextTab = demoTabs[nextIndex];
      nextTab.focus();
      activateTab(nextTab);
    });
  });

  const initialTab =
    demoTabs.find(
      (tab) => tab.classList.contains('active') || tab.getAttribute('aria-selected') === 'true',
    ) ?? demoTabs[0];

  activateTab(initialTab);
}

function setupBackToTop() {
  const button = document.getElementById('back-to-top');
  const header = document.getElementById('site-header');
  if (!button || !header) return;

  const sync = () => {
    const scrolled = window.scrollY > 24;
    const showButton = window.scrollY > window.innerHeight * 0.8;
    header.classList.toggle('is-scrolled', scrolled);
    button.hidden = !showButton;
  };

  sync();
  window.addEventListener('scroll', sync, { passive: true });
  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function setYear() {
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
}

renderNav();
renderStartHere();
renderProducts();
renderIntegrations();
renderArticles();
setupReveal();
setupDemoTabs();
setupBackToTop();
setYear();
