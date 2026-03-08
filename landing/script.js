const yearEl = document.getElementById('year');
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

const revealItems = document.querySelectorAll('.reveal');
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.12 },
);

revealItems.forEach((el) => observer.observe(el));

const demoTabs = document.querySelectorAll('.demo-tab');
const demoPanels = document.querySelectorAll('.demo-embed');

if (demoTabs.length > 0 && demoPanels.length > 0) {
  const tabList = demoTabs[0].parentElement;
  if (tabList && !tabList.hasAttribute('role')) {
    tabList.setAttribute('role', 'tablist');
  }

  demoTabs.forEach((tab) => {
    if (!tab.hasAttribute('role')) {
      tab.setAttribute('role', 'tab');
    }
  });

  demoPanels.forEach((panel) => {
    if (!panel.hasAttribute('role')) {
      panel.setAttribute('role', 'tabpanel');
    }
  });

  const activateTab = (newActiveTab) => {
    const targetId = newActiveTab.dataset.target;

    demoTabs.forEach((tab) => {
      const isActive = tab === newActiveTab;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    demoPanels.forEach((panel) => {
      const isTarget = panel.id === targetId;
      panel.hidden = !isTarget;
      panel.setAttribute('aria-hidden', isTarget ? 'false' : 'true');
    });
  };

  let initialActiveTab = null;
  demoTabs.forEach((tab) => {
    if (tab.classList.contains('active') && !initialActiveTab) {
      initialActiveTab = tab;
    }
  });
  if (!initialActiveTab) {
    initialActiveTab = demoTabs[0];
  }

  activateTab(initialActiveTab);

  demoTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      activateTab(tab);
    });

    tab.addEventListener('keydown', (event) => {
      const { key } = event;
      if (key !== 'ArrowRight' && key !== 'ArrowLeft' && key !== 'Home' && key !== 'End') {
        return;
      }

      event.preventDefault();

      const tabsArray = Array.prototype.slice.call(demoTabs);
      let newIndex = index;

      if (key === 'ArrowRight') {
        newIndex = (index + 1) % tabsArray.length;
      } else if (key === 'ArrowLeft') {
        newIndex = (index - 1 + tabsArray.length) % tabsArray.length;
      } else if (key === 'Home') {
        newIndex = 0;
      } else if (key === 'End') {
        newIndex = tabsArray.length - 1;
      }

      const newTab = tabsArray[newIndex];
      newTab.focus();
      activateTab(newTab);
    });
  });
}
