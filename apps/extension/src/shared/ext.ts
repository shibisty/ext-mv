// Общее для страниц расширения: полный просмотрщик во вкладке, боковая панель (Chrome sidePanel / Firefox sidebarAction).
interface FirefoxSidebar { sidebarAction?: { open(): Promise<void> } }
// sidePanel есть только в Chrome; Reflect.get — чтобы web-ext lint Firefox не считал это вызовом неподдерживаемого API
const chromePanel = (): typeof chrome.sidePanel | undefined => Reflect.get(chrome, 'sidePanel');
const ff = (): FirefoxSidebar['sidebarAction'] =>
  (globalThis as { browser?: FirefoxSidebar }).browser?.sidebarAction ?? (chrome as unknown as FirefoxSidebar).sidebarAction;

/** Есть ли в браузере боковая панель расширения. */
export const hasSidePanel = (): boolean => !!(chromePanel()?.open || ff());

export const isFirefox = (): boolean => /\bFirefox\//.test(navigator.userAgent);

/**
 * Открыть боковую панель. Вызывать прямо в обработчике щелчка, без await перед вызовом: браузер разрешает это только
 * в ответ на действие пользователя. windowId нужен Chrome (в попапе его узнают заранее).
 */
export function openSidePanel(windowId: number | undefined): Promise<void> {
  const side = ff();
  if (side) return side.open();
  const panel = chromePanel();
  if (panel?.open && windowId !== undefined) return panel.open({ windowId });
  return Promise.reject(new Error('side panel is not available'));
}

export const viewerUrl = (handoff = false): string => chrome.runtime.getURL('viewer.html' + (handoff ? '?handoff=1' : ''));
