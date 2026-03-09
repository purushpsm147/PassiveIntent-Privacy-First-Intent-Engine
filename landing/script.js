const NAV_ITEMS = [
  { href: '#why-different', label: 'Why' },
  { href: '#how', label: 'How' },
  { href: '#use-cases', label: 'Use Cases' },
  { href: '#demo', label: 'Demo' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#articles', label: 'Articles' },
  { href: '#faq', label: 'FAQ' },
];

const START_HERE = [
  {
    label: 'Docs',
    title: 'Read the package docs',
    description:
      'Start with installation, APIs, event models, and calibration guidance for production use.',
    linkLabel: 'Open documentation',
    href: 'https://github.com/passiveintent/core/tree/main/packages/core',
  },
  {
    label: 'Demo',
    title: 'Try the guided lab',
    description:
      'Test hesitation, entropy, exit intent, and trajectory signals in the browser before integrating.',
    linkLabel: 'Jump to the live demo',
    href: '#demo',
  },
  {
    label: 'GitHub',
    title: 'Inspect the source',
    description:
      'Review the core package, React package, demo apps, and calibration guide in the public repo.',
    linkLabel: 'View GitHub repository',
    href: 'https://github.com/passiveintent/core',
  },
  {
    label: 'Pricing',
    title: 'Check pricing and licensing',
    description:
      'See the AGPL path, commercial tiers, and the license brief used for legal and procurement review.',
    linkLabel: 'Go to pricing',
    href: '#pricing',
  },
];

const PRODUCTS = [
  {
    status: 'Shipping now',
    statusClass: '',
    title: 'PassiveIntent Core Library',
    description:
      'The current offering: on-device intent detection for checkout, pricing, billing, and support-sensitive flows.',
    chips: ['Core JS package', 'React package', 'Live guided lab'],
    warmChips: [],
  },
  {
    status: 'Planned',
    statusClass: 'product-status-warm',
    title: 'Sentinel',
    description:
      'A future SDK for higher-sensitivity behavioral signals and insider-risk use cases. The direction is public, but the product is not being fully unveiled yet.',
    chips: ['Insider-risk focus'],
    warmChips: ['Details later'],
  },
  {
    status: 'Planned',
    statusClass: 'product-status-warm',
    title: 'Integration Layer',
    description:
      'Packaged integrations for commerce, CRM, and SaaS surfaces so teams can deploy the core library faster in real environments.',
    chips: ['Salesforce', 'Adobe Commerce'],
    warmChips: ['Shopify', 'BigCommerce', 'Wix'],
  },
];

const INTEGRATIONS = {
  available: [
    {
      title: 'Core SDK + React Package',
      status: 'Available',
      warm: false,
      description:
        'Production-ready npm packages for browser apps and React teams adopting the engine directly.',
      linkLabel: 'Open npm and package docs',
      href: 'https://www.npmjs.com/package/@passiveintent/core',
    },
    {
      title: 'Guided StackBlitz Demos',
      status: 'Live',
      warm: false,
      description:
        'Two public demos with matching UI shells so teams can evaluate the engine quickly in either implementation style.',
      linkLabel: 'Launch the demo theater',
      href: '#demo',
    },
    {
      title: 'Docs + Calibration Guide',
      status: 'Available',
      warm: false,
      description:
        'Implementation docs and tuning guidance for teams moving from evaluation into real intervention logic.',
      linkLabel: 'Open the calibration guide',
      href: 'https://github.com/passiveintent/core/blob/main/CALIBRATION_GUIDE.md',
    },
  ],
  planned: [
    {
      title: 'Salesforce',
      status: 'Planned',
      warm: true,
      description:
        'CRM-oriented workflows for account context, customer journeys, and recovery playbooks.',
    },
    {
      title: 'Adobe Commerce',
      status: 'Planned',
      warm: true,
      description:
        'A packaged path for checkout and storefront signals in more complex commerce environments.',
    },
    {
      title: 'Shopify',
      status: 'Planned',
      warm: true,
      description:
        'A simpler deployment path for merchant storefronts that want faster time to value.',
    },
    {
      title: 'BigCommerce',
      status: 'Planned',
      warm: true,
      description:
        'Another packaged commerce surface for teams standardizing on hosted storefront platforms.',
    },
    {
      title: 'Wix',
      status: 'Planned',
      warm: true,
      description:
        'A lightweight integration path for sites that need easier deployment without custom frontend work.',
    },
  ],
};

const ARTICLES = [
  {
    source: 'Medium',
    title: 'Why privacy-first intent detection belongs in the browser',
    description:
      'A category-level essay on zero-egress intent modeling and why it matters for teams that care about privacy.',
    live: false,
    linkLabel: 'Medium post coming soon',
  },
  {
    source: 'dev.to',
    title: 'Implementation notes from the guided demo',
    description:
      'A developer walkthrough of the core package, signal model, and intervention patterns shown in the demo.',
    live: false,
    linkLabel: 'dev.to post coming soon',
  },
  {
    source: 'Substack',
    title: 'Founder note on product direction',
    description:
      'Product thinking, launch context, and occasional updates on where the platform is heading.',
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
  if (!nav) return;
  nav.innerHTML = NAV_ITEMS.map((item) => `<a href="${item.href}">${item.label}</a>`).join('');
}

function getLinkAttributes(href) {
  return /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

function renderProducts() {
  const container = document.getElementById('products-grid');
  if (!container) return;

  container.innerHTML = PRODUCTS.map(
    (product) => `
      <article class="product-card">
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
  if (!container) return;

  container.innerHTML = START_HERE.map(
    (item) => `
      <article class="start-card">
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
  const planned = document.getElementById('integrations-planned');
  if (!available || !planned) return;

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

  planned.innerHTML = INTEGRATIONS.planned
    .map(
      (item) => `
      <article class="integration-item">
        <div class="integration-head">
          <h4>${item.title}</h4>
          <span class="integration-pill ${item.warm ? 'warm' : ''}">${item.status}</span>
        </div>
        <p>${item.description}</p>
      </article>
    `,
    )
    .join('');
}

function renderArticles() {
  const container = document.getElementById('articles-grid');
  if (!container) return;

  container.innerHTML = ARTICLES.map((article) => {
    const linkMarkup = article.live
      ? `<a class="article-link" href="${article.href}"${getLinkAttributes(article.href)}>${article.linkLabel}</a>`
      : `<span class="article-link article-link-disabled">${article.linkLabel}</span>`;

    return `
      <article class="article-card">
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

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.14 },
  );

  revealItems.forEach((item) => observer.observe(item));
}

function setupDemoTabs() {
  const demoTabs = Array.from(document.querySelectorAll('.demo-tab'));
  const demoPanels = Array.from(document.querySelectorAll('.demo-panel'));
  if (!demoTabs.length || !demoPanels.length) return;

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

  activateTab(demoTabs[0]);
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
