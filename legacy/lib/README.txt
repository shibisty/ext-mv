Сюда положите WASM-сборку assimpjs (https://github.com/kovacsv/assimpjs):
  npm install assimpjs   ->   node_modules/assimpjs/dist/
Скопируйте в эту папку пару файлов (рекомендуется "all" — максимум форматов):
  assimpjs-all.js + assimpjs-all.wasm
либо
  assimpjs.js + assimpjs.wasm
Затем перезагрузите расширение на chrome://extensions. Для игровых форматов (OGF) assimp не нужен.
