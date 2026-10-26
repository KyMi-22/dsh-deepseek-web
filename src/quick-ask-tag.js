/**
 * Naming rules for quick-ask web conversations.
 *
 * Kept dependency-free on purpose: `sync.js` (import rules) and
 * `quick-ask.js` (thread management) both need the tag, while `adapter.js`
 * already imports `sync.js` — putting these helpers anywhere with an import
 * edge would close that loop back through the adapter.
 *
 * @module src/quick-ask-tag
 */
'use strict';

/**
 * The title prefix every quick-ask web conversation is renamed to, and the
 * marker `selectImportBatch` refuses to import.
 *
 * A quick-ask thread lives on the web account but is NOT a conversation the
 * user would recognize as theirs: it is plugin machinery. Without this tag a
 * sync pass happily imports it as an ordinary conversation, and the sidebar
 * fills with "SideBar：" rows the user never wrote.
 *
 * The format is `SideBar：<DSH conversation title>`, so the web conversation
 * list groups every side thread under one recognizable prefix.
 *
 * @type {string}
 */
export const QUICK_ASK_TAG = 'SideBar：';

/** What a thread is named when its DSH conversation has no title yet. */
export const QUICK_ASK_FALLBACK_TITLE = `${QUICK_ASK_TAG}快捷侧问`;

/**
 * Whether one web conversation title marks a quick-ask thread.
 *
 * The current `SideBar：` prefix plus the historical spellings of earlier
 * versions are all recognized, so old threads stay excluded after an upgrade.
 *
 * @param {unknown} title
 */
export function isQuickAskTitle(title) {
  if (typeof title !== 'string') return false;
  return title.startsWith(QUICK_ASK_TAG) || title.includes('[SideBar]') || title.includes('[快捷侧问]');
}

/**
 * Extract the session's display title from its stored log.
 *
 * The DSH session log carries one `session/title` event (seeded or renamed);
 * the LAST one is the current name. A blank or malformed log yields ''.
 *
 * @param {ReadonlyArray<object>} events
 * @returns {string}
 */
export function extractSessionTitle(events) {
  let title = '';
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'session/title') continue;
    const value = event.data?.title;
    if (typeof value === 'string' && value.trim() !== '') title = value.trim();
  }
  return title;
}

/**
 * The web conversation title a thread is renamed to.
 *
 * `SideBar：<title>`, clipped so the tag stays visible in a narrow web row.
 *
 * @param {string} sessionTitle
 * @returns {string}
 */
export function quickAskTitle(sessionTitle) {
  const label = typeof sessionTitle === 'string' ? sessionTitle.trim() : '';
  if (label === '') return QUICK_ASK_FALLBACK_TITLE;
  const clipped = label.length > 40 ? `${label.slice(0, 40)}…` : label;
  return `${QUICK_ASK_TAG}${clipped}`;
}
