// Sidebar: every page you can open, newest first, with filter and tags
import { get } from '../lib/api.js';
import { el, icon, timeAgo } from '../lib/ui.js';

const MAX_TAGS = 14;

export class Sidebar {
  constructor({ list, filter, tagRow }) {
    this.listEl = list;
    this.filterEl = filter;
    this.tagRow = tagRow;
    this.pages = [];
    this.current = null;
    this.tag = new URLSearchParams(window.location.search).get('tag') || '';
    filter.addEventListener('input', () => this.render());
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.listEl.querySelector('a.page-link');
        if (first) first.click();
      } else if (e.key === 'Escape') {
        filter.value = '';
        this.render();
      }
    });
  }

  async refresh() {
    try {
      this.pages = await get('/api/pages');
    } catch (err) {
      if (!this.pages.length) this.listEl.replaceChildren(el('li', { class: 'list-empty', text: 'Could not load pages' }));
      return;
    }
    this.render();
  }

  setCurrent(name) {
    this.current = name;
    for (const link of this.listEl.querySelectorAll('a.page-link')) {
      link.classList.toggle('active', link.dataset.name === name);
      if (link.dataset.name === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  setTag(tag) {
    this.tag = this.tag === tag ? '' : tag;
    const url = new URL(window.location.href);
    if (this.tag) url.searchParams.set('tag', this.tag);
    else url.searchParams.delete('tag');
    history.replaceState(history.state, '', url);
    this.render();
  }

  renderTags() {
    const counts = new Map();
    for (const page of this.pages) for (const tag of page.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TAGS).map(([t]) => t);
    if (this.tag && !tags.includes(this.tag)) tags.unshift(this.tag);
    this.tagRow.replaceChildren(...tags.map(tag => el('button', {
      class: `tag${tag === this.tag ? ' active' : ''}`,
      type: 'button',
      text: `#${tag}`,
      'aria-pressed': String(tag === this.tag),
      onclick: () => this.setTag(tag)
    })));
    this.tagRow.hidden = tags.length === 0;
  }

  render() {
    this.renderTags();
    const query = this.filterEl.value.trim().toLowerCase();
    const pages = this.pages.filter(p => {
      if (this.tag && !(p.tags || []).includes(this.tag)) return false;
      if (!query) return true;
      return p.name.toLowerCase().includes(query) || (p.title || '').toLowerCase().includes(query);
    });
    if (!pages.length) {
      const message = this.pages.length ? 'No matching pages' : 'No pages yet — create one with +';
      this.listEl.replaceChildren(el('li', { class: 'list-empty', text: message }));
      return;
    }
    this.listEl.replaceChildren(...pages.map(page => {
      const title = page.title && page.title.toLowerCase() !== page.name.toLowerCase() ? page.title : page.name;
      const meta = page.locked
        ? 'Private · needs the password'
        : [title !== page.name ? page.name : null, timeAgo(page.updatedAt), page.updatedBy].filter(Boolean).join(' · ');
      const link = el('a', {
        class: `page-link${page.name === this.current ? ' active' : ''}${page.locked ? ' locked' : ''}`,
        href: page.name === 'home' ? '/' : `/person/${encodeURIComponent(page.name)}`,
        dataset: { name: page.name },
        title: page.locked ? `${page.name} is private: open it and enter the password` : (page.preview || page.name)
      }, [
        el('div', { class: 'title' }, [el('span', { text: title }), page.protected ? icon('lock') : null]),
        el('div', { class: 'meta', text: meta })
      ]);
      if (page.name === this.current) link.setAttribute('aria-current', 'page');
      return el('li', {}, [link]);
    }));
  }
}
