/**
 * NetSuite TactaSuite - Author and support links
 *
 * @author Blane Maher
 *
 * Single place for the author's name and outbound links (source repository,
 * LinkedIn, tip jar). Rendered in the popup footer, the Settings About
 * section and the last step of the setup walkthrough.
 *
 * Links with an empty url are not rendered. All links open in a new tab with rel=noopener; the
 * extension never embeds payment widgets or tracking pixels (Chrome Web Store
 * allows plain donation links, not in-page payment forms).
 */
(function () {
  'use strict';

  if (window.TactaAuthor) return;

  var AUTHOR = {
    name: 'Blane Maher',
    role: 'ERP team lead, built for NetSuite admins and developers',
    // Where the in-extension "Send feedback" form addresses its email. Leave
    // empty to fall back to opening a prefilled GitHub issue instead. The
    // extension never sends mail itself; see shared/feedback.js.
    feedbackEmail: 'blane.maher@gmail.com',
    links: [
      { id: 'github',   label: 'Source on GitHub', short: 'GitHub',   url: 'https://github.com/Theblane/TactaSuiteNSToolkit' },
      { id: 'website',  label: 'blanemaher.com',   short: 'Website',  url: 'https://blanemaher.com' },
      { id: 'linkedin', label: 'LinkedIn',         short: 'LinkedIn', url: 'https://www.linkedin.com/in/blanemaher' },
      { id: 'coffee',   label: 'Buy me a coffee',  short: 'Coffee',   url: 'https://buymeacoffee.com/theblane' }
    ]
  };

  var ICONS = {
    github:   'M8 .5a7.5 7.5 0 0 0-2.37 14.62c.37.07.51-.16.51-.36v-1.3c-2.09.46-2.53-.9-2.53-.9-.34-.87-.83-1.1-.83-1.1-.68-.46.05-.45.05-.45.75.05 1.15.77 1.15.77.67 1.15 1.76.82 2.19.63.07-.49.26-.82.48-1.01-1.67-.19-3.42-.84-3.42-3.71 0-.82.29-1.49.77-2.02-.08-.19-.33-.95.07-1.98 0 0 .63-.2 2.06.77a7.1 7.1 0 0 1 3.76 0c1.43-.97 2.06-.77 2.06-.77.4 1.03.15 1.79.07 1.98.48.53.77 1.2.77 2.02 0 2.88-1.75 3.51-3.43 3.7.27.23.51.69.51 1.39v2.06c0 .2.14.44.52.36A7.5 7.5 0 0 0 8 .5z',
    website:  'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm4.9 6.3h-2.2a11 11 0 0 0-.9-3.8 5.6 5.6 0 0 1 3.1 3.8zM8 2.4c.7.8 1.3 2.3 1.4 4.9H6.6c.1-2.6.7-4.1 1.4-4.9zM3.1 7.3a5.6 5.6 0 0 1 3.1-3.8 11 11 0 0 0-.9 3.8H3.1zm0 1.4h2.2c.1 1.5.4 2.8.9 3.8a5.6 5.6 0 0 1-3.1-3.8zM8 13.6c-.7-.8-1.3-2.3-1.4-4.9h2.8c-.1 2.6-.7 4.1-1.4 4.9zm1.8-1.1c.5-1 .8-2.3.9-3.8h2.2a5.6 5.6 0 0 1-3.1 3.8z',
    linkedin: 'M2 5.5h2.6V14H2V5.5zM3.3 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM6.2 5.5h2.5v1.2c.4-.7 1.3-1.4 2.7-1.4 2.8 0 3.3 1.8 3.3 4.2V14h-2.6V9.9c0-1 0-2.3-1.4-2.3s-1.6 1.1-1.6 2.2V14H6.2V5.5z',
    coffee:   'M3 4h8.5v1.2A2.3 2.3 0 0 1 14 7.5v.3a2.4 2.4 0 0 1-2.5 2.4h-.3A4 4 0 0 1 7.3 13H6.7A3.7 3.7 0 0 1 3 9.3V4zm8.5 2.5v2.4h.1a1.1 1.1 0 0 0 1.1-1.1v-.3a1.1 1.1 0 0 0-1.2-1zM2.5 14h9v1h-9v-1z'
  };

  function activeLinks() {
    return AUTHOR.links.filter(function (l) { return l.url && /^https:\/\//i.test(l.url); });
  }

  function icon(id) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[id] || ICONS.github);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  /**
   * Render the author block into a container.
   * @param {HTMLElement} container
   * @param {Object} [opts]
   * @param {'full'|'compact'|'inline'} [opts.variant='full']
   *   full    - name, role line and labelled link buttons (Settings, walkthrough)
   *   compact - name plus icon-only links (popup footer)
   *   inline  - links only, no name
   * @param {string} [opts.prefix] - text before the name, e.g. 'Made by'
   */
  function render(container, opts) {
    if (!container) return;
    opts = opts || {};
    var variant = opts.variant || 'full';
    var links = activeLinks();
    container.textContent = '';
    container.classList.add('tacta-author', 'tacta-author--' + variant);

    if (variant !== 'inline') {
      var who = document.createElement('div');
      who.className = 'tacta-author-name';
      if (opts.prefix) {
        var pre = document.createElement('span');
        pre.className = 'tacta-author-prefix';
        pre.textContent = opts.prefix + ' ';
        who.appendChild(pre);
      }
      var name = document.createElement('span');
      name.textContent = AUTHOR.name;
      who.appendChild(name);
      container.appendChild(who);
      if (variant === 'full' && AUTHOR.role) {
        var role = document.createElement('div');
        role.className = 'tacta-author-role';
        role.textContent = AUTHOR.role;
        container.appendChild(role);
      }
    }

    if (!links.length) return;
    var list = document.createElement('div');
    list.className = 'tacta-author-links';
    links.forEach(function (l) {
      var a = document.createElement('a');
      a.className = 'tacta-author-link tacta-author-link--' + l.id;
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = l.label;
      a.appendChild(icon(l.id));
      if (variant !== 'compact') {
        var txt = document.createElement('span');
        txt.textContent = l.label;
        a.appendChild(txt);
      }
      list.appendChild(a);
    });
    container.appendChild(list);
  }

  window.TactaAuthor = {
    AUTHOR: AUTHOR,
    links: activeLinks,
    render: render
  };
})();
