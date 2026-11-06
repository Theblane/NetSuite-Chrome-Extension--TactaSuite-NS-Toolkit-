/**
 * NetSuite TactaSuite - Context Menu Manager
 *
 * @author Blane Maher
 *
 * Registers right-click context menu items that are visible only on
 * *.netsuite.com pages.
 */

export function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tacta-toolkit-parent',
      title: 'NetSuite TactaSuite',
      contexts: ['page', 'editable', 'link'],
      documentUrlPatterns: ['https://*.netsuite.com/*']
    });

    chrome.contextMenus.create({
      id: 'tacta-split-view',
      parentId: 'tacta-toolkit-parent',
      title: 'Open in Split View',
      contexts: ['page', 'link'],
      documentUrlPatterns: ['https://*.netsuite.com/*']
    });
  });

  if (!setupContextMenus._listenerRegistered) {
    chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
    setupContextMenus._listenerRegistered = true;
  }
}

function handleContextMenuClick(info, tab) {
  if (!tab?.id) return;

  if (info.menuItemId === 'tacta-split-view') {
    const targetUrl = info.linkUrl || tab.url;
    chrome.tabs.sendMessage(tab.id, {
      action: 'activateFeature',
      featureId: 'split-view',
      data: { url: targetUrl }
    });
  }
}
