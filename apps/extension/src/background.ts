// Фон: меню на значке расширения — полный просмотрщик во вкладке и боковая панель (щелчок по значку открывает попап).
// Без import: фоновый скрипт собирается в один файл (service worker Chrome и background.scripts Firefox — не модули).
interface FirefoxSidebar { sidebarAction?: { open(): Promise<void> } }

const msg = (k: string, fallback: string) => chrome.i18n?.getMessage(k) || fallback;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'gmv-full', title: msg('menuFull', 'Open full viewer in a tab'), contexts: ['action'] });
    chrome.contextMenus.create({ id: 'gmv-side', title: msg('menuSide', 'Open side panel'), contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gmv-full') { void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }); return; }
  if (info.menuItemId !== 'gmv-side') return;
  // боковая панель открывается только сразу в ответ на действие пользователя — без await до вызова
  const side = (globalThis as { browser?: FirefoxSidebar }).browser?.sidebarAction;
  // sidePanel есть только в Chrome; Reflect.get — чтобы web-ext lint Firefox не считал это вызовом неподдерживаемого API
  const panel: typeof chrome.sidePanel | undefined = Reflect.get(chrome, 'sidePanel');
  const done = side ? side.open() : tab?.windowId !== undefined && panel?.open ? panel.open({ windowId: tab.windowId }) : null;
  done?.catch(() => { /* нет боковой панели */ });
});
