// assimpjs (emscripten/embind) создаёт функции через `new Function`, а CSP страниц расширения MV3
// ('wasm-unsafe-eval', без 'unsafe-eval') это запрещает: «Refused to evaluate a string as JavaScript».
// Заменяем два места на эквивалентные замыкания. Если исходник изменится, патч упадёт с понятной ошибкой.

const ALLOCATOR_RE = /function craftEmvalAllocator\(argCount\)\{[\s\S]*?return new Function\("requireRegisteredType","Module","valueToHandle","getMemory",functionBody\)\(requireRegisteredType,Module,Emval\.toHandle,getMemory\)\}/;
const ALLOCATOR = 'function craftEmvalAllocator(argCount){return function(constructor,argTypes,args){var a=[];for(var i=0;i<argCount;++i){' +
  'var argType=requireRegisteredType(HEAPU32[argTypes>>2],"parameter "+i);a.push(argType.readValueFromPointer(args));args+=argType["argPackAdvance"];argTypes+=4}' +
  'return Emval.toHandle(new constructor(...a))}}';
// embind: функции-обёртки C++ собираются строкой и компилируются через newFunc(Function, …) — заменяем замыканием
// (так делает сам emscripten при -sDYNAMIC_EXECUTION=0).
const INVOKER_RE = /function craftInvokerFunction\(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync\)\{[\s\S]*?return newFunc\(Function,args1\)\.apply\(null,args2\)\}/;
const INVOKER = 'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){var argCount=argTypes.length;' +
  'if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!")}' +
  'var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;' +
  'for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}' +
  'var returns=argTypes[0].name!=="void";var expected=argCount-2;' +
  'return function(){if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!")}' +
  'var destructors=needsDestructorStack?[]:null;var thisWired;var wired=new Array(expected);var callArgs=[cppTargetFunc];' +
  'if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);callArgs.push(thisWired)}' +
  'for(var i=0;i<expected;++i){wired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);callArgs.push(wired[i])}' +
  'var rv=cppInvokerFunc.apply(null,callArgs);' +
  'if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var param=i===1?thisWired:wired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(param)}}}' +
  'if(returns){return argTypes[0].fromWireType(rv)}}}';
const GLOBAL_RE = /return function\(\)\{return Function\}\(\)\("return this"\)\(\)/;
const GLOBAL = 'return globalThis';

/** Найти оставшиеся способы выполнить строку как код. */
export function findEval(src) {
  return [...src.matchAll(/new Function\s*\(|(?<![\w$.])Function\s*\(|(?<![\w$.])eval\s*\(|newFunc\(Function/g)].map((m) => src.slice(Math.max(0, m.index - 40), m.index + 40));
}

export function patchAssimp(src) {
  if (src.startsWith('/* gmv: patched')) return src;
  if (!ALLOCATOR_RE.test(src)) throw new Error('patch-assimp: не найден craftEmvalAllocator — версия assimpjs изменилась, проверьте патч');
  if (!INVOKER_RE.test(src)) throw new Error('patch-assimp: не найден craftInvokerFunction — версия assimpjs изменилась, проверьте патч');
  let out = src.replace(ALLOCATOR_RE, ALLOCATOR).replace(INVOKER_RE, INVOKER);
  out = out.replace(GLOBAL_RE, GLOBAL);
  const left = findEval(out);
  if (left.length) throw new Error('patch-assimp: остались вызовы eval/Function: ' + left.join(' | '));
  return '/* gmv: patched for MV3 CSP (no eval), see apps/extension/scripts/patch-assimp.mjs */\n' + out;
}
