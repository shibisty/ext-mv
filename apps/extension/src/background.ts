// Клик по значку расширения открывает просмотрщик во вкладке (Chrome — service worker, Firefox — фоновый скрипт).
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});
