import 'array-flat-polyfill';
import fs, { readFile, outputJson, readJSONSync } from 'fs-extra';
import { flatten, get, difference, set } from 'lodash';
import path, { relative, basename, join } from 'path';
import cheerio from 'cheerio';
import { cosmiconfigSync } from 'cosmiconfig';
import { JSONPath } from 'jsonpath-plus';
import memoize from 'mem';
import slash from 'slash';
import { existsSync } from 'fs';
import glob from 'glob';
import Ajv from 'ajv';
import { JsonPointer } from 'json-ptr';
import { rollup } from 'rollup';

const not =
  (fn) =>
  (x) =>
    !fn(x);

function isChunk(x) {
  return x && x.type === 'chunk'
}

function isAsset(x) {
  return x.type === 'asset'
}

function isString(x) {
  return typeof x === 'string'
}

function isUndefined(x) {
  return typeof x === 'undefined'
}

function isNull(x) {
  return x === null
}

function isPresent(x) {
  return !isUndefined(x) && !isNull(x)
}

const normalizeFilename = (p) => p.replace(/\.[tj]sx?$/, '.js');

/** Update the manifest source in the output bundle */
const updateManifest = (
  updater,
  bundle,
  handleError,
) => {
  try {
    const manifestKey = 'manifest.json';
    const manifestAsset = bundle[manifestKey]; 

    if (!manifestAsset) {
      throw new Error('No manifest.json in the rollup output bundle.')
    }

    const manifest = JSON.parse(manifestAsset.source ); 

    const result = updater(manifest);

    manifestAsset.source = JSON.stringify(result, undefined, 2);
  } catch (error) {
    if (handleError && error instanceof Error) {
      handleError(error.message);
    } else {
      throw error
    }
  }

  return bundle
};

function reduceToRecord(srcDir) {
  if (srcDir === null || typeof srcDir === 'undefined') {
    // This would be a config error, so should throw
    throw new TypeError('srcDir is null or undefined')
  }

  return (inputRecord, filename) => {
    const name = relative(srcDir, filename).split('.').slice(0, -1).join('.');

    if (name in inputRecord) {
      throw new Error(
        `Script files with different extensions should not share names:\n\n"${filename}"\nwill overwrite\n"${inputRecord[name]}"`,
      )
    }

    return { ...inputRecord, [name]: filename }
  }
}

const loadHtml =
  (rootPath) =>
  (filePath) => {
    const htmlCode = fs.readFileSync(filePath, 'utf8');
    const $ = cheerio.load(htmlCode);

    return Object.assign($, { filePath, rootPath })
  };

const getRelativePath =
  ({ filePath, rootPath }) =>
  (p) => {
    const htmlFileDir = path.dirname(filePath);

    let relDir;
    if (p.startsWith('/')) {
      relDir = path.relative(process.cwd(), rootPath);
    } else {
      relDir = path.relative(process.cwd(), htmlFileDir);
    }

    return path.join(relDir, p)
  };

/* -------------------- SCRIPTS -------------------- */

const getScriptElems = ($) =>
  $('script')
    .not('[data-rollup-asset]')
    .not('[src^="http:"]')
    .not('[src^="https:"]')
    .not('[src^="data:"]')
    .not('[src^="/"]');

// Mutative action
const mutateScriptElems =
  ({ browserPolyfill }) =>
  ($) => {
    getScriptElems($)
      .attr('type', 'module')
      .attr('src', (i, value) => {
        // FIXME: @types/cheerio is wrong for AttrFunction: index.d.ts, line 16
        // declare type AttrFunction = (i: number, currentValue: string) => any;
        // eslint-disable-next-line
        // @ts-ignore
        const replaced = value.replace(/\.[jt]sx?/g, '.js');

        return replaced
      });

    if (browserPolyfill) {
      const head = $('head');
      if (
        browserPolyfill === true ||
        (typeof browserPolyfill === 'object' && browserPolyfill.executeScript)
      ) {
        head.prepend(
          '<script src="/assets/browser-polyfill-executeScript.js"></script>',
        );
      }

      head.prepend('<script src="/assets/browser-polyfill.js"></script>');
    }

    return $
  };

const getScripts = ($) => getScriptElems($).toArray();

const getScriptSrc = ($) =>
  getScripts($)
    .map((elem) => $(elem).attr('src'))
    .filter(isString)
    .map(getRelativePath($));

/* ----------------- ASSET SCRIPTS ----------------- */

const getAssets = ($) =>
  $('script')
    .filter('[data-rollup-asset="true"]')
    .not('[src^="http:"]')
    .not('[src^="https:"]')
    .not('[src^="data:"]')
    .not('[src^="/"]')
    .toArray();

const getJsAssets = ($) =>
  getAssets($)
    .map((elem) => $(elem).attr('src'))
    .filter(isString)
    .map(getRelativePath($));

/* -------------------- css ------------------- */

const getCss = ($) =>
  $('link')
    .filter('[rel="stylesheet"]')
    .not('[href^="http:"]')
    .not('[href^="https:"]')
    .not('[href^="data:"]')
    .not('[href^="/"]')
    .toArray();

const getCssHrefs = ($) =>
  getCss($)
    .map((elem) => $(elem).attr('href'))
    .filter(isString)
    .map(getRelativePath($));

/* -------------------- img ------------------- */

const getImgs = ($) =>
  $('img')
    .not('[src^="http://"]')
    .not('[src^="https://"]')
    .not('[src^="data:"]')
    .toArray();

const getFavicons = ($) =>
  $('link[rel="icon"]')
    .not('[href^="http:"]')
    .not('[href^="https:"]')
    .not('[href^="data:"]')
    .toArray();

const getImgSrcs = ($) => {
  return [
    ...getImgs($).map((elem) => $(elem).attr('src')),
    ...getFavicons($).map((elem) => $(elem).attr('href')),
  ]
    .filter(isString)
    .map(getRelativePath($))
};

const isHtml = (path) => /\.html?$/.test(path);

const name$1 = 'html-inputs';

/* ============================================ */
/*                  HTML-INPUTS                 */
/* ============================================ */

function htmlInputs(
  htmlInputsOptions,
  /** Used for testing */
  cache = {
    scripts: [],
    html: [],
    html$: [],
    js: [],
    css: [],
    img: [],
    input: [],
  } ,
) {
  return {
    name: name$1,
    cache,

    /* ============================================ */
    /*                 OPTIONS HOOK                 */
    /* ============================================ */

    options(options) {
      // srcDir may be initialized by another plugin
      const { srcDir } = htmlInputsOptions;

      if (srcDir) {
        cache.srcDir = srcDir;
      } else {
        throw new TypeError('options.srcDir not initialized')
      }

      // Skip if cache.input exists
      // cache is dumped in watchChange hook

      // Parse options.input to array
      let input;
      if (typeof options.input === 'string') {
        input = [options.input];
      } else if (Array.isArray(options.input)) {
        input = [...options.input];
      } else if (typeof options.input === 'object') {
        input = Object.values(options.input);
      } else {
        throw new TypeError(`options.input cannot be ${typeof options.input}`)
      }

      /* ------------------------------------------------- */
      /*                 HANDLE HTML FILES                 */
      /* ------------------------------------------------- */

      // Filter htm and html files
      cache.html = input.filter(isHtml);

      // If no html files, do nothing
      if (cache.html.length === 0) return options

      // If the cache has been dumped, reload from files
      if (cache.html$.length === 0) {
        // This is all done once
        cache.html$ = cache.html.map(loadHtml(srcDir));

        cache.js = flatten(cache.html$.map(getScriptSrc));
        cache.css = flatten(cache.html$.map(getCssHrefs));
        cache.img = flatten(cache.html$.map(getImgSrcs));
        cache.scripts = flatten(cache.html$.map(getJsAssets));

        // Cache jsEntries with existing options.input
        cache.input = input.filter(not(isHtml)).concat(cache.js);

        // Prepare cache.html$ for asset emission
        cache.html$.forEach(mutateScriptElems(htmlInputsOptions));

        if (cache.input.length === 0) {
          throw new Error(
            'At least one HTML file must have at least one script.',
          )
        }
      }

      // TODO: simply remove HTML files from options.input
      // - Parse HTML and emit chunks and assets in buildStart
      return {
        ...options,
        input: cache.input.reduce(reduceToRecord(htmlInputsOptions.srcDir), {}),
      }
    },

    /* ============================================ */
    /*              HANDLE FILE CHANGES             */
    /* ============================================ */

    async buildStart() {
      const { srcDir } = htmlInputsOptions;

      if (srcDir) {
        cache.srcDir = srcDir;
      } else {
        throw new TypeError('options.srcDir not initialized')
      }

      const assets = [...cache.css, ...cache.img, ...cache.scripts];

      assets.concat(cache.html).forEach((asset) => {
        this.addWatchFile(asset);
      });

      const emitting = assets.map(async (asset) => {
        // Read these files as Buffers
        const source = await readFile(asset);
        const fileName = relative(srcDir, asset);

        this.emitFile({
          type: 'asset',
          source, // Buffer
          fileName,
        });
      });

      cache.html$.map(($) => {
        const source = $.html();
        const fileName = relative(srcDir, $.filePath);

        this.emitFile({
          type: 'asset',
          source, // String
          fileName,
        });
      });

      await Promise.all(emitting);
    },

    watchChange(id) {
      if (id.endsWith('.html') || id.endsWith('manifest.json')) {
        // Dump cache if html file or manifest changes
        cache.html$ = [];
      }
    },
  }
}

const code$5 = "(function () {\n\t'use strict';\n\n\tconst importPath = /*@__PURE__*/ JSON.parse('%PATH%');\n\n\timport(chrome.runtime.getURL(importPath));\n\n})();\n";

function isMV2(
  m,
) {
  if (!isPresent(m)) throw new TypeError('manifest is undefined')
  return m.manifest_version === 2
}

function isMV3(
  m,
) {
  if (!isPresent(m)) throw new TypeError('manifest is undefined')
  return m.manifest_version === 3
}

const cloneObject = (obj) => JSON.parse(JSON.stringify(obj));

const code$4 = "(function () {\n  'use strict';\n\n  function delay(ms) {\n    return new Promise((resolve) => {\n      setTimeout(resolve, ms);\n    })\n  }\n\n  function captureEvents(events) {\n    const captured = events.map(captureEvent);\n\n    return () => captured.forEach((t) => t())\n\n    function captureEvent(event) {\n      let isCapturePhase = true;\n\n      // eslint-disable-next-line @typescript-eslint/ban-types\n      const callbacks = new Map();\n      const eventArgs = new Set();\n\n      // This is the only listener for the native event\n      event.addListener(handleEvent);\n\n      function handleEvent(...args) {\n        if (isCapturePhase) {\n          // This is before dynamic import completes\n          eventArgs.add(args);\n\n          if (typeof args[2] === 'function') {\n            // During capture phase all messages are async\n            return true\n          } else {\n            // Sync messages or some other event\n            return false\n          }\n        } else {\n          // The callbacks determine the listener return value\n          return callListeners(...args)\n        }\n      }\n\n      // Called when dynamic import is complete\n      //  and when subsequent events fire\n      function callListeners(...args) {\n        let isAsyncCallback = false;\n        callbacks.forEach((options, cb) => {\n          // A callback error should not affect the other callbacks\n          try {\n            isAsyncCallback = cb(...args) || isAsyncCallback;\n          } catch (error) {\n            console.error(error);\n          }\n        });\n\n        if (!isAsyncCallback && typeof args[2] === 'function') {\n          // We made this an async message callback during capture phase\n          //   when the function handleEvent returned true\n          //   so we are responsible to call sendResponse\n          // If the callbacks are sync message callbacks\n          //   the sendMessage callback on the other side\n          //   resolves with no arguments (this is the same behavior)\n          args[2]();\n        }\n\n        // Support events after import is complete\n        return isAsyncCallback\n      }\n\n      // This function will trigger this Event with our stored args\n      function triggerEvents() {\n        // Fire each event for this Event\n        eventArgs.forEach((args) => {\n          callListeners(...args);\n        });\n\n        // Dynamic import is complete\n        isCapturePhase = false;\n        // Don't need these anymore\n        eventArgs.clear();\n      }\n\n      // All future listeners are handled by our code\n      event.addListener = function addListener(cb, ...options) {\n        callbacks.set(cb, options);\n      };\n\n      event.hasListeners = function hasListeners() {\n        return callbacks.size > 0\n      };\n\n      event.hasListener = function hasListener(cb) {\n        return callbacks.has(cb)\n      };\n\n      event.removeListener = function removeListener(cb) {\n        callbacks.delete(cb);\n      };\n\n      event.__isCapturedEvent = true;\n\n      return triggerEvents\n    }\n  }\n\n  function resolvePath(object, path, defaultValue) {\n    return path.split('.').reduce((o, p) => (o ? o[p] : defaultValue), object) \n  }\n\n  const eventPaths = /*@__PURE__*/ JSON.parse('%EVENTS%'); \n  const importPath = /*@__PURE__*/ JSON.parse('%PATH%'); \n  const delayLength = /*@__PURE__*/ JSON.parse('%DELAY%');\n\n  const events = eventPaths.map((eventPath) => resolvePath(chrome, eventPath));\n  const triggerEvents = captureEvents(events);\n\n  import(importPath).then(async () => {\n    if (delayLength) await delay(delayLength);\n\n    triggerEvents();\n  });\n\n})();\n";

const code$3 = "(function () {\n  'use strict';\n\n  function captureEvents(events) {\n    const captured = events.map(captureEvent);\n\n    return () => captured.forEach((t) => t())\n\n    function captureEvent(event) {\n      let isCapturePhase = true;\n\n      // eslint-disable-next-line @typescript-eslint/ban-types\n      const callbacks = new Map();\n      const eventArgs = new Set();\n\n      // This is the only listener for the native event\n      event.addListener(handleEvent);\n\n      function handleEvent(...args) {\n        if (isCapturePhase) {\n          // This is before dynamic import completes\n          eventArgs.add(args);\n\n          if (typeof args[2] === 'function') {\n            // During capture phase all messages are async\n            return true\n          } else {\n            // Sync messages or some other event\n            return false\n          }\n        } else {\n          // The callbacks determine the listener return value\n          return callListeners(...args)\n        }\n      }\n\n      // Called when dynamic import is complete\n      //  and when subsequent events fire\n      function callListeners(...args) {\n        let isAsyncCallback = false;\n        callbacks.forEach((options, cb) => {\n          // A callback error should not affect the other callbacks\n          try {\n            isAsyncCallback = cb(...args) || isAsyncCallback;\n          } catch (error) {\n            console.error(error);\n          }\n        });\n\n        if (!isAsyncCallback && typeof args[2] === 'function') {\n          // We made this an async message callback during capture phase\n          //   when the function handleEvent returned true\n          //   so we are responsible to call sendResponse\n          // If the callbacks are sync message callbacks\n          //   the sendMessage callback on the other side\n          //   resolves with no arguments (this is the same behavior)\n          args[2]();\n        }\n\n        // Support events after import is complete\n        return isAsyncCallback\n      }\n\n      // This function will trigger this Event with our stored args\n      function triggerEvents() {\n        // Fire each event for this Event\n        eventArgs.forEach((args) => {\n          callListeners(...args);\n        });\n\n        // Dynamic import is complete\n        isCapturePhase = false;\n        // Don't need these anymore\n        eventArgs.clear();\n      }\n\n      // All future listeners are handled by our code\n      event.addListener = function addListener(cb, ...options) {\n        callbacks.set(cb, options);\n      };\n\n      event.hasListeners = function hasListeners() {\n        return callbacks.size > 0\n      };\n\n      event.hasListener = function hasListener(cb) {\n        return callbacks.has(cb)\n      };\n\n      event.removeListener = function removeListener(cb) {\n        callbacks.delete(cb);\n      };\n\n      event.__isCapturedEvent = true;\n\n      return triggerEvents\n    }\n  }\n\n  function delay(ms) {\n    return new Promise((resolve) => {\n      setTimeout(resolve, ms);\n    })\n  }\n\n  /**\n   * Get matches from an object of nested objects\n   *\n   * @export\n   * @template T Type of matches\n   * @param {*} object Parent object to search\n   * @param {(x: any) => boolean} pred A predicate function that will receive each property value of an object\n   * @param {string[]} excludeKeys Exclude a property if the key exactly matches\n   * @returns {T[]} The matched values from the parent object\n   */\n  function getDeepMatches(object, pred, excludeKeys) {\n    const keys = typeof object === 'object' && object ? Object.keys(object) : [];\n\n    return keys.length\n      ? keys\n          .filter((key) => !excludeKeys.includes(key))\n          .reduce((r, key) => {\n            const target = object[key];\n\n            if (target && pred(target)) {\n              return [...r, target]\n            } else {\n              return [...r, ...getDeepMatches(target, pred, excludeKeys)]\n            }\n          }, [] )\n      : []\n  }\n\n  const importPath = /*@__PURE__*/ JSON.parse('%PATH%'); \n  const delayLength = /*@__PURE__*/ JSON.parse('%DELAY%'); \n  const excludedPaths = /*@__PURE__*/ JSON.parse('%EXCLUDE%');\n\n  const events = getDeepMatches(\n    chrome,\n    (x) => typeof x === 'object' && 'addListener' in x,\n    // The webRequest API is not compatible with event pages\n    //  TODO: this can be removed\n    //   if we stop using this wrapper with \"webRequest\" permission\n    excludedPaths.concat(['webRequest']),\n  );\n  const triggerEvents = captureEvents(events);\n\n  import(importPath).then(async () => {\n    if (delayLength) await delay(delayLength);\n\n    triggerEvents();\n  });\n\n})();\n";

/**
 * This options object allows fine-tuning of the dynamic import wrapper.
 *
 * @export
 * @interface DynamicImportWrapper
 */









// FEATURE: add static code analysis for wake events
//  - This will be slower...
function prepImportWrapperScript({
  eventDelay = 0,
  wakeEvents = [],
  excludeNames = ['extension'],
}) {
  const delay = JSON.stringify(eventDelay);
  const events = wakeEvents.length
    ? JSON.stringify(wakeEvents.map((ev) => ev.replace(/^chrome\./, '')))
    : false;
  const exclude = JSON.stringify(excludeNames);

  const script = (
    events
      ? code$4.replace('%EVENTS%', events)
      : code$3.replace('%EXCLUDE%', exclude)
  ).replace('%DELAY%', delay);

  return script
}

const isManifestFileName = (filename) =>
  basename(filename).startsWith('manifest');

const validateFileName = (filename, { input }) => {
  if (isUndefined(filename))
    throw new Error(
      `Could not find manifest in Rollup options.input: ${JSON.stringify(
        input,
      )}`,
    )
  if (!existsSync(filename))
    throw new Error(`Could not load manifest: ${filename} does not exist`)

  return filename
};

function getInputManifestPath(options)



 {
  if (Array.isArray(options.input)) {
    const manifestIndex = options.input.findIndex(isManifestFileName);
    const inputAry = [
      ...options.input.slice(0, manifestIndex),
      ...options.input.slice(manifestIndex + 1),
    ];
    const inputManifestPath = validateFileName(
      options.input[manifestIndex],
      options,
    );

    return { inputManifestPath, inputAry }
  } else if (typeof options.input === 'object') {
    const inputManifestPath = validateFileName(options.input.manifest, options);
    const inputObj = cloneObject(options.input);
    delete inputObj['manifest'];

    return { inputManifestPath, inputObj }
  } else if (isString(options.input)) {
    const inputManifestPath = validateFileName(options.input, options);
    return { inputManifestPath }
  }

  throw new TypeError(
    `Rollup options.input cannot be type "${typeof options.input}"`,
  )
}

const combinePerms = (
  ...permissions
) => {
  const { perms, xperms } = (permissions.flat(Infinity) )
    .filter((perm) => typeof perm !== 'undefined')
    .reduce(
      ({ perms, xperms }, perm) => {
        if (perm.startsWith('!')) {
          xperms.add(perm.slice(1));
        } else {
          perms.add(perm);
        }

        return { perms, xperms }
      },
      { perms: new Set(), xperms: new Set() },
    );

  return [...perms].filter((p) => !xperms.has(p))
};

/* ============================================ */
/*               CHECK PERMISSIONS              */
/* ============================================ */

// export const debugger = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*debugger/.test(s)
// export const enterprise.deviceAttributes = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*enterprise\.deviceAttributes/.test(s)
// export const enterprise.hardwarePlatform = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*enterprise\.hardwarePlatform/.test(s)
// export const enterprise.platformKeys = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*enterprise\.platformKeys/.test(s)
// export const networking.config = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*networking\.config/.test(s)
// export const system.cpu = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.cpu/.test(s)
// export const system.display = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.display/.test(s)
// export const system.memory = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.memory/.test(s)
// export const system.storage = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*system\.storage/.test(s)

const alarms = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*alarms/.test(s);

const bookmarks = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*bookmarks/.test(s);

const contentSettings = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*contentSettings/.test(s);

const contextMenus = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*contextMenus/.test(s);

const cookies = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*cookies/.test(s);

const declarativeContent = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*declarativeContent/.test(s);
const declarativeNetRequest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*declarativeNetRequest/.test(s);
const declarativeWebRequest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*declarativeWebRequest/.test(s);
const desktopCapture = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*desktopCapture/.test(s);
const displaySource = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*displaySource/.test(s);
const dns = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*dns/.test(s);
const documentScan = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*documentScan/.test(s);
const downloads = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*downloads/.test(s);
const experimental = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*experimental/.test(s);
const fileBrowserHandler = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*fileBrowserHandler/.test(s);
const fileSystemProvider = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*fileSystemProvider/.test(s);
const fontSettings = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*fontSettings/.test(s);
const gcm = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*gcm/.test(s);
const geolocation = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*geolocation/.test(s);
const history = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*history/.test(s);
const identity = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*identity/.test(s);
const idle = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*idle/.test(s);
const idltest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*idltest/.test(s);
const management = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*management/.test(s);
const nativeMessaging = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*nativeMessaging/.test(s);
const notifications = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*notifications/.test(s);
const pageCapture = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*pageCapture/.test(s);
const platformKeys = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*platformKeys/.test(s);
const power = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*power/.test(s);
const printerProvider = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*printerProvider/.test(s);
const privacy = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*privacy/.test(s);
const processes = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*processes/.test(s);
const proxy = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*proxy/.test(s);
const sessions = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*sessions/.test(s);
const signedInDevices = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*signedInDevices/.test(s);
const storage = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*storage/.test(s);
const tabCapture = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*tabCapture/.test(s);
// export const tabs = s => /((chromep?)|(browser))[\s\n]*\.[\s\n]*tabs/.test(s)
const topSites = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*topSites/.test(s);
const tts = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*tts/.test(s);
const ttsEngine = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*ttsEngine/.test(s);
const unlimitedStorage = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*unlimitedStorage/.test(s);
const vpnProvider = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*vpnProvider/.test(s);
const wallpaper = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*wallpaper/.test(s);
const webNavigation = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*webNavigation/.test(s);
const webRequest = (s) =>
  /((chromep?)|(browser))[\s\n]*\.[\s\n]*webRequest/.test(s);
const webRequestBlocking = (s) =>
  webRequest(s) && s.includes("'blocking'");

// TODO: add readClipboard
// TODO: add writeClipboard

var permissions = /*#__PURE__*/Object.freeze({
  __proto__: null,
  alarms: alarms,
  bookmarks: bookmarks,
  contentSettings: contentSettings,
  contextMenus: contextMenus,
  cookies: cookies,
  declarativeContent: declarativeContent,
  declarativeNetRequest: declarativeNetRequest,
  declarativeWebRequest: declarativeWebRequest,
  desktopCapture: desktopCapture,
  displaySource: displaySource,
  dns: dns,
  documentScan: documentScan,
  downloads: downloads,
  experimental: experimental,
  fileBrowserHandler: fileBrowserHandler,
  fileSystemProvider: fileSystemProvider,
  fontSettings: fontSettings,
  gcm: gcm,
  geolocation: geolocation,
  history: history,
  identity: identity,
  idle: idle,
  idltest: idltest,
  management: management,
  nativeMessaging: nativeMessaging,
  notifications: notifications,
  pageCapture: pageCapture,
  platformKeys: platformKeys,
  power: power,
  printerProvider: printerProvider,
  privacy: privacy,
  processes: processes,
  proxy: proxy,
  sessions: sessions,
  signedInDevices: signedInDevices,
  storage: storage,
  tabCapture: tabCapture,
  topSites: topSites,
  tts: tts,
  ttsEngine: ttsEngine,
  unlimitedStorage: unlimitedStorage,
  vpnProvider: vpnProvider,
  wallpaper: wallpaper,
  webNavigation: webNavigation,
  webRequest: webRequest,
  webRequestBlocking: webRequestBlocking
});

/* ============================================ */
/*              DERIVE PERMISSIONS              */
/* ============================================ */

const derivePermissions = (set, { code }) =>
  Object.entries(permissions)
    .filter(([key]) => key !== 'default')
    .filter(([, fn]) => fn(code))
    .map(([key]) => key)
    .reduce((s, p) => s.add(p), set);

/* -------------------------------------------- */
/*                 DERIVE FILES                 */
/* -------------------------------------------- */

function deriveFiles(
  manifest,
  srcDir,
  options,
) {
  if (manifest.manifest_version === 3) {
    return deriveFilesMV3(manifest, srcDir, options)
  } else {
    return deriveFilesMV2(manifest, srcDir, options)
  }
}

function deriveFilesMV3(
  manifest,
  srcDir,
  options,
) {
  const locales = isString(manifest.default_locale)
    ? ['_locales/**/messages.json']
    : [];

  const files = get(
    manifest,
    'web_accessible_resources',
    [] ,
  )
    .flatMap(({ resources }) => resources)
    .concat(locales)
    .reduce((r, x) => {
      if (glob.hasMagic(x)) {
        const files = glob.sync(x, { cwd: srcDir });
        return [...r, ...files.map((f) => f.replace(srcDir, ''))]
      } else {
        return [...r, x]
      }
    }, [] );

  const contentScripts = get(
    manifest,
    'content_scripts',
    [] ,
  ).reduce((r, { js = [] }) => [...r, ...js], [] );

  const js = [
    ...files.filter((f) => /\.[jt]sx?$/.test(f)),
    get(manifest, 'background.service_worker'),
    ...(options.contentScripts ? contentScripts : []),
  ];

  const html = [
    ...files.filter((f) => /\.html?$/.test(f)),
    get(manifest, 'options_page'),
    get(manifest, 'options_ui.page'),
    get(manifest, 'devtools_page'),
    get(manifest, 'action.default_popup'),
    ...Object.values(get(manifest, 'chrome_url_overrides', {})),
  ];

  const css = [
    ...files.filter((f) => f.endsWith('.css')),
    ...get(manifest, 'content_scripts', [] ).reduce(
      (r, { css = [] }) => [...r, ...css],
      [] ,
    ),
  ];

  const img = [
    ...files.filter((f) =>
      /\.(jpe?g|png|svg|tiff?|gif|webp|bmp|ico)$/i.test(f),
    ),
    ...(Object.values(get(manifest, 'icons', {})) ),
    ...(Object.values(get(manifest, 'action.default_icon', {})) ),
  ];

  // Files like fonts, things that are not expected
  const others = difference(files, css, contentScripts, js, html, img);

  return {
    css: validate(css),
    contentScripts: validate(contentScripts),
    js: validate(js),
    html: validate(html),
    img: validate(img),
    others: validate(others),
  }

  function validate(ary) {
    return [...new Set(ary.filter(isString))].map((x) => join(srcDir, x))
  }
}

function deriveFilesMV2(
  manifest,
  srcDir,
  options,
) {
  const locales = isString(manifest.default_locale)
    ? ['_locales/**/messages.json']
    : [];

  const files = get(
    manifest,
    'web_accessible_resources',
    [] ,
  )
    .concat(locales)
    .reduce((r, x) => {
      if (glob.hasMagic(x)) {
        const files = glob.sync(x, { cwd: srcDir });
        return [...r, ...files.map((f) => f.replace(srcDir, ''))]
      } else {
        return [...r, x]
      }
    }, [] );

  const contentScripts = get(
    manifest,
    'content_scripts',
    [] ,
  ).reduce((r, { js = [] }) => [...r, ...js], [] );
  const js = [
    ...files.filter((f) => /\.[jt]sx?$/.test(f)),
    ...get(manifest, 'background.scripts', [] ),
    ...(options.contentScripts ? contentScripts : []),
  ];

  const html = [
    ...files.filter((f) => /\.html?$/.test(f)),
    get(manifest, 'background.page'),
    get(manifest, 'options_page'),
    get(manifest, 'options_ui.page'),
    get(manifest, 'devtools_page'),
    get(manifest, 'browser_action.default_popup'),
    get(manifest, 'page_action.default_popup'),
    ...Object.values(get(manifest, 'chrome_url_overrides', {})),
  ];

  const css = [
    ...files.filter((f) => f.endsWith('.css')),
    ...get(manifest, 'content_scripts', [] ).reduce(
      (r, { css = [] }) => [...r, ...css],
      [] ,
    ),
  ];

  const actionIconSet = [
    'browser_action.default_icon',
    'page_action.default_icon',
  ].reduce((set, query) => {
    const result = get(manifest, query, {});

    if (typeof result === 'string') {
      set.add(result);
    } else {
      Object.values(result).forEach((x) => set.add(x));
    }

    return set
  }, new Set());

  const img = [
    ...actionIconSet,
    ...files.filter((f) =>
      /\.(jpe?g|png|svg|tiff?|gif|webp|bmp|ico)$/i.test(f),
    ),
    ...Object.values(get(manifest, 'icons', {})),
  ];

  // Files like fonts, things that are not expected
  const others = difference(files, css, contentScripts, js, html, img);

  return {
    css: validate(css),
    contentScripts: validate(contentScripts),
    js: validate(js),
    html: validate(html),
    img: validate(img),
    others: validate(others),
  }

  function validate(ary) {
    return [...new Set(ary.filter(isString))].map((x) => join(srcDir, x))
  }
}

var $id$2 = "https://extend-chrome.dev/schema/manifest-strict.schema.json";
var $schema$2 = "http://json-schema.org/draft-07/schema#";
var required = [
	"manifest_version",
	"name",
	"version"
];
var then = {
	$ref: "./manifest-v3.schema.json"
};
var schema = {
	$id: $id$2,
	$schema: $schema$2,
	required: required,
	"if": {
	properties: {
		manifest_version: {
			type: "number",
			"enum": [
				3
			]
		}
	}
},
	then: then,
	"else": {
	$ref: "./manifest-v2.schema.json"
}
};

var $id$1 = "https://extend-chrome.dev/schema/manifest-v2.schema.json";
var $schema$1 = "http://json-schema.org/draft-07/schema#";
var additionalProperties$1 = true;
var definitions$1 = {
	action: {
		dependencies: {
			icons: {
				not: {
					required: [
						"icons"
					]
				}
			},
			name: {
				not: {
					required: [
						"name"
					]
				}
			},
			popup: {
				not: {
					required: [
						"popup"
					]
				}
			}
		},
		properties: {
			default_icon: {
				anyOf: [
					{
						description: "FIXME: String form is deprecated.",
						type: "string"
					},
					{
						description: "Icon for the main toolbar.",
						properties: {
							"19": {
								$ref: "#/definitions/icon"
							},
							"38": {
								$ref: "#/definitions/icon"
							}
						},
						type: "object"
					}
				]
			},
			default_popup: {
				$ref: "#/definitions/uri",
				description: "The popup appears when the user clicks the icon."
			},
			default_title: {
				description: "Tooltip for the main toolbar icon.",
				type: "string"
			}
		},
		type: "object"
	},
	command: {
		additionalProperties: false,
		properties: {
			description: {
				type: "string"
			},
			suggested_key: {
				additionalProperties: false,
				patternProperties: {
					"^(default|mac|windows|linux|chromeos)$": {
						pattern: "^(Ctrl|Command|MacCtrl|Alt|Option)\\+(Shift\\+)?[A-Z]",
						type: "string"
					}
				},
				type: "object"
			}
		},
		type: "object"
	},
	content_security_policy: {
		"default": "script-src 'self'; object-src 'self'",
		description: "This introduces some fairly strict policies that will make extensions more secure by default, and provides you with the ability to create and enforce rules governing the types of content that can be loaded and executed by your extensions and applications.",
		format: "content-security-policy",
		type: "string"
	},
	glob_pattern: {
		format: "glob-pattern",
		type: "string"
	},
	icon: {
		$ref: "#/definitions/uri"
	},
	match_pattern: {
		format: "match-pattern",
		pattern: "^((\\*|http|https|file|ftp|chrome-extension):\\/\\/(\\*|(([^/*:]+:(\\d{1,5}|\\*)))|(\\*.[^\\/*:]+)|[^\\/*:]+)?(\\/.*))|<all_urls>$",
		type: "string"
	},
	mime_type: {
		format: "mime-type",
		pattern: "^(?:application|audio|image|message|model|multipart|text|video)\\/[-+.\\w]+$",
		type: "string"
	},
	page: {
		$ref: "#/definitions/uri"
	},
	permissions: {
		items: {
			format: "permission",
			type: "string"
		},
		type: "array",
		uniqueItems: true
	},
	scripts: {
		items: {
			$ref: "#/definitions/uri"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	},
	uri: {
		type: "string"
	},
	version_string: {
		pattern: "^(?:\\d{1,5}\\.){0,3}\\d{1,5}$",
		type: "string"
	}
};
var dependencies$1 = {
	browser_action: {
		not: {
			required: [
				"page_action"
			]
		}
	},
	content_scripts: {
		not: {
			required: [
				"script_badge"
			]
		}
	},
	page_action: {
		not: {
			required: [
				"browser_action"
			]
		}
	},
	script_badge: {
		not: {
			required: [
				"content_scripts"
			]
		}
	}
};
var properties$1 = {
	action: {
		not: {
		}
	},
	background: {
		dependencies: {
			page: {
				not: {
					required: [
						"scripts"
					]
				}
			},
			scripts: {
				not: {
					required: [
						"page"
					]
				}
			}
		},
		description: "The background page is an HTML page that runs in the extension process. It exists for the lifetime of your extension, and only one instance of it at a time is active.",
		properties: {
			page: {
				$ref: "#/definitions/page",
				"default": "background.html",
				description: "Specify the HTML of the background page."
			},
			persistent: {
				"default": true,
				description: "When false, makes the background page an event page (loaded only when needed).",
				type: "boolean"
			},
			scripts: {
				$ref: "#/definitions/scripts",
				"default": [
					"background.js"
				],
				description: "A background page will be generated by the extension system that includes each of the files listed in the scripts property."
			},
			service_worker: {
				not: {
				}
			},
			type: {
				not: {
				}
			}
		},
		type: "object"
	},
	browser_action: {
		$ref: "#/definitions/action",
		description: "Use browser actions to put icons in the main Google Chrome toolbar, to the right of the address bar. In addition to its icon, a browser action can also have a tooltip, a badge, and a popup."
	},
	chrome_settings_overrides: {
	},
	chrome_url_overrides: {
		additionalProperties: false,
		description: "Override pages are a way to substitute an HTML file from your extension for a page that Google Chrome normally provides.",
		maxProperties: 1,
		properties: {
			bookmarks: {
				$ref: "#/definitions/page",
				"default": "bookmarks.html",
				description: "The page that appears when the user chooses the Bookmark Manager menu item from the Chrome menu or, on Mac, the Bookmark Manager item from the Bookmarks menu. You can also get to this page by entering the URL chrome://bookmarks."
			},
			history: {
				$ref: "#/definitions/page",
				"default": "history.html",
				description: "The page that appears when the user chooses the History menu item from the Chrome menu or, on Mac, the Show Full History item from the History menu. You can also get to this page by entering the URL chrome://history."
			},
			newtab: {
				$ref: "#/definitions/page",
				"default": "newtab.html",
				description: "The page that appears when the user creates a new tab or window. You can also get to this page by entering the URL chrome://newtab."
			}
		},
		type: "object"
	},
	commands: {
		description: "Use the commands API to add keyboard shortcuts that trigger actions in your extension, for example, an action to open the browser action or send a command to the extension.",
		patternProperties: {
			".*": {
				$ref: "#/definitions/command"
			},
			"^_execute_browser_action$": {
				$ref: "#/definitions/command"
			},
			"^_execute_page_action$": {
				$ref: "#/definitions/command"
			}
		},
		type: "object"
	},
	content_pack: {
	},
	content_scripts: {
		description: "Content scripts are JavaScript files that run in the context of web pages.",
		items: {
			additionalProperties: false,
			properties: {
				all_frames: {
					"default": false,
					description: "Controls whether the content script runs in all frames of the matching page, or only the top frame.",
					type: "boolean"
				},
				css: {
					description: "The list of CSS files to be injected into matching pages. These are injected in the order they appear in this array, before any DOM is constructed or displayed for the page.",
					items: {
						$ref: "#/definitions/uri"
					},
					type: "array",
					uniqueItems: true
				},
				exclude_globs: {
					description: "Applied after matches to exclude URLs that match this glob. Intended to emulate the @exclude Greasemonkey keyword.",
					items: {
						$ref: "#/definitions/glob_pattern"
					},
					type: "array",
					uniqueItems: true
				},
				exclude_matches: {
					description: "Excludes pages that this content script would otherwise be injected into.",
					items: {
						$ref: "#/definitions/match_pattern"
					},
					type: "array",
					uniqueItems: true
				},
				include_globs: {
					description: "Applied after matches to include only those URLs that also match this glob. Intended to emulate the @include Greasemonkey keyword.",
					items: {
						$ref: "#/definitions/glob_pattern"
					},
					type: "array",
					uniqueItems: true
				},
				js: {
					$ref: "#/definitions/scripts",
					description: "The list of JavaScript files to be injected into matching pages. These are injected in the order they appear in this array."
				},
				match_about_blank: {
					"default": false,
					description: "Whether to insert the content script on about:blank and about:srcdoc.",
					type: "boolean"
				},
				matches: {
					description: "Specifies which pages this content script will be injected into.",
					items: {
						$ref: "#/definitions/match_pattern"
					},
					minItems: 1,
					type: "array",
					uniqueItems: true
				},
				run_at: {
					"default": "document_idle",
					description: "Controls when the files in js are injected.",
					"enum": [
						"document_start",
						"document_end",
						"document_idle"
					],
					type: "string"
				}
			},
			required: [
				"matches"
			],
			type: "object"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	},
	content_security_policy: {
		$ref: "#/definitions/content_security_policy"
	},
	current_locale: {
	},
	default_locale: {
		"default": "en",
		description: "Specifies the subdirectory of _locales that contains the default strings for this extension.",
		type: "string"
	},
	description: {
		description: "A plain text description of the extension",
		maxLength: 132,
		type: "string"
	},
	devtools_page: {
		$ref: "#/definitions/page",
		description: "A DevTools extension adds functionality to the Chrome DevTools. It can add new UI panels and sidebars, interact with the inspected page, get information about network requests, and more."
	},
	externally_connectable: {
		description: "Declares which extensions, apps, and web pages can connect to your extension via runtime.connect and runtime.sendMessage.",
		items: {
			additionalProperties: false,
			properties: {
				accepts_tls_channel_id: {
					"default": false,
					description: "Indicates that the extension would like to make use of the TLS channel ID of the web page connecting to it. The web page must also opt to send the TLS channel ID to the extension via setting includeTlsChannelId to true in runtime.connect's connectInfo or runtime.sendMessage's options.",
					type: "boolean"
				},
				ids: {
					items: {
						description: "The IDs of extensions or apps that are allowed to connect. If left empty or unspecified, no extensions or apps can connect.",
						type: "string"
					},
					type: "array"
				},
				matches: {
					items: {
						description: "The URL patterns for web pages that are allowed to connect. This does not affect content scripts. If left empty or unspecified, no web pages can connect.",
						type: "string"
					},
					type: "array"
				}
			},
			type: "object"
		},
		type: "object"
	},
	file_browser_handlers: {
		description: "You can use this API to enable users to upload files to your website.",
		items: {
			additionalProperties: false,
			properties: {
				default_title: {
					description: "What the button will display.",
					type: "string"
				},
				file_filters: {
					description: "Filetypes to match.",
					items: {
						type: "string"
					},
					minItems: 1,
					type: "array"
				},
				id: {
					description: "Used by event handling code to differentiate between multiple file handlers",
					type: "string"
				}
			},
			required: [
				"id",
				"default_title",
				"file_filters"
			],
			type: "object"
		},
		minItems: 1,
		type: "array"
	},
	homepage_url: {
		$ref: "#/definitions/uri",
		description: "The URL of the homepage for this extension."
	},
	icons: {
		description: "One or more icons that represent the extension, app, or theme. Recommended format: PNG; also BMP, GIF, ICO, JPEG.",
		minProperties: 1,
		properties: {
			"16": {
				$ref: "#/definitions/icon",
				description: "Used as the favicon for an extension's pages and infobar."
			},
			"48": {
				$ref: "#/definitions/icon",
				description: "Used on the extension management page (chrome://extensions)."
			},
			"128": {
				$ref: "#/definitions/icon",
				description: "Used during installation and in the Chrome Web Store."
			},
			"256": {
				$ref: "#/definitions/icon",
				description: "Used during installation and in the Chrome Web Store."
			}
		},
		type: "object"
	},
	"import": {
	},
	incognito: {
		"default": "spanning",
		description: "Specify how this extension will behave if allowed to run in incognito mode.",
		"enum": [
			"spanning",
			"split",
			"not_allowed"
		],
		type: "string"
	},
	input_components: {
		description: "Allows your extension to handle keystrokes, set the composition, and manage the candidate window.",
		items: {
			additionalProperties: false,
			properties: {
				description: {
					type: "string"
				},
				id: {
					type: "string"
				},
				language: {
					type: "string"
				},
				layouts: {
					type: "array"
				},
				name: {
					type: "string"
				},
				type: {
					type: "string"
				}
			},
			required: [
				"name",
				"type",
				"id",
				"description",
				"language",
				"layouts"
			],
			type: "object"
		},
		type: "array"
	},
	key: {
		description: "This value can be used to control the unique ID of an extension, app, or theme when it is loaded during development.",
		type: "string"
	},
	manifest_version: {
		description: "One integer specifying the version of the manifest file format your package requires.",
		"enum": [
			2
		],
		maximum: 2,
		minimum: 2,
		type: "number"
	},
	minimum_chrome_version: {
		$ref: "#/definitions/version_string",
		description: "The version of Chrome that your extension, app, or theme requires, if any."
	},
	nacl_modules: {
		description: "One or more mappings from MIME types to the Native Client module that handles each type.",
		items: {
			additionalProperties: false,
			properties: {
				mime_type: {
					$ref: "#/definitions/mime_type",
					description: "The MIME type for which the Native Client module will be registered as content handler."
				},
				path: {
					$ref: "#/definitions/uri",
					description: "The location of a Native Client manifest (a .nmf file) within the extension directory."
				}
			},
			required: [
				"path",
				"mime_type"
			],
			type: "object"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	},
	name: {
		description: "The name of the extension",
		maxLength: 45,
		type: "string"
	},
	oauth2: {
		additionalProperties: false,
		description: "Use the Chrome Identity API to authenticate users: the getAuthToken for users logged into their Google Account and the launchWebAuthFlow for users logged into a non-Google account.",
		properties: {
			client_id: {
				description: "You need to register your app in the Google APIs Console to get the client ID.",
				type: "string"
			},
			scopes: {
				items: {
					type: "string"
				},
				minItems: 1,
				type: "array"
			}
		},
		required: [
			"client_id",
			"scopes"
		],
		type: "object"
	},
	offline_enabled: {
		description: "Whether the app or extension is expected to work offline. When Chrome detects that it is offline, apps with this field set to true will be highlighted on the New Tab page.",
		type: "boolean"
	},
	omnibox: {
		additionalProperties: false,
		description: "The omnibox API allows you to register a keyword with Google Chrome's address bar, which is also known as the omnibox.",
		properties: {
			keyword: {
				description: "The keyward that will trigger your extension.",
				type: "string"
			}
		},
		required: [
			"keyword"
		],
		type: "object"
	},
	optional_permissions: {
		$ref: "#/definitions/permissions",
		description: "Use the chrome.permissions API to request declared optional permissions at run time rather than install time, so users understand why the permissions are needed and grant only those that are necessary."
	},
	options_page: {
		$ref: "#/definitions/page",
		"default": "options.html",
		description: "To allow users to customize the behavior of your extension, you may wish to provide an options page. If you do, a link to it will be provided from the extensions management page at chrome://extensions. Clicking the Options link opens a new tab pointing at your options page."
	},
	options_ui: {
		description: "To allow users to customize the behavior of your extension, you may wish to provide an options page. If you do, an Options link will be shown on the extensions management page at chrome://extensions which opens a dialogue containing your options page.",
		properties: {
			chrome_style: {
				"default": true,
				description: "If true, a Chrome user agent stylesheet will be applied to your options page. The default value is false, but we recommend you enable it for a consistent UI with Chrome.",
				type: "boolean"
			},
			open_in_tab: {
				"default": false,
				description: "If true, your extension's options page will be opened in a new tab rather than embedded in chrome://extensions. The default is false, and we recommend that you don't change it. This is only useful to delay the inevitable deprecation of the old options UI! It will be removed soon, so try not to use it. It will break.",
				type: "boolean"
			},
			page: {
				description: "The path to your options page, relative to your extension's root.",
				type: "string"
			}
		},
		required: [
			"page"
		],
		type: "object"
	},
	page_action: {
		$ref: "#/definitions/action",
		description: "Use the chrome.pageAction API to put icons inside the address bar. Page actions represent actions that can be taken on the current page, but that aren't applicable to all pages."
	},
	permissions: {
		$ref: "#/definitions/permissions",
		description: "Permissions help to limit damage if your extension or app is compromised by malware. Some permissions are also displayed to users before installation, as detailed in Permission Warnings."
	},
	platforms: {
	},
	requirements: {
		additionalProperties: false,
		description: "Technologies required by the app or extension. Hosting sites such as the Chrome Web Store may use this list to dissuade users from installing apps or extensions that will not work on their computer.",
		properties: {
			"3D": {
				additionalProperties: false,
				description: "The '3D' requirement denotes GPU hardware acceleration.",
				properties: {
					features: {
						description: "List of the 3D-related features your app requires.",
						items: {
							"enum": [
								"webgl"
							],
							type: "string"
						},
						minItems: 1,
						type: "array",
						uniqueItems: true
					}
				},
				required: [
					"features"
				],
				type: "object"
			},
			plugins: {
				additionalProperties: false,
				description: "Indicates if an app or extension requires NPAPI to run. This requirement is enabled by default when the manifest includes the 'plugins' field.",
				properties: {
					npapi: {
						"default": true,
						type: "boolean"
					}
				},
				required: [
					"npapi"
				],
				type: "object"
			}
		},
		type: "object"
	},
	sandbox: {
		additionalProperties: false,
		description: "Defines an collection of app or extension pages that are to be served in a sandboxed unique origin, and optionally a Content Security Policy to use with them.",
		properties: {
			content_security_policy: {
				$ref: "#/definitions/content_security_policy",
				"default": "sandbox allow-scripts allow-forms"
			},
			pages: {
				items: {
					$ref: "#/definitions/page"
				},
				minItems: 1,
				type: "array",
				uniqueItems: true
			}
		},
		required: [
			"pages"
		],
		type: "object"
	},
	short_name: {
		description: "The short name is typically used where there is insufficient space to display the full name.",
		maxLength: 12,
		type: "string"
	},
	signature: {
	},
	spellcheck: {
	},
	storage: {
	},
	system_indicator: {
	},
	tts_engine: {
		additionalProperties: false,
		description: "Register itself as a speech engine.",
		properties: {
			voices: {
				description: "Voices the extension can synthesize.",
				items: {
					additionalProperties: false,
					properties: {
						event_types: {
							description: "Events sent to update the client on the progress of speech synthesis.",
							items: {
								description: "",
								"enum": [
									"start",
									"word",
									"sentence",
									"marker",
									"end",
									"error"
								],
								type: "string"
							},
							minItems: 1,
							type: "array",
							uniqueItems: true
						},
						gender: {
							description: "If your voice corresponds to a male or female voice, you can use this parameter to help clients choose the most appropriate voice for their application.",
							type: "string"
						},
						lang: {
							description: "Almost always, a voice can synthesize speech in just a single language. When an engine supports more than one language, it can easily register a separate voice for each language.",
							type: "string"
						},
						voice_name: {
							description: "Identifies the name of the voice and the engine used.",
							type: "string"
						}
					},
					required: [
						"voice_name",
						"event_types"
					],
					type: "object"
				},
				minItems: 1,
				type: "array",
				uniqueItems: true
			}
		},
		required: [
			"voices"
		],
		type: "object"
	},
	update_url: {
		$ref: "#/definitions/uri",
		description: "If you publish using the Chrome Developer Dashboard, ignore this field. If you host your own extension or app: URL to an update manifest XML file."
	},
	version: {
		$ref: "#/definitions/version_string",
		description: "One to four dot-separated integers identifying the version of this extension."
	},
	version_name: {
		description: "In addition to the version field, which is used for update purposes, version_name can be set to a descriptive version string and will be used for display purposes if present.",
		type: "string"
	},
	web_accessible_resources: {
		description: "An array of strings specifying the paths (relative to the package root) of packaged resources that are expected to be usable in the context of a web page.",
		items: {
			$ref: "#/definitions/uri"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	}
};
var title$1 = "JSON schema for Google Chrome extension manifest files";
var type$1 = "object";
var schemaMV2 = {
	$id: $id$1,
	$schema: $schema$1,
	additionalProperties: additionalProperties$1,
	definitions: definitions$1,
	dependencies: dependencies$1,
	properties: properties$1,
	title: title$1,
	type: type$1
};

var $id = "https://extend-chrome.dev/schema/manifest-v3.schema.json";
var $schema = "http://json-schema.org/draft-07/schema#";
var additionalProperties = true;
var definitions = {
	action: {
		dependencies: {
			icons: {
				not: {
					required: [
						"icons"
					]
				}
			},
			name: {
				not: {
					required: [
						"name"
					]
				}
			},
			popup: {
				not: {
					required: [
						"popup"
					]
				}
			}
		},
		properties: {
			default_icon: {
				description: "Icon for the main toolbar.",
				properties: {
					"16": {
						$ref: "#/definitions/icon",
						"default": "icon-16.png"
					},
					"24": {
						$ref: "#/definitions/icon",
						"default": "icon-24.png"
					},
					"32": {
						$ref: "#/definitions/icon",
						"default": "icon-32.png"
					}
				},
				type: "object"
			},
			default_popup: {
				$ref: "#/definitions/uri",
				description: "The popup appears when the user clicks the icon."
			},
			default_title: {
				description: "Tooltip for the main toolbar icon.",
				type: "string"
			}
		},
		type: "object"
	},
	command: {
		additionalProperties: false,
		properties: {
			description: {
				type: "string"
			},
			suggested_key: {
				additionalProperties: false,
				patternProperties: {
					"^(default|mac|windows|linux|chromeos)$": {
						pattern: "^(Ctrl|Command|MacCtrl|Alt|Option)\\+(Shift\\+)?[A-Z]",
						type: "string"
					}
				},
				type: "object"
			}
		},
		type: "object"
	},
	content_security_policy: {
		"default": "script-src 'self'; object-src 'self'",
		description: "This introduces some fairly strict policies that will make extensions more secure by default, and provides you with the ability to create and enforce rules governing the types of content that can be loaded and executed by your extensions and applications.",
		format: "content-security-policy",
		type: "string"
	},
	glob_pattern: {
		format: "glob-pattern",
		type: "string"
	},
	icon: {
		$ref: "#/definitions/uri",
		"default": "icon.png"
	},
	match_pattern: {
		format: "match-pattern",
		pattern: "^((\\*|http|https|file|ftp|chrome-extension):\\/\\/(\\*|(([^/*:]+:(\\d{1,5}|\\*)))|(\\*.[^\\/*:]+)|[^\\/*:]+)?(\\/.*))|<all_urls>$",
		type: "string"
	},
	mime_type: {
		format: "mime-type",
		pattern: "^(?:application|audio|image|message|model|multipart|text|video)\\/[-+.\\w]+$",
		type: "string"
	},
	page: {
		$ref: "#/definitions/uri"
	},
	permissions: {
		items: {
			"enum": [
				"activeTab",
				"alarms",
				"background",
				"bookmarks",
				"browsingData",
				"certificateProvider",
				"clipboardRead",
				"clipboardWrite",
				"contentSettings",
				"contextMenus",
				"cookies",
				"debugger",
				"declarativeContent",
				"declarativeNetRequest",
				"declarativeNetRequestFeedback",
				"declarativeNetRequestWithHostAccess",
				"declarativeWebRequest",
				"desktopCapture",
				"documentScan",
				"downloads",
				"enterprise.deviceAttributes",
				"enterprise.hardwarePlatform",
				"enterprise.networkingAttributes",
				"enterprise.platformKeys",
				"experimental",
				"fileBrowserHandler",
				"fileSystemProvider",
				"fontSettings",
				"gcm",
				"geolocation",
				"history",
				"identity",
				"identity.email",
				"idle",
				"loginState",
				"management",
				"nativeMessaging",
				"notifications",
				"pageCapture",
				"platformKeys",
				"power",
				"printerProvider",
				"printing",
				"printingMetrics",
				"privacy",
				"processes",
				"proxy",
				"scripting",
				"search",
				"sessions",
				"signedInDevices",
				"storage",
				"system.cpu",
				"system.display",
				"system.memory",
				"system.storage",
				"tabCapture",
				"tabGroups",
				"tabs",
				"topSites",
				"tts",
				"ttsEngine",
				"unlimitedStorage",
				"vpnProvider",
				"wallpaper",
				"webNavigation",
				"webRequest",
				"webRequestBlocking"
			],
			type: "string"
		},
		type: "array",
		uniqueItems: true
	},
	files: {
		items: {
			$ref: "#/definitions/uri"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	},
	service_worker: {
		$ref: "#/definitions/uri"
	},
	uri: {
		type: "string"
	},
	version_string: {
		pattern: "^(?:\\d{1,5}\\.){0,3}\\d{1,5}$",
		type: "string"
	}
};
var dependencies = {
	content_scripts: {
		not: {
			required: [
				"script_badge"
			]
		}
	},
	script_badge: {
		not: {
			required: [
				"content_scripts"
			]
		}
	}
};
var properties = {
	action: {
		$ref: "#/definitions/action",
		description: "Use the extension action to put icons in the main Google Chrome toolbar, to the right of the address bar. In addition to its icon, an action can also have a tooltip, a badge, and a popup."
	},
	background: {
		description: "Extensions use the background service worker to listen for events.",
		properties: {
			service_worker: {
				$ref: "#/definitions/service_worker",
				"default": "service-worker.js",
				description: "Specify the service worker file. It must be located in the root folder of the extension next to the manifest."
			},
			type: {
				type: "string",
				"enum": [
					"module"
				]
			},
			persistent: {
				not: {
				}
			},
			scripts: {
				not: {
				}
			},
			page: {
				not: {
				}
			}
		},
		type: "object"
	},
	browser_action: {
		not: {
		}
	},
	chrome_settings_overrides: {
	},
	chrome_url_overrides: {
		additionalProperties: false,
		description: "Override pages are a way to substitute an HTML file from your extension for a page that Google Chrome normally provides.",
		maxProperties: 1,
		properties: {
			bookmarks: {
				$ref: "#/definitions/page",
				"default": "bookmarks.html",
				description: "The page that appears when the user chooses the Bookmark Manager menu item from the Chrome menu or, on Mac, the Bookmark Manager item from the Bookmarks menu. You can also get to this page by entering the URL chrome://bookmarks."
			},
			history: {
				$ref: "#/definitions/page",
				"default": "history.html",
				description: "The page that appears when the user chooses the History menu item from the Chrome menu or, on Mac, the Show Full History item from the History menu. You can also get to this page by entering the URL chrome://history."
			},
			newtab: {
				$ref: "#/definitions/page",
				"default": "newtab.html",
				description: "The page that appears when the user creates a new tab or window. You can also get to this page by entering the URL chrome://newtab."
			}
		},
		type: "object"
	},
	commands: {
		description: "Use the commands API to add keyboard shortcuts that trigger actions in your extension, for example, an action to open the browser action or send a command to the extension.",
		patternProperties: {
			".*": {
				$ref: "#/definitions/command"
			},
			"^_execute_browser_action$": {
				$ref: "#/definitions/command"
			},
			"^_execute_page_action$": {
				$ref: "#/definitions/command"
			}
		},
		type: "object"
	},
	content_pack: {
	},
	content_scripts: {
		description: "Content scripts are JavaScript files that run in the context of web pages.",
		items: {
			additionalProperties: false,
			properties: {
				all_frames: {
					"default": false,
					description: "Controls whether the content script runs in all frames of the matching page, or only the top frame.",
					type: "boolean"
				},
				css: {
					description: "The list of CSS files to be injected into matching pages. These are injected in the order they appear in this array, before any DOM is constructed or displayed for the page.",
					items: {
						$ref: "#/definitions/uri"
					},
					type: "array",
					uniqueItems: true
				},
				exclude_globs: {
					description: "Applied after matches to exclude URLs that match this glob. Intended to emulate the @exclude Greasemonkey keyword.",
					items: {
						$ref: "#/definitions/glob_pattern"
					},
					type: "array",
					uniqueItems: true
				},
				exclude_matches: {
					description: "Excludes pages that this content script would otherwise be injected into.",
					items: {
						$ref: "#/definitions/match_pattern"
					},
					type: "array",
					uniqueItems: true
				},
				include_globs: {
					description: "Applied after matches to include only those URLs that also match this glob. Intended to emulate the @include Greasemonkey keyword.",
					items: {
						$ref: "#/definitions/glob_pattern"
					},
					type: "array",
					uniqueItems: true
				},
				js: {
					$ref: "#/definitions/files",
					description: "The list of JavaScript files to be injected into matching pages. These are injected in the order they appear in this array."
				},
				match_about_blank: {
					"default": false,
					description: "Whether to insert the content script on about:blank and about:srcdoc.",
					type: "boolean"
				},
				matches: {
					description: "Specifies which pages this content script will be injected into.",
					items: {
						$ref: "#/definitions/match_pattern"
					},
					minItems: 1,
					type: "array",
					uniqueItems: true
				},
				run_at: {
					"default": "document_idle",
					description: "Controls when the files in js are injected.",
					"enum": [
						"document_start",
						"document_end",
						"document_idle"
					],
					type: "string"
				}
			},
			required: [
				"matches"
			],
			type: "object"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	},
	content_security_policy: {
		properties: {
			extension_pages: {
				$ref: "#/definitions/content_security_policy"
			},
			sandbox: {
				$ref: "#/definitions/content_security_policy"
			}
		},
		type: "object"
	},
	current_locale: {
	},
	default_locale: {
		"default": "en",
		description: "Specifies the subdirectory of _locales that contains the default strings for this extension.",
		type: "string"
	},
	description: {
		description: "A plain text description of the extension",
		maxLength: 132,
		type: "string"
	},
	devtools_page: {
		$ref: "#/definitions/page",
		description: "A DevTools extension adds functionality to the Chrome DevTools. It can add new UI panels and sidebars, interact with the inspected page, get information about network requests, and more."
	},
	externally_connectable: {
		description: "Declares which extensions, apps, and web pages can connect to your extension via runtime.connect and runtime.sendMessage.",
		items: {
			additionalProperties: false,
			properties: {
				accepts_tls_channel_id: {
					"default": false,
					description: "Indicates that the extension would like to make use of the TLS channel ID of the web page connecting to it. The web page must also opt to send the TLS channel ID to the extension via setting includeTlsChannelId to true in runtime.connect's connectInfo or runtime.sendMessage's options.",
					type: "boolean"
				},
				ids: {
					items: {
						description: "The IDs of extensions or apps that are allowed to connect. If left empty or unspecified, no extensions or apps can connect.",
						type: "string"
					},
					type: "array"
				},
				matches: {
					items: {
						description: "The URL patterns for web pages that are allowed to connect. This does not affect content scripts. If left empty or unspecified, no web pages can connect.",
						type: "string"
					},
					type: "array"
				}
			},
			type: "object"
		},
		type: "object"
	},
	file_browser_handlers: {
		description: "You can use this API to enable users to upload files to your website.",
		items: {
			additionalProperties: false,
			properties: {
				default_title: {
					description: "What the button will display.",
					type: "string"
				},
				file_filters: {
					description: "Filetypes to match.",
					items: {
						type: "string"
					},
					minItems: 1,
					type: "array"
				},
				id: {
					description: "Used by event handling code to differentiate between multiple file handlers",
					type: "string"
				}
			},
			required: [
				"id",
				"default_title",
				"file_filters"
			],
			type: "object"
		},
		minItems: 1,
		type: "array"
	},
	host_permissions: {
		description: "Contains one or more match patterns that give access to one or more hosts.",
		items: {
			$ref: "#/definitions/match_pattern"
		},
		type: "array",
		uniqueItems: true
	},
	homepage_url: {
		$ref: "#/definitions/uri",
		description: "The URL of the homepage for this extension."
	},
	icons: {
		description: "One or more icons that represent the extension, app, or theme. Recommended format: PNG; also BMP, GIF, ICO, JPEG.",
		minProperties: 1,
		properties: {
			"16": {
				$ref: "#/definitions/icon",
				description: "Used as the favicon for an extension's pages and infobar."
			},
			"48": {
				$ref: "#/definitions/icon",
				description: "Used on the extension management page (chrome://extensions)."
			},
			"128": {
				$ref: "#/definitions/icon",
				description: "Used during installation and in the Chrome Web Store."
			},
			"256": {
				$ref: "#/definitions/icon",
				description: "Used during installation and in the Chrome Web Store."
			}
		},
		type: "object"
	},
	"import": {
	},
	incognito: {
		"default": "spanning",
		description: "Specify how this extension will behave if allowed to run in incognito mode.",
		"enum": [
			"spanning",
			"split",
			"not_allowed"
		],
		type: "string"
	},
	input_components: {
		description: "Allows your extension to handle keystrokes, set the composition, and manage the candidate window.",
		items: {
			additionalProperties: false,
			properties: {
				description: {
					type: "string"
				},
				id: {
					type: "string"
				},
				language: {
					type: "string"
				},
				layouts: {
					type: "array"
				},
				name: {
					type: "string"
				},
				type: {
					type: "string"
				}
			},
			required: [
				"name",
				"type",
				"id",
				"description",
				"language",
				"layouts"
			],
			type: "object"
		},
		type: "array"
	},
	key: {
		description: "This value can be used to control the unique ID of an extension, app, or theme when it is loaded during development.",
		type: "string"
	},
	manifest_version: {
		description: "One integer specifying the version of the manifest file format your package requires.",
		"enum": [
			3
		],
		type: "number"
	},
	minimum_chrome_version: {
		$ref: "#/definitions/version_string",
		description: "The version of Chrome that your extension, app, or theme requires, if any."
	},
	nacl_modules: {
		description: "One or more mappings from MIME types to the Native Client module that handles each type.",
		items: {
			additionalProperties: false,
			properties: {
				mime_type: {
					$ref: "#/definitions/mime_type",
					description: "The MIME type for which the Native Client module will be registered as content handler."
				},
				path: {
					$ref: "#/definitions/uri",
					description: "The location of a Native Client manifest (a .nmf file) within the extension directory."
				}
			},
			required: [
				"path",
				"mime_type"
			],
			type: "object"
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	},
	name: {
		description: "The name of the extension",
		maxLength: 45,
		type: "string"
	},
	oauth2: {
		additionalProperties: false,
		description: "Use the Chrome Identity API to authenticate users: the getAuthToken for users logged into their Google Account and the launchWebAuthFlow for users logged into a non-Google account.",
		properties: {
			client_id: {
				description: "You need to register your app in the Google APIs Console to get the client ID.",
				type: "string"
			},
			scopes: {
				items: {
					type: "string"
				},
				minItems: 1,
				type: "array"
			}
		},
		required: [
			"client_id",
			"scopes"
		],
		type: "object"
	},
	offline_enabled: {
		description: "Whether the app or extension is expected to work offline. When Chrome detects that it is offline, apps with this field set to true will be highlighted on the New Tab page.",
		type: "boolean"
	},
	omnibox: {
		additionalProperties: false,
		description: "The omnibox API allows you to register a keyword with Google Chrome's address bar, which is also known as the omnibox.",
		properties: {
			keyword: {
				description: "The keyward that will trigger your extension.",
				type: "string"
			}
		},
		required: [
			"keyword"
		],
		type: "object"
	},
	optional_permissions: {
		$ref: "#/definitions/permissions",
		description: "Use the chrome.permissions API to request declared optional permissions at run time rather than install time, so users understand why the permissions are needed and grant only those that are necessary."
	},
	options_page: {
		$ref: "#/definitions/page",
		"default": "options.html",
		description: "To allow users to customize the behavior of your extension, you may wish to provide an options page. If you do, a link to it will be provided from the extensions management page at chrome://extensions. Clicking the Options link opens a new tab pointing at your options page."
	},
	options_ui: {
		description: "To allow users to customize the behavior of your extension, you may wish to provide an options page. If you do, an Options link will be shown on the extensions management page at chrome://extensions which opens a dialogue containing your options page.",
		properties: {
			chrome_style: {
				"default": true,
				description: "If true, a Chrome user agent stylesheet will be applied to your options page. The default value is false, but we recommend you enable it for a consistent UI with Chrome.",
				type: "boolean"
			},
			open_in_tab: {
				"default": false,
				description: "If true, your extension's options page will be opened in a new tab rather than embedded in chrome://extensions. The default is false, and we recommend that you don't change it. This is only useful to delay the inevitable deprecation of the old options UI! It will be removed soon, so try not to use it. It will break.",
				type: "boolean"
			},
			page: {
				description: "The path to your options page, relative to your extension's root.",
				type: "string"
			}
		},
		required: [
			"page"
		],
		type: "object"
	},
	page_action: {
		not: {
		}
	},
	permissions: {
		$ref: "#/definitions/permissions",
		description: "Permissions help to limit damage if your extension or app is compromised by malware. Some permissions are also displayed to users before installation, as detailed in Permission Warnings."
	},
	platforms: {
	},
	requirements: {
		additionalProperties: false,
		description: "Technologies required by the app or extension. Hosting sites such as the Chrome Web Store may use this list to dissuade users from installing apps or extensions that will not work on their computer.",
		properties: {
			"3D": {
				additionalProperties: false,
				description: "The '3D' requirement denotes GPU hardware acceleration.",
				properties: {
					features: {
						description: "List of the 3D-related features your app requires.",
						items: {
							"enum": [
								"webgl"
							],
							type: "string"
						},
						minItems: 1,
						type: "array",
						uniqueItems: true
					}
				},
				required: [
					"features"
				],
				type: "object"
			},
			plugins: {
				additionalProperties: false,
				description: "Indicates if an app or extension requires NPAPI to run. This requirement is enabled by default when the manifest includes the 'plugins' field.",
				properties: {
					npapi: {
						"default": true,
						type: "boolean"
					}
				},
				required: [
					"npapi"
				],
				type: "object"
			}
		},
		type: "object"
	},
	sandbox: {
		additionalProperties: false,
		description: "Defines an collection of app or extension pages that are to be served in a sandboxed unique origin, and optionally a Content Security Policy to use with them.",
		properties: {
			content_security_policy: {
				$ref: "#/definitions/content_security_policy",
				"default": "sandbox allow-scripts allow-forms"
			},
			pages: {
				items: {
					$ref: "#/definitions/page"
				},
				minItems: 1,
				type: "array",
				uniqueItems: true
			}
		},
		required: [
			"pages"
		],
		type: "object"
	},
	short_name: {
		description: "The short name is typically used where there is insufficient space to display the full name.",
		maxLength: 12,
		type: "string"
	},
	signature: {
	},
	spellcheck: {
	},
	storage: {
	},
	system_indicator: {
	},
	tts_engine: {
		additionalProperties: false,
		description: "Register itself as a speech engine.",
		properties: {
			voices: {
				description: "Voices the extension can synthesize.",
				items: {
					additionalProperties: false,
					properties: {
						event_types: {
							description: "Events sent to update the client on the progress of speech synthesis.",
							items: {
								description: "",
								"enum": [
									"start",
									"word",
									"sentence",
									"marker",
									"end",
									"error"
								],
								type: "string"
							},
							minItems: 1,
							type: "array",
							uniqueItems: true
						},
						gender: {
							description: "If your voice corresponds to a male or female voice, you can use this parameter to help clients choose the most appropriate voice for their application.",
							type: "string"
						},
						lang: {
							description: "Almost always, a voice can synthesize speech in just a single language. When an engine supports more than one language, it can easily register a separate voice for each language.",
							type: "string"
						},
						voice_name: {
							description: "Identifies the name of the voice and the engine used.",
							type: "string"
						}
					},
					required: [
						"voice_name",
						"event_types"
					],
					type: "object"
				},
				minItems: 1,
				type: "array",
				uniqueItems: true
			}
		},
		required: [
			"voices"
		],
		type: "object"
	},
	update_url: {
		$ref: "#/definitions/uri",
		description: "If you publish using the Chrome Developer Dashboard, ignore this field. If you host your own extension or app: URL to an update manifest XML file."
	},
	version: {
		$ref: "#/definitions/version_string",
		description: "One to four dot-separated integers identifying the version of this extension."
	},
	version_name: {
		description: "In addition to the version field, which is used for update purposes, version_name can be set to a descriptive version string and will be used for display purposes if present.",
		type: "string"
	},
	web_accessible_resources: {
		description: "An array of objects that declare resource access rules. Each object maps an array of extension resources to an array of URLs and/or extension IDs that can access those resources.",
		items: {
			anyOf: [
				{
					required: [
						"matches"
					]
				},
				{
					required: [
						"extensions"
					]
				}
			],
			properties: {
				resources: {
					$ref: "#/definitions/files"
				},
				matches: {
					items: {
						$ref: "#/definitions/match_pattern"
					},
					minItems: 1,
					type: "array",
					uniqueItems: true
				},
				extensions: {
					items: {
						maxLength: 32,
						minLength: 32,
						pattern: "^[a-z]+$",
						type: "string"
					},
					type: "array"
				},
				use_dynamic_url: {
					"default": true,
					type: "boolean"
				}
			},
			required: [
				"resources"
			]
		},
		minItems: 1,
		type: "array",
		uniqueItems: true
	}
};
var title = "JSON schema for Google Chrome extension manifest files";
var type = "object";
var schemaMV3 = {
	$id: $id,
	$schema: $schema,
	additionalProperties: additionalProperties,
	definitions: definitions,
	dependencies: dependencies,
	properties: properties,
	title: title,
	type: type
};

function _nullishCoalesce$4(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain$5(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }
const ajv = new Ajv({
  schemas: [schema, schemaMV2, schemaMV3],
  strict: false,
  verbose: true,
});

ajv.addFormat('glob-pattern', true);
ajv.addFormat('match-pattern', true);
ajv.addFormat('content-security-policy', true);
ajv.addFormat('mime-type', true);
ajv.addFormat('permission', true);

const validator = ajv.compile(schema);

const setupPointer =
  (target) =>
  (pointer) =>
    JsonPointer.create(pointer).get(target); 

const getSchemaDataMV2 = setupPointer(schemaMV2);
const getSchemaDataMV3 = setupPointer(schemaMV3);

const ignoredErrors = ['must match "then" schema', 'must match "else" schema'];

function validateManifest(
  manifest,
) {
  const valid = validator(manifest);
  if (valid === true) return manifest

  const getValue = setupPointer(manifest);
  const getDesc =
    manifest.manifest_version === 2 ? getSchemaDataMV2 : getSchemaDataMV3;

  throw new Error(
    [
      'There were problems with the extension manifest.',
      ...(_nullishCoalesce$4(_optionalChain$5([validator, 'access', _ => _.errors
, 'optionalAccess', _2 => _2.filter, 'call', _3 => _3(({ message }) => message && !ignoredErrors.includes(message))
, 'access', _4 => _4.map, 'call', _5 => _5((e) => {
          const schemaPath = `/${e.schemaPath
            .split('/')
            .slice(1, -1)
            .concat('description')
            .join('/')}`;
          const desc = _nullishCoalesce$4(getDesc(schemaPath), () => ( e.message));

          if (e.instancePath.length === 0) {
            return `- Manifest ${desc}`
          }

          return `- ${JSON.stringify(getValue(e.instancePath))} at "${
            e.instancePath
          }" ${desc}`
        })]), () => ( []))),
    ].join('\n'),
  )
}

const convertMatchPatterns = (m) => {
  // Use URL to parse match pattern
  // URL must have valid url scheme
  const [scheme, rest] = m.split('://');

  // URL must have valid port
  const [a, port, b] = rest.split(/(:\*)/);
  const isWildPort = port === ':*';
  const frag = isWildPort ? `${a}:3333${b}` : rest;

  // match patterns can only define origin
  const { origin } = new URL(`http://${frag}`);
  const [, base] = origin.split('://');

  // put port back
  const [x, y] = base.split(':3333');
  const final = isWildPort ? [x, port, y].join('') : base;

  // URL escapes asterixes
  // Need to unescape them
  return unescape(`${scheme}://${final}/*`)
};

function _nullishCoalesce$3(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain$4(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }
function getImportContentScriptFileName(target) {
  const base = basename(target);
  return target.replace(base, `import-${base}`)
}

function updateManifestV3(
  m,
  options,
  wrapContentScripts,
  cache,
) {
  const manifest = cloneObject(m);

  if (manifest.background) {
    manifest.background.type = 'module';
  }

  if (manifest.content_scripts) {
    const { output = {} } = options;
    const { chunkFileNames = 'chunks/[name]-[hash].js' } = Array.isArray(output)
      ? output[0]
      : output;

    const cfn = chunkFileNames; 

    cache.chunkFileNames = cfn;

    // Output could be an array
    if (Array.isArray(output)) {
      if (
        // Should only be one value for chunkFileNames
        output.reduce((r, x) => r.add(_nullishCoalesce$3(x.chunkFileNames, () => ( 'no cfn'))), new Set())
          .size > 1
      )
        // We need to know chunkFileNames now, before the output stage
        throw new TypeError(
          'Multiple output values for chunkFileNames are not supported',
        )

      // If chunkFileNames is undefined, use our default
      output.forEach((x) => (x.chunkFileNames = cfn));
    } else {
      // If chunkFileNames is undefined, use our default
      output.chunkFileNames = cfn;
    }

    const allMatches = manifest.content_scripts
      .flatMap(({ matches }) => _nullishCoalesce$3(matches, () => ( [])))
      .concat(_nullishCoalesce$3(manifest.host_permissions, () => ( [])))
      .map(convertMatchPatterns);

    const matches = Array.from(new Set(allMatches));
    // Use slash to guarantee support Windows
    const resources = [
      slash(
        `${cfn
          .split('/')
          .join('/')
          .replace('[format]', '*')
          .replace('[name]', '*')
          .replace('[hash]', '*')}`,
      ),
      ...cache.contentScripts.map((x) => slash(relative(cache.srcDir, x))),
    ];

    if (wrapContentScripts) {
      manifest.content_scripts = manifest.content_scripts.map((c) => ({
        ...c,
        js: _optionalChain$4([c, 'access', _ => _.js, 'optionalAccess', _2 => _2.map, 'call', _3 => _3(getImportContentScriptFileName)]),
      }));
    }

    manifest.web_accessible_resources = _nullishCoalesce$3(manifest.web_accessible_resources, () => ( []));

    manifest.web_accessible_resources.push({
      resources,
      matches,
    });
  }

  return manifest
}

function _optionalChain$3(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }





function warnDeprecatedOptions(
  
  {
    browserPolyfill,
    crossBrowser,
    dynamicImportWrapper,
    firstClassManifest,
    iifeJsonPaths,
    publicKey,
    contentScriptWrapper,
  }








,
  cache,
) {
  /* ------------ WARN DEPRECATED OPTIONS ------------ */
  if (crossBrowser) this.warn('`options.crossBrowser` is not implemented yet');

  if (!firstClassManifest)
    this.warn('`options.firstClassManifest` will be removed in version 5.0.0');

  if (_optionalChain$3([iifeJsonPaths, 'optionalAccess', _ => _.length])) this.warn('`options.iifeJsonPaths` is deprecated');

  if (typeof contentScriptWrapper !== 'undefined')
    this.warn(
      '`options.contentScriptWrapper` is deprecated.\nPlease use `options.wrapContentScript`',
    );

  if (isMV2(cache.manifest))
    // MV2 manifest is handled in `generateBundle`
    return

  if (browserPolyfill)
    this.warn(
      [
        '`options.browserPolyfill` is deprecated for MV3 and does nothing internally',
        'See: https://extend-chrome.dev/rollup-plugin#mv3-faq',
      ].join('\n'),
    );

  if (
    // This should be an empty object
    typeof dynamicImportWrapper !== 'object' ||
    Object.keys(dynamicImportWrapper).length > 0
  )
    this.warn('`options.dynamicImportWrapper` is not required for MV3');

  if (publicKey)
    this.warn(
      [
        '`options.publicKey` is deprecated for MV3,',
        'please use `options.extendManifest` instead',
        'see: https://extend-chrome.dev/rollup-plugin#mv3-faq',
      ].join('\n'),
    );
}

function _nullishCoalesce$2(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain$2(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }
const explorer = cosmiconfigSync('manifest', {
  cache: false,
  loaders: {
    '.ts': (filePath) => {
      require('esbuild-runner/register');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const result = require(filePath);

      return _nullishCoalesce$2(result.default, () => ( result))
    },
  },
});

const name = 'manifest-input';

// We use a stub if the manifest has no scripts
//   eg, a CSS only Chrome Extension
const stubChunkNameForCssOnlyCrx =
  'stub__css-only-chrome-extension-manifest';
const importWrapperChunkNamePrefix = '__RPCE-import-wrapper';

const npmPkgDetails =
  process.env.npm_package_name &&
  process.env.npm_package_version &&
  process.env.npm_package_description
    ? {
        name: process.env.npm_package_name,
        version: process.env.npm_package_version,
        description: process.env.npm_package_description,
      }
    : {
        name: '',
        version: '',
        description: '',
      };

/* ============================================ */
/*                MANIFEST-INPUT                */
/* ============================================ */

function manifestInput(
  {
    browserPolyfill = false,
    contentScriptWrapper = true,
    crossBrowser = false,
    dynamicImportWrapper = {},
    extendManifest = {},
    firstClassManifest = true,
    iifeJsonPaths = [],
    pkg = npmPkgDetails,
    publicKey,
    verbose = true,
    wrapContentScripts = true,
    cache = {
      assetChanged: false,
      assets: [],
      contentScripts: [],
      contentScriptCode: {},
      contentScriptIds: {},
      iife: [],
      input: [],
      inputAry: [],
      inputObj: {},
      permsHash: '',
      readFile: new Map(),
      srcDir: null,
    } ,
  } = {} ,
) {
  const readAssetAsBuffer = memoize(
    (filepath) => {
      return fs.readFile(filepath)
    },
    {
      cache: cache.readFile,
    },
  );

  /* ------------------ DEPRECATIONS ----------------- */

  // contentScriptWrapper = wrapContentScripts

  /* ----------- HOOKS CLOSURES START ----------- */

  let manifestPath;

  const manifestName = 'manifest.json';

  /* ------------ HOOKS CLOSURES END ------------ */

  /* - SETUP DYNAMIC IMPORT LOADER SCRIPT START - */

  let wrapperScript = '';
  if (dynamicImportWrapper !== false) {
    wrapperScript = prepImportWrapperScript(dynamicImportWrapper);
  }

  /* -- SETUP DYNAMIC IMPORT LOADER SCRIPT END -- */

  /* --------------- plugin object -------------- */
  return {
    name,

    browserPolyfill,
    crossBrowser,

    get srcDir() {
      return cache.srcDir
    },

    get formatMap() {
      return { iife: cache.iife }
    },

    /* ============================================ */
    /*                 OPTIONS HOOK                 */
    /* ============================================ */

    options(options) {
      /* ----------- LOAD AND PROCESS MANIFEST ----------- */

      // Do not reload manifest without changes
      if (!cache.manifest) {
        const { inputManifestPath, ...cacheValues } =
          getInputManifestPath(options);

        Object.assign(cache, cacheValues);

        const configResult = explorer.load(inputManifestPath); 





        if (configResult.isEmpty) {
          throw new Error(`${options.input} is an empty file.`)
        }

        const { options_page, options_ui } = configResult.config;
        if (isPresent(options_ui) && isPresent(options_page)) {
          throw new Error(
            'options_ui and options_page cannot both be defined in manifest.json.',
          )
        }

        manifestPath = configResult.filepath;
        cache.srcDir = path.dirname(manifestPath);

        let extendedManifest;
        if (typeof extendManifest === 'function') {
          extendedManifest = extendManifest(configResult.config);
        } else if (typeof extendManifest === 'object') {
          extendedManifest = {
            ...configResult.config,
            ...extendManifest,
          }; 
        } else {
          extendedManifest = configResult.config;
        }

        const fullManifest = {
          // MV2 is default
          manifest_version: 2,
          name: pkg.name,
          // version must be all digits with up to three dots
          version: [...(_nullishCoalesce$2(_optionalChain$2([pkg, 'access', _ => _.version, 'optionalAccess', _2 => _2.matchAll, 'call', _3 => _3(/\d+/g)]), () => ( [])))].join('.'),
          description: pkg.description,
          ...extendedManifest,
        }; 

        // If the manifest is the source of truth for inputs
        //   `false` means that all inputs must come from Rollup config
        if (firstClassManifest) {
          // Any scripts from here will be regenerated as IIFE's
          cache.iife = iifeJsonPaths
            .map((jsonPath) => {
              const result = JSONPath({
                path: jsonPath,
                json: fullManifest,
              });

              return result
            })
            .flat(Infinity);

          // Derive entry paths from manifest
          const { js, html, css, img, others, contentScripts } = deriveFiles(
            fullManifest,
            cache.srcDir,
            {
              contentScripts: true,
            },
          );

          cache.contentScripts = contentScripts;

          // Cache derived inputs
          cache.input = [...cache.inputAry, ...js, ...html];

          cache.assets = [
            // Dedupe assets
            ...new Set([...css, ...img, ...others]),
          ];
        }

        let finalManifest;
        if (isMV3(fullManifest)) {
          finalManifest = updateManifestV3(
            fullManifest,
            options,
            wrapContentScripts,
            cache,
          );
        } else {
          finalManifest = fullManifest;
        }

        cache.manifest = validateManifest(finalManifest);
      }
      /* --------------- END LOAD MANIFEST --------------- */

      // Final `options.input` is an object
      //   this grants full compatibility with all Rollup options
      const finalInput = cache.input.reduce(
        reduceToRecord(cache.srcDir),
        cache.inputObj,
      );

      // Use a stub if no js scripts
      if (Object.keys(finalInput).length === 0) {
        finalInput[stubChunkNameForCssOnlyCrx] = stubChunkNameForCssOnlyCrx;
      }

      return { ...options, input: finalInput }
    },

    async buildStart() {
      /* ------------ WATCH ASSETS FOR CHANGES ----------- */

      this.addWatchFile(manifestPath);

      cache.assets.forEach((srcPath) => {
        this.addWatchFile(srcPath);
      });

      /* ------------------ EMIT ASSETS ------------------ */

      const assets = await Promise.all(
        cache.assets.map(async (srcPath) => {
          const source = await readAssetAsBuffer(srcPath);

          return {
            type: 'asset' ,
            source,
            fileName: path.relative(cache.srcDir, srcPath),
          }
        }),
      );

      assets.forEach((asset) => {
        this.emitFile(asset);
      });

      warnDeprecatedOptions.call(
        this,
        {
          browserPolyfill,
          crossBrowser,
          dynamicImportWrapper,
          firstClassManifest,
          iifeJsonPaths,
          publicKey,
        },
        cache,
      );

      // MV2 manifest is handled in `generateBundle`
      if (isMV2(cache.manifest)) return

      /* ---------- EMIT CONTENT SCRIPT WRAPPERS --------- */

      /* --------------- EMIT MV3 MANIFEST --------------- */

      const manifestBody = cloneObject(cache.manifest);
      const manifestJson = JSON.stringify(manifestBody, undefined, 2).replace(
        /\.[jt]sx?"/g,
        '.js"',
      );

      // Emit manifest.json
      this.emitFile({
        type: 'asset',
        fileName: manifestName,
        source: manifestJson,
      });
    },

    async resolveId(source) {
      return source === stubChunkNameForCssOnlyCrx ||
        source.startsWith(importWrapperChunkNamePrefix)
        ? source
        : null
    },

    load(id) {
      if (id === stubChunkNameForCssOnlyCrx) {
        return {
          code: `console.log(${stubChunkNameForCssOnlyCrx})`,
        }
      } else if (
        wrapContentScripts &&
        isMV3(cache.manifest) &&
        id.startsWith(importWrapperChunkNamePrefix)
      ) {
        const [, target] = id.split(':');
        const code = code$5.replace('%PATH%', JSON.stringify(target));
        return { code }
      }

      return null
    },

    transform(code, id) {
      if (
        wrapContentScripts &&
        isMV3(cache.manifest) &&
        cache.contentScripts.includes(id)
      ) {
        // Use slash to guarantee support Windows
        const target = `${slash(relative(cache.srcDir, id))
          .split('.')
          .slice(0, -1)
          .join('.')}.js`;

        const fileName = getImportContentScriptFileName(target);

        // Emit content script wrapper
        this.emitFile({
          id: `${importWrapperChunkNamePrefix}:${target}`,
          type: 'chunk',
          fileName,
        });
      }

      // No source transformation took place
      return { code, map: null }
    },

    watchChange(id) {
      if (id.endsWith(manifestName)) {
        // Dump cache.manifest if manifest changes
        delete cache.manifest;
        cache.assetChanged = false;
      } else {
        // Force new read of changed asset
        cache.assetChanged = cache.readFile.delete(id);
      }
    },

    /* ============================================ */
    /*                GENERATEBUNDLE                */
    /* ============================================ */

    generateBundle(options, bundle) {
      /* ----------------- CLEAN UP STUB ----------------- */

      delete bundle[stubChunkNameForCssOnlyCrx + '.js'];

      // We don't support completely empty bundles
      if (Object.keys(bundle).length === 0) {
        throw new Error(
          'The Chrome extension must have at least one asset (html or css) or script file.',
        )
      }

      // MV3 is handled in `buildStart` to support Vite
      if (isMV3(cache.manifest)) return

      /* ------------------------------------------------- */
      /*                 EMIT MV2 MANIFEST                 */
      /* ------------------------------------------------- */

      /* ------------ DERIVE PERMISSIONS START ----------- */

      let permissions = [];
      // Get module ids for all chunks
      if (cache.assetChanged && cache.permsHash) {
        // Permissions did not change
        permissions = JSON.parse(cache.permsHash); 

        cache.assetChanged = false;
      } else {
        const chunks = Object.values(bundle).filter(isChunk);

        // Permissions may have changed
        permissions = Array.from(
          chunks.reduce(derivePermissions, new Set()),
        );

        const permsHash = JSON.stringify(permissions);

        if (verbose && permissions.length) {
          if (!cache.permsHash) {
            this.warn(`Detected permissions: ${permissions.toString()}`);
          } else if (permsHash !== cache.permsHash) {
            this.warn(`Detected new permissions: ${permissions.toString()}`);
          }
        }

        cache.permsHash = permsHash;
      }

      const clonedManifest = cloneObject(
        cache.manifest,
      ); 

      const manifestBody = {
        ...clonedManifest,
        permissions: combinePerms(
          permissions,
          clonedManifest.permissions || [],
        ),
      };

      const {
        background: { scripts: bgs = [] } = {},
        content_scripts: cts = [],
        web_accessible_resources: war = [],
      } = manifestBody;

      /* ------------ SETUP BACKGROUND SCRIPTS ----------- */

      // Emit background script wrappers
      if (bgs.length && wrapperScript.length) {
        // background exists because bgs has scripts
        manifestBody.background.scripts = bgs
          .map(normalizeFilename)
          .map((scriptPath) => {
            // Loader script exists because of type guard above
            const source =
              // Path to module being loaded
              wrapperScript.replace(
                '%PATH%',
                // Fix path slashes to support Windows
                JSON.stringify(slash(relative('assets', scriptPath))),
              );

            const assetId = this.emitFile({
              type: 'asset',
              source,
              name: basename(scriptPath),
            });

            return this.getFileName(assetId)
          })
          .map((p) => slash(p));
      }

      /* ---------- END SETUP BACKGROUND SCRIPTS --------- */

      /* ------------- SETUP CONTENT SCRIPTS ------------- */

      const contentScripts = cts.reduce(
        (r, { js = [] }) => [...r, ...js],
        [] ,
      );

      if (contentScriptWrapper && contentScripts.length) {
        const memoizedEmitter = memoize((scriptPath) => {
          const source = code$5.replace(
            '%PATH%',
            // Fix path slashes to support Windows
            JSON.stringify(slash(relative('assets', scriptPath))),
          );

          const assetId = this.emitFile({
            type: 'asset',
            source,
            name: basename(scriptPath),
          });

          return this.getFileName(assetId)
        });

        // Setup content script import wrapper
        manifestBody.content_scripts = cts.map(({ js, ...rest }) => {
          return typeof js === 'undefined'
            ? rest
            : {
                js: js
                  .map(normalizeFilename)
                  .map(memoizedEmitter)
                  .map((p) => slash(p)),
                ...rest,
              }
        });

        // make all imports & dynamic imports web_acc_res
        const imports = Object.values(bundle)
          .filter((x) => x.type === 'chunk')
          .reduce(
            (r, { isEntry, fileName }) =>
              // Get imported filenames
              !isEntry ? [...r, fileName] : r,
            [] ,
          );

        manifestBody.web_accessible_resources = Array.from(
          new Set([
            ...war,
            // FEATURE: filter out imports for background?
            ...imports,
            // Need to be web accessible b/c of import
            ...contentScripts,
          ]),
        ).map((p) => slash(p));

        /* ----------- END SETUP CONTENT SCRIPTS ----------- */
      }

      /* --------- STABLE EXTENSION ID BEGIN -------- */

      if (publicKey) {
        manifestBody.key = publicKey;
      }

      /* ---------- STABLE EXTENSION ID END --------- */

      /* ----------- OUTPUT MANIFEST.JSON BEGIN ---------- */

      const manifestJson = JSON.stringify(manifestBody, null, 2).replace(
        /\.[jt]sx?"/g,
        '.js"',
      );

      // Emit manifest.json
      this.emitFile({
        type: 'asset',
        fileName: manifestName,
        source: manifestJson,
      });

      /* ------------ OUTPUT MANIFEST.JSON END ----------- */
    },
  }
}

const code$2 = "(function () {\n  'use strict';\n\n  const checkPolyfilled = 'typeof browser !== \"undefined\"';\n\n  const _executeScript = chrome.tabs.executeScript;\n  const withP = (...args) =>\n    new Promise((resolve, reject) => {\n      _executeScript(...args, (results) => {\n        if (chrome.runtime.lastError) {\n          reject(chrome.runtime.lastError.message);\n        } else {\n          resolve(results);\n        }\n      });\n    });\n\n  // @ts-expect-error FIXME: executeScript should return Promise<any[]>\n  chrome.tabs.executeScript = (...args) => {\n  (async () => {\n      const baseArgs = (typeof args[0] === 'number' ? [args[0]] : []); \n\n      const [done] = await withP(...(baseArgs.concat({ code: checkPolyfilled }) ));\n\n      if (!done) {\n        await withP(...(baseArgs.concat([{ file: JSON.parse('%BROWSER_POLYFILL_PATH%') }]) ));\n      }\n\n      _executeScript(...(args ));\n    })();\n  };\n\n})();\n";

function _optionalChain$1(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }

const defaultOptions = { executeScript: true };
function browserPolyfill({
  browserPolyfill: options = defaultOptions,
})


 {
  if (options === false)
    return {
      name: 'no-op',
      generateBundle() {},
    }
  else if (options === true) options = defaultOptions;
  const { executeScript = true } = options;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const convert = require('convert-source-map');
  const polyfillPath = require.resolve('webextension-polyfill');
  const src = fs.readFileSync(polyfillPath, 'utf-8');
  const map = fs.readJsonSync(polyfillPath + '.map');

  const browserPolyfillSrc = [
    convert.removeMapFileComments(src),
    convert.fromObject(map).toComment(),
  ].join('\n');

  return {
    name: 'browser-polyfill',
    generateBundle({ plugins = [] }, bundle) {
      const firefoxPlugin = plugins.find(({ name }) => name === 'firefox-addon');
      const chromeExtensionPlugin = plugins.find(
        ({ name }) => name === 'chrome-extension',
      ); 

      if (
        firefoxPlugin &&
        !chromeExtensionPlugin._plugins.manifest.crossBrowser
      ) {
        return // Don't need to add it
      }

      const manifestAsset = bundle['manifest.json'];
      if (!isAsset(manifestAsset)) {
        throw new TypeError(
          `manifest.json must be an OutputAsset, received "${typeof manifestAsset}"`,
        )
      }
      const manifest = JSON.parse(
        manifestAsset.source ,
      ); 

      /* ------------- EMIT BROWSER POLYFILL ------------- */

      // Browser polyfill is not supported for MV3, there are better ways to do this:
      //   `import browser from "webextension-polyfill";`
      //   See: https://github.com/Lusito/webextension-polyfill-ts#migration-guide-from-webextension-polyfill-ts
      if (isMV3(manifest)) return

      const bpId = this.emitFile({
        type: 'asset',
        source: browserPolyfillSrc,
        fileName: 'assets/browser-polyfill.js',
      });

      const browserPolyfillPath = this.getFileName(bpId);

      if (executeScript) {
        const exId = this.emitFile({
          type: 'asset',
          source: code$2.replace(
            '%BROWSER_POLYFILL_PATH%',
            JSON.stringify(browserPolyfillPath),
          ),
          fileName: 'assets/browser-polyfill-executeScript.js',
        });

        const executeScriptPolyfillPath = this.getFileName(exId);

        // TODO: support this in MV3
        _optionalChain$1([manifest, 'access', _ => _.background, 'optionalAccess', _2 => _2.scripts, 'optionalAccess', _3 => _3.unshift, 'call', _4 => _4(executeScriptPolyfillPath)]);
      }

      // TODO: support this in MV3
      _optionalChain$1([manifest, 'access', _5 => _5.background, 'optionalAccess', _6 => _6.scripts, 'optionalAccess', _7 => _7.unshift, 'call', _8 => _8(browserPolyfillPath)]);
      _optionalChain$1([manifest, 'access', _9 => _9.content_scripts, 'optionalAccess', _10 => _10.forEach, 'call', _11 => _11((script) => {
        _optionalChain$1([script, 'access', _12 => _12.js, 'optionalAccess', _13 => _13.unshift, 'call', _14 => _14(browserPolyfillPath)]);
      })]);

      /* ---------------- UPDATE MANIFEST ---------------- */
      manifestAsset.source = JSON.stringify(manifest);
    },
  }
}

const validateNames = () => ({
  name: 'validate-names',

  generateBundle(options, bundle) {
    const chunks = Object.values(bundle).filter(
      (x) => x.type === 'chunk',
    );

    // Files cannot start with "_" in Chrome Extensions, but folders CAN start with "_"
    // Rollup may output a helper file that starts with "_commonjsHelpers"
    // Loop through each file and check for "_commonjsHelpers" in filename
    Object.keys(bundle)
      .filter((fileName) => basename(fileName).startsWith('_commonjsHelpers'))
      .forEach((fileName) => {
        // Only replace first instance
        const regex = new RegExp(fileName);
        const [base, ...rest] = fileName.split('/').reverse();
        const fixed = [base.slice(1), ...rest].reverse().join('/');

        // Fix manifest
        const manifest = bundle['manifest.json']; 
        manifest.source = manifest.source.replace(regex, fixed);

        // Change bundle key
        const chunk = bundle[fileName];
        delete bundle[fileName];
        bundle[fixed] = chunk;

        // Fix chunk
        chunk.fileName = fixed;

        // Find imports and fix
        chunks
          .filter(({ imports }) => imports.includes(fileName))
          .forEach((chunk) => {
            // Fix imports list
            chunk.imports = chunk.imports.map((i) =>
              i === fileName ? fixed : i,
            );
            // Fix imports in code
            chunk.code = chunk.code.replace(regex, fixed);
          });
      });
  },
});

const resolveFromBundle = (bundle) => ({
  name: 'resolve-from-bundle',
  resolveId(source, importer) {
    if (typeof importer === 'undefined') {
      return source
    } else {
      const dirname = path.dirname(importer);
      const resolved = path.join(dirname, source);

      // if it's not in the bundle,
      //   tell Rollup not to try to resolve it
      return resolved in bundle ? resolved : false
    }
  },
  load(id) {
    const chunk = bundle[id];

    if (isChunk(chunk)) {
      return {
        code: chunk.code,
        map: chunk.map,
      }
    } else {
      // anything not in the bundle is external
      //  this doesn't make sense for a chrome extension,
      //    but we should let Rollup handle it
      return null
    }
  },
});

async function regenerateBundle(
  
  { input, output },
  bundle,
) {
  if (!output || Array.isArray(output)) {
    throw new TypeError('options.output must be an OutputOptions object')
  }

  if (typeof input === 'undefined') {
    throw new TypeError(
      'options.input should be an object, string array or string',
    )
  }

  // Don't do anything if input is an empty array
  if (Array.isArray(input) && input.length === 0) {
    return {}
  }

  const { format, chunkFileNames: cfn = '', sourcemap } = output;

  const chunkFileNames = path.join(path.dirname(cfn ), '[name].js');

  // Transform input array to input object
  const inputValue = Array.isArray(input)
    ? input.reduce((r, x) => {
        const { dir, name } = path.parse(x);
        return { ...r, [path.join(dir, name)]: x }
      }, {} )
    : input;

  const build = await rollup({
    input: inputValue,
    plugins: [resolveFromBundle(bundle)],
  });

  let _b;
  await build.generate({
    format,
    sourcemap,
    chunkFileNames,
    plugins: [
      {
        name: 'get-bundle',
        generateBundle(o, b) {
          _b = b;
        },
      } ,
    ],
  });
  const newBundle = _b;

  if (typeof inputValue === 'string') {
    delete bundle[inputValue];

    const bundleKey = path.basename(inputValue);

    return {
      [inputValue]: {
        ...(newBundle[bundleKey] ),
        fileName: inputValue,
      },
    }
  } else {
    // Remove regenerated entries from bundle
    Object.values(inputValue).forEach((key) => {
      delete bundle[key];
    });

    return newBundle
  }
}

function mixedFormat(
  options,
) {
  return {
    name: 'mixed-format',
    async generateBundle(
      
      { format, chunkFileNames, sourcemap },
      bundle,
    ) {
      const { formatMap } = options; // this might not be defined upon init

      if (typeof formatMap === 'undefined') return

      const formats = Object.entries(formatMap).filter(
        (x) =>
          typeof x[1] !== 'undefined',
      );

      {
        const allInput = formats.flatMap(([, inputs]) =>
          Array.isArray(inputs) ? inputs : Object.values(inputs || {}),
        );
        const allInputSet = new Set(allInput);
        if (allInput.length !== allInputSet.size) {
          throw new Error('formats should not have duplicate inputs')
        }
      }

      // TODO: handle different kinds of formats differently?
      const bundles = await Promise.all(
        // Configured formats
        formats.flatMap(([f, inputs]) =>
          (Array.isArray(inputs) ? inputs : Object.values(inputs)).map(
            (input) =>
              regenerateBundle.call(
                this,
                {
                  input,
                  output: {
                    format: f,
                    chunkFileNames,
                    sourcemap,
                  },
                },
                bundle,
              ),
          ),
        ),
      );

      // Base format (ESM)
      const base = await regenerateBundle.call(
        this,
        {
          input: Object.entries(bundle)
            .filter(([, file]) => isChunk(file) && file.isEntry)
            .map(([key]) => key),
          output: { format, chunkFileNames, sourcemap },
        },
        bundle,
      );

      // Empty bundle
      Object.entries(bundle)
        .filter(([, v]) => isChunk(v))
        .forEach(([key]) => {
          delete bundle[key];
        });

      // Refill bundle
      Object.assign(bundle, base, ...bundles);
    },
  }
}

const code$1 = "(function () {\n  'use strict';\n\n  /* ------------------- FILENAMES ------------------- */\n\n  /* ------------------ PLACEHOLDERS ----------------- */\n\n  const timestampPathPlaceholder = '%TIMESTAMP_PATH%';\n  const loadMessagePlaceholder = '%LOAD_MESSAGE%';\n  const ctScriptPathPlaceholder = '%CONTENT_SCRIPT_PATH%';\n  const unregisterServiceWorkersPlaceholder =\n    '%UNREGISTER_SERVICE_WORKERS%';\n  const executeScriptPlaceholder = '%EXECUTE_SCRIPT%';\n\n  var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};\n\n  function commonjsRequire (path) {\n  \tthrow new Error('Could not dynamically require \"' + path + '\". Please configure the dynamicRequireTargets or/and ignoreDynamicRequires option of @rollup/plugin-commonjs appropriately for this require call to work.');\n  }\n\n  var localforage$1 = {exports: {}};\n\n  /*!\n      localForage -- Offline Storage, Improved\n      Version 1.10.0\n      https://localforage.github.io/localForage\n      (c) 2013-2017 Mozilla, Apache License 2.0\n  */\n\n  (function (module, exports) {\n  (function(f){{module.exports=f();}})(function(){return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof commonjsRequire==\"function\"&&commonjsRequire;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error(\"Cannot find module '\"+o+\"'\");throw (f.code=\"MODULE_NOT_FOUND\", f)}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r);}return n[o].exports}var i=typeof commonjsRequire==\"function\"&&commonjsRequire;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){\n  (function (global){\n  var Mutation = global.MutationObserver || global.WebKitMutationObserver;\n\n  var scheduleDrain;\n\n  {\n    if (Mutation) {\n      var called = 0;\n      var observer = new Mutation(nextTick);\n      var element = global.document.createTextNode('');\n      observer.observe(element, {\n        characterData: true\n      });\n      scheduleDrain = function () {\n        element.data = (called = ++called % 2);\n      };\n    } else if (!global.setImmediate && typeof global.MessageChannel !== 'undefined') {\n      var channel = new global.MessageChannel();\n      channel.port1.onmessage = nextTick;\n      scheduleDrain = function () {\n        channel.port2.postMessage(0);\n      };\n    } else if ('document' in global && 'onreadystatechange' in global.document.createElement('script')) {\n      scheduleDrain = function () {\n\n        // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted\n        // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.\n        var scriptEl = global.document.createElement('script');\n        scriptEl.onreadystatechange = function () {\n          nextTick();\n\n          scriptEl.onreadystatechange = null;\n          scriptEl.parentNode.removeChild(scriptEl);\n          scriptEl = null;\n        };\n        global.document.documentElement.appendChild(scriptEl);\n      };\n    } else {\n      scheduleDrain = function () {\n        setTimeout(nextTick, 0);\n      };\n    }\n  }\n\n  var draining;\n  var queue = [];\n  //named nextTick for less confusing stack traces\n  function nextTick() {\n    draining = true;\n    var i, oldQueue;\n    var len = queue.length;\n    while (len) {\n      oldQueue = queue;\n      queue = [];\n      i = -1;\n      while (++i < len) {\n        oldQueue[i]();\n      }\n      len = queue.length;\n    }\n    draining = false;\n  }\n\n  module.exports = immediate;\n  function immediate(task) {\n    if (queue.push(task) === 1 && !draining) {\n      scheduleDrain();\n    }\n  }\n\n  }).call(this,typeof commonjsGlobal !== \"undefined\" ? commonjsGlobal : typeof self !== \"undefined\" ? self : typeof window !== \"undefined\" ? window : {});\n  },{}],2:[function(_dereq_,module,exports){\n  var immediate = _dereq_(1);\n\n  /* istanbul ignore next */\n  function INTERNAL() {}\n\n  var handlers = {};\n\n  var REJECTED = ['REJECTED'];\n  var FULFILLED = ['FULFILLED'];\n  var PENDING = ['PENDING'];\n\n  module.exports = Promise;\n\n  function Promise(resolver) {\n    if (typeof resolver !== 'function') {\n      throw new TypeError('resolver must be a function');\n    }\n    this.state = PENDING;\n    this.queue = [];\n    this.outcome = void 0;\n    if (resolver !== INTERNAL) {\n      safelyResolveThenable(this, resolver);\n    }\n  }\n\n  Promise.prototype[\"catch\"] = function (onRejected) {\n    return this.then(null, onRejected);\n  };\n  Promise.prototype.then = function (onFulfilled, onRejected) {\n    if (typeof onFulfilled !== 'function' && this.state === FULFILLED ||\n      typeof onRejected !== 'function' && this.state === REJECTED) {\n      return this;\n    }\n    var promise = new this.constructor(INTERNAL);\n    if (this.state !== PENDING) {\n      var resolver = this.state === FULFILLED ? onFulfilled : onRejected;\n      unwrap(promise, resolver, this.outcome);\n    } else {\n      this.queue.push(new QueueItem(promise, onFulfilled, onRejected));\n    }\n\n    return promise;\n  };\n  function QueueItem(promise, onFulfilled, onRejected) {\n    this.promise = promise;\n    if (typeof onFulfilled === 'function') {\n      this.onFulfilled = onFulfilled;\n      this.callFulfilled = this.otherCallFulfilled;\n    }\n    if (typeof onRejected === 'function') {\n      this.onRejected = onRejected;\n      this.callRejected = this.otherCallRejected;\n    }\n  }\n  QueueItem.prototype.callFulfilled = function (value) {\n    handlers.resolve(this.promise, value);\n  };\n  QueueItem.prototype.otherCallFulfilled = function (value) {\n    unwrap(this.promise, this.onFulfilled, value);\n  };\n  QueueItem.prototype.callRejected = function (value) {\n    handlers.reject(this.promise, value);\n  };\n  QueueItem.prototype.otherCallRejected = function (value) {\n    unwrap(this.promise, this.onRejected, value);\n  };\n\n  function unwrap(promise, func, value) {\n    immediate(function () {\n      var returnValue;\n      try {\n        returnValue = func(value);\n      } catch (e) {\n        return handlers.reject(promise, e);\n      }\n      if (returnValue === promise) {\n        handlers.reject(promise, new TypeError('Cannot resolve promise with itself'));\n      } else {\n        handlers.resolve(promise, returnValue);\n      }\n    });\n  }\n\n  handlers.resolve = function (self, value) {\n    var result = tryCatch(getThen, value);\n    if (result.status === 'error') {\n      return handlers.reject(self, result.value);\n    }\n    var thenable = result.value;\n\n    if (thenable) {\n      safelyResolveThenable(self, thenable);\n    } else {\n      self.state = FULFILLED;\n      self.outcome = value;\n      var i = -1;\n      var len = self.queue.length;\n      while (++i < len) {\n        self.queue[i].callFulfilled(value);\n      }\n    }\n    return self;\n  };\n  handlers.reject = function (self, error) {\n    self.state = REJECTED;\n    self.outcome = error;\n    var i = -1;\n    var len = self.queue.length;\n    while (++i < len) {\n      self.queue[i].callRejected(error);\n    }\n    return self;\n  };\n\n  function getThen(obj) {\n    // Make sure we only access the accessor once as required by the spec\n    var then = obj && obj.then;\n    if (obj && (typeof obj === 'object' || typeof obj === 'function') && typeof then === 'function') {\n      return function appyThen() {\n        then.apply(obj, arguments);\n      };\n    }\n  }\n\n  function safelyResolveThenable(self, thenable) {\n    // Either fulfill, reject or reject with error\n    var called = false;\n    function onError(value) {\n      if (called) {\n        return;\n      }\n      called = true;\n      handlers.reject(self, value);\n    }\n\n    function onSuccess(value) {\n      if (called) {\n        return;\n      }\n      called = true;\n      handlers.resolve(self, value);\n    }\n\n    function tryToUnwrap() {\n      thenable(onSuccess, onError);\n    }\n\n    var result = tryCatch(tryToUnwrap);\n    if (result.status === 'error') {\n      onError(result.value);\n    }\n  }\n\n  function tryCatch(func, value) {\n    var out = {};\n    try {\n      out.value = func(value);\n      out.status = 'success';\n    } catch (e) {\n      out.status = 'error';\n      out.value = e;\n    }\n    return out;\n  }\n\n  Promise.resolve = resolve;\n  function resolve(value) {\n    if (value instanceof this) {\n      return value;\n    }\n    return handlers.resolve(new this(INTERNAL), value);\n  }\n\n  Promise.reject = reject;\n  function reject(reason) {\n    var promise = new this(INTERNAL);\n    return handlers.reject(promise, reason);\n  }\n\n  Promise.all = all;\n  function all(iterable) {\n    var self = this;\n    if (Object.prototype.toString.call(iterable) !== '[object Array]') {\n      return this.reject(new TypeError('must be an array'));\n    }\n\n    var len = iterable.length;\n    var called = false;\n    if (!len) {\n      return this.resolve([]);\n    }\n\n    var values = new Array(len);\n    var resolved = 0;\n    var i = -1;\n    var promise = new this(INTERNAL);\n\n    while (++i < len) {\n      allResolver(iterable[i], i);\n    }\n    return promise;\n    function allResolver(value, i) {\n      self.resolve(value).then(resolveFromAll, function (error) {\n        if (!called) {\n          called = true;\n          handlers.reject(promise, error);\n        }\n      });\n      function resolveFromAll(outValue) {\n        values[i] = outValue;\n        if (++resolved === len && !called) {\n          called = true;\n          handlers.resolve(promise, values);\n        }\n      }\n    }\n  }\n\n  Promise.race = race;\n  function race(iterable) {\n    var self = this;\n    if (Object.prototype.toString.call(iterable) !== '[object Array]') {\n      return this.reject(new TypeError('must be an array'));\n    }\n\n    var len = iterable.length;\n    var called = false;\n    if (!len) {\n      return this.resolve([]);\n    }\n\n    var i = -1;\n    var promise = new this(INTERNAL);\n\n    while (++i < len) {\n      resolver(iterable[i]);\n    }\n    return promise;\n    function resolver(value) {\n      self.resolve(value).then(function (response) {\n        if (!called) {\n          called = true;\n          handlers.resolve(promise, response);\n        }\n      }, function (error) {\n        if (!called) {\n          called = true;\n          handlers.reject(promise, error);\n        }\n      });\n    }\n  }\n\n  },{\"1\":1}],3:[function(_dereq_,module,exports){\n  (function (global){\n  if (typeof global.Promise !== 'function') {\n    global.Promise = _dereq_(2);\n  }\n\n  }).call(this,typeof commonjsGlobal !== \"undefined\" ? commonjsGlobal : typeof self !== \"undefined\" ? self : typeof window !== \"undefined\" ? window : {});\n  },{\"2\":2}],4:[function(_dereq_,module,exports){\n\n  var _typeof = typeof Symbol === \"function\" && typeof Symbol.iterator === \"symbol\" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === \"function\" && obj.constructor === Symbol && obj !== Symbol.prototype ? \"symbol\" : typeof obj; };\n\n  function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError(\"Cannot call a class as a function\"); } }\n\n  function getIDB() {\n      /* global indexedDB,webkitIndexedDB,mozIndexedDB,OIndexedDB,msIndexedDB */\n      try {\n          if (typeof indexedDB !== 'undefined') {\n              return indexedDB;\n          }\n          if (typeof webkitIndexedDB !== 'undefined') {\n              return webkitIndexedDB;\n          }\n          if (typeof mozIndexedDB !== 'undefined') {\n              return mozIndexedDB;\n          }\n          if (typeof OIndexedDB !== 'undefined') {\n              return OIndexedDB;\n          }\n          if (typeof msIndexedDB !== 'undefined') {\n              return msIndexedDB;\n          }\n      } catch (e) {\n          return;\n      }\n  }\n\n  var idb = getIDB();\n\n  function isIndexedDBValid() {\n      try {\n          // Initialize IndexedDB; fall back to vendor-prefixed versions\n          // if needed.\n          if (!idb || !idb.open) {\n              return false;\n          }\n          // We mimic PouchDB here;\n          //\n          // We test for openDatabase because IE Mobile identifies itself\n          // as Safari. Oh the lulz...\n          var isSafari = typeof openDatabase !== 'undefined' && /(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent) && !/BlackBerry/.test(navigator.platform);\n\n          var hasFetch = typeof fetch === 'function' && fetch.toString().indexOf('[native code') !== -1;\n\n          // Safari <10.1 does not meet our requirements for IDB support\n          // (see: https://github.com/pouchdb/pouchdb/issues/5572).\n          // Safari 10.1 shipped with fetch, we can use that to detect it.\n          // Note: this creates issues with `window.fetch` polyfills and\n          // overrides; see:\n          // https://github.com/localForage/localForage/issues/856\n          return (!isSafari || hasFetch) && typeof indexedDB !== 'undefined' &&\n          // some outdated implementations of IDB that appear on Samsung\n          // and HTC Android devices <4.4 are missing IDBKeyRange\n          // See: https://github.com/mozilla/localForage/issues/128\n          // See: https://github.com/mozilla/localForage/issues/272\n          typeof IDBKeyRange !== 'undefined';\n      } catch (e) {\n          return false;\n      }\n  }\n\n  // Abstracts constructing a Blob object, so it also works in older\n  // browsers that don't support the native Blob constructor. (i.e.\n  // old QtWebKit versions, at least).\n  // Abstracts constructing a Blob object, so it also works in older\n  // browsers that don't support the native Blob constructor. (i.e.\n  // old QtWebKit versions, at least).\n  function createBlob(parts, properties) {\n      /* global BlobBuilder,MSBlobBuilder,MozBlobBuilder,WebKitBlobBuilder */\n      parts = parts || [];\n      properties = properties || {};\n      try {\n          return new Blob(parts, properties);\n      } catch (e) {\n          if (e.name !== 'TypeError') {\n              throw e;\n          }\n          var Builder = typeof BlobBuilder !== 'undefined' ? BlobBuilder : typeof MSBlobBuilder !== 'undefined' ? MSBlobBuilder : typeof MozBlobBuilder !== 'undefined' ? MozBlobBuilder : WebKitBlobBuilder;\n          var builder = new Builder();\n          for (var i = 0; i < parts.length; i += 1) {\n              builder.append(parts[i]);\n          }\n          return builder.getBlob(properties.type);\n      }\n  }\n\n  // This is CommonJS because lie is an external dependency, so Rollup\n  // can just ignore it.\n  if (typeof Promise === 'undefined') {\n      // In the \"nopromises\" build this will just throw if you don't have\n      // a global promise object, but it would throw anyway later.\n      _dereq_(3);\n  }\n  var Promise$1 = Promise;\n\n  function executeCallback(promise, callback) {\n      if (callback) {\n          promise.then(function (result) {\n              callback(null, result);\n          }, function (error) {\n              callback(error);\n          });\n      }\n  }\n\n  function executeTwoCallbacks(promise, callback, errorCallback) {\n      if (typeof callback === 'function') {\n          promise.then(callback);\n      }\n\n      if (typeof errorCallback === 'function') {\n          promise[\"catch\"](errorCallback);\n      }\n  }\n\n  function normalizeKey(key) {\n      // Cast the key to a string, as that's all we can set as a key.\n      if (typeof key !== 'string') {\n          console.warn(key + ' used as a key, but it is not a string.');\n          key = String(key);\n      }\n\n      return key;\n  }\n\n  function getCallback() {\n      if (arguments.length && typeof arguments[arguments.length - 1] === 'function') {\n          return arguments[arguments.length - 1];\n      }\n  }\n\n  // Some code originally from async_storage.js in\n  // [Gaia](https://github.com/mozilla-b2g/gaia).\n\n  var DETECT_BLOB_SUPPORT_STORE = 'local-forage-detect-blob-support';\n  var supportsBlobs = void 0;\n  var dbContexts = {};\n  var toString = Object.prototype.toString;\n\n  // Transaction Modes\n  var READ_ONLY = 'readonly';\n  var READ_WRITE = 'readwrite';\n\n  // Transform a binary string to an array buffer, because otherwise\n  // weird stuff happens when you try to work with the binary string directly.\n  // It is known.\n  // From http://stackoverflow.com/questions/14967647/ (continues on next line)\n  // encode-decode-image-with-base64-breaks-image (2013-04-21)\n  function _binStringToArrayBuffer(bin) {\n      var length = bin.length;\n      var buf = new ArrayBuffer(length);\n      var arr = new Uint8Array(buf);\n      for (var i = 0; i < length; i++) {\n          arr[i] = bin.charCodeAt(i);\n      }\n      return buf;\n  }\n\n  //\n  // Blobs are not supported in all versions of IndexedDB, notably\n  // Chrome <37 and Android <5. In those versions, storing a blob will throw.\n  //\n  // Various other blob bugs exist in Chrome v37-42 (inclusive).\n  // Detecting them is expensive and confusing to users, and Chrome 37-42\n  // is at very low usage worldwide, so we do a hacky userAgent check instead.\n  //\n  // content-type bug: https://code.google.com/p/chromium/issues/detail?id=408120\n  // 404 bug: https://code.google.com/p/chromium/issues/detail?id=447916\n  // FileReader bug: https://code.google.com/p/chromium/issues/detail?id=447836\n  //\n  // Code borrowed from PouchDB. See:\n  // https://github.com/pouchdb/pouchdb/blob/master/packages/node_modules/pouchdb-adapter-idb/src/blobSupport.js\n  //\n  function _checkBlobSupportWithoutCaching(idb) {\n      return new Promise$1(function (resolve) {\n          var txn = idb.transaction(DETECT_BLOB_SUPPORT_STORE, READ_WRITE);\n          var blob = createBlob(['']);\n          txn.objectStore(DETECT_BLOB_SUPPORT_STORE).put(blob, 'key');\n\n          txn.onabort = function (e) {\n              // If the transaction aborts now its due to not being able to\n              // write to the database, likely due to the disk being full\n              e.preventDefault();\n              e.stopPropagation();\n              resolve(false);\n          };\n\n          txn.oncomplete = function () {\n              var matchedChrome = navigator.userAgent.match(/Chrome\\/(\\d+)/);\n              var matchedEdge = navigator.userAgent.match(/Edge\\//);\n              // MS Edge pretends to be Chrome 42:\n              // https://msdn.microsoft.com/en-us/library/hh869301%28v=vs.85%29.aspx\n              resolve(matchedEdge || !matchedChrome || parseInt(matchedChrome[1], 10) >= 43);\n          };\n      })[\"catch\"](function () {\n          return false; // error, so assume unsupported\n      });\n  }\n\n  function _checkBlobSupport(idb) {\n      if (typeof supportsBlobs === 'boolean') {\n          return Promise$1.resolve(supportsBlobs);\n      }\n      return _checkBlobSupportWithoutCaching(idb).then(function (value) {\n          supportsBlobs = value;\n          return supportsBlobs;\n      });\n  }\n\n  function _deferReadiness(dbInfo) {\n      var dbContext = dbContexts[dbInfo.name];\n\n      // Create a deferred object representing the current database operation.\n      var deferredOperation = {};\n\n      deferredOperation.promise = new Promise$1(function (resolve, reject) {\n          deferredOperation.resolve = resolve;\n          deferredOperation.reject = reject;\n      });\n\n      // Enqueue the deferred operation.\n      dbContext.deferredOperations.push(deferredOperation);\n\n      // Chain its promise to the database readiness.\n      if (!dbContext.dbReady) {\n          dbContext.dbReady = deferredOperation.promise;\n      } else {\n          dbContext.dbReady = dbContext.dbReady.then(function () {\n              return deferredOperation.promise;\n          });\n      }\n  }\n\n  function _advanceReadiness(dbInfo) {\n      var dbContext = dbContexts[dbInfo.name];\n\n      // Dequeue a deferred operation.\n      var deferredOperation = dbContext.deferredOperations.pop();\n\n      // Resolve its promise (which is part of the database readiness\n      // chain of promises).\n      if (deferredOperation) {\n          deferredOperation.resolve();\n          return deferredOperation.promise;\n      }\n  }\n\n  function _rejectReadiness(dbInfo, err) {\n      var dbContext = dbContexts[dbInfo.name];\n\n      // Dequeue a deferred operation.\n      var deferredOperation = dbContext.deferredOperations.pop();\n\n      // Reject its promise (which is part of the database readiness\n      // chain of promises).\n      if (deferredOperation) {\n          deferredOperation.reject(err);\n          return deferredOperation.promise;\n      }\n  }\n\n  function _getConnection(dbInfo, upgradeNeeded) {\n      return new Promise$1(function (resolve, reject) {\n          dbContexts[dbInfo.name] = dbContexts[dbInfo.name] || createDbContext();\n\n          if (dbInfo.db) {\n              if (upgradeNeeded) {\n                  _deferReadiness(dbInfo);\n                  dbInfo.db.close();\n              } else {\n                  return resolve(dbInfo.db);\n              }\n          }\n\n          var dbArgs = [dbInfo.name];\n\n          if (upgradeNeeded) {\n              dbArgs.push(dbInfo.version);\n          }\n\n          var openreq = idb.open.apply(idb, dbArgs);\n\n          if (upgradeNeeded) {\n              openreq.onupgradeneeded = function (e) {\n                  var db = openreq.result;\n                  try {\n                      db.createObjectStore(dbInfo.storeName);\n                      if (e.oldVersion <= 1) {\n                          // Added when support for blob shims was added\n                          db.createObjectStore(DETECT_BLOB_SUPPORT_STORE);\n                      }\n                  } catch (ex) {\n                      if (ex.name === 'ConstraintError') {\n                          console.warn('The database \"' + dbInfo.name + '\"' + ' has been upgraded from version ' + e.oldVersion + ' to version ' + e.newVersion + ', but the storage \"' + dbInfo.storeName + '\" already exists.');\n                      } else {\n                          throw ex;\n                      }\n                  }\n              };\n          }\n\n          openreq.onerror = function (e) {\n              e.preventDefault();\n              reject(openreq.error);\n          };\n\n          openreq.onsuccess = function () {\n              var db = openreq.result;\n              db.onversionchange = function (e) {\n                  // Triggered when the database is modified (e.g. adding an objectStore) or\n                  // deleted (even when initiated by other sessions in different tabs).\n                  // Closing the connection here prevents those operations from being blocked.\n                  // If the database is accessed again later by this instance, the connection\n                  // will be reopened or the database recreated as needed.\n                  e.target.close();\n              };\n              resolve(db);\n              _advanceReadiness(dbInfo);\n          };\n      });\n  }\n\n  function _getOriginalConnection(dbInfo) {\n      return _getConnection(dbInfo, false);\n  }\n\n  function _getUpgradedConnection(dbInfo) {\n      return _getConnection(dbInfo, true);\n  }\n\n  function _isUpgradeNeeded(dbInfo, defaultVersion) {\n      if (!dbInfo.db) {\n          return true;\n      }\n\n      var isNewStore = !dbInfo.db.objectStoreNames.contains(dbInfo.storeName);\n      var isDowngrade = dbInfo.version < dbInfo.db.version;\n      var isUpgrade = dbInfo.version > dbInfo.db.version;\n\n      if (isDowngrade) {\n          // If the version is not the default one\n          // then warn for impossible downgrade.\n          if (dbInfo.version !== defaultVersion) {\n              console.warn('The database \"' + dbInfo.name + '\"' + \" can't be downgraded from version \" + dbInfo.db.version + ' to version ' + dbInfo.version + '.');\n          }\n          // Align the versions to prevent errors.\n          dbInfo.version = dbInfo.db.version;\n      }\n\n      if (isUpgrade || isNewStore) {\n          // If the store is new then increment the version (if needed).\n          // This will trigger an \"upgradeneeded\" event which is required\n          // for creating a store.\n          if (isNewStore) {\n              var incVersion = dbInfo.db.version + 1;\n              if (incVersion > dbInfo.version) {\n                  dbInfo.version = incVersion;\n              }\n          }\n\n          return true;\n      }\n\n      return false;\n  }\n\n  // encode a blob for indexeddb engines that don't support blobs\n  function _encodeBlob(blob) {\n      return new Promise$1(function (resolve, reject) {\n          var reader = new FileReader();\n          reader.onerror = reject;\n          reader.onloadend = function (e) {\n              var base64 = btoa(e.target.result || '');\n              resolve({\n                  __local_forage_encoded_blob: true,\n                  data: base64,\n                  type: blob.type\n              });\n          };\n          reader.readAsBinaryString(blob);\n      });\n  }\n\n  // decode an encoded blob\n  function _decodeBlob(encodedBlob) {\n      var arrayBuff = _binStringToArrayBuffer(atob(encodedBlob.data));\n      return createBlob([arrayBuff], { type: encodedBlob.type });\n  }\n\n  // is this one of our fancy encoded blobs?\n  function _isEncodedBlob(value) {\n      return value && value.__local_forage_encoded_blob;\n  }\n\n  // Specialize the default `ready()` function by making it dependent\n  // on the current database operations. Thus, the driver will be actually\n  // ready when it's been initialized (default) *and* there are no pending\n  // operations on the database (initiated by some other instances).\n  function _fullyReady(callback) {\n      var self = this;\n\n      var promise = self._initReady().then(function () {\n          var dbContext = dbContexts[self._dbInfo.name];\n\n          if (dbContext && dbContext.dbReady) {\n              return dbContext.dbReady;\n          }\n      });\n\n      executeTwoCallbacks(promise, callback, callback);\n      return promise;\n  }\n\n  // Try to establish a new db connection to replace the\n  // current one which is broken (i.e. experiencing\n  // InvalidStateError while creating a transaction).\n  function _tryReconnect(dbInfo) {\n      _deferReadiness(dbInfo);\n\n      var dbContext = dbContexts[dbInfo.name];\n      var forages = dbContext.forages;\n\n      for (var i = 0; i < forages.length; i++) {\n          var forage = forages[i];\n          if (forage._dbInfo.db) {\n              forage._dbInfo.db.close();\n              forage._dbInfo.db = null;\n          }\n      }\n      dbInfo.db = null;\n\n      return _getOriginalConnection(dbInfo).then(function (db) {\n          dbInfo.db = db;\n          if (_isUpgradeNeeded(dbInfo)) {\n              // Reopen the database for upgrading.\n              return _getUpgradedConnection(dbInfo);\n          }\n          return db;\n      }).then(function (db) {\n          // store the latest db reference\n          // in case the db was upgraded\n          dbInfo.db = dbContext.db = db;\n          for (var i = 0; i < forages.length; i++) {\n              forages[i]._dbInfo.db = db;\n          }\n      })[\"catch\"](function (err) {\n          _rejectReadiness(dbInfo, err);\n          throw err;\n      });\n  }\n\n  // FF doesn't like Promises (micro-tasks) and IDDB store operations,\n  // so we have to do it with callbacks\n  function createTransaction(dbInfo, mode, callback, retries) {\n      if (retries === undefined) {\n          retries = 1;\n      }\n\n      try {\n          var tx = dbInfo.db.transaction(dbInfo.storeName, mode);\n          callback(null, tx);\n      } catch (err) {\n          if (retries > 0 && (!dbInfo.db || err.name === 'InvalidStateError' || err.name === 'NotFoundError')) {\n              return Promise$1.resolve().then(function () {\n                  if (!dbInfo.db || err.name === 'NotFoundError' && !dbInfo.db.objectStoreNames.contains(dbInfo.storeName) && dbInfo.version <= dbInfo.db.version) {\n                      // increase the db version, to create the new ObjectStore\n                      if (dbInfo.db) {\n                          dbInfo.version = dbInfo.db.version + 1;\n                      }\n                      // Reopen the database for upgrading.\n                      return _getUpgradedConnection(dbInfo);\n                  }\n              }).then(function () {\n                  return _tryReconnect(dbInfo).then(function () {\n                      createTransaction(dbInfo, mode, callback, retries - 1);\n                  });\n              })[\"catch\"](callback);\n          }\n\n          callback(err);\n      }\n  }\n\n  function createDbContext() {\n      return {\n          // Running localForages sharing a database.\n          forages: [],\n          // Shared database.\n          db: null,\n          // Database readiness (promise).\n          dbReady: null,\n          // Deferred operations on the database.\n          deferredOperations: []\n      };\n  }\n\n  // Open the IndexedDB database (automatically creates one if one didn't\n  // previously exist), using any options set in the config.\n  function _initStorage(options) {\n      var self = this;\n      var dbInfo = {\n          db: null\n      };\n\n      if (options) {\n          for (var i in options) {\n              dbInfo[i] = options[i];\n          }\n      }\n\n      // Get the current context of the database;\n      var dbContext = dbContexts[dbInfo.name];\n\n      // ...or create a new context.\n      if (!dbContext) {\n          dbContext = createDbContext();\n          // Register the new context in the global container.\n          dbContexts[dbInfo.name] = dbContext;\n      }\n\n      // Register itself as a running localForage in the current context.\n      dbContext.forages.push(self);\n\n      // Replace the default `ready()` function with the specialized one.\n      if (!self._initReady) {\n          self._initReady = self.ready;\n          self.ready = _fullyReady;\n      }\n\n      // Create an array of initialization states of the related localForages.\n      var initPromises = [];\n\n      function ignoreErrors() {\n          // Don't handle errors here,\n          // just makes sure related localForages aren't pending.\n          return Promise$1.resolve();\n      }\n\n      for (var j = 0; j < dbContext.forages.length; j++) {\n          var forage = dbContext.forages[j];\n          if (forage !== self) {\n              // Don't wait for itself...\n              initPromises.push(forage._initReady()[\"catch\"](ignoreErrors));\n          }\n      }\n\n      // Take a snapshot of the related localForages.\n      var forages = dbContext.forages.slice(0);\n\n      // Initialize the connection process only when\n      // all the related localForages aren't pending.\n      return Promise$1.all(initPromises).then(function () {\n          dbInfo.db = dbContext.db;\n          // Get the connection or open a new one without upgrade.\n          return _getOriginalConnection(dbInfo);\n      }).then(function (db) {\n          dbInfo.db = db;\n          if (_isUpgradeNeeded(dbInfo, self._defaultConfig.version)) {\n              // Reopen the database for upgrading.\n              return _getUpgradedConnection(dbInfo);\n          }\n          return db;\n      }).then(function (db) {\n          dbInfo.db = dbContext.db = db;\n          self._dbInfo = dbInfo;\n          // Share the final connection amongst related localForages.\n          for (var k = 0; k < forages.length; k++) {\n              var forage = forages[k];\n              if (forage !== self) {\n                  // Self is already up-to-date.\n                  forage._dbInfo.db = dbInfo.db;\n                  forage._dbInfo.version = dbInfo.version;\n              }\n          }\n      });\n  }\n\n  function getItem(key, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_ONLY, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      var req = store.get(key);\n\n                      req.onsuccess = function () {\n                          var value = req.result;\n                          if (value === undefined) {\n                              value = null;\n                          }\n                          if (_isEncodedBlob(value)) {\n                              value = _decodeBlob(value);\n                          }\n                          resolve(value);\n                      };\n\n                      req.onerror = function () {\n                          reject(req.error);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Iterate over all items stored in database.\n  function iterate(iterator, callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_ONLY, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      var req = store.openCursor();\n                      var iterationNumber = 1;\n\n                      req.onsuccess = function () {\n                          var cursor = req.result;\n\n                          if (cursor) {\n                              var value = cursor.value;\n                              if (_isEncodedBlob(value)) {\n                                  value = _decodeBlob(value);\n                              }\n                              var result = iterator(value, cursor.key, iterationNumber++);\n\n                              // when the iterator callback returns any\n                              // (non-`undefined`) value, then we stop\n                              // the iteration immediately\n                              if (result !== void 0) {\n                                  resolve(result);\n                              } else {\n                                  cursor[\"continue\"]();\n                              }\n                          } else {\n                              resolve();\n                          }\n                      };\n\n                      req.onerror = function () {\n                          reject(req.error);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n\n      return promise;\n  }\n\n  function setItem(key, value, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = new Promise$1(function (resolve, reject) {\n          var dbInfo;\n          self.ready().then(function () {\n              dbInfo = self._dbInfo;\n              if (toString.call(value) === '[object Blob]') {\n                  return _checkBlobSupport(dbInfo.db).then(function (blobSupport) {\n                      if (blobSupport) {\n                          return value;\n                      }\n                      return _encodeBlob(value);\n                  });\n              }\n              return value;\n          }).then(function (value) {\n              createTransaction(self._dbInfo, READ_WRITE, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n\n                      // The reason we don't _save_ null is because IE 10 does\n                      // not support saving the `null` type in IndexedDB. How\n                      // ironic, given the bug below!\n                      // See: https://github.com/mozilla/localForage/issues/161\n                      if (value === null) {\n                          value = undefined;\n                      }\n\n                      var req = store.put(value, key);\n\n                      transaction.oncomplete = function () {\n                          // Cast to undefined so the value passed to\n                          // callback/promise is the same as what one would get out\n                          // of `getItem()` later. This leads to some weirdness\n                          // (setItem('foo', undefined) will return `null`), but\n                          // it's not my fault localStorage is our baseline and that\n                          // it's weird.\n                          if (value === undefined) {\n                              value = null;\n                          }\n\n                          resolve(value);\n                      };\n                      transaction.onabort = transaction.onerror = function () {\n                          var err = req.error ? req.error : req.transaction.error;\n                          reject(err);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function removeItem(key, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_WRITE, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      // We use a Grunt task to make this safe for IE and some\n                      // versions of Android (including those used by Cordova).\n                      // Normally IE won't like `.delete()` and will insist on\n                      // using `['delete']()`, but we have a build step that\n                      // fixes this for us now.\n                      var req = store[\"delete\"](key);\n                      transaction.oncomplete = function () {\n                          resolve();\n                      };\n\n                      transaction.onerror = function () {\n                          reject(req.error);\n                      };\n\n                      // The request will be also be aborted if we've exceeded our storage\n                      // space.\n                      transaction.onabort = function () {\n                          var err = req.error ? req.error : req.transaction.error;\n                          reject(err);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function clear(callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_WRITE, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      var req = store.clear();\n\n                      transaction.oncomplete = function () {\n                          resolve();\n                      };\n\n                      transaction.onabort = transaction.onerror = function () {\n                          var err = req.error ? req.error : req.transaction.error;\n                          reject(err);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function length(callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_ONLY, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      var req = store.count();\n\n                      req.onsuccess = function () {\n                          resolve(req.result);\n                      };\n\n                      req.onerror = function () {\n                          reject(req.error);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function key(n, callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          if (n < 0) {\n              resolve(null);\n\n              return;\n          }\n\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_ONLY, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      var advanced = false;\n                      var req = store.openKeyCursor();\n\n                      req.onsuccess = function () {\n                          var cursor = req.result;\n                          if (!cursor) {\n                              // this means there weren't enough keys\n                              resolve(null);\n\n                              return;\n                          }\n\n                          if (n === 0) {\n                              // We have the first key, return it if that's what they\n                              // wanted.\n                              resolve(cursor.key);\n                          } else {\n                              if (!advanced) {\n                                  // Otherwise, ask the cursor to skip ahead n\n                                  // records.\n                                  advanced = true;\n                                  cursor.advance(n);\n                              } else {\n                                  // When we get here, we've got the nth key.\n                                  resolve(cursor.key);\n                              }\n                          }\n                      };\n\n                      req.onerror = function () {\n                          reject(req.error);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function keys(callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              createTransaction(self._dbInfo, READ_ONLY, function (err, transaction) {\n                  if (err) {\n                      return reject(err);\n                  }\n\n                  try {\n                      var store = transaction.objectStore(self._dbInfo.storeName);\n                      var req = store.openKeyCursor();\n                      var keys = [];\n\n                      req.onsuccess = function () {\n                          var cursor = req.result;\n\n                          if (!cursor) {\n                              resolve(keys);\n                              return;\n                          }\n\n                          keys.push(cursor.key);\n                          cursor[\"continue\"]();\n                      };\n\n                      req.onerror = function () {\n                          reject(req.error);\n                      };\n                  } catch (e) {\n                      reject(e);\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function dropInstance(options, callback) {\n      callback = getCallback.apply(this, arguments);\n\n      var currentConfig = this.config();\n      options = typeof options !== 'function' && options || {};\n      if (!options.name) {\n          options.name = options.name || currentConfig.name;\n          options.storeName = options.storeName || currentConfig.storeName;\n      }\n\n      var self = this;\n      var promise;\n      if (!options.name) {\n          promise = Promise$1.reject('Invalid arguments');\n      } else {\n          var isCurrentDb = options.name === currentConfig.name && self._dbInfo.db;\n\n          var dbPromise = isCurrentDb ? Promise$1.resolve(self._dbInfo.db) : _getOriginalConnection(options).then(function (db) {\n              var dbContext = dbContexts[options.name];\n              var forages = dbContext.forages;\n              dbContext.db = db;\n              for (var i = 0; i < forages.length; i++) {\n                  forages[i]._dbInfo.db = db;\n              }\n              return db;\n          });\n\n          if (!options.storeName) {\n              promise = dbPromise.then(function (db) {\n                  _deferReadiness(options);\n\n                  var dbContext = dbContexts[options.name];\n                  var forages = dbContext.forages;\n\n                  db.close();\n                  for (var i = 0; i < forages.length; i++) {\n                      var forage = forages[i];\n                      forage._dbInfo.db = null;\n                  }\n\n                  var dropDBPromise = new Promise$1(function (resolve, reject) {\n                      var req = idb.deleteDatabase(options.name);\n\n                      req.onerror = function () {\n                          var db = req.result;\n                          if (db) {\n                              db.close();\n                          }\n                          reject(req.error);\n                      };\n\n                      req.onblocked = function () {\n                          // Closing all open connections in onversionchange handler should prevent this situation, but if\n                          // we do get here, it just means the request remains pending - eventually it will succeed or error\n                          console.warn('dropInstance blocked for database \"' + options.name + '\" until all open connections are closed');\n                      };\n\n                      req.onsuccess = function () {\n                          var db = req.result;\n                          if (db) {\n                              db.close();\n                          }\n                          resolve(db);\n                      };\n                  });\n\n                  return dropDBPromise.then(function (db) {\n                      dbContext.db = db;\n                      for (var i = 0; i < forages.length; i++) {\n                          var _forage = forages[i];\n                          _advanceReadiness(_forage._dbInfo);\n                      }\n                  })[\"catch\"](function (err) {\n                      (_rejectReadiness(options, err) || Promise$1.resolve())[\"catch\"](function () {});\n                      throw err;\n                  });\n              });\n          } else {\n              promise = dbPromise.then(function (db) {\n                  if (!db.objectStoreNames.contains(options.storeName)) {\n                      return;\n                  }\n\n                  var newVersion = db.version + 1;\n\n                  _deferReadiness(options);\n\n                  var dbContext = dbContexts[options.name];\n                  var forages = dbContext.forages;\n\n                  db.close();\n                  for (var i = 0; i < forages.length; i++) {\n                      var forage = forages[i];\n                      forage._dbInfo.db = null;\n                      forage._dbInfo.version = newVersion;\n                  }\n\n                  var dropObjectPromise = new Promise$1(function (resolve, reject) {\n                      var req = idb.open(options.name, newVersion);\n\n                      req.onerror = function (err) {\n                          var db = req.result;\n                          db.close();\n                          reject(err);\n                      };\n\n                      req.onupgradeneeded = function () {\n                          var db = req.result;\n                          db.deleteObjectStore(options.storeName);\n                      };\n\n                      req.onsuccess = function () {\n                          var db = req.result;\n                          db.close();\n                          resolve(db);\n                      };\n                  });\n\n                  return dropObjectPromise.then(function (db) {\n                      dbContext.db = db;\n                      for (var j = 0; j < forages.length; j++) {\n                          var _forage2 = forages[j];\n                          _forage2._dbInfo.db = db;\n                          _advanceReadiness(_forage2._dbInfo);\n                      }\n                  })[\"catch\"](function (err) {\n                      (_rejectReadiness(options, err) || Promise$1.resolve())[\"catch\"](function () {});\n                      throw err;\n                  });\n              });\n          }\n      }\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  var asyncStorage = {\n      _driver: 'asyncStorage',\n      _initStorage: _initStorage,\n      _support: isIndexedDBValid(),\n      iterate: iterate,\n      getItem: getItem,\n      setItem: setItem,\n      removeItem: removeItem,\n      clear: clear,\n      length: length,\n      key: key,\n      keys: keys,\n      dropInstance: dropInstance\n  };\n\n  function isWebSQLValid() {\n      return typeof openDatabase === 'function';\n  }\n\n  // Sadly, the best way to save binary data in WebSQL/localStorage is serializing\n  // it to Base64, so this is how we store it to prevent very strange errors with less\n  // verbose ways of binary <-> string data storage.\n  var BASE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n\n  var BLOB_TYPE_PREFIX = '~~local_forage_type~';\n  var BLOB_TYPE_PREFIX_REGEX = /^~~local_forage_type~([^~]+)~/;\n\n  var SERIALIZED_MARKER = '__lfsc__:';\n  var SERIALIZED_MARKER_LENGTH = SERIALIZED_MARKER.length;\n\n  // OMG the serializations!\n  var TYPE_ARRAYBUFFER = 'arbf';\n  var TYPE_BLOB = 'blob';\n  var TYPE_INT8ARRAY = 'si08';\n  var TYPE_UINT8ARRAY = 'ui08';\n  var TYPE_UINT8CLAMPEDARRAY = 'uic8';\n  var TYPE_INT16ARRAY = 'si16';\n  var TYPE_INT32ARRAY = 'si32';\n  var TYPE_UINT16ARRAY = 'ur16';\n  var TYPE_UINT32ARRAY = 'ui32';\n  var TYPE_FLOAT32ARRAY = 'fl32';\n  var TYPE_FLOAT64ARRAY = 'fl64';\n  var TYPE_SERIALIZED_MARKER_LENGTH = SERIALIZED_MARKER_LENGTH + TYPE_ARRAYBUFFER.length;\n\n  var toString$1 = Object.prototype.toString;\n\n  function stringToBuffer(serializedString) {\n      // Fill the string into a ArrayBuffer.\n      var bufferLength = serializedString.length * 0.75;\n      var len = serializedString.length;\n      var i;\n      var p = 0;\n      var encoded1, encoded2, encoded3, encoded4;\n\n      if (serializedString[serializedString.length - 1] === '=') {\n          bufferLength--;\n          if (serializedString[serializedString.length - 2] === '=') {\n              bufferLength--;\n          }\n      }\n\n      var buffer = new ArrayBuffer(bufferLength);\n      var bytes = new Uint8Array(buffer);\n\n      for (i = 0; i < len; i += 4) {\n          encoded1 = BASE_CHARS.indexOf(serializedString[i]);\n          encoded2 = BASE_CHARS.indexOf(serializedString[i + 1]);\n          encoded3 = BASE_CHARS.indexOf(serializedString[i + 2]);\n          encoded4 = BASE_CHARS.indexOf(serializedString[i + 3]);\n\n          /*jslint bitwise: true */\n          bytes[p++] = encoded1 << 2 | encoded2 >> 4;\n          bytes[p++] = (encoded2 & 15) << 4 | encoded3 >> 2;\n          bytes[p++] = (encoded3 & 3) << 6 | encoded4 & 63;\n      }\n      return buffer;\n  }\n\n  // Converts a buffer to a string to store, serialized, in the backend\n  // storage library.\n  function bufferToString(buffer) {\n      // base64-arraybuffer\n      var bytes = new Uint8Array(buffer);\n      var base64String = '';\n      var i;\n\n      for (i = 0; i < bytes.length; i += 3) {\n          /*jslint bitwise: true */\n          base64String += BASE_CHARS[bytes[i] >> 2];\n          base64String += BASE_CHARS[(bytes[i] & 3) << 4 | bytes[i + 1] >> 4];\n          base64String += BASE_CHARS[(bytes[i + 1] & 15) << 2 | bytes[i + 2] >> 6];\n          base64String += BASE_CHARS[bytes[i + 2] & 63];\n      }\n\n      if (bytes.length % 3 === 2) {\n          base64String = base64String.substring(0, base64String.length - 1) + '=';\n      } else if (bytes.length % 3 === 1) {\n          base64String = base64String.substring(0, base64String.length - 2) + '==';\n      }\n\n      return base64String;\n  }\n\n  // Serialize a value, afterwards executing a callback (which usually\n  // instructs the `setItem()` callback/promise to be executed). This is how\n  // we store binary data with localStorage.\n  function serialize(value, callback) {\n      var valueType = '';\n      if (value) {\n          valueType = toString$1.call(value);\n      }\n\n      // Cannot use `value instanceof ArrayBuffer` or such here, as these\n      // checks fail when running the tests using casper.js...\n      //\n      // TODO: See why those tests fail and use a better solution.\n      if (value && (valueType === '[object ArrayBuffer]' || value.buffer && toString$1.call(value.buffer) === '[object ArrayBuffer]')) {\n          // Convert binary arrays to a string and prefix the string with\n          // a special marker.\n          var buffer;\n          var marker = SERIALIZED_MARKER;\n\n          if (value instanceof ArrayBuffer) {\n              buffer = value;\n              marker += TYPE_ARRAYBUFFER;\n          } else {\n              buffer = value.buffer;\n\n              if (valueType === '[object Int8Array]') {\n                  marker += TYPE_INT8ARRAY;\n              } else if (valueType === '[object Uint8Array]') {\n                  marker += TYPE_UINT8ARRAY;\n              } else if (valueType === '[object Uint8ClampedArray]') {\n                  marker += TYPE_UINT8CLAMPEDARRAY;\n              } else if (valueType === '[object Int16Array]') {\n                  marker += TYPE_INT16ARRAY;\n              } else if (valueType === '[object Uint16Array]') {\n                  marker += TYPE_UINT16ARRAY;\n              } else if (valueType === '[object Int32Array]') {\n                  marker += TYPE_INT32ARRAY;\n              } else if (valueType === '[object Uint32Array]') {\n                  marker += TYPE_UINT32ARRAY;\n              } else if (valueType === '[object Float32Array]') {\n                  marker += TYPE_FLOAT32ARRAY;\n              } else if (valueType === '[object Float64Array]') {\n                  marker += TYPE_FLOAT64ARRAY;\n              } else {\n                  callback(new Error('Failed to get type for BinaryArray'));\n              }\n          }\n\n          callback(marker + bufferToString(buffer));\n      } else if (valueType === '[object Blob]') {\n          // Conver the blob to a binaryArray and then to a string.\n          var fileReader = new FileReader();\n\n          fileReader.onload = function () {\n              // Backwards-compatible prefix for the blob type.\n              var str = BLOB_TYPE_PREFIX + value.type + '~' + bufferToString(this.result);\n\n              callback(SERIALIZED_MARKER + TYPE_BLOB + str);\n          };\n\n          fileReader.readAsArrayBuffer(value);\n      } else {\n          try {\n              callback(JSON.stringify(value));\n          } catch (e) {\n              console.error(\"Couldn't convert value into a JSON string: \", value);\n\n              callback(null, e);\n          }\n      }\n  }\n\n  // Deserialize data we've inserted into a value column/field. We place\n  // special markers into our strings to mark them as encoded; this isn't\n  // as nice as a meta field, but it's the only sane thing we can do whilst\n  // keeping localStorage support intact.\n  //\n  // Oftentimes this will just deserialize JSON content, but if we have a\n  // special marker (SERIALIZED_MARKER, defined above), we will extract\n  // some kind of arraybuffer/binary data/typed array out of the string.\n  function deserialize(value) {\n      // If we haven't marked this string as being specially serialized (i.e.\n      // something other than serialized JSON), we can just return it and be\n      // done with it.\n      if (value.substring(0, SERIALIZED_MARKER_LENGTH) !== SERIALIZED_MARKER) {\n          return JSON.parse(value);\n      }\n\n      // The following code deals with deserializing some kind of Blob or\n      // TypedArray. First we separate out the type of data we're dealing\n      // with from the data itself.\n      var serializedString = value.substring(TYPE_SERIALIZED_MARKER_LENGTH);\n      var type = value.substring(SERIALIZED_MARKER_LENGTH, TYPE_SERIALIZED_MARKER_LENGTH);\n\n      var blobType;\n      // Backwards-compatible blob type serialization strategy.\n      // DBs created with older versions of localForage will simply not have the blob type.\n      if (type === TYPE_BLOB && BLOB_TYPE_PREFIX_REGEX.test(serializedString)) {\n          var matcher = serializedString.match(BLOB_TYPE_PREFIX_REGEX);\n          blobType = matcher[1];\n          serializedString = serializedString.substring(matcher[0].length);\n      }\n      var buffer = stringToBuffer(serializedString);\n\n      // Return the right type based on the code/type set during\n      // serialization.\n      switch (type) {\n          case TYPE_ARRAYBUFFER:\n              return buffer;\n          case TYPE_BLOB:\n              return createBlob([buffer], { type: blobType });\n          case TYPE_INT8ARRAY:\n              return new Int8Array(buffer);\n          case TYPE_UINT8ARRAY:\n              return new Uint8Array(buffer);\n          case TYPE_UINT8CLAMPEDARRAY:\n              return new Uint8ClampedArray(buffer);\n          case TYPE_INT16ARRAY:\n              return new Int16Array(buffer);\n          case TYPE_UINT16ARRAY:\n              return new Uint16Array(buffer);\n          case TYPE_INT32ARRAY:\n              return new Int32Array(buffer);\n          case TYPE_UINT32ARRAY:\n              return new Uint32Array(buffer);\n          case TYPE_FLOAT32ARRAY:\n              return new Float32Array(buffer);\n          case TYPE_FLOAT64ARRAY:\n              return new Float64Array(buffer);\n          default:\n              throw new Error('Unkown type: ' + type);\n      }\n  }\n\n  var localforageSerializer = {\n      serialize: serialize,\n      deserialize: deserialize,\n      stringToBuffer: stringToBuffer,\n      bufferToString: bufferToString\n  };\n\n  /*\n   * Includes code from:\n   *\n   * base64-arraybuffer\n   * https://github.com/niklasvh/base64-arraybuffer\n   *\n   * Copyright (c) 2012 Niklas von Hertzen\n   * Licensed under the MIT license.\n   */\n\n  function createDbTable(t, dbInfo, callback, errorCallback) {\n      t.executeSql('CREATE TABLE IF NOT EXISTS ' + dbInfo.storeName + ' ' + '(id INTEGER PRIMARY KEY, key unique, value)', [], callback, errorCallback);\n  }\n\n  // Open the WebSQL database (automatically creates one if one didn't\n  // previously exist), using any options set in the config.\n  function _initStorage$1(options) {\n      var self = this;\n      var dbInfo = {\n          db: null\n      };\n\n      if (options) {\n          for (var i in options) {\n              dbInfo[i] = typeof options[i] !== 'string' ? options[i].toString() : options[i];\n          }\n      }\n\n      var dbInfoPromise = new Promise$1(function (resolve, reject) {\n          // Open the database; the openDatabase API will automatically\n          // create it for us if it doesn't exist.\n          try {\n              dbInfo.db = openDatabase(dbInfo.name, String(dbInfo.version), dbInfo.description, dbInfo.size);\n          } catch (e) {\n              return reject(e);\n          }\n\n          // Create our key/value table if it doesn't exist.\n          dbInfo.db.transaction(function (t) {\n              createDbTable(t, dbInfo, function () {\n                  self._dbInfo = dbInfo;\n                  resolve();\n              }, function (t, error) {\n                  reject(error);\n              });\n          }, reject);\n      });\n\n      dbInfo.serializer = localforageSerializer;\n      return dbInfoPromise;\n  }\n\n  function tryExecuteSql(t, dbInfo, sqlStatement, args, callback, errorCallback) {\n      t.executeSql(sqlStatement, args, callback, function (t, error) {\n          if (error.code === error.SYNTAX_ERR) {\n              t.executeSql('SELECT name FROM sqlite_master ' + \"WHERE type='table' AND name = ?\", [dbInfo.storeName], function (t, results) {\n                  if (!results.rows.length) {\n                      // if the table is missing (was deleted)\n                      // re-create it table and retry\n                      createDbTable(t, dbInfo, function () {\n                          t.executeSql(sqlStatement, args, callback, errorCallback);\n                      }, errorCallback);\n                  } else {\n                      errorCallback(t, error);\n                  }\n              }, errorCallback);\n          } else {\n              errorCallback(t, error);\n          }\n      }, errorCallback);\n  }\n\n  function getItem$1(key, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n              dbInfo.db.transaction(function (t) {\n                  tryExecuteSql(t, dbInfo, 'SELECT * FROM ' + dbInfo.storeName + ' WHERE key = ? LIMIT 1', [key], function (t, results) {\n                      var result = results.rows.length ? results.rows.item(0).value : null;\n\n                      // Check to see if this is serialized content we need to\n                      // unpack.\n                      if (result) {\n                          result = dbInfo.serializer.deserialize(result);\n                      }\n\n                      resolve(result);\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function iterate$1(iterator, callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n\n              dbInfo.db.transaction(function (t) {\n                  tryExecuteSql(t, dbInfo, 'SELECT * FROM ' + dbInfo.storeName, [], function (t, results) {\n                      var rows = results.rows;\n                      var length = rows.length;\n\n                      for (var i = 0; i < length; i++) {\n                          var item = rows.item(i);\n                          var result = item.value;\n\n                          // Check to see if this is serialized content\n                          // we need to unpack.\n                          if (result) {\n                              result = dbInfo.serializer.deserialize(result);\n                          }\n\n                          result = iterator(result, item.key, i + 1);\n\n                          // void(0) prevents problems with redefinition\n                          // of `undefined`.\n                          if (result !== void 0) {\n                              resolve(result);\n                              return;\n                          }\n                      }\n\n                      resolve();\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function _setItem(key, value, callback, retriesLeft) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              // The localStorage API doesn't return undefined values in an\n              // \"expected\" way, so undefined is always cast to null in all\n              // drivers. See: https://github.com/mozilla/localForage/pull/42\n              if (value === undefined) {\n                  value = null;\n              }\n\n              // Save the original value to pass to the callback.\n              var originalValue = value;\n\n              var dbInfo = self._dbInfo;\n              dbInfo.serializer.serialize(value, function (value, error) {\n                  if (error) {\n                      reject(error);\n                  } else {\n                      dbInfo.db.transaction(function (t) {\n                          tryExecuteSql(t, dbInfo, 'INSERT OR REPLACE INTO ' + dbInfo.storeName + ' ' + '(key, value) VALUES (?, ?)', [key, value], function () {\n                              resolve(originalValue);\n                          }, function (t, error) {\n                              reject(error);\n                          });\n                      }, function (sqlError) {\n                          // The transaction failed; check\n                          // to see if it's a quota error.\n                          if (sqlError.code === sqlError.QUOTA_ERR) {\n                              // We reject the callback outright for now, but\n                              // it's worth trying to re-run the transaction.\n                              // Even if the user accepts the prompt to use\n                              // more storage on Safari, this error will\n                              // be called.\n                              //\n                              // Try to re-run the transaction.\n                              if (retriesLeft > 0) {\n                                  resolve(_setItem.apply(self, [key, originalValue, callback, retriesLeft - 1]));\n                                  return;\n                              }\n                              reject(sqlError);\n                          }\n                      });\n                  }\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function setItem$1(key, value, callback) {\n      return _setItem.apply(this, [key, value, callback, 1]);\n  }\n\n  function removeItem$1(key, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n              dbInfo.db.transaction(function (t) {\n                  tryExecuteSql(t, dbInfo, 'DELETE FROM ' + dbInfo.storeName + ' WHERE key = ?', [key], function () {\n                      resolve();\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Deletes every item in the table.\n  // TODO: Find out if this resets the AUTO_INCREMENT number.\n  function clear$1(callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n              dbInfo.db.transaction(function (t) {\n                  tryExecuteSql(t, dbInfo, 'DELETE FROM ' + dbInfo.storeName, [], function () {\n                      resolve();\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Does a simple `COUNT(key)` to get the number of items stored in\n  // localForage.\n  function length$1(callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n              dbInfo.db.transaction(function (t) {\n                  // Ahhh, SQL makes this one soooooo easy.\n                  tryExecuteSql(t, dbInfo, 'SELECT COUNT(key) as c FROM ' + dbInfo.storeName, [], function (t, results) {\n                      var result = results.rows.item(0).c;\n                      resolve(result);\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Return the key located at key index X; essentially gets the key from a\n  // `WHERE id = ?`. This is the most efficient way I can think to implement\n  // this rarely-used (in my experience) part of the API, but it can seem\n  // inconsistent, because we do `INSERT OR REPLACE INTO` on `setItem()`, so\n  // the ID of each key will change every time it's updated. Perhaps a stored\n  // procedure for the `setItem()` SQL would solve this problem?\n  // TODO: Don't change ID on `setItem()`.\n  function key$1(n, callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n              dbInfo.db.transaction(function (t) {\n                  tryExecuteSql(t, dbInfo, 'SELECT key FROM ' + dbInfo.storeName + ' WHERE id = ? LIMIT 1', [n + 1], function (t, results) {\n                      var result = results.rows.length ? results.rows.item(0).key : null;\n                      resolve(result);\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function keys$1(callback) {\n      var self = this;\n\n      var promise = new Promise$1(function (resolve, reject) {\n          self.ready().then(function () {\n              var dbInfo = self._dbInfo;\n              dbInfo.db.transaction(function (t) {\n                  tryExecuteSql(t, dbInfo, 'SELECT key FROM ' + dbInfo.storeName, [], function (t, results) {\n                      var keys = [];\n\n                      for (var i = 0; i < results.rows.length; i++) {\n                          keys.push(results.rows.item(i).key);\n                      }\n\n                      resolve(keys);\n                  }, function (t, error) {\n                      reject(error);\n                  });\n              });\n          })[\"catch\"](reject);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // https://www.w3.org/TR/webdatabase/#databases\n  // > There is no way to enumerate or delete the databases available for an origin from this API.\n  function getAllStoreNames(db) {\n      return new Promise$1(function (resolve, reject) {\n          db.transaction(function (t) {\n              t.executeSql('SELECT name FROM sqlite_master ' + \"WHERE type='table' AND name <> '__WebKitDatabaseInfoTable__'\", [], function (t, results) {\n                  var storeNames = [];\n\n                  for (var i = 0; i < results.rows.length; i++) {\n                      storeNames.push(results.rows.item(i).name);\n                  }\n\n                  resolve({\n                      db: db,\n                      storeNames: storeNames\n                  });\n              }, function (t, error) {\n                  reject(error);\n              });\n          }, function (sqlError) {\n              reject(sqlError);\n          });\n      });\n  }\n\n  function dropInstance$1(options, callback) {\n      callback = getCallback.apply(this, arguments);\n\n      var currentConfig = this.config();\n      options = typeof options !== 'function' && options || {};\n      if (!options.name) {\n          options.name = options.name || currentConfig.name;\n          options.storeName = options.storeName || currentConfig.storeName;\n      }\n\n      var self = this;\n      var promise;\n      if (!options.name) {\n          promise = Promise$1.reject('Invalid arguments');\n      } else {\n          promise = new Promise$1(function (resolve) {\n              var db;\n              if (options.name === currentConfig.name) {\n                  // use the db reference of the current instance\n                  db = self._dbInfo.db;\n              } else {\n                  db = openDatabase(options.name, '', '', 0);\n              }\n\n              if (!options.storeName) {\n                  // drop all database tables\n                  resolve(getAllStoreNames(db));\n              } else {\n                  resolve({\n                      db: db,\n                      storeNames: [options.storeName]\n                  });\n              }\n          }).then(function (operationInfo) {\n              return new Promise$1(function (resolve, reject) {\n                  operationInfo.db.transaction(function (t) {\n                      function dropTable(storeName) {\n                          return new Promise$1(function (resolve, reject) {\n                              t.executeSql('DROP TABLE IF EXISTS ' + storeName, [], function () {\n                                  resolve();\n                              }, function (t, error) {\n                                  reject(error);\n                              });\n                          });\n                      }\n\n                      var operations = [];\n                      for (var i = 0, len = operationInfo.storeNames.length; i < len; i++) {\n                          operations.push(dropTable(operationInfo.storeNames[i]));\n                      }\n\n                      Promise$1.all(operations).then(function () {\n                          resolve();\n                      })[\"catch\"](function (e) {\n                          reject(e);\n                      });\n                  }, function (sqlError) {\n                      reject(sqlError);\n                  });\n              });\n          });\n      }\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  var webSQLStorage = {\n      _driver: 'webSQLStorage',\n      _initStorage: _initStorage$1,\n      _support: isWebSQLValid(),\n      iterate: iterate$1,\n      getItem: getItem$1,\n      setItem: setItem$1,\n      removeItem: removeItem$1,\n      clear: clear$1,\n      length: length$1,\n      key: key$1,\n      keys: keys$1,\n      dropInstance: dropInstance$1\n  };\n\n  function isLocalStorageValid() {\n      try {\n          return typeof localStorage !== 'undefined' && 'setItem' in localStorage &&\n          // in IE8 typeof localStorage.setItem === 'object'\n          !!localStorage.setItem;\n      } catch (e) {\n          return false;\n      }\n  }\n\n  function _getKeyPrefix(options, defaultConfig) {\n      var keyPrefix = options.name + '/';\n\n      if (options.storeName !== defaultConfig.storeName) {\n          keyPrefix += options.storeName + '/';\n      }\n      return keyPrefix;\n  }\n\n  // Check if localStorage throws when saving an item\n  function checkIfLocalStorageThrows() {\n      var localStorageTestKey = '_localforage_support_test';\n\n      try {\n          localStorage.setItem(localStorageTestKey, true);\n          localStorage.removeItem(localStorageTestKey);\n\n          return false;\n      } catch (e) {\n          return true;\n      }\n  }\n\n  // Check if localStorage is usable and allows to save an item\n  // This method checks if localStorage is usable in Safari Private Browsing\n  // mode, or in any other case where the available quota for localStorage\n  // is 0 and there wasn't any saved items yet.\n  function _isLocalStorageUsable() {\n      return !checkIfLocalStorageThrows() || localStorage.length > 0;\n  }\n\n  // Config the localStorage backend, using options set in the config.\n  function _initStorage$2(options) {\n      var self = this;\n      var dbInfo = {};\n      if (options) {\n          for (var i in options) {\n              dbInfo[i] = options[i];\n          }\n      }\n\n      dbInfo.keyPrefix = _getKeyPrefix(options, self._defaultConfig);\n\n      if (!_isLocalStorageUsable()) {\n          return Promise$1.reject();\n      }\n\n      self._dbInfo = dbInfo;\n      dbInfo.serializer = localforageSerializer;\n\n      return Promise$1.resolve();\n  }\n\n  // Remove all keys from the datastore, effectively destroying all data in\n  // the app's key/value store!\n  function clear$2(callback) {\n      var self = this;\n      var promise = self.ready().then(function () {\n          var keyPrefix = self._dbInfo.keyPrefix;\n\n          for (var i = localStorage.length - 1; i >= 0; i--) {\n              var key = localStorage.key(i);\n\n              if (key.indexOf(keyPrefix) === 0) {\n                  localStorage.removeItem(key);\n              }\n          }\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Retrieve an item from the store. Unlike the original async_storage\n  // library in Gaia, we don't modify return values at all. If a key's value\n  // is `undefined`, we pass that value to the callback function.\n  function getItem$2(key, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = self.ready().then(function () {\n          var dbInfo = self._dbInfo;\n          var result = localStorage.getItem(dbInfo.keyPrefix + key);\n\n          // If a result was found, parse it from the serialized\n          // string into a JS object. If result isn't truthy, the key\n          // is likely undefined and we'll pass it straight to the\n          // callback.\n          if (result) {\n              result = dbInfo.serializer.deserialize(result);\n          }\n\n          return result;\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Iterate over all items in the store.\n  function iterate$2(iterator, callback) {\n      var self = this;\n\n      var promise = self.ready().then(function () {\n          var dbInfo = self._dbInfo;\n          var keyPrefix = dbInfo.keyPrefix;\n          var keyPrefixLength = keyPrefix.length;\n          var length = localStorage.length;\n\n          // We use a dedicated iterator instead of the `i` variable below\n          // so other keys we fetch in localStorage aren't counted in\n          // the `iterationNumber` argument passed to the `iterate()`\n          // callback.\n          //\n          // See: github.com/mozilla/localForage/pull/435#discussion_r38061530\n          var iterationNumber = 1;\n\n          for (var i = 0; i < length; i++) {\n              var key = localStorage.key(i);\n              if (key.indexOf(keyPrefix) !== 0) {\n                  continue;\n              }\n              var value = localStorage.getItem(key);\n\n              // If a result was found, parse it from the serialized\n              // string into a JS object. If result isn't truthy, the\n              // key is likely undefined and we'll pass it straight\n              // to the iterator.\n              if (value) {\n                  value = dbInfo.serializer.deserialize(value);\n              }\n\n              value = iterator(value, key.substring(keyPrefixLength), iterationNumber++);\n\n              if (value !== void 0) {\n                  return value;\n              }\n          }\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Same as localStorage's key() method, except takes a callback.\n  function key$2(n, callback) {\n      var self = this;\n      var promise = self.ready().then(function () {\n          var dbInfo = self._dbInfo;\n          var result;\n          try {\n              result = localStorage.key(n);\n          } catch (error) {\n              result = null;\n          }\n\n          // Remove the prefix from the key, if a key is found.\n          if (result) {\n              result = result.substring(dbInfo.keyPrefix.length);\n          }\n\n          return result;\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function keys$2(callback) {\n      var self = this;\n      var promise = self.ready().then(function () {\n          var dbInfo = self._dbInfo;\n          var length = localStorage.length;\n          var keys = [];\n\n          for (var i = 0; i < length; i++) {\n              var itemKey = localStorage.key(i);\n              if (itemKey.indexOf(dbInfo.keyPrefix) === 0) {\n                  keys.push(itemKey.substring(dbInfo.keyPrefix.length));\n              }\n          }\n\n          return keys;\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Supply the number of keys in the datastore to the callback function.\n  function length$2(callback) {\n      var self = this;\n      var promise = self.keys().then(function (keys) {\n          return keys.length;\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Remove an item from the store, nice and simple.\n  function removeItem$2(key, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = self.ready().then(function () {\n          var dbInfo = self._dbInfo;\n          localStorage.removeItem(dbInfo.keyPrefix + key);\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  // Set a key's value and run an optional callback once the value is set.\n  // Unlike Gaia's implementation, the callback function is passed the value,\n  // in case you want to operate on that value only after you're sure it\n  // saved, or something like that.\n  function setItem$2(key, value, callback) {\n      var self = this;\n\n      key = normalizeKey(key);\n\n      var promise = self.ready().then(function () {\n          // Convert undefined values to null.\n          // https://github.com/mozilla/localForage/pull/42\n          if (value === undefined) {\n              value = null;\n          }\n\n          // Save the original value to pass to the callback.\n          var originalValue = value;\n\n          return new Promise$1(function (resolve, reject) {\n              var dbInfo = self._dbInfo;\n              dbInfo.serializer.serialize(value, function (value, error) {\n                  if (error) {\n                      reject(error);\n                  } else {\n                      try {\n                          localStorage.setItem(dbInfo.keyPrefix + key, value);\n                          resolve(originalValue);\n                      } catch (e) {\n                          // localStorage capacity exceeded.\n                          // TODO: Make this a specific error/event.\n                          if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {\n                              reject(e);\n                          }\n                          reject(e);\n                      }\n                  }\n              });\n          });\n      });\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  function dropInstance$2(options, callback) {\n      callback = getCallback.apply(this, arguments);\n\n      options = typeof options !== 'function' && options || {};\n      if (!options.name) {\n          var currentConfig = this.config();\n          options.name = options.name || currentConfig.name;\n          options.storeName = options.storeName || currentConfig.storeName;\n      }\n\n      var self = this;\n      var promise;\n      if (!options.name) {\n          promise = Promise$1.reject('Invalid arguments');\n      } else {\n          promise = new Promise$1(function (resolve) {\n              if (!options.storeName) {\n                  resolve(options.name + '/');\n              } else {\n                  resolve(_getKeyPrefix(options, self._defaultConfig));\n              }\n          }).then(function (keyPrefix) {\n              for (var i = localStorage.length - 1; i >= 0; i--) {\n                  var key = localStorage.key(i);\n\n                  if (key.indexOf(keyPrefix) === 0) {\n                      localStorage.removeItem(key);\n                  }\n              }\n          });\n      }\n\n      executeCallback(promise, callback);\n      return promise;\n  }\n\n  var localStorageWrapper = {\n      _driver: 'localStorageWrapper',\n      _initStorage: _initStorage$2,\n      _support: isLocalStorageValid(),\n      iterate: iterate$2,\n      getItem: getItem$2,\n      setItem: setItem$2,\n      removeItem: removeItem$2,\n      clear: clear$2,\n      length: length$2,\n      key: key$2,\n      keys: keys$2,\n      dropInstance: dropInstance$2\n  };\n\n  var sameValue = function sameValue(x, y) {\n      return x === y || typeof x === 'number' && typeof y === 'number' && isNaN(x) && isNaN(y);\n  };\n\n  var includes = function includes(array, searchElement) {\n      var len = array.length;\n      var i = 0;\n      while (i < len) {\n          if (sameValue(array[i], searchElement)) {\n              return true;\n          }\n          i++;\n      }\n\n      return false;\n  };\n\n  var isArray = Array.isArray || function (arg) {\n      return Object.prototype.toString.call(arg) === '[object Array]';\n  };\n\n  // Drivers are stored here when `defineDriver()` is called.\n  // They are shared across all instances of localForage.\n  var DefinedDrivers = {};\n\n  var DriverSupport = {};\n\n  var DefaultDrivers = {\n      INDEXEDDB: asyncStorage,\n      WEBSQL: webSQLStorage,\n      LOCALSTORAGE: localStorageWrapper\n  };\n\n  var DefaultDriverOrder = [DefaultDrivers.INDEXEDDB._driver, DefaultDrivers.WEBSQL._driver, DefaultDrivers.LOCALSTORAGE._driver];\n\n  var OptionalDriverMethods = ['dropInstance'];\n\n  var LibraryMethods = ['clear', 'getItem', 'iterate', 'key', 'keys', 'length', 'removeItem', 'setItem'].concat(OptionalDriverMethods);\n\n  var DefaultConfig = {\n      description: '',\n      driver: DefaultDriverOrder.slice(),\n      name: 'localforage',\n      // Default DB size is _JUST UNDER_ 5MB, as it's the highest size\n      // we can use without a prompt.\n      size: 4980736,\n      storeName: 'keyvaluepairs',\n      version: 1.0\n  };\n\n  function callWhenReady(localForageInstance, libraryMethod) {\n      localForageInstance[libraryMethod] = function () {\n          var _args = arguments;\n          return localForageInstance.ready().then(function () {\n              return localForageInstance[libraryMethod].apply(localForageInstance, _args);\n          });\n      };\n  }\n\n  function extend() {\n      for (var i = 1; i < arguments.length; i++) {\n          var arg = arguments[i];\n\n          if (arg) {\n              for (var _key in arg) {\n                  if (arg.hasOwnProperty(_key)) {\n                      if (isArray(arg[_key])) {\n                          arguments[0][_key] = arg[_key].slice();\n                      } else {\n                          arguments[0][_key] = arg[_key];\n                      }\n                  }\n              }\n          }\n      }\n\n      return arguments[0];\n  }\n\n  var LocalForage = function () {\n      function LocalForage(options) {\n          _classCallCheck(this, LocalForage);\n\n          for (var driverTypeKey in DefaultDrivers) {\n              if (DefaultDrivers.hasOwnProperty(driverTypeKey)) {\n                  var driver = DefaultDrivers[driverTypeKey];\n                  var driverName = driver._driver;\n                  this[driverTypeKey] = driverName;\n\n                  if (!DefinedDrivers[driverName]) {\n                      // we don't need to wait for the promise,\n                      // since the default drivers can be defined\n                      // in a blocking manner\n                      this.defineDriver(driver);\n                  }\n              }\n          }\n\n          this._defaultConfig = extend({}, DefaultConfig);\n          this._config = extend({}, this._defaultConfig, options);\n          this._driverSet = null;\n          this._initDriver = null;\n          this._ready = false;\n          this._dbInfo = null;\n\n          this._wrapLibraryMethodsWithReady();\n          this.setDriver(this._config.driver)[\"catch\"](function () {});\n      }\n\n      // Set any config values for localForage; can be called anytime before\n      // the first API call (e.g. `getItem`, `setItem`).\n      // We loop through options so we don't overwrite existing config\n      // values.\n\n\n      LocalForage.prototype.config = function config(options) {\n          // If the options argument is an object, we use it to set values.\n          // Otherwise, we return either a specified config value or all\n          // config values.\n          if ((typeof options === 'undefined' ? 'undefined' : _typeof(options)) === 'object') {\n              // If localforage is ready and fully initialized, we can't set\n              // any new configuration values. Instead, we return an error.\n              if (this._ready) {\n                  return new Error(\"Can't call config() after localforage \" + 'has been used.');\n              }\n\n              for (var i in options) {\n                  if (i === 'storeName') {\n                      options[i] = options[i].replace(/\\W/g, '_');\n                  }\n\n                  if (i === 'version' && typeof options[i] !== 'number') {\n                      return new Error('Database version must be a number.');\n                  }\n\n                  this._config[i] = options[i];\n              }\n\n              // after all config options are set and\n              // the driver option is used, try setting it\n              if ('driver' in options && options.driver) {\n                  return this.setDriver(this._config.driver);\n              }\n\n              return true;\n          } else if (typeof options === 'string') {\n              return this._config[options];\n          } else {\n              return this._config;\n          }\n      };\n\n      // Used to define a custom driver, shared across all instances of\n      // localForage.\n\n\n      LocalForage.prototype.defineDriver = function defineDriver(driverObject, callback, errorCallback) {\n          var promise = new Promise$1(function (resolve, reject) {\n              try {\n                  var driverName = driverObject._driver;\n                  var complianceError = new Error('Custom driver not compliant; see ' + 'https://mozilla.github.io/localForage/#definedriver');\n\n                  // A driver name should be defined and not overlap with the\n                  // library-defined, default drivers.\n                  if (!driverObject._driver) {\n                      reject(complianceError);\n                      return;\n                  }\n\n                  var driverMethods = LibraryMethods.concat('_initStorage');\n                  for (var i = 0, len = driverMethods.length; i < len; i++) {\n                      var driverMethodName = driverMethods[i];\n\n                      // when the property is there,\n                      // it should be a method even when optional\n                      var isRequired = !includes(OptionalDriverMethods, driverMethodName);\n                      if ((isRequired || driverObject[driverMethodName]) && typeof driverObject[driverMethodName] !== 'function') {\n                          reject(complianceError);\n                          return;\n                      }\n                  }\n\n                  var configureMissingMethods = function configureMissingMethods() {\n                      var methodNotImplementedFactory = function methodNotImplementedFactory(methodName) {\n                          return function () {\n                              var error = new Error('Method ' + methodName + ' is not implemented by the current driver');\n                              var promise = Promise$1.reject(error);\n                              executeCallback(promise, arguments[arguments.length - 1]);\n                              return promise;\n                          };\n                      };\n\n                      for (var _i = 0, _len = OptionalDriverMethods.length; _i < _len; _i++) {\n                          var optionalDriverMethod = OptionalDriverMethods[_i];\n                          if (!driverObject[optionalDriverMethod]) {\n                              driverObject[optionalDriverMethod] = methodNotImplementedFactory(optionalDriverMethod);\n                          }\n                      }\n                  };\n\n                  configureMissingMethods();\n\n                  var setDriverSupport = function setDriverSupport(support) {\n                      if (DefinedDrivers[driverName]) {\n                          console.info('Redefining LocalForage driver: ' + driverName);\n                      }\n                      DefinedDrivers[driverName] = driverObject;\n                      DriverSupport[driverName] = support;\n                      // don't use a then, so that we can define\n                      // drivers that have simple _support methods\n                      // in a blocking manner\n                      resolve();\n                  };\n\n                  if ('_support' in driverObject) {\n                      if (driverObject._support && typeof driverObject._support === 'function') {\n                          driverObject._support().then(setDriverSupport, reject);\n                      } else {\n                          setDriverSupport(!!driverObject._support);\n                      }\n                  } else {\n                      setDriverSupport(true);\n                  }\n              } catch (e) {\n                  reject(e);\n              }\n          });\n\n          executeTwoCallbacks(promise, callback, errorCallback);\n          return promise;\n      };\n\n      LocalForage.prototype.driver = function driver() {\n          return this._driver || null;\n      };\n\n      LocalForage.prototype.getDriver = function getDriver(driverName, callback, errorCallback) {\n          var getDriverPromise = DefinedDrivers[driverName] ? Promise$1.resolve(DefinedDrivers[driverName]) : Promise$1.reject(new Error('Driver not found.'));\n\n          executeTwoCallbacks(getDriverPromise, callback, errorCallback);\n          return getDriverPromise;\n      };\n\n      LocalForage.prototype.getSerializer = function getSerializer(callback) {\n          var serializerPromise = Promise$1.resolve(localforageSerializer);\n          executeTwoCallbacks(serializerPromise, callback);\n          return serializerPromise;\n      };\n\n      LocalForage.prototype.ready = function ready(callback) {\n          var self = this;\n\n          var promise = self._driverSet.then(function () {\n              if (self._ready === null) {\n                  self._ready = self._initDriver();\n              }\n\n              return self._ready;\n          });\n\n          executeTwoCallbacks(promise, callback, callback);\n          return promise;\n      };\n\n      LocalForage.prototype.setDriver = function setDriver(drivers, callback, errorCallback) {\n          var self = this;\n\n          if (!isArray(drivers)) {\n              drivers = [drivers];\n          }\n\n          var supportedDrivers = this._getSupportedDrivers(drivers);\n\n          function setDriverToConfig() {\n              self._config.driver = self.driver();\n          }\n\n          function extendSelfWithDriver(driver) {\n              self._extend(driver);\n              setDriverToConfig();\n\n              self._ready = self._initStorage(self._config);\n              return self._ready;\n          }\n\n          function initDriver(supportedDrivers) {\n              return function () {\n                  var currentDriverIndex = 0;\n\n                  function driverPromiseLoop() {\n                      while (currentDriverIndex < supportedDrivers.length) {\n                          var driverName = supportedDrivers[currentDriverIndex];\n                          currentDriverIndex++;\n\n                          self._dbInfo = null;\n                          self._ready = null;\n\n                          return self.getDriver(driverName).then(extendSelfWithDriver)[\"catch\"](driverPromiseLoop);\n                      }\n\n                      setDriverToConfig();\n                      var error = new Error('No available storage method found.');\n                      self._driverSet = Promise$1.reject(error);\n                      return self._driverSet;\n                  }\n\n                  return driverPromiseLoop();\n              };\n          }\n\n          // There might be a driver initialization in progress\n          // so wait for it to finish in order to avoid a possible\n          // race condition to set _dbInfo\n          var oldDriverSetDone = this._driverSet !== null ? this._driverSet[\"catch\"](function () {\n              return Promise$1.resolve();\n          }) : Promise$1.resolve();\n\n          this._driverSet = oldDriverSetDone.then(function () {\n              var driverName = supportedDrivers[0];\n              self._dbInfo = null;\n              self._ready = null;\n\n              return self.getDriver(driverName).then(function (driver) {\n                  self._driver = driver._driver;\n                  setDriverToConfig();\n                  self._wrapLibraryMethodsWithReady();\n                  self._initDriver = initDriver(supportedDrivers);\n              });\n          })[\"catch\"](function () {\n              setDriverToConfig();\n              var error = new Error('No available storage method found.');\n              self._driverSet = Promise$1.reject(error);\n              return self._driverSet;\n          });\n\n          executeTwoCallbacks(this._driverSet, callback, errorCallback);\n          return this._driverSet;\n      };\n\n      LocalForage.prototype.supports = function supports(driverName) {\n          return !!DriverSupport[driverName];\n      };\n\n      LocalForage.prototype._extend = function _extend(libraryMethodsAndProperties) {\n          extend(this, libraryMethodsAndProperties);\n      };\n\n      LocalForage.prototype._getSupportedDrivers = function _getSupportedDrivers(drivers) {\n          var supportedDrivers = [];\n          for (var i = 0, len = drivers.length; i < len; i++) {\n              var driverName = drivers[i];\n              if (this.supports(driverName)) {\n                  supportedDrivers.push(driverName);\n              }\n          }\n          return supportedDrivers;\n      };\n\n      LocalForage.prototype._wrapLibraryMethodsWithReady = function _wrapLibraryMethodsWithReady() {\n          // Add a stub for each driver API method that delays the call to the\n          // corresponding driver method until localForage is ready. These stubs\n          // will be replaced by the driver methods as soon as the driver is\n          // loaded, so there is no performance impact.\n          for (var i = 0, len = LibraryMethods.length; i < len; i++) {\n              callWhenReady(this, LibraryMethods[i]);\n          }\n      };\n\n      LocalForage.prototype.createInstance = function createInstance(options) {\n          return new LocalForage(options);\n      };\n\n      return LocalForage;\n  }();\n\n  // The actual localForage object that we expose as a module or via a\n  // global. It's extended by pulling in one of our other libraries.\n\n\n  var localforage_js = new LocalForage();\n\n  module.exports = localforage_js;\n\n  },{\"3\":3}]},{},[4])(4)\n  });\n  }(localforage$1));\n\n  const localforage = localforage$1.exports;\n\n  async function _asyncNullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return await rhsFn(); } }/* eslint-env browser */\n\n  // Log load message to browser dev console\n  console.log(loadMessagePlaceholder.slice(1, -1));\n\n  const manifest = chrome.runtime.getManifest();\n  const isMV2 = manifest.manifest_version === 2;\n\n  const options = {\n    executeScript: isMV2 && JSON.parse(executeScriptPlaceholder),\n    unregisterServiceWorkers:\n      isMV2 && JSON.parse(unregisterServiceWorkersPlaceholder),\n  };\n\n  /* ----------- UNREGISTER SERVICE WORKERS ---------- */\n\n  async function unregisterServiceWorkers() {\n    try {\n      const registrations = await navigator.serviceWorker.getRegistrations();\n      await Promise.all(registrations.map((r) => r.unregister()));\n    } catch (error) {\n      console.error(error);\n    }\n  }\n\n  /* ----------- TRICK SERVICE WORKER OPEN ----------- */\n\n  const ports = new Set();\n  function reloadContentScripts() {\n    ports.forEach((port) => {\n      port.postMessage({ type: 'reload' });\n    });\n  }\n  chrome.runtime.onConnect.addListener((port) => {\n    if (port.name !== 'simpleReloader') return\n    ports.add(port);\n    port.onDisconnect.addListener(() => ports.delete(port));\n  });\n\n  /* -------------- CHECK TIMESTAMP.JSON ------------- */\n\n  const timestampKey = 'chromeExtensionReloaderTimestamp';\n  const errorsKey = 'chromeExtensionReloaderErrors';\n  const interval = setInterval(async () => {\n    try {\n      const res = await fetch(timestampPathPlaceholder);\n      const t = await res.json();\n      await localforage.removeItem(errorsKey);\n      const timestamp = await _asyncNullishCoalesce((await localforage.getItem(timestampKey)), async () => ( undefined));\n\n      if (typeof timestamp === 'undefined') {\n        await localforage.setItem(timestampKey, t);\n      } else if (timestamp !== t) {\n        chrome.runtime.reload();\n      }\n    } catch (error) {\n      const errors = await _asyncNullishCoalesce((await localforage.getItem(errorsKey)), async () => ( 0));\n\n      if (errors < 5) {\n        await localforage.setItem(errorsKey, errors + 1);\n      } else {\n        clearInterval(interval);\n\n        console.log('rollup-plugin-chrome-extension simple reloader error:');\n        console.error(error);\n      }\n    }\n  }, 1000);\n\n  /* ------------ POLYFILL RUNTIME.RELOAD ------------ */\n\n  // Other calls to runtime.reload\n  //  should also perform the same tasks\n  const _runtimeReload = chrome.runtime.reload;\n  chrome.runtime.reload = () => {\n  (async () => {\n      // Stop checking the timestamp\n      clearInterval(interval);\n      // Clean up storage\n      await localforage.removeItem(timestampKey);\n      // Reload the content scripts\n      reloadContentScripts();\n      // Unregister service workers in MV2\n      if (options.unregisterServiceWorkers) await unregisterServiceWorkers();\n      // Reload the extension\n      _runtimeReload();\n    })();\n  };\n\n  /* ---------- POLYFILL TABS.EXECUTESCRIPT ---------- */\n\n  if (options.executeScript) {\n    const markerId = 'rollup-plugin-chrome-extension-simple-reloader';\n\n    const addMarker = `{\n    const tag = document.createElement('meta');\n    tag.id = '${markerId}';\n    document.head.append(tag);\n  }`;\n\n    const checkMarker = `\n  !!document.head.querySelector('#${markerId}')\n  `;\n\n    // Modify chrome.tabs.executeScript to inject reloader\n    const _executeScript = chrome.tabs.executeScript;\n    const withP = (...args) =>\n      new Promise((resolve, reject) => {\n        // eslint-disable-next-line\n        // @ts-ignore\n        _executeScript(...args, (results) => {\n          if (chrome.runtime.lastError) {\n            reject(chrome.runtime.lastError.message);\n          } else {\n            resolve(results);\n          }\n        });\n      });\n\n    // @ts-expect-error executeScript has a complex return type\n    chrome.tabs.executeScript = async (...args) => {\n      const tabId = typeof args[0] === 'number' ? args[0] : null;\n      const argsBase = (tabId === null ? [] : [tabId]); \n\n      const [done] = await withP(\n        ...(argsBase.concat({ code: checkMarker }) ),\n      );\n\n      // Don't add reloader if it's already there\n      if (!done) {\n        await withP(...(argsBase.concat({ code: addMarker }) ));\n\n        // execute reloader\n        const reloaderArgs = argsBase.concat([\n          { file: JSON.parse(ctScriptPathPlaceholder) },\n        ]); \n\n        await withP(...reloaderArgs);\n      }\n\n      return _executeScript(...(args ))\n    };\n  }\n\n})();\n";

const code = "(function () {\n  'use strict';\n\n  /* ------------------- FILENAMES ------------------- */\n  const loadMessagePlaceholder = '%LOAD_MESSAGE%';\n\n  /* eslint-env browser */\n\n  const delay = (ms) =>\n    new Promise((resolve) => setTimeout(() => resolve(), ms));\n\n  // Log load message to browser dev console\n  console.log(loadMessagePlaceholder.slice(1, -1));\n\n  const { name } = chrome.runtime.getManifest();\n\n  connect().then(reload).catch(console.error);\n\n  async function reload() {\n    console.log(`${name} has reloaded...`);\n\n    await delay(500);\n\n    return location.reload()\n  }\n\n  async function connect() {\n    // If the background was reloaded manually,\n    //  need to delay for context invalidation\n    await delay(100);\n\n    let port;\n    try {\n      // This will throw if bg was reloaded manually\n      port = chrome.runtime.connect({\n        name: 'simpleReloader',\n      });\n    } catch (error) {\n      return // should reload, context invalid\n    }\n\n    const shouldReload = await Promise.race([\n      // get a new port every 5 minutes\n      delay(5 * 59 * 1000).then(() => false),\n      // or if the background disconnects\n      new Promise((r) =>\n        port.onDisconnect.addListener(r),\n      ).then(() => false),\n      // unless we get a reload message\n      new Promise((r) => port.onMessage.addListener(r)).then(\n        ({ type }) => type === 'reload',\n      ),\n    ]);\n\n    // Clean up old port\n    port.disconnect();\n\n    if (shouldReload) return\n\n    return connect()\n  }\n\n})();\n";

/* ------------------- FILENAMES ------------------- */

const backgroundPageReloader = 'background-page-reloader.js';
const contentScriptReloader = 'content-script-reloader.js';
const timestampFilename = 'timestamp.json';

/* ------------------ PLACEHOLDERS ----------------- */

const timestampPathPlaceholder = '%TIMESTAMP_PATH%';
const loadMessagePlaceholder = '%LOAD_MESSAGE%';
const ctScriptPathPlaceholder = '%CONTENT_SCRIPT_PATH%';
const unregisterServiceWorkersPlaceholder =
  '%UNREGISTER_SERVICE_WORKERS%';
const executeScriptPlaceholder = '%EXECUTE_SCRIPT%';

function _nullishCoalesce$1(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));





















// Used for testing
const _internalCache = {};

const simpleReloader = (
  {
    executeScript = true,
    unregisterServiceWorkers = true,
    reloadDelay = 100,
  } = {} ,
  cache = {} ,
) => {
  if (!process.env.ROLLUP_WATCH) {
    return undefined
  }

  return {
    name: 'chrome-extension-simple-reloader',

    generateBundle({ dir }, bundle) {
      const date = new Date();
      const time = `${date.getFullYear().toString().padStart(2, '0')}-${(
        date.getMonth() + 1
      )
        .toString()
        .padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date
        .getHours()
        .toString()
        .padStart(2, '0')}:${date
        .getMinutes()
        .toString()
        .padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;

      cache.outputDir = dir;
      cache.loadMessage = [
        'DEVELOPMENT build with simple auto-reloader',
        `[${time}] waiting for changes...`,
      ].join('\n');

      /* --------------- EMIT CLIENT FILES --------------- */

      const emit = (name, source, isFileName) => {
        const id = this.emitFile({
          type: 'asset',
          [isFileName ? 'fileName' : 'name']: name,
          source,
        });

        return this.getFileName(id)
      };

      cache.timestampPath = emit(
        timestampFilename,
        JSON.stringify(Date.now()),
        true,
      );

      cache.ctScriptPath = emit(
        contentScriptReloader,
        code.replace(
          loadMessagePlaceholder,
          JSON.stringify(cache.loadMessage),
        ),
      );

      cache.bgScriptPath = emit(
        backgroundPageReloader,
        code$1
          .replace(timestampPathPlaceholder, cache.timestampPath)
          .replace(loadMessagePlaceholder, JSON.stringify(cache.loadMessage))
          .replace(ctScriptPathPlaceholder, JSON.stringify(cache.ctScriptPath))
          .replace(executeScriptPlaceholder, JSON.stringify(executeScript))
          .replace(
            unregisterServiceWorkersPlaceholder,
            JSON.stringify(unregisterServiceWorkers),
          ),
      );

      // Update the exported cache
      Object.assign(_internalCache, cache);

      /* ---------------- UPDATE MANIFEST ---------------- */

      updateManifest(
        (manifest) => {
          /* ---------------- MANIFEST VERSION --------------- */

          cache.manifestVersion = manifest.manifest_version;

          /* ------------------ DESCRIPTION ------------------ */

          manifest.description = cache.loadMessage;

          /* ---------------- BACKGROUND PAGE ---------------- */

          if (!cache.bgScriptPath)
            this.error(`cache.bgScriptPath is ${typeof cache.bgScriptPath}`);

          if (manifest.manifest_version === 3) {
            const swPath =
              _nullishCoalesce$1(_optionalChain([manifest, 'access', _ => _.background, 'optionalAccess', _2 => _2.service_worker]), () => ( 'service_worker.js'));

            const swCode = `
              // SIMPLE RELOADER IMPORT
              import "./${cache.bgScriptPath}"
            `.trim();

            if (!bundle[swPath]) emit(swPath, swCode, true);
            else {
              const sw = bundle[swPath]; 
              sw.code = `
              ${swCode}
              ${sw.code}
              `.trim();
            }

            set(manifest, 'background.service_worker', swPath);
            set(manifest, 'background.type', 'module');
          } else {
            set(
              manifest,
              'background.scripts',
              (_nullishCoalesce$1(_optionalChain([manifest, 'access', _3 => _3.background, 'optionalAccess', _4 => _4.scripts]), () => ( []))).concat([cache.bgScriptPath]),
            );
            set(manifest, 'background.persistent', true);
          }

          /* ---------------- CONTENT SCRIPTS ---------------- */

          if (!cache.ctScriptPath)
            this.error(`cache.ctScriptPath is ${typeof cache.ctScriptPath}`);

          const { content_scripts: ctScripts } = manifest;

          manifest.content_scripts = _optionalChain([ctScripts, 'optionalAccess', _5 => _5.map, 'call', _6 => _6(({ js = [], ...rest }) => ({
            js: [cache.ctScriptPath, ...js],
            ...rest,
          }))]);

          return manifest
        },
        bundle,
        this.error,
      );

      // We'll write this file ourselves, we just need a safe path to write the timestamp
      delete bundle[cache.timestampPath];
    },

    /* -------------- WRITE TIMESTAMP FILE ------------- */
    async writeBundle() {
      // Sometimes Chrome says the manifest isn't valid, so we need to wait a bit
      reloadDelay > 0 && (await delay(reloadDelay));

      try {
        await outputJson(
          join(cache.outputDir, cache.timestampPath),
          Date.now(),
        );
      } catch (err) {
        if (isErrorLike(err)) {
          this.error(`Unable to update timestamp file:\n\t${err.message}`);
        } else {
          this.error('Unable to update timestamp file');
        }
      }
    },
  }
};




function isErrorLike(x) {
  return typeof x === 'object' && x !== null && 'message' in x
}

function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } }


const chromeExtension = (
  options = {} ,
) => {
  /* --------------- LOAD PACKAGE.JSON --------------- */

  try {
    const packageJsonPath = join(process.cwd(), 'package.json');
    options.pkg = options.pkg || readJSONSync(packageJsonPath);
    // eslint-disable-next-line no-empty
  } catch (error) {}

  /* ----------------- SETUP PLUGINS ----------------- */

  const manifest = manifestInput(options);
  const html = htmlInputs(manifest);
  const validate = validateNames();
  const browser = browserPolyfill(manifest);
  const mixedFormat$1 = mixedFormat(manifest);

  /* ----------------- RETURN PLUGIN ----------------- */

  return {
    name: 'chrome-extension',

    // For testing
    _plugins: { manifest, html, validate },

    config: () => {
      console.warn(
        'Please run `npm i rollup-plugin-chrome-extension@beta` to use with Vite.',
      );
      throw new Error(
        '[chrome-extension] Vite support is for RPCE v4 and above. This is RPCE v3.6.7.',
      )
    },

    async options(options) {
      try {
        // return [manifest, html].reduce((opts, plugin) => {
        //   const result = plugin.options.call(this, opts)

        //   return result || options
        // }, options)
        let result = options;
        for (const plugin of [manifest, html]) {
          const r = await plugin.options.call(this, result);
          result = _nullishCoalesce(r, () => ( result));
        }
        return result
      } catch (error) {
        const manifestError =
          'The manifest must have at least one script or HTML file.';
        const htmlError =
          'At least one HTML file must have at least one script.';

        if (
          error instanceof Error &&
          (error.message === manifestError || error.message === htmlError)
        ) {
          throw new Error(
            'A Chrome extension must have at least one script or HTML file.',
          )
        } else {
          throw error
        }
      }
    },

    async buildStart(options) {
      await Promise.all([
        manifest.buildStart.call(this, options),
        html.buildStart.call(this, options),
      ]);
    },

    async resolveId(...args) {
      return manifest.resolveId.call(this, ...args)
    },

    async load(id) {
      return manifest.load.call(this, id)
    },

    transform(source, id) {
      return manifest.transform.call(this, source, id)
    },

    watchChange(...args) {
      manifest.watchChange.call(this, ...args);
      html.watchChange.call(this, ...args);
    },

    async generateBundle(...args) {
      await manifest.generateBundle.call(this, ...args);
      await validate.generateBundle.call(this, ...args);
      await browser.generateBundle.call(this, ...args);
      // TODO: should skip this if not needed
      await mixedFormat$1.generateBundle.call(this, ...args);
    },
  }
};

export { chromeExtension, simpleReloader };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXgtZXNtLmpzIiwic291cmNlcyI6WyIuLi9zcmMvaGVscGVycy50cyIsIi4uL3NyYy9tYW5pZmVzdC1pbnB1dC9yZWR1Y2VUb1JlY29yZC50cyIsIi4uL3NyYy9odG1sLWlucHV0cy9jaGVlcmlvLnRzIiwiLi4vc3JjL2h0bWwtaW5wdXRzL2luZGV4LnRzIiwiLi4vc3JjL21hbmlmZXN0LXR5cGVzLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L2Nsb25lT2JqZWN0LnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L2R5bmFtaWNJbXBvcnRXcmFwcGVyLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L2dldElucHV0TWFuaWZlc3RQYXRoLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L21hbmlmZXN0LXBhcnNlci9jb21iaW5lLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L21hbmlmZXN0LXBhcnNlci9wZXJtaXNzaW9ucy50cyIsIi4uL3NyYy9tYW5pZmVzdC1pbnB1dC9tYW5pZmVzdC1wYXJzZXIvaW5kZXgudHMiLCIuLi9zcmMvbWFuaWZlc3QtaW5wdXQvbWFuaWZlc3QtcGFyc2VyL3ZhbGlkYXRlLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L2NvbnZlcnRNYXRjaFBhdHRlcm5zLnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L3VwZGF0ZU1hbmlmZXN0LnRzIiwiLi4vc3JjL21hbmlmZXN0LWlucHV0L3dhcm5EZXByZWNhdGVkT3B0aW9ucy50cyIsIi4uL3NyYy9tYW5pZmVzdC1pbnB1dC9pbmRleC50cyIsIi4uL3NyYy9icm93c2VyLXBvbHlmaWxsL2luZGV4LnRzIiwiLi4vc3JjL3ZhbGlkYXRlLW5hbWVzL2luZGV4LnRzIiwiLi4vc3JjL21peGVkLWZvcm1hdC9yZXNvbHZlRnJvbUJ1bmRsZS50cyIsIi4uL3NyYy9taXhlZC1mb3JtYXQvcmVnZW5lcmF0ZUJ1bmRsZS50cyIsIi4uL3NyYy9taXhlZC1mb3JtYXQvaW5kZXgudHMiLCIuLi9zcmMvcGx1Z2luLXJlbG9hZGVyLXNpbXBsZS9DT05TVEFOVFMudHMiLCIuLi9zcmMvcGx1Z2luLXJlbG9hZGVyLXNpbXBsZS9pbmRleC50cyIsIi4uL3NyYy9pbmRleC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBPdXRwdXRPcHRpb25zIH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHsgT3V0cHV0QXNzZXQsIE91dHB1dENodW5rLCBPdXRwdXRCdW5kbGUgfSBmcm9tICdyb2xsdXAnXG5cbmV4cG9ydCB0eXBlIFVucGFja2VkPFQ+ID0gVCBleHRlbmRzIEFycmF5PGluZmVyIFI+ID8gUiA6IG5ldmVyXG5cbmV4cG9ydCBjb25zdCBub3QgPVxuICA8VD4oZm46ICh4OiBUKSA9PiBib29sZWFuKSA9PlxuICAoeDogVCkgPT5cbiAgICAhZm4oeClcblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ2h1bmsoeDogT3V0cHV0Q2h1bmsgfCBPdXRwdXRBc3NldCk6IHggaXMgT3V0cHV0Q2h1bmsge1xuICByZXR1cm4geCAmJiB4LnR5cGUgPT09ICdjaHVuaydcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRXJyb3JMaWtlKHg6IHVua25vd24pOiB4IGlzIEVycm9yIHtcbiAgcmV0dXJuIHR5cGVvZiB4ID09PSAnb2JqZWN0JyAmJiB4ICE9PSBudWxsICYmICdtZXNzYWdlJyBpbiB4XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc091dHB1dE9wdGlvbnMoeDogYW55KTogeCBpcyBPdXRwdXRPcHRpb25zIHtcbiAgcmV0dXJuIChcbiAgICB0eXBlb2YgeCA9PT0gJ29iamVjdCcgJiZcbiAgICAhQXJyYXkuaXNBcnJheSh4KSAmJlxuICAgIHR5cGVvZiB4LmZvcm1hdCA9PT0gJ3N0cmluZycgJiZcbiAgICBbJ2lpZmUnLCAnZXMnXS5pbmNsdWRlcyh4LmZvcm1hdClcbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNBc3NldCh4OiBPdXRwdXRDaHVuayB8IE91dHB1dEFzc2V0KTogeCBpcyBPdXRwdXRBc3NldCB7XG4gIHJldHVybiB4LnR5cGUgPT09ICdhc3NldCdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzU3RyaW5nKHg6IGFueSk6IHggaXMgc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiB4ID09PSAnc3RyaW5nJ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNVbmRlZmluZWQoeDogdW5rbm93bik6IHggaXMgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHR5cGVvZiB4ID09PSAndW5kZWZpbmVkJ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNOdWxsKHg6IHVua25vd24pOiB4IGlzIG51bGwge1xuICByZXR1cm4geCA9PT0gbnVsbFxufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNQcmVzZW50PFQ+KHg6IG51bGwgfCB1bmRlZmluZWQgfCBUKTogeCBpcyBUIHtcbiAgcmV0dXJuICFpc1VuZGVmaW5lZCh4KSAmJiAhaXNOdWxsKHgpXG59XG5cbmV4cG9ydCBjb25zdCBub3JtYWxpemVGaWxlbmFtZSA9IChwOiBzdHJpbmcpID0+IHAucmVwbGFjZSgvXFwuW3RqXXN4PyQvLCAnLmpzJylcblxuLyoqIFVwZGF0ZSB0aGUgbWFuaWZlc3Qgc291cmNlIGluIHRoZSBvdXRwdXQgYnVuZGxlICovXG5leHBvcnQgY29uc3QgdXBkYXRlTWFuaWZlc3QgPSA8VCBleHRlbmRzIGNocm9tZS5ydW50aW1lLk1hbmlmZXN0PihcbiAgdXBkYXRlcjogKG1hbmlmZXN0OiBUKSA9PiBULFxuICBidW5kbGU6IE91dHB1dEJ1bmRsZSxcbiAgaGFuZGxlRXJyb3I/OiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogT3V0cHV0QnVuZGxlID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBtYW5pZmVzdEtleSA9ICdtYW5pZmVzdC5qc29uJ1xuICAgIGNvbnN0IG1hbmlmZXN0QXNzZXQgPSBidW5kbGVbbWFuaWZlc3RLZXldIGFzIE91dHB1dEFzc2V0XG5cbiAgICBpZiAoIW1hbmlmZXN0QXNzZXQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTm8gbWFuaWZlc3QuanNvbiBpbiB0aGUgcm9sbHVwIG91dHB1dCBidW5kbGUuJylcbiAgICB9XG5cbiAgICBjb25zdCBtYW5pZmVzdCA9IEpTT04ucGFyc2UobWFuaWZlc3RBc3NldC5zb3VyY2UgYXMgc3RyaW5nKSBhcyBUXG5cbiAgICBjb25zdCByZXN1bHQgPSB1cGRhdGVyKG1hbmlmZXN0KVxuXG4gICAgbWFuaWZlc3RBc3NldC5zb3VyY2UgPSBKU09OLnN0cmluZ2lmeShyZXN1bHQsIHVuZGVmaW5lZCwgMilcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoaGFuZGxlRXJyb3IgJiYgZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgICAgaGFuZGxlRXJyb3IoZXJyb3IubWVzc2FnZSlcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgZXJyb3JcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYnVuZGxlXG59XG4iLCJpbXBvcnQgeyByZWxhdGl2ZSB9IGZyb20gJ3BhdGgnXG5cbnR5cGUgSW5wdXRSZWNvcmQgPSBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+XG5cbmV4cG9ydCBmdW5jdGlvbiByZWR1Y2VUb1JlY29yZChzcmNEaXI6IHN0cmluZyB8IG51bGwpIHtcbiAgaWYgKHNyY0RpciA9PT0gbnVsbCB8fCB0eXBlb2Ygc3JjRGlyID09PSAndW5kZWZpbmVkJykge1xuICAgIC8vIFRoaXMgd291bGQgYmUgYSBjb25maWcgZXJyb3IsIHNvIHNob3VsZCB0aHJvd1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ3NyY0RpciBpcyBudWxsIG9yIHVuZGVmaW5lZCcpXG4gIH1cblxuICByZXR1cm4gKGlucHV0UmVjb3JkOiBJbnB1dFJlY29yZCwgZmlsZW5hbWU6IHN0cmluZyk6IElucHV0UmVjb3JkID0+IHtcbiAgICBjb25zdCBuYW1lID0gcmVsYXRpdmUoc3JjRGlyLCBmaWxlbmFtZSkuc3BsaXQoJy4nKS5zbGljZSgwLCAtMSkuam9pbignLicpXG5cbiAgICBpZiAobmFtZSBpbiBpbnB1dFJlY29yZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgU2NyaXB0IGZpbGVzIHdpdGggZGlmZmVyZW50IGV4dGVuc2lvbnMgc2hvdWxkIG5vdCBzaGFyZSBuYW1lczpcXG5cXG5cIiR7ZmlsZW5hbWV9XCJcXG53aWxsIG92ZXJ3cml0ZVxcblwiJHtpbnB1dFJlY29yZFtuYW1lXX1cImAsXG4gICAgICApXG4gICAgfVxuXG4gICAgcmV0dXJuIHsgLi4uaW5wdXRSZWNvcmQsIFtuYW1lXTogZmlsZW5hbWUgfVxuICB9XG59XG4iLCJpbXBvcnQgY2hlZXJpbyBmcm9tICdjaGVlcmlvJ1xuaW1wb3J0IGZzIGZyb20gJ2ZzLWV4dHJhJ1xuaW1wb3J0IHBhdGggZnJvbSAncGF0aCdcblxuaW1wb3J0IHsgaXNTdHJpbmcgfSBmcm9tICcuLi9oZWxwZXJzJ1xuaW1wb3J0IHsgSHRtbElucHV0c09wdGlvbnMgfSBmcm9tICcuLi9wbHVnaW4tb3B0aW9ucydcblxuZXhwb3J0IHR5cGUgSHRtbEZpbGVQYXRoRGF0YSA9IHtcbiAgZmlsZVBhdGg6IHN0cmluZ1xuICByb290UGF0aDogc3RyaW5nXG59XG5cbi8qKiBDaGVlcmlvLlJvb3Qgb2JqZWN0cyB3aXRoIGEgZmlsZSBwYXRoICovXG5leHBvcnQgdHlwZSBDaGVlcmlvRmlsZSA9IGNoZWVyaW8uUm9vdCAmIEh0bWxGaWxlUGF0aERhdGFcblxuZXhwb3J0IGNvbnN0IGxvYWRIdG1sID1cbiAgKHJvb3RQYXRoOiBzdHJpbmcpID0+XG4gIChmaWxlUGF0aDogc3RyaW5nKTogQ2hlZXJpb0ZpbGUgPT4ge1xuICAgIGNvbnN0IGh0bWxDb2RlID0gZnMucmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmOCcpXG4gICAgY29uc3QgJCA9IGNoZWVyaW8ubG9hZChodG1sQ29kZSlcblxuICAgIHJldHVybiBPYmplY3QuYXNzaWduKCQsIHsgZmlsZVBhdGgsIHJvb3RQYXRoIH0pXG4gIH1cblxuZXhwb3J0IGNvbnN0IGdldFJlbGF0aXZlUGF0aCA9XG4gICh7IGZpbGVQYXRoLCByb290UGF0aCB9OiBIdG1sRmlsZVBhdGhEYXRhKSA9PlxuICAocDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgaHRtbEZpbGVEaXIgPSBwYXRoLmRpcm5hbWUoZmlsZVBhdGgpXG5cbiAgICBsZXQgcmVsRGlyOiBzdHJpbmdcbiAgICBpZiAocC5zdGFydHNXaXRoKCcvJykpIHtcbiAgICAgIHJlbERpciA9IHBhdGgucmVsYXRpdmUocHJvY2Vzcy5jd2QoKSwgcm9vdFBhdGgpXG4gICAgfSBlbHNlIHtcbiAgICAgIHJlbERpciA9IHBhdGgucmVsYXRpdmUocHJvY2Vzcy5jd2QoKSwgaHRtbEZpbGVEaXIpXG4gICAgfVxuXG4gICAgcmV0dXJuIHBhdGguam9pbihyZWxEaXIsIHApXG4gIH1cblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0gU0NSSVBUUyAtLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5leHBvcnQgY29uc3QgZ2V0U2NyaXB0RWxlbXMgPSAoJDogY2hlZXJpby5Sb290KSA9PlxuICAkKCdzY3JpcHQnKVxuICAgIC5ub3QoJ1tkYXRhLXJvbGx1cC1hc3NldF0nKVxuICAgIC5ub3QoJ1tzcmNePVwiaHR0cDpcIl0nKVxuICAgIC5ub3QoJ1tzcmNePVwiaHR0cHM6XCJdJylcbiAgICAubm90KCdbc3JjXj1cImRhdGE6XCJdJylcbiAgICAubm90KCdbc3JjXj1cIi9cIl0nKVxuXG4vLyBNdXRhdGl2ZSBhY3Rpb25cbmV4cG9ydCBjb25zdCBtdXRhdGVTY3JpcHRFbGVtcyA9XG4gICh7IGJyb3dzZXJQb2x5ZmlsbCB9OiBQaWNrPEh0bWxJbnB1dHNPcHRpb25zLCAnYnJvd3NlclBvbHlmaWxsJz4pID0+XG4gICgkOiBDaGVlcmlvRmlsZSkgPT4ge1xuICAgIGdldFNjcmlwdEVsZW1zKCQpXG4gICAgICAuYXR0cigndHlwZScsICdtb2R1bGUnKVxuICAgICAgLmF0dHIoJ3NyYycsIChpLCB2YWx1ZSkgPT4ge1xuICAgICAgICAvLyBGSVhNRTogQHR5cGVzL2NoZWVyaW8gaXMgd3JvbmcgZm9yIEF0dHJGdW5jdGlvbjogaW5kZXguZC50cywgbGluZSAxNlxuICAgICAgICAvLyBkZWNsYXJlIHR5cGUgQXR0ckZ1bmN0aW9uID0gKGk6IG51bWJlciwgY3VycmVudFZhbHVlOiBzdHJpbmcpID0+IGFueTtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lXG4gICAgICAgIC8vIEB0cy1pZ25vcmVcbiAgICAgICAgY29uc3QgcmVwbGFjZWQgPSB2YWx1ZS5yZXBsYWNlKC9cXC5banRdc3g/L2csICcuanMnKVxuXG4gICAgICAgIHJldHVybiByZXBsYWNlZFxuICAgICAgfSlcblxuICAgIGlmIChicm93c2VyUG9seWZpbGwpIHtcbiAgICAgIGNvbnN0IGhlYWQgPSAkKCdoZWFkJylcbiAgICAgIGlmIChcbiAgICAgICAgYnJvd3NlclBvbHlmaWxsID09PSB0cnVlIHx8XG4gICAgICAgICh0eXBlb2YgYnJvd3NlclBvbHlmaWxsID09PSAnb2JqZWN0JyAmJiBicm93c2VyUG9seWZpbGwuZXhlY3V0ZVNjcmlwdClcbiAgICAgICkge1xuICAgICAgICBoZWFkLnByZXBlbmQoXG4gICAgICAgICAgJzxzY3JpcHQgc3JjPVwiL2Fzc2V0cy9icm93c2VyLXBvbHlmaWxsLWV4ZWN1dGVTY3JpcHQuanNcIj48L3NjcmlwdD4nLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIGhlYWQucHJlcGVuZCgnPHNjcmlwdCBzcmM9XCIvYXNzZXRzL2Jyb3dzZXItcG9seWZpbGwuanNcIj48L3NjcmlwdD4nKVxuICAgIH1cblxuICAgIHJldHVybiAkXG4gIH1cblxuZXhwb3J0IGNvbnN0IGdldFNjcmlwdHMgPSAoJDogY2hlZXJpby5Sb290KSA9PiBnZXRTY3JpcHRFbGVtcygkKS50b0FycmF5KClcblxuZXhwb3J0IGNvbnN0IGdldFNjcmlwdFNyYyA9ICgkOiBDaGVlcmlvRmlsZSkgPT5cbiAgZ2V0U2NyaXB0cygkKVxuICAgIC5tYXAoKGVsZW0pID0+ICQoZWxlbSkuYXR0cignc3JjJykpXG4gICAgLmZpbHRlcihpc1N0cmluZylcbiAgICAubWFwKGdldFJlbGF0aXZlUGF0aCgkKSlcblxuLyogLS0tLS0tLS0tLS0tLS0tLS0gQVNTRVQgU0NSSVBUUyAtLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5jb25zdCBnZXRBc3NldHMgPSAoJDogY2hlZXJpby5Sb290KSA9PlxuICAkKCdzY3JpcHQnKVxuICAgIC5maWx0ZXIoJ1tkYXRhLXJvbGx1cC1hc3NldD1cInRydWVcIl0nKVxuICAgIC5ub3QoJ1tzcmNePVwiaHR0cDpcIl0nKVxuICAgIC5ub3QoJ1tzcmNePVwiaHR0cHM6XCJdJylcbiAgICAubm90KCdbc3JjXj1cImRhdGE6XCJdJylcbiAgICAubm90KCdbc3JjXj1cIi9cIl0nKVxuICAgIC50b0FycmF5KClcblxuZXhwb3J0IGNvbnN0IGdldEpzQXNzZXRzID0gKCQ6IENoZWVyaW9GaWxlKSA9PlxuICBnZXRBc3NldHMoJClcbiAgICAubWFwKChlbGVtKSA9PiAkKGVsZW0pLmF0dHIoJ3NyYycpKVxuICAgIC5maWx0ZXIoaXNTdHJpbmcpXG4gICAgLm1hcChnZXRSZWxhdGl2ZVBhdGgoJCkpXG5cbi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tIGNzcyAtLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbmNvbnN0IGdldENzcyA9ICgkOiBjaGVlcmlvLlJvb3QpID0+XG4gICQoJ2xpbmsnKVxuICAgIC5maWx0ZXIoJ1tyZWw9XCJzdHlsZXNoZWV0XCJdJylcbiAgICAubm90KCdbaHJlZl49XCJodHRwOlwiXScpXG4gICAgLm5vdCgnW2hyZWZePVwiaHR0cHM6XCJdJylcbiAgICAubm90KCdbaHJlZl49XCJkYXRhOlwiXScpXG4gICAgLm5vdCgnW2hyZWZePVwiL1wiXScpXG4gICAgLnRvQXJyYXkoKVxuXG5leHBvcnQgY29uc3QgZ2V0Q3NzSHJlZnMgPSAoJDogQ2hlZXJpb0ZpbGUpID0+XG4gIGdldENzcygkKVxuICAgIC5tYXAoKGVsZW0pID0+ICQoZWxlbSkuYXR0cignaHJlZicpKVxuICAgIC5maWx0ZXIoaXNTdHJpbmcpXG4gICAgLm1hcChnZXRSZWxhdGl2ZVBhdGgoJCkpXG5cbi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0tIGltZyAtLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbmNvbnN0IGdldEltZ3MgPSAoJDogY2hlZXJpby5Sb290KSA9PlxuICAkKCdpbWcnKVxuICAgIC5ub3QoJ1tzcmNePVwiaHR0cDovL1wiXScpXG4gICAgLm5vdCgnW3NyY149XCJodHRwczovL1wiXScpXG4gICAgLm5vdCgnW3NyY149XCJkYXRhOlwiXScpXG4gICAgLnRvQXJyYXkoKVxuXG5jb25zdCBnZXRGYXZpY29ucyA9ICgkOiBjaGVlcmlvLlJvb3QpID0+XG4gICQoJ2xpbmtbcmVsPVwiaWNvblwiXScpXG4gICAgLm5vdCgnW2hyZWZePVwiaHR0cDpcIl0nKVxuICAgIC5ub3QoJ1tocmVmXj1cImh0dHBzOlwiXScpXG4gICAgLm5vdCgnW2hyZWZePVwiZGF0YTpcIl0nKVxuICAgIC50b0FycmF5KClcblxuZXhwb3J0IGNvbnN0IGdldEltZ1NyY3MgPSAoJDogQ2hlZXJpb0ZpbGUpID0+IHtcbiAgcmV0dXJuIFtcbiAgICAuLi5nZXRJbWdzKCQpLm1hcCgoZWxlbSkgPT4gJChlbGVtKS5hdHRyKCdzcmMnKSksXG4gICAgLi4uZ2V0RmF2aWNvbnMoJCkubWFwKChlbGVtKSA9PiAkKGVsZW0pLmF0dHIoJ2hyZWYnKSksXG4gIF1cbiAgICAuZmlsdGVyKGlzU3RyaW5nKVxuICAgIC5tYXAoZ2V0UmVsYXRpdmVQYXRoKCQpKVxufVxuIiwiaW1wb3J0ICdhcnJheS1mbGF0LXBvbHlmaWxsJ1xuXG5pbXBvcnQgeyByZWFkRmlsZSB9IGZyb20gJ2ZzLWV4dHJhJ1xuaW1wb3J0IHsgZmxhdHRlbiB9IGZyb20gJ2xvZGFzaCdcbmltcG9ydCB7IHJlbGF0aXZlIH0gZnJvbSAncGF0aCdcblxuaW1wb3J0IHsgbm90IH0gZnJvbSAnLi4vaGVscGVycydcbmltcG9ydCB7IHJlZHVjZVRvUmVjb3JkIH0gZnJvbSAnLi4vbWFuaWZlc3QtaW5wdXQvcmVkdWNlVG9SZWNvcmQnXG5pbXBvcnQge1xuICBIdG1sSW5wdXRzT3B0aW9ucyxcbiAgSHRtbElucHV0c1BsdWdpbkNhY2hlLFxuICBIdG1sSW5wdXRzUGx1Z2luLFxufSBmcm9tICcuLi9wbHVnaW4tb3B0aW9ucydcbmltcG9ydCB7XG4gIGdldENzc0hyZWZzLFxuICBnZXRJbWdTcmNzLFxuICBnZXRKc0Fzc2V0cyxcbiAgZ2V0U2NyaXB0U3JjLFxuICBsb2FkSHRtbCxcbiAgbXV0YXRlU2NyaXB0RWxlbXMsXG59IGZyb20gJy4vY2hlZXJpbydcblxuY29uc3QgaXNIdG1sID0gKHBhdGg6IHN0cmluZykgPT4gL1xcLmh0bWw/JC8udGVzdChwYXRoKVxuXG5jb25zdCBuYW1lID0gJ2h0bWwtaW5wdXRzJ1xuXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuLyogICAgICAgICAgICAgICAgICBIVE1MLUlOUFVUUyAgICAgICAgICAgICAgICAgKi9cbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIGh0bWxJbnB1dHMoXG4gIGh0bWxJbnB1dHNPcHRpb25zOiBIdG1sSW5wdXRzT3B0aW9ucyxcbiAgLyoqIFVzZWQgZm9yIHRlc3RpbmcgKi9cbiAgY2FjaGUgPSB7XG4gICAgc2NyaXB0czogW10sXG4gICAgaHRtbDogW10sXG4gICAgaHRtbCQ6IFtdLFxuICAgIGpzOiBbXSxcbiAgICBjc3M6IFtdLFxuICAgIGltZzogW10sXG4gICAgaW5wdXQ6IFtdLFxuICB9IGFzIEh0bWxJbnB1dHNQbHVnaW5DYWNoZSxcbik6IEh0bWxJbnB1dHNQbHVnaW4ge1xuICByZXR1cm4ge1xuICAgIG5hbWUsXG4gICAgY2FjaGUsXG5cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuICAgIC8qICAgICAgICAgICAgICAgICBPUFRJT05TIEhPT0sgICAgICAgICAgICAgICAgICovXG4gICAgLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuICAgIG9wdGlvbnMob3B0aW9ucykge1xuICAgICAgLy8gc3JjRGlyIG1heSBiZSBpbml0aWFsaXplZCBieSBhbm90aGVyIHBsdWdpblxuICAgICAgY29uc3QgeyBzcmNEaXIgfSA9IGh0bWxJbnB1dHNPcHRpb25zXG5cbiAgICAgIGlmIChzcmNEaXIpIHtcbiAgICAgICAgY2FjaGUuc3JjRGlyID0gc3JjRGlyXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zLnNyY0RpciBub3QgaW5pdGlhbGl6ZWQnKVxuICAgICAgfVxuXG4gICAgICAvLyBTa2lwIGlmIGNhY2hlLmlucHV0IGV4aXN0c1xuICAgICAgLy8gY2FjaGUgaXMgZHVtcGVkIGluIHdhdGNoQ2hhbmdlIGhvb2tcblxuICAgICAgLy8gUGFyc2Ugb3B0aW9ucy5pbnB1dCB0byBhcnJheVxuICAgICAgbGV0IGlucHV0OiBzdHJpbmdbXVxuICAgICAgaWYgKHR5cGVvZiBvcHRpb25zLmlucHV0ID09PSAnc3RyaW5nJykge1xuICAgICAgICBpbnB1dCA9IFtvcHRpb25zLmlucHV0XVxuICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMuaW5wdXQpKSB7XG4gICAgICAgIGlucHV0ID0gWy4uLm9wdGlvbnMuaW5wdXRdXG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zLmlucHV0ID09PSAnb2JqZWN0Jykge1xuICAgICAgICBpbnB1dCA9IE9iamVjdC52YWx1ZXMob3B0aW9ucy5pbnB1dClcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYG9wdGlvbnMuaW5wdXQgY2Fubm90IGJlICR7dHlwZW9mIG9wdGlvbnMuaW5wdXR9YClcbiAgICAgIH1cblxuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuICAgICAgLyogICAgICAgICAgICAgICAgIEhBTkRMRSBIVE1MIEZJTEVTICAgICAgICAgICAgICAgICAqL1xuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICAvLyBGaWx0ZXIgaHRtIGFuZCBodG1sIGZpbGVzXG4gICAgICBjYWNoZS5odG1sID0gaW5wdXQuZmlsdGVyKGlzSHRtbClcblxuICAgICAgLy8gSWYgbm8gaHRtbCBmaWxlcywgZG8gbm90aGluZ1xuICAgICAgaWYgKGNhY2hlLmh0bWwubGVuZ3RoID09PSAwKSByZXR1cm4gb3B0aW9uc1xuXG4gICAgICAvLyBJZiB0aGUgY2FjaGUgaGFzIGJlZW4gZHVtcGVkLCByZWxvYWQgZnJvbSBmaWxlc1xuICAgICAgaWYgKGNhY2hlLmh0bWwkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBUaGlzIGlzIGFsbCBkb25lIG9uY2VcbiAgICAgICAgY2FjaGUuaHRtbCQgPSBjYWNoZS5odG1sLm1hcChsb2FkSHRtbChzcmNEaXIpKVxuXG4gICAgICAgIGNhY2hlLmpzID0gZmxhdHRlbihjYWNoZS5odG1sJC5tYXAoZ2V0U2NyaXB0U3JjKSlcbiAgICAgICAgY2FjaGUuY3NzID0gZmxhdHRlbihjYWNoZS5odG1sJC5tYXAoZ2V0Q3NzSHJlZnMpKVxuICAgICAgICBjYWNoZS5pbWcgPSBmbGF0dGVuKGNhY2hlLmh0bWwkLm1hcChnZXRJbWdTcmNzKSlcbiAgICAgICAgY2FjaGUuc2NyaXB0cyA9IGZsYXR0ZW4oY2FjaGUuaHRtbCQubWFwKGdldEpzQXNzZXRzKSlcblxuICAgICAgICAvLyBDYWNoZSBqc0VudHJpZXMgd2l0aCBleGlzdGluZyBvcHRpb25zLmlucHV0XG4gICAgICAgIGNhY2hlLmlucHV0ID0gaW5wdXQuZmlsdGVyKG5vdChpc0h0bWwpKS5jb25jYXQoY2FjaGUuanMpXG5cbiAgICAgICAgLy8gUHJlcGFyZSBjYWNoZS5odG1sJCBmb3IgYXNzZXQgZW1pc3Npb25cbiAgICAgICAgY2FjaGUuaHRtbCQuZm9yRWFjaChtdXRhdGVTY3JpcHRFbGVtcyhodG1sSW5wdXRzT3B0aW9ucykpXG5cbiAgICAgICAgaWYgKGNhY2hlLmlucHV0Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICdBdCBsZWFzdCBvbmUgSFRNTCBmaWxlIG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgc2NyaXB0LicsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRPRE86IHNpbXBseSByZW1vdmUgSFRNTCBmaWxlcyBmcm9tIG9wdGlvbnMuaW5wdXRcbiAgICAgIC8vIC0gUGFyc2UgSFRNTCBhbmQgZW1pdCBjaHVua3MgYW5kIGFzc2V0cyBpbiBidWlsZFN0YXJ0XG4gICAgICByZXR1cm4ge1xuICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgICBpbnB1dDogY2FjaGUuaW5wdXQucmVkdWNlKHJlZHVjZVRvUmVjb3JkKGh0bWxJbnB1dHNPcHRpb25zLnNyY0RpciksIHt9KSxcbiAgICAgIH1cbiAgICB9LFxuXG4gICAgLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cbiAgICAvKiAgICAgICAgICAgICAgSEFORExFIEZJTEUgQ0hBTkdFUyAgICAgICAgICAgICAqL1xuICAgIC8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG5cbiAgICBhc3luYyBidWlsZFN0YXJ0KCkge1xuICAgICAgY29uc3QgeyBzcmNEaXIgfSA9IGh0bWxJbnB1dHNPcHRpb25zXG5cbiAgICAgIGlmIChzcmNEaXIpIHtcbiAgICAgICAgY2FjaGUuc3JjRGlyID0gc3JjRGlyXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdvcHRpb25zLnNyY0RpciBub3QgaW5pdGlhbGl6ZWQnKVxuICAgICAgfVxuXG4gICAgICBjb25zdCBhc3NldHMgPSBbLi4uY2FjaGUuY3NzLCAuLi5jYWNoZS5pbWcsIC4uLmNhY2hlLnNjcmlwdHNdXG5cbiAgICAgIGFzc2V0cy5jb25jYXQoY2FjaGUuaHRtbCkuZm9yRWFjaCgoYXNzZXQpID0+IHtcbiAgICAgICAgdGhpcy5hZGRXYXRjaEZpbGUoYXNzZXQpXG4gICAgICB9KVxuXG4gICAgICBjb25zdCBlbWl0dGluZyA9IGFzc2V0cy5tYXAoYXN5bmMgKGFzc2V0KSA9PiB7XG4gICAgICAgIC8vIFJlYWQgdGhlc2UgZmlsZXMgYXMgQnVmZmVyc1xuICAgICAgICBjb25zdCBzb3VyY2UgPSBhd2FpdCByZWFkRmlsZShhc3NldClcbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSByZWxhdGl2ZShzcmNEaXIsIGFzc2V0KVxuXG4gICAgICAgIHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgICAgc291cmNlLCAvLyBCdWZmZXJcbiAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIGNhY2hlLmh0bWwkLm1hcCgoJCkgPT4ge1xuICAgICAgICBjb25zdCBzb3VyY2UgPSAkLmh0bWwoKVxuICAgICAgICBjb25zdCBmaWxlTmFtZSA9IHJlbGF0aXZlKHNyY0RpciwgJC5maWxlUGF0aClcblxuICAgICAgICB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgICB0eXBlOiAnYXNzZXQnLFxuICAgICAgICAgIHNvdXJjZSwgLy8gU3RyaW5nXG4gICAgICAgICAgZmlsZU5hbWUsXG4gICAgICAgIH0pXG4gICAgICB9KVxuXG4gICAgICBhd2FpdCBQcm9taXNlLmFsbChlbWl0dGluZylcbiAgICB9LFxuXG4gICAgd2F0Y2hDaGFuZ2UoaWQpIHtcbiAgICAgIGlmIChpZC5lbmRzV2l0aCgnLmh0bWwnKSB8fCBpZC5lbmRzV2l0aCgnbWFuaWZlc3QuanNvbicpKSB7XG4gICAgICAgIC8vIER1bXAgY2FjaGUgaWYgaHRtbCBmaWxlIG9yIG1hbmlmZXN0IGNoYW5nZXNcbiAgICAgICAgY2FjaGUuaHRtbCQgPSBbXVxuICAgICAgfVxuICAgIH0sXG4gIH1cbn1cbiIsImltcG9ydCB7IGlzUHJlc2VudCwgVW5wYWNrZWQgfSBmcm9tICcuL2hlbHBlcnMnXG5cbmV4cG9ydCB0eXBlIE1hbmlmZXN0VjIgPSBPbWl0PFxuICBjaHJvbWUucnVudGltZS5NYW5pZmVzdFYyLFxuICAnbmFtZScgfCAnZGVzY3JpcHRpb24nIHwgJ3ZlcnNpb24nXG4+ICZcbiAgUGFydGlhbDxQaWNrPGNocm9tZS5ydW50aW1lLk1hbmlmZXN0VjIsICduYW1lJyB8ICdkZXNjcmlwdGlvbicgfCAndmVyc2lvbic+PlxuXG5leHBvcnQgdHlwZSBNYW5pZmVzdFYzID0gT21pdDxcbiAgY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RWMyxcbiAgJ25hbWUnIHwgJ2Rlc2NyaXB0aW9uJyB8ICd2ZXJzaW9uJ1xuPiAmXG4gIFBhcnRpYWw8UGljazxjaHJvbWUucnVudGltZS5NYW5pZmVzdFYzLCAnbmFtZScgfCAnZGVzY3JpcHRpb24nIHwgJ3ZlcnNpb24nPj5cblxuZXhwb3J0IHR5cGUgQ29udGVudFNjcmlwdCA9IFVucGFja2VkPGNocm9tZS5ydW50aW1lLk1hbmlmZXN0Wydjb250ZW50X3NjcmlwdHMnXT5cblxuZXhwb3J0IHR5cGUgV2ViQWNjZXNzaWJsZVJlc291cmNlID0gVW5wYWNrZWQ8XG4gIGNocm9tZS5ydW50aW1lLk1hbmlmZXN0VjNbJ3dlYl9hY2Nlc3NpYmxlX3Jlc291cmNlcyddXG4+XG5cbmV4cG9ydCBmdW5jdGlvbiBpc01WMihcbiAgbT86IGNocm9tZS5ydW50aW1lLk1hbmlmZXN0QmFzZSxcbik6IG0gaXMgY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RWMiB7XG4gIGlmICghaXNQcmVzZW50KG0pKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdtYW5pZmVzdCBpcyB1bmRlZmluZWQnKVxuICByZXR1cm4gbS5tYW5pZmVzdF92ZXJzaW9uID09PSAyXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc01WMyhcbiAgbT86IGNocm9tZS5ydW50aW1lLk1hbmlmZXN0QmFzZSxcbik6IG0gaXMgY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RWMyB7XG4gIGlmICghaXNQcmVzZW50KG0pKSB0aHJvdyBuZXcgVHlwZUVycm9yKCdtYW5pZmVzdCBpcyB1bmRlZmluZWQnKVxuICByZXR1cm4gbS5tYW5pZmVzdF92ZXJzaW9uID09PSAzXG59XG4iLCJleHBvcnQgY29uc3QgY2xvbmVPYmplY3QgPSA8VD4ob2JqOiBUKTogVCA9PiBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KG9iaikpXG4iLCJpbXBvcnQgeyBjb2RlIGFzIGV4cGxpY2l0U2NyaXB0IH0gZnJvbSAnY29kZSAuL2Jyb3dzZXIvaW1wb3J0V3JhcHBlci0tZXhwbGljaXQudHMnXG5pbXBvcnQgeyBjb2RlIGFzIGltcGxpY2l0U2NyaXB0IH0gZnJvbSAnY29kZSAuL2Jyb3dzZXIvaW1wb3J0V3JhcHBlci0taW1wbGljaXQudHMnXG5cbi8qKlxuICogVGhpcyBvcHRpb25zIG9iamVjdCBhbGxvd3MgZmluZS10dW5pbmcgb2YgdGhlIGR5bmFtaWMgaW1wb3J0IHdyYXBwZXIuXG4gKlxuICogQGV4cG9ydFxuICogQGludGVyZmFjZSBEeW5hbWljSW1wb3J0V3JhcHBlclxuICovXG5leHBvcnQgaW50ZXJmYWNlIER5bmFtaWNJbXBvcnRXcmFwcGVyT3B0aW9ucyB7XG4gIC8qKiBIb3cgbG9uZyB0byBkZWxheSB3YWtlIGV2ZW50cyBhZnRlciBkeW5hbWljIGltcG9ydCBoYXMgY29tcGxldGVkICovXG4gIGV2ZW50RGVsYXk/OiBudW1iZXJcbiAgLyoqIExpbWl0IHdoaWNoIHdha2UgZXZlbnRzIHRvIGNhcHR1cmUuIFVzZSBpZiB0aGUgZGVmYXVsdCBldmVudCBkaXNjb3ZlcnkgaXMgdG9vIHNsb3cuICovXG4gIHdha2VFdmVudHM/OiBzdHJpbmdbXVxuICAvKiogQVBJIG5hbWVzcGFjZXMgdG8gZXhjbHVkZSBmcm9tIGF1dG9tYXRpYyBkZXRlY3Rpb24gKi9cbiAgZXhjbHVkZU5hbWVzPzogc3RyaW5nW11cbn1cblxuLy8gRkVBVFVSRTogYWRkIHN0YXRpYyBjb2RlIGFuYWx5c2lzIGZvciB3YWtlIGV2ZW50c1xuLy8gIC0gVGhpcyB3aWxsIGJlIHNsb3dlci4uLlxuZXhwb3J0IGZ1bmN0aW9uIHByZXBJbXBvcnRXcmFwcGVyU2NyaXB0KHtcbiAgZXZlbnREZWxheSA9IDAsXG4gIHdha2VFdmVudHMgPSBbXSxcbiAgZXhjbHVkZU5hbWVzID0gWydleHRlbnNpb24nXSxcbn06IER5bmFtaWNJbXBvcnRXcmFwcGVyT3B0aW9ucykge1xuICBjb25zdCBkZWxheSA9IEpTT04uc3RyaW5naWZ5KGV2ZW50RGVsYXkpXG4gIGNvbnN0IGV2ZW50cyA9IHdha2VFdmVudHMubGVuZ3RoXG4gICAgPyBKU09OLnN0cmluZ2lmeSh3YWtlRXZlbnRzLm1hcCgoZXYpID0+IGV2LnJlcGxhY2UoL15jaHJvbWVcXC4vLCAnJykpKVxuICAgIDogZmFsc2VcbiAgY29uc3QgZXhjbHVkZSA9IEpTT04uc3RyaW5naWZ5KGV4Y2x1ZGVOYW1lcylcblxuICBjb25zdCBzY3JpcHQgPSAoXG4gICAgZXZlbnRzXG4gICAgICA/IGV4cGxpY2l0U2NyaXB0LnJlcGxhY2UoJyVFVkVOVFMlJywgZXZlbnRzKVxuICAgICAgOiBpbXBsaWNpdFNjcmlwdC5yZXBsYWNlKCclRVhDTFVERSUnLCBleGNsdWRlKVxuICApLnJlcGxhY2UoJyVERUxBWSUnLCBkZWxheSlcblxuICByZXR1cm4gc2NyaXB0XG59XG4iLCJpbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSAnZnMnXG5pbXBvcnQgeyBiYXNlbmFtZSB9IGZyb20gJ3BhdGgnXG5pbXBvcnQgeyBJbnB1dE9wdGlvbnMgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyBpc1N0cmluZywgaXNVbmRlZmluZWQgfSBmcm9tICcuLi9oZWxwZXJzJ1xuaW1wb3J0IHsgTWFuaWZlc3RJbnB1dFBsdWdpbkNhY2hlIH0gZnJvbSAnLi4vcGx1Z2luLW9wdGlvbnMnXG5pbXBvcnQgeyBjbG9uZU9iamVjdCB9IGZyb20gJy4vY2xvbmVPYmplY3QnXG5cbmNvbnN0IGlzTWFuaWZlc3RGaWxlTmFtZSA9IChmaWxlbmFtZTogc3RyaW5nKSA9PlxuICBiYXNlbmFtZShmaWxlbmFtZSkuc3RhcnRzV2l0aCgnbWFuaWZlc3QnKVxuXG5jb25zdCB2YWxpZGF0ZUZpbGVOYW1lID0gKGZpbGVuYW1lOiBzdHJpbmcsIHsgaW5wdXQgfTogSW5wdXRPcHRpb25zKSA9PiB7XG4gIGlmIChpc1VuZGVmaW5lZChmaWxlbmFtZSkpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENvdWxkIG5vdCBmaW5kIG1hbmlmZXN0IGluIFJvbGx1cCBvcHRpb25zLmlucHV0OiAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICBpbnB1dCxcbiAgICAgICl9YCxcbiAgICApXG4gIGlmICghZXhpc3RzU3luYyhmaWxlbmFtZSkpXG4gICAgdGhyb3cgbmV3IEVycm9yKGBDb3VsZCBub3QgbG9hZCBtYW5pZmVzdDogJHtmaWxlbmFtZX0gZG9lcyBub3QgZXhpc3RgKVxuXG4gIHJldHVybiBmaWxlbmFtZVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0SW5wdXRNYW5pZmVzdFBhdGgob3B0aW9uczogSW5wdXRPcHRpb25zKTogUGFydGlhbDxcbiAgUGljazxNYW5pZmVzdElucHV0UGx1Z2luQ2FjaGUsICdpbnB1dEFyeScgfCAnaW5wdXRPYmonPlxuPiAmIHtcbiAgaW5wdXRNYW5pZmVzdFBhdGg6IHN0cmluZ1xufSB7XG4gIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMuaW5wdXQpKSB7XG4gICAgY29uc3QgbWFuaWZlc3RJbmRleCA9IG9wdGlvbnMuaW5wdXQuZmluZEluZGV4KGlzTWFuaWZlc3RGaWxlTmFtZSlcbiAgICBjb25zdCBpbnB1dEFyeSA9IFtcbiAgICAgIC4uLm9wdGlvbnMuaW5wdXQuc2xpY2UoMCwgbWFuaWZlc3RJbmRleCksXG4gICAgICAuLi5vcHRpb25zLmlucHV0LnNsaWNlKG1hbmlmZXN0SW5kZXggKyAxKSxcbiAgICBdXG4gICAgY29uc3QgaW5wdXRNYW5pZmVzdFBhdGggPSB2YWxpZGF0ZUZpbGVOYW1lKFxuICAgICAgb3B0aW9ucy5pbnB1dFttYW5pZmVzdEluZGV4XSxcbiAgICAgIG9wdGlvbnMsXG4gICAgKVxuXG4gICAgcmV0dXJuIHsgaW5wdXRNYW5pZmVzdFBhdGgsIGlucHV0QXJ5IH1cbiAgfSBlbHNlIGlmICh0eXBlb2Ygb3B0aW9ucy5pbnB1dCA9PT0gJ29iamVjdCcpIHtcbiAgICBjb25zdCBpbnB1dE1hbmlmZXN0UGF0aCA9IHZhbGlkYXRlRmlsZU5hbWUob3B0aW9ucy5pbnB1dC5tYW5pZmVzdCwgb3B0aW9ucylcbiAgICBjb25zdCBpbnB1dE9iaiA9IGNsb25lT2JqZWN0KG9wdGlvbnMuaW5wdXQpXG4gICAgZGVsZXRlIGlucHV0T2JqWydtYW5pZmVzdCddXG5cbiAgICByZXR1cm4geyBpbnB1dE1hbmlmZXN0UGF0aCwgaW5wdXRPYmogfVxuICB9IGVsc2UgaWYgKGlzU3RyaW5nKG9wdGlvbnMuaW5wdXQpKSB7XG4gICAgY29uc3QgaW5wdXRNYW5pZmVzdFBhdGggPSB2YWxpZGF0ZUZpbGVOYW1lKG9wdGlvbnMuaW5wdXQsIG9wdGlvbnMpXG4gICAgcmV0dXJuIHsgaW5wdXRNYW5pZmVzdFBhdGggfVxuICB9XG5cbiAgdGhyb3cgbmV3IFR5cGVFcnJvcihcbiAgICBgUm9sbHVwIG9wdGlvbnMuaW5wdXQgY2Fubm90IGJlIHR5cGUgXCIke3R5cGVvZiBvcHRpb25zLmlucHV0fVwiYCxcbiAgKVxufVxuIiwiaW1wb3J0ICdhcnJheS1mbGF0LXBvbHlmaWxsJ1xuXG5leHBvcnQgY29uc3QgY29tYmluZVBlcm1zID0gKFxuICAuLi5wZXJtaXNzaW9uczogc3RyaW5nW10gfCBzdHJpbmdbXVtdXG4pOiBzdHJpbmdbXSA9PiB7XG4gIGNvbnN0IHsgcGVybXMsIHhwZXJtcyB9ID0gKHBlcm1pc3Npb25zLmZsYXQoSW5maW5pdHkpIGFzIHN0cmluZ1tdKVxuICAgIC5maWx0ZXIoKHBlcm0pID0+IHR5cGVvZiBwZXJtICE9PSAndW5kZWZpbmVkJylcbiAgICAucmVkdWNlKFxuICAgICAgKHsgcGVybXMsIHhwZXJtcyB9LCBwZXJtKSA9PiB7XG4gICAgICAgIGlmIChwZXJtLnN0YXJ0c1dpdGgoJyEnKSkge1xuICAgICAgICAgIHhwZXJtcy5hZGQocGVybS5zbGljZSgxKSlcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBwZXJtcy5hZGQocGVybSlcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHBlcm1zLCB4cGVybXMgfVxuICAgICAgfSxcbiAgICAgIHsgcGVybXM6IG5ldyBTZXQ8c3RyaW5nPigpLCB4cGVybXM6IG5ldyBTZXQ8c3RyaW5nPigpIH0sXG4gICAgKVxuXG4gIHJldHVybiBbLi4ucGVybXNdLmZpbHRlcigocCkgPT4gIXhwZXJtcy5oYXMocCkpXG59XG4iLCIvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuLyogICAgICAgICAgICAgICBDSEVDSyBQRVJNSVNTSU9OUyAgICAgICAgICAgICAgKi9cbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG5cbi8vIGV4cG9ydCBjb25zdCBkZWJ1Z2dlciA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpkZWJ1Z2dlci8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IGVudGVycHJpc2UuZGV2aWNlQXR0cmlidXRlcyA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSplbnRlcnByaXNlXFwuZGV2aWNlQXR0cmlidXRlcy8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IGVudGVycHJpc2UuaGFyZHdhcmVQbGF0Zm9ybSA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSplbnRlcnByaXNlXFwuaGFyZHdhcmVQbGF0Zm9ybS8udGVzdChzKVxuLy8gZXhwb3J0IGNvbnN0IGVudGVycHJpc2UucGxhdGZvcm1LZXlzID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmVudGVycHJpc2VcXC5wbGF0Zm9ybUtleXMvLnRlc3Qocylcbi8vIGV4cG9ydCBjb25zdCBuZXR3b3JraW5nLmNvbmZpZyA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpuZXR3b3JraW5nXFwuY29uZmlnLy50ZXN0KHMpXG4vLyBleHBvcnQgY29uc3Qgc3lzdGVtLmNwdSA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzeXN0ZW1cXC5jcHUvLnRlc3Qocylcbi8vIGV4cG9ydCBjb25zdCBzeXN0ZW0uZGlzcGxheSA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzeXN0ZW1cXC5kaXNwbGF5Ly50ZXN0KHMpXG4vLyBleHBvcnQgY29uc3Qgc3lzdGVtLm1lbW9yeSA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzeXN0ZW1cXC5tZW1vcnkvLnRlc3Qocylcbi8vIGV4cG9ydCBjb25zdCBzeXN0ZW0uc3RvcmFnZSA9IHMgPT4gLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzeXN0ZW1cXC5zdG9yYWdlLy50ZXN0KHMpXG5cbmV4cG9ydCBjb25zdCBhbGFybXMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmFsYXJtcy8udGVzdChzKVxuXG5leHBvcnQgY29uc3QgYm9va21hcmtzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpib29rbWFya3MvLnRlc3QocylcblxuZXhwb3J0IGNvbnN0IGNvbnRlbnRTZXR0aW5ncyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qY29udGVudFNldHRpbmdzLy50ZXN0KHMpXG5cbmV4cG9ydCBjb25zdCBjb250ZXh0TWVudXMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmNvbnRleHRNZW51cy8udGVzdChzKVxuXG5leHBvcnQgY29uc3QgY29va2llcyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qY29va2llcy8udGVzdChzKVxuXG5leHBvcnQgY29uc3QgZGVjbGFyYXRpdmVDb250ZW50ID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpkZWNsYXJhdGl2ZUNvbnRlbnQvLnRlc3QocylcbmV4cG9ydCBjb25zdCBkZWNsYXJhdGl2ZU5ldFJlcXVlc3QgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmRlY2xhcmF0aXZlTmV0UmVxdWVzdC8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGRlY2xhcmF0aXZlV2ViUmVxdWVzdCA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZGVjbGFyYXRpdmVXZWJSZXF1ZXN0Ly50ZXN0KHMpXG5leHBvcnQgY29uc3QgZGVza3RvcENhcHR1cmUgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmRlc2t0b3BDYXB0dXJlLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZGlzcGxheVNvdXJjZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZGlzcGxheVNvdXJjZS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGRucyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZG5zLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZG9jdW1lbnRTY2FuID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpkb2N1bWVudFNjYW4vLnRlc3QocylcbmV4cG9ydCBjb25zdCBkb3dubG9hZHMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmRvd25sb2Fkcy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGV4cGVyaW1lbnRhbCA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZXhwZXJpbWVudGFsLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZmlsZUJyb3dzZXJIYW5kbGVyID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpmaWxlQnJvd3NlckhhbmRsZXIvLnRlc3QocylcbmV4cG9ydCBjb25zdCBmaWxlU3lzdGVtUHJvdmlkZXIgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmZpbGVTeXN0ZW1Qcm92aWRlci8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGZvbnRTZXR0aW5ncyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZm9udFNldHRpbmdzLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgZ2NtID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpnY20vLnRlc3QocylcbmV4cG9ydCBjb25zdCBnZW9sb2NhdGlvbiA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qZ2VvbG9jYXRpb24vLnRlc3QocylcbmV4cG9ydCBjb25zdCBoaXN0b3J5ID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpoaXN0b3J5Ly50ZXN0KHMpXG5leHBvcnQgY29uc3QgaWRlbnRpdHkgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmlkZW50aXR5Ly50ZXN0KHMpXG5leHBvcnQgY29uc3QgaWRsZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qaWRsZS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IGlkbHRlc3QgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKmlkbHRlc3QvLnRlc3QocylcbmV4cG9ydCBjb25zdCBtYW5hZ2VtZW50ID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSptYW5hZ2VtZW50Ly50ZXN0KHMpXG5leHBvcnQgY29uc3QgbmF0aXZlTWVzc2FnaW5nID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpuYXRpdmVNZXNzYWdpbmcvLnRlc3QocylcbmV4cG9ydCBjb25zdCBub3RpZmljYXRpb25zID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpub3RpZmljYXRpb25zLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgcGFnZUNhcHR1cmUgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnBhZ2VDYXB0dXJlLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgcGxhdGZvcm1LZXlzID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpwbGF0Zm9ybUtleXMvLnRlc3QocylcbmV4cG9ydCBjb25zdCBwb3dlciA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qcG93ZXIvLnRlc3QocylcbmV4cG9ydCBjb25zdCBwcmludGVyUHJvdmlkZXIgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnByaW50ZXJQcm92aWRlci8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHByaXZhY3kgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnByaXZhY3kvLnRlc3QocylcbmV4cG9ydCBjb25zdCBwcm9jZXNzZXMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnByb2Nlc3Nlcy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHByb3h5ID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpwcm94eS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHNlc3Npb25zID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSpzZXNzaW9ucy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHNpZ25lZEluRGV2aWNlcyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qc2lnbmVkSW5EZXZpY2VzLy50ZXN0KHMpXG5leHBvcnQgY29uc3Qgc3RvcmFnZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qc3RvcmFnZS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHRhYkNhcHR1cmUgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnRhYkNhcHR1cmUvLnRlc3Qocylcbi8vIGV4cG9ydCBjb25zdCB0YWJzID0gcyA9PiAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnRhYnMvLnRlc3QocylcbmV4cG9ydCBjb25zdCB0b3BTaXRlcyA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qdG9wU2l0ZXMvLnRlc3QocylcbmV4cG9ydCBjb25zdCB0dHMgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKnR0cy8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHR0c0VuZ2luZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qdHRzRW5naW5lLy50ZXN0KHMpXG5leHBvcnQgY29uc3QgdW5saW1pdGVkU3RvcmFnZSA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qdW5saW1pdGVkU3RvcmFnZS8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHZwblByb3ZpZGVyID0gKHM6IHN0cmluZykgPT5cbiAgLygoY2hyb21lcD8pfChicm93c2VyKSlbXFxzXFxuXSpcXC5bXFxzXFxuXSp2cG5Qcm92aWRlci8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHdhbGxwYXBlciA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qd2FsbHBhcGVyLy50ZXN0KHMpXG5leHBvcnQgY29uc3Qgd2ViTmF2aWdhdGlvbiA9IChzOiBzdHJpbmcpID0+XG4gIC8oKGNocm9tZXA/KXwoYnJvd3NlcikpW1xcc1xcbl0qXFwuW1xcc1xcbl0qd2ViTmF2aWdhdGlvbi8udGVzdChzKVxuZXhwb3J0IGNvbnN0IHdlYlJlcXVlc3QgPSAoczogc3RyaW5nKSA9PlxuICAvKChjaHJvbWVwPyl8KGJyb3dzZXIpKVtcXHNcXG5dKlxcLltcXHNcXG5dKndlYlJlcXVlc3QvLnRlc3QocylcbmV4cG9ydCBjb25zdCB3ZWJSZXF1ZXN0QmxvY2tpbmcgPSAoczogc3RyaW5nKSA9PlxuICB3ZWJSZXF1ZXN0KHMpICYmIHMuaW5jbHVkZXMoXCInYmxvY2tpbmcnXCIpXG5cbi8vIFRPRE86IGFkZCByZWFkQ2xpcGJvYXJkXG4vLyBUT0RPOiBhZGQgd3JpdGVDbGlwYm9hcmRcbiIsImltcG9ydCBnbG9iIGZyb20gJ2dsb2InXG5pbXBvcnQgeyBnZXQsIGRpZmZlcmVuY2UgYXMgZGlmZiB9IGZyb20gJ2xvZGFzaCdcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgT3V0cHV0Q2h1bmsgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgKiBhcyBwZXJtaXNzaW9ucyBmcm9tICcuL3Blcm1pc3Npb25zJ1xuaW1wb3J0IHsgQ29udGVudFNjcmlwdCB9IGZyb20gJy4uLy4uL21hbmlmZXN0LXR5cGVzJ1xuaW1wb3J0IHsgaXNTdHJpbmcgfSBmcm9tICcuLi8uLi9oZWxwZXJzJ1xuXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuLyogICAgICAgICAgICAgIERFUklWRSBQRVJNSVNTSU9OUyAgICAgICAgICAgICAgKi9cbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG5cbmV4cG9ydCBjb25zdCBkZXJpdmVQZXJtaXNzaW9ucyA9IChzZXQ6IFNldDxzdHJpbmc+LCB7IGNvZGUgfTogT3V0cHV0Q2h1bmspID0+XG4gIE9iamVjdC5lbnRyaWVzKHBlcm1pc3Npb25zKVxuICAgIC5maWx0ZXIoKFtrZXldKSA9PiBrZXkgIT09ICdkZWZhdWx0JylcbiAgICAuZmlsdGVyKChbLCBmbl0pID0+IGZuKGNvZGUpKVxuICAgIC5tYXAoKFtrZXldKSA9PiBrZXkpXG4gICAgLnJlZHVjZSgocywgcCkgPT4gcy5hZGQocCksIHNldClcblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cbi8qICAgICAgICAgICAgICAgICBERVJJVkUgRklMRVMgICAgICAgICAgICAgICAgICovXG4vKiAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlRmlsZXMoXG4gIG1hbmlmZXN0OiBjaHJvbWUucnVudGltZS5NYW5pZmVzdCxcbiAgc3JjRGlyOiBzdHJpbmcsXG4gIG9wdGlvbnM6IHsgY29udGVudFNjcmlwdHM6IGJvb2xlYW4gfSxcbikge1xuICBpZiAobWFuaWZlc3QubWFuaWZlc3RfdmVyc2lvbiA9PT0gMykge1xuICAgIHJldHVybiBkZXJpdmVGaWxlc01WMyhtYW5pZmVzdCwgc3JjRGlyLCBvcHRpb25zKVxuICB9IGVsc2Uge1xuICAgIHJldHVybiBkZXJpdmVGaWxlc01WMihtYW5pZmVzdCwgc3JjRGlyLCBvcHRpb25zKVxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVGaWxlc01WMyhcbiAgbWFuaWZlc3Q6IGNocm9tZS5ydW50aW1lLk1hbmlmZXN0VjMsXG4gIHNyY0Rpcjogc3RyaW5nLFxuICBvcHRpb25zOiB7IGNvbnRlbnRTY3JpcHRzOiBib29sZWFuIH0sXG4pIHtcbiAgY29uc3QgbG9jYWxlcyA9IGlzU3RyaW5nKG1hbmlmZXN0LmRlZmF1bHRfbG9jYWxlKVxuICAgID8gWydfbG9jYWxlcy8qKi9tZXNzYWdlcy5qc29uJ11cbiAgICA6IFtdXG5cbiAgY29uc3QgZmlsZXMgPSBnZXQoXG4gICAgbWFuaWZlc3QsXG4gICAgJ3dlYl9hY2Nlc3NpYmxlX3Jlc291cmNlcycsXG4gICAgW10gYXMgUmVxdWlyZWQ8dHlwZW9mIG1hbmlmZXN0Plsnd2ViX2FjY2Vzc2libGVfcmVzb3VyY2VzJ10sXG4gIClcbiAgICAuZmxhdE1hcCgoeyByZXNvdXJjZXMgfSkgPT4gcmVzb3VyY2VzKVxuICAgIC5jb25jYXQobG9jYWxlcylcbiAgICAucmVkdWNlKChyLCB4KSA9PiB7XG4gICAgICBpZiAoZ2xvYi5oYXNNYWdpYyh4KSkge1xuICAgICAgICBjb25zdCBmaWxlcyA9IGdsb2Iuc3luYyh4LCB7IGN3ZDogc3JjRGlyIH0pXG4gICAgICAgIHJldHVybiBbLi4uciwgLi4uZmlsZXMubWFwKChmKSA9PiBmLnJlcGxhY2Uoc3JjRGlyLCAnJykpXVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIFsuLi5yLCB4XVxuICAgICAgfVxuICAgIH0sIFtdIGFzIHN0cmluZ1tdKVxuXG4gIGNvbnN0IGNvbnRlbnRTY3JpcHRzID0gZ2V0KFxuICAgIG1hbmlmZXN0LFxuICAgICdjb250ZW50X3NjcmlwdHMnLFxuICAgIFtdIGFzIENvbnRlbnRTY3JpcHRbXSxcbiAgKS5yZWR1Y2UoKHIsIHsganMgPSBbXSB9KSA9PiBbLi4uciwgLi4uanNdLCBbXSBhcyBzdHJpbmdbXSlcblxuICBjb25zdCBqcyA9IFtcbiAgICAuLi5maWxlcy5maWx0ZXIoKGYpID0+IC9cXC5banRdc3g/JC8udGVzdChmKSksXG4gICAgZ2V0KG1hbmlmZXN0LCAnYmFja2dyb3VuZC5zZXJ2aWNlX3dvcmtlcicpLFxuICAgIC4uLihvcHRpb25zLmNvbnRlbnRTY3JpcHRzID8gY29udGVudFNjcmlwdHMgOiBbXSksXG4gIF1cblxuICBjb25zdCBodG1sID0gW1xuICAgIC4uLmZpbGVzLmZpbHRlcigoZikgPT4gL1xcLmh0bWw/JC8udGVzdChmKSksXG4gICAgZ2V0KG1hbmlmZXN0LCAnb3B0aW9uc19wYWdlJyksXG4gICAgZ2V0KG1hbmlmZXN0LCAnb3B0aW9uc191aS5wYWdlJyksXG4gICAgZ2V0KG1hbmlmZXN0LCAnZGV2dG9vbHNfcGFnZScpLFxuICAgIGdldChtYW5pZmVzdCwgJ2FjdGlvbi5kZWZhdWx0X3BvcHVwJyksXG4gICAgLi4uT2JqZWN0LnZhbHVlcyhnZXQobWFuaWZlc3QsICdjaHJvbWVfdXJsX292ZXJyaWRlcycsIHt9KSksXG4gIF1cblxuICBjb25zdCBjc3MgPSBbXG4gICAgLi4uZmlsZXMuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKCcuY3NzJykpLFxuICAgIC4uLmdldChtYW5pZmVzdCwgJ2NvbnRlbnRfc2NyaXB0cycsIFtdIGFzIENvbnRlbnRTY3JpcHRbXSkucmVkdWNlKFxuICAgICAgKHIsIHsgY3NzID0gW10gfSkgPT4gWy4uLnIsIC4uLmNzc10sXG4gICAgICBbXSBhcyBzdHJpbmdbXSxcbiAgICApLFxuICBdXG5cbiAgY29uc3QgaW1nID0gW1xuICAgIC4uLmZpbGVzLmZpbHRlcigoZikgPT5cbiAgICAgIC9cXC4oanBlP2d8cG5nfHN2Z3x0aWZmP3xnaWZ8d2VicHxibXB8aWNvKSQvaS50ZXN0KGYpLFxuICAgICksXG4gICAgLi4uKE9iamVjdC52YWx1ZXMoZ2V0KG1hbmlmZXN0LCAnaWNvbnMnLCB7fSkpIGFzIHN0cmluZ1tdKSxcbiAgICAuLi4oT2JqZWN0LnZhbHVlcyhnZXQobWFuaWZlc3QsICdhY3Rpb24uZGVmYXVsdF9pY29uJywge30pKSBhcyBzdHJpbmdbXSksXG4gIF1cblxuICAvLyBGaWxlcyBsaWtlIGZvbnRzLCB0aGluZ3MgdGhhdCBhcmUgbm90IGV4cGVjdGVkXG4gIGNvbnN0IG90aGVycyA9IGRpZmYoZmlsZXMsIGNzcywgY29udGVudFNjcmlwdHMsIGpzLCBodG1sLCBpbWcpXG5cbiAgcmV0dXJuIHtcbiAgICBjc3M6IHZhbGlkYXRlKGNzcyksXG4gICAgY29udGVudFNjcmlwdHM6IHZhbGlkYXRlKGNvbnRlbnRTY3JpcHRzKSxcbiAgICBqczogdmFsaWRhdGUoanMpLFxuICAgIGh0bWw6IHZhbGlkYXRlKGh0bWwpLFxuICAgIGltZzogdmFsaWRhdGUoaW1nKSxcbiAgICBvdGhlcnM6IHZhbGlkYXRlKG90aGVycyksXG4gIH1cblxuICBmdW5jdGlvbiB2YWxpZGF0ZShhcnk6IGFueVtdKSB7XG4gICAgcmV0dXJuIFsuLi5uZXcgU2V0KGFyeS5maWx0ZXIoaXNTdHJpbmcpKV0ubWFwKCh4KSA9PiBqb2luKHNyY0RpciwgeCkpXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZUZpbGVzTVYyKFxuICBtYW5pZmVzdDogY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RWMixcbiAgc3JjRGlyOiBzdHJpbmcsXG4gIG9wdGlvbnM6IHsgY29udGVudFNjcmlwdHM6IGJvb2xlYW4gfSxcbikge1xuICBjb25zdCBsb2NhbGVzID0gaXNTdHJpbmcobWFuaWZlc3QuZGVmYXVsdF9sb2NhbGUpXG4gICAgPyBbJ19sb2NhbGVzLyoqL21lc3NhZ2VzLmpzb24nXVxuICAgIDogW11cblxuICBjb25zdCBmaWxlcyA9IGdldChcbiAgICBtYW5pZmVzdCxcbiAgICAnd2ViX2FjY2Vzc2libGVfcmVzb3VyY2VzJyxcbiAgICBbXSBhcyBSZXF1aXJlZDx0eXBlb2YgbWFuaWZlc3Q+Wyd3ZWJfYWNjZXNzaWJsZV9yZXNvdXJjZXMnXSxcbiAgKVxuICAgIC5jb25jYXQobG9jYWxlcylcbiAgICAucmVkdWNlKChyLCB4KSA9PiB7XG4gICAgICBpZiAoZ2xvYi5oYXNNYWdpYyh4KSkge1xuICAgICAgICBjb25zdCBmaWxlcyA9IGdsb2Iuc3luYyh4LCB7IGN3ZDogc3JjRGlyIH0pXG4gICAgICAgIHJldHVybiBbLi4uciwgLi4uZmlsZXMubWFwKChmKSA9PiBmLnJlcGxhY2Uoc3JjRGlyLCAnJykpXVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIFsuLi5yLCB4XVxuICAgICAgfVxuICAgIH0sIFtdIGFzIHN0cmluZ1tdKVxuXG4gIGNvbnN0IGNvbnRlbnRTY3JpcHRzID0gZ2V0KFxuICAgIG1hbmlmZXN0LFxuICAgICdjb250ZW50X3NjcmlwdHMnLFxuICAgIFtdIGFzIENvbnRlbnRTY3JpcHRbXSxcbiAgKS5yZWR1Y2UoKHIsIHsganMgPSBbXSB9KSA9PiBbLi4uciwgLi4uanNdLCBbXSBhcyBzdHJpbmdbXSlcbiAgY29uc3QganMgPSBbXG4gICAgLi4uZmlsZXMuZmlsdGVyKChmKSA9PiAvXFwuW2p0XXN4PyQvLnRlc3QoZikpLFxuICAgIC4uLmdldChtYW5pZmVzdCwgJ2JhY2tncm91bmQuc2NyaXB0cycsIFtdIGFzIHN0cmluZ1tdKSxcbiAgICAuLi4ob3B0aW9ucy5jb250ZW50U2NyaXB0cyA/IGNvbnRlbnRTY3JpcHRzIDogW10pLFxuICBdXG5cbiAgY29uc3QgaHRtbCA9IFtcbiAgICAuLi5maWxlcy5maWx0ZXIoKGYpID0+IC9cXC5odG1sPyQvLnRlc3QoZikpLFxuICAgIGdldChtYW5pZmVzdCwgJ2JhY2tncm91bmQucGFnZScpLFxuICAgIGdldChtYW5pZmVzdCwgJ29wdGlvbnNfcGFnZScpLFxuICAgIGdldChtYW5pZmVzdCwgJ29wdGlvbnNfdWkucGFnZScpLFxuICAgIGdldChtYW5pZmVzdCwgJ2RldnRvb2xzX3BhZ2UnKSxcbiAgICBnZXQobWFuaWZlc3QsICdicm93c2VyX2FjdGlvbi5kZWZhdWx0X3BvcHVwJyksXG4gICAgZ2V0KG1hbmlmZXN0LCAncGFnZV9hY3Rpb24uZGVmYXVsdF9wb3B1cCcpLFxuICAgIC4uLk9iamVjdC52YWx1ZXMoZ2V0KG1hbmlmZXN0LCAnY2hyb21lX3VybF9vdmVycmlkZXMnLCB7fSkpLFxuICBdXG5cbiAgY29uc3QgY3NzID0gW1xuICAgIC4uLmZpbGVzLmZpbHRlcigoZikgPT4gZi5lbmRzV2l0aCgnLmNzcycpKSxcbiAgICAuLi5nZXQobWFuaWZlc3QsICdjb250ZW50X3NjcmlwdHMnLCBbXSBhcyBDb250ZW50U2NyaXB0W10pLnJlZHVjZShcbiAgICAgIChyLCB7IGNzcyA9IFtdIH0pID0+IFsuLi5yLCAuLi5jc3NdLFxuICAgICAgW10gYXMgc3RyaW5nW10sXG4gICAgKSxcbiAgXVxuXG4gIGNvbnN0IGFjdGlvbkljb25TZXQgPSBbXG4gICAgJ2Jyb3dzZXJfYWN0aW9uLmRlZmF1bHRfaWNvbicsXG4gICAgJ3BhZ2VfYWN0aW9uLmRlZmF1bHRfaWNvbicsXG4gIF0ucmVkdWNlKChzZXQsIHF1ZXJ5KSA9PiB7XG4gICAgY29uc3QgcmVzdWx0OiBzdHJpbmcgfCB7IFtzaXplOiBzdHJpbmddOiBzdHJpbmcgfSA9IGdldChtYW5pZmVzdCwgcXVlcnksIHt9KVxuXG4gICAgaWYgKHR5cGVvZiByZXN1bHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICBzZXQuYWRkKHJlc3VsdClcbiAgICB9IGVsc2Uge1xuICAgICAgT2JqZWN0LnZhbHVlcyhyZXN1bHQpLmZvckVhY2goKHgpID0+IHNldC5hZGQoeCkpXG4gICAgfVxuXG4gICAgcmV0dXJuIHNldFxuICB9LCBuZXcgU2V0PHN0cmluZz4oKSlcblxuICBjb25zdCBpbWcgPSBbXG4gICAgLi4uYWN0aW9uSWNvblNldCxcbiAgICAuLi5maWxlcy5maWx0ZXIoKGYpID0+XG4gICAgICAvXFwuKGpwZT9nfHBuZ3xzdmd8dGlmZj98Z2lmfHdlYnB8Ym1wfGljbykkL2kudGVzdChmKSxcbiAgICApLFxuICAgIC4uLk9iamVjdC52YWx1ZXMoZ2V0KG1hbmlmZXN0LCAnaWNvbnMnLCB7fSkpLFxuICBdXG5cbiAgLy8gRmlsZXMgbGlrZSBmb250cywgdGhpbmdzIHRoYXQgYXJlIG5vdCBleHBlY3RlZFxuICBjb25zdCBvdGhlcnMgPSBkaWZmKGZpbGVzLCBjc3MsIGNvbnRlbnRTY3JpcHRzLCBqcywgaHRtbCwgaW1nKVxuXG4gIHJldHVybiB7XG4gICAgY3NzOiB2YWxpZGF0ZShjc3MpLFxuICAgIGNvbnRlbnRTY3JpcHRzOiB2YWxpZGF0ZShjb250ZW50U2NyaXB0cyksXG4gICAganM6IHZhbGlkYXRlKGpzKSxcbiAgICBodG1sOiB2YWxpZGF0ZShodG1sKSxcbiAgICBpbWc6IHZhbGlkYXRlKGltZyksXG4gICAgb3RoZXJzOiB2YWxpZGF0ZShvdGhlcnMpLFxuICB9XG5cbiAgZnVuY3Rpb24gdmFsaWRhdGUoYXJ5OiBhbnlbXSkge1xuICAgIHJldHVybiBbLi4ubmV3IFNldChhcnkuZmlsdGVyKGlzU3RyaW5nKSldLm1hcCgoeCkgPT4gam9pbihzcmNEaXIsIHgpKVxuICB9XG59XG4iLCJpbXBvcnQgQWp2IGZyb20gJ2FqdidcbmltcG9ydCB7IEpzb25Qb2ludGVyIH0gZnJvbSAnanNvbi1wdHInXG5pbXBvcnQgc2NoZW1hIGZyb20gJy4uLy4uLy4uL3NjaGVtYS9tYW5pZmVzdC1zdHJpY3Quc2NoZW1hLmpzb24nXG5pbXBvcnQgc2NoZW1hTVYyIGZyb20gJy4uLy4uLy4uL3NjaGVtYS9tYW5pZmVzdC12Mi5zY2hlbWEuanNvbidcbmltcG9ydCBzY2hlbWFNVjMgZnJvbSAnLi4vLi4vLi4vc2NoZW1hL21hbmlmZXN0LXYzLnNjaGVtYS5qc29uJ1xuXG5leHBvcnQgY29uc3QgYWp2ID0gbmV3IEFqdih7XG4gIHNjaGVtYXM6IFtzY2hlbWEsIHNjaGVtYU1WMiwgc2NoZW1hTVYzXSxcbiAgc3RyaWN0OiBmYWxzZSxcbiAgdmVyYm9zZTogdHJ1ZSxcbn0pXG5cbmFqdi5hZGRGb3JtYXQoJ2dsb2ItcGF0dGVybicsIHRydWUpXG5hanYuYWRkRm9ybWF0KCdtYXRjaC1wYXR0ZXJuJywgdHJ1ZSlcbmFqdi5hZGRGb3JtYXQoJ2NvbnRlbnQtc2VjdXJpdHktcG9saWN5JywgdHJ1ZSlcbmFqdi5hZGRGb3JtYXQoJ21pbWUtdHlwZScsIHRydWUpXG5hanYuYWRkRm9ybWF0KCdwZXJtaXNzaW9uJywgdHJ1ZSlcblxuY29uc3QgdmFsaWRhdG9yID0gYWp2LmNvbXBpbGUoc2NoZW1hKVxuXG5jb25zdCBzZXR1cFBvaW50ZXIgPVxuICAodGFyZ2V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgKHBvaW50ZXI6IHN0cmluZyk6IHN0cmluZyB8IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XG4gICAgSnNvblBvaW50ZXIuY3JlYXRlKHBvaW50ZXIpLmdldCh0YXJnZXQpIGFzIHN0cmluZ1xuXG5jb25zdCBnZXRTY2hlbWFEYXRhTVYyID0gc2V0dXBQb2ludGVyKHNjaGVtYU1WMilcbmNvbnN0IGdldFNjaGVtYURhdGFNVjMgPSBzZXR1cFBvaW50ZXIoc2NoZW1hTVYzKVxuXG5jb25zdCBpZ25vcmVkRXJyb3JzID0gWydtdXN0IG1hdGNoIFwidGhlblwiIHNjaGVtYScsICdtdXN0IG1hdGNoIFwiZWxzZVwiIHNjaGVtYSddXG5cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZU1hbmlmZXN0PFQgZXh0ZW5kcyBjaHJvbWUucnVudGltZS5NYW5pZmVzdEJhc2U+KFxuICBtYW5pZmVzdDogVCxcbik6IFQge1xuICBjb25zdCB2YWxpZCA9IHZhbGlkYXRvcihtYW5pZmVzdClcbiAgaWYgKHZhbGlkID09PSB0cnVlKSByZXR1cm4gbWFuaWZlc3RcblxuICBjb25zdCBnZXRWYWx1ZSA9IHNldHVwUG9pbnRlcihtYW5pZmVzdClcbiAgY29uc3QgZ2V0RGVzYyA9XG4gICAgbWFuaWZlc3QubWFuaWZlc3RfdmVyc2lvbiA9PT0gMiA/IGdldFNjaGVtYURhdGFNVjIgOiBnZXRTY2hlbWFEYXRhTVYzXG5cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIFtcbiAgICAgICdUaGVyZSB3ZXJlIHByb2JsZW1zIHdpdGggdGhlIGV4dGVuc2lvbiBtYW5pZmVzdC4nLFxuICAgICAgLi4uKHZhbGlkYXRvci5lcnJvcnNcbiAgICAgICAgPy5maWx0ZXIoKHsgbWVzc2FnZSB9KSA9PiBtZXNzYWdlICYmICFpZ25vcmVkRXJyb3JzLmluY2x1ZGVzKG1lc3NhZ2UpKVxuICAgICAgICAubWFwKChlKSA9PiB7XG4gICAgICAgICAgY29uc3Qgc2NoZW1hUGF0aCA9IGAvJHtlLnNjaGVtYVBhdGhcbiAgICAgICAgICAgIC5zcGxpdCgnLycpXG4gICAgICAgICAgICAuc2xpY2UoMSwgLTEpXG4gICAgICAgICAgICAuY29uY2F0KCdkZXNjcmlwdGlvbicpXG4gICAgICAgICAgICAuam9pbignLycpfWBcbiAgICAgICAgICBjb25zdCBkZXNjID0gZ2V0RGVzYyhzY2hlbWFQYXRoKSA/PyBlLm1lc3NhZ2VcblxuICAgICAgICAgIGlmIChlLmluc3RhbmNlUGF0aC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgIHJldHVybiBgLSBNYW5pZmVzdCAke2Rlc2N9YFxuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBgLSAke0pTT04uc3RyaW5naWZ5KGdldFZhbHVlKGUuaW5zdGFuY2VQYXRoKSl9IGF0IFwiJHtcbiAgICAgICAgICAgIGUuaW5zdGFuY2VQYXRoXG4gICAgICAgICAgfVwiICR7ZGVzY31gXG4gICAgICAgIH0pID8/IFtdKSxcbiAgICBdLmpvaW4oJ1xcbicpLFxuICApXG59XG4iLCJleHBvcnQgY29uc3QgY29udmVydE1hdGNoUGF0dGVybnMgPSAobTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgLy8gVXNlIFVSTCB0byBwYXJzZSBtYXRjaCBwYXR0ZXJuXG4gIC8vIFVSTCBtdXN0IGhhdmUgdmFsaWQgdXJsIHNjaGVtZVxuICBjb25zdCBbc2NoZW1lLCByZXN0XSA9IG0uc3BsaXQoJzovLycpXG5cbiAgLy8gVVJMIG11c3QgaGF2ZSB2YWxpZCBwb3J0XG4gIGNvbnN0IFthLCBwb3J0LCBiXSA9IHJlc3Quc3BsaXQoLyg6XFwqKS8pXG4gIGNvbnN0IGlzV2lsZFBvcnQgPSBwb3J0ID09PSAnOionXG4gIGNvbnN0IGZyYWcgPSBpc1dpbGRQb3J0ID8gYCR7YX06MzMzMyR7Yn1gIDogcmVzdFxuXG4gIC8vIG1hdGNoIHBhdHRlcm5zIGNhbiBvbmx5IGRlZmluZSBvcmlnaW5cbiAgY29uc3QgeyBvcmlnaW4gfSA9IG5ldyBVUkwoYGh0dHA6Ly8ke2ZyYWd9YClcbiAgY29uc3QgWywgYmFzZV0gPSBvcmlnaW4uc3BsaXQoJzovLycpXG5cbiAgLy8gcHV0IHBvcnQgYmFja1xuICBjb25zdCBbeCwgeV0gPSBiYXNlLnNwbGl0KCc6MzMzMycpXG4gIGNvbnN0IGZpbmFsID0gaXNXaWxkUG9ydCA/IFt4LCBwb3J0LCB5XS5qb2luKCcnKSA6IGJhc2VcblxuICAvLyBVUkwgZXNjYXBlcyBhc3Rlcml4ZXNcbiAgLy8gTmVlZCB0byB1bmVzY2FwZSB0aGVtXG4gIHJldHVybiB1bmVzY2FwZShgJHtzY2hlbWV9Oi8vJHtmaW5hbH0vKmApXG59XG4iLCJpbXBvcnQgeyBiYXNlbmFtZSwgcmVsYXRpdmUgfSBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgUm9sbHVwT3B0aW9ucyB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCBzbGFzaCBmcm9tICdzbGFzaCdcbmltcG9ydCB7IE1hbmlmZXN0SW5wdXRQbHVnaW5DYWNoZSB9IGZyb20gJy4uL3BsdWdpbi1vcHRpb25zJ1xuaW1wb3J0IHsgY2xvbmVPYmplY3QgfSBmcm9tICcuL2Nsb25lT2JqZWN0J1xuaW1wb3J0IHsgY29udmVydE1hdGNoUGF0dGVybnMgfSBmcm9tICcuL2NvbnZlcnRNYXRjaFBhdHRlcm5zJ1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0SW1wb3J0Q29udGVudFNjcmlwdEZpbGVOYW1lKHRhcmdldDogc3RyaW5nKSB7XG4gIGNvbnN0IGJhc2UgPSBiYXNlbmFtZSh0YXJnZXQpXG4gIHJldHVybiB0YXJnZXQucmVwbGFjZShiYXNlLCBgaW1wb3J0LSR7YmFzZX1gKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlTWFuaWZlc3RWMyhcbiAgbTogY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RWMyxcbiAgb3B0aW9uczogUm9sbHVwT3B0aW9ucyxcbiAgd3JhcENvbnRlbnRTY3JpcHRzOiBib29sZWFuLFxuICBjYWNoZTogTWFuaWZlc3RJbnB1dFBsdWdpbkNhY2hlLFxuKSB7XG4gIGNvbnN0IG1hbmlmZXN0ID0gY2xvbmVPYmplY3QobSlcblxuICBpZiAobWFuaWZlc3QuYmFja2dyb3VuZCkge1xuICAgIG1hbmlmZXN0LmJhY2tncm91bmQudHlwZSA9ICdtb2R1bGUnXG4gIH1cblxuICBpZiAobWFuaWZlc3QuY29udGVudF9zY3JpcHRzKSB7XG4gICAgY29uc3QgeyBvdXRwdXQgPSB7fSB9ID0gb3B0aW9uc1xuICAgIGNvbnN0IHsgY2h1bmtGaWxlTmFtZXMgPSAnY2h1bmtzL1tuYW1lXS1baGFzaF0uanMnIH0gPSBBcnJheS5pc0FycmF5KG91dHB1dClcbiAgICAgID8gb3V0cHV0WzBdXG4gICAgICA6IG91dHB1dFxuXG4gICAgY29uc3QgY2ZuID0gY2h1bmtGaWxlTmFtZXMgYXMgc3RyaW5nXG5cbiAgICBjYWNoZS5jaHVua0ZpbGVOYW1lcyA9IGNmblxuXG4gICAgLy8gT3V0cHV0IGNvdWxkIGJlIGFuIGFycmF5XG4gICAgaWYgKEFycmF5LmlzQXJyYXkob3V0cHV0KSkge1xuICAgICAgaWYgKFxuICAgICAgICAvLyBTaG91bGQgb25seSBiZSBvbmUgdmFsdWUgZm9yIGNodW5rRmlsZU5hbWVzXG4gICAgICAgIG91dHB1dC5yZWR1Y2UoKHIsIHgpID0+IHIuYWRkKHguY2h1bmtGaWxlTmFtZXMgPz8gJ25vIGNmbicpLCBuZXcgU2V0KCkpXG4gICAgICAgICAgLnNpemUgPiAxXG4gICAgICApXG4gICAgICAgIC8vIFdlIG5lZWQgdG8ga25vdyBjaHVua0ZpbGVOYW1lcyBub3csIGJlZm9yZSB0aGUgb3V0cHV0IHN0YWdlXG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgJ011bHRpcGxlIG91dHB1dCB2YWx1ZXMgZm9yIGNodW5rRmlsZU5hbWVzIGFyZSBub3Qgc3VwcG9ydGVkJyxcbiAgICAgICAgKVxuXG4gICAgICAvLyBJZiBjaHVua0ZpbGVOYW1lcyBpcyB1bmRlZmluZWQsIHVzZSBvdXIgZGVmYXVsdFxuICAgICAgb3V0cHV0LmZvckVhY2goKHgpID0+ICh4LmNodW5rRmlsZU5hbWVzID0gY2ZuKSlcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gSWYgY2h1bmtGaWxlTmFtZXMgaXMgdW5kZWZpbmVkLCB1c2Ugb3VyIGRlZmF1bHRcbiAgICAgIG91dHB1dC5jaHVua0ZpbGVOYW1lcyA9IGNmblxuICAgIH1cblxuICAgIGNvbnN0IGFsbE1hdGNoZXMgPSBtYW5pZmVzdC5jb250ZW50X3NjcmlwdHNcbiAgICAgIC5mbGF0TWFwKCh7IG1hdGNoZXMgfSkgPT4gbWF0Y2hlcyA/PyBbXSlcbiAgICAgIC5jb25jYXQobWFuaWZlc3QuaG9zdF9wZXJtaXNzaW9ucyA/PyBbXSlcbiAgICAgIC5tYXAoY29udmVydE1hdGNoUGF0dGVybnMpXG5cbiAgICBjb25zdCBtYXRjaGVzID0gQXJyYXkuZnJvbShuZXcgU2V0KGFsbE1hdGNoZXMpKVxuICAgIC8vIFVzZSBzbGFzaCB0byBndWFyYW50ZWUgc3VwcG9ydCBXaW5kb3dzXG4gICAgY29uc3QgcmVzb3VyY2VzID0gW1xuICAgICAgc2xhc2goXG4gICAgICAgIGAke2NmblxuICAgICAgICAgIC5zcGxpdCgnLycpXG4gICAgICAgICAgLmpvaW4oJy8nKVxuICAgICAgICAgIC5yZXBsYWNlKCdbZm9ybWF0XScsICcqJylcbiAgICAgICAgICAucmVwbGFjZSgnW25hbWVdJywgJyonKVxuICAgICAgICAgIC5yZXBsYWNlKCdbaGFzaF0nLCAnKicpfWAsXG4gICAgICApLFxuICAgICAgLi4uY2FjaGUuY29udGVudFNjcmlwdHMubWFwKCh4KSA9PiBzbGFzaChyZWxhdGl2ZShjYWNoZS5zcmNEaXIhLCB4KSkpLFxuICAgIF1cblxuICAgIGlmICh3cmFwQ29udGVudFNjcmlwdHMpIHtcbiAgICAgIG1hbmlmZXN0LmNvbnRlbnRfc2NyaXB0cyA9IG1hbmlmZXN0LmNvbnRlbnRfc2NyaXB0cy5tYXAoKGMpID0+ICh7XG4gICAgICAgIC4uLmMsXG4gICAgICAgIGpzOiBjLmpzPy5tYXAoZ2V0SW1wb3J0Q29udGVudFNjcmlwdEZpbGVOYW1lKSxcbiAgICAgIH0pKVxuICAgIH1cblxuICAgIG1hbmlmZXN0LndlYl9hY2Nlc3NpYmxlX3Jlc291cmNlcyA9IG1hbmlmZXN0LndlYl9hY2Nlc3NpYmxlX3Jlc291cmNlcyA/PyBbXVxuXG4gICAgbWFuaWZlc3Qud2ViX2FjY2Vzc2libGVfcmVzb3VyY2VzLnB1c2goe1xuICAgICAgcmVzb3VyY2VzLFxuICAgICAgbWF0Y2hlcyxcbiAgICB9KVxuICB9XG5cbiAgcmV0dXJuIG1hbmlmZXN0XG59XG4iLCJpbXBvcnQgeyBQbHVnaW5Db250ZXh0IH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHsgaXNNVjIgfSBmcm9tICcuLi9tYW5pZmVzdC10eXBlcydcbmltcG9ydCB7XG4gIE1hbmlmZXN0SW5wdXRQbHVnaW5DYWNoZSxcbiAgTWFuaWZlc3RJbnB1dFBsdWdpbk9wdGlvbnMsXG59IGZyb20gJy4uL3BsdWdpbi1vcHRpb25zJ1xuXG5leHBvcnQgZnVuY3Rpb24gd2FybkRlcHJlY2F0ZWRPcHRpb25zKFxuICB0aGlzOiBQbHVnaW5Db250ZXh0LFxuICB7XG4gICAgYnJvd3NlclBvbHlmaWxsLFxuICAgIGNyb3NzQnJvd3NlcixcbiAgICBkeW5hbWljSW1wb3J0V3JhcHBlcixcbiAgICBmaXJzdENsYXNzTWFuaWZlc3QsXG4gICAgaWlmZUpzb25QYXRocyxcbiAgICBwdWJsaWNLZXksXG4gICAgY29udGVudFNjcmlwdFdyYXBwZXIsXG4gIH06IFBpY2s8XG4gICAgTWFuaWZlc3RJbnB1dFBsdWdpbk9wdGlvbnMsXG4gICAgfCAnY3Jvc3NCcm93c2VyJ1xuICAgIHwgJ2Jyb3dzZXJQb2x5ZmlsbCdcbiAgICB8ICdmaXJzdENsYXNzTWFuaWZlc3QnXG4gICAgfCAnaWlmZUpzb25QYXRocydcbiAgICB8ICdkeW5hbWljSW1wb3J0V3JhcHBlcidcbiAgICB8ICdwdWJsaWNLZXknXG4gICAgfCAnY29udGVudFNjcmlwdFdyYXBwZXInXG4gID4sXG4gIGNhY2hlOiBNYW5pZmVzdElucHV0UGx1Z2luQ2FjaGUsXG4pIHtcbiAgLyogLS0tLS0tLS0tLS0tIFdBUk4gREVQUkVDQVRFRCBPUFRJT05TIC0tLS0tLS0tLS0tLSAqL1xuICBpZiAoY3Jvc3NCcm93c2VyKSB0aGlzLndhcm4oJ2BvcHRpb25zLmNyb3NzQnJvd3NlcmAgaXMgbm90IGltcGxlbWVudGVkIHlldCcpXG5cbiAgaWYgKCFmaXJzdENsYXNzTWFuaWZlc3QpXG4gICAgdGhpcy53YXJuKCdgb3B0aW9ucy5maXJzdENsYXNzTWFuaWZlc3RgIHdpbGwgYmUgcmVtb3ZlZCBpbiB2ZXJzaW9uIDUuMC4wJylcblxuICBpZiAoaWlmZUpzb25QYXRocz8ubGVuZ3RoKSB0aGlzLndhcm4oJ2BvcHRpb25zLmlpZmVKc29uUGF0aHNgIGlzIGRlcHJlY2F0ZWQnKVxuXG4gIGlmICh0eXBlb2YgY29udGVudFNjcmlwdFdyYXBwZXIgIT09ICd1bmRlZmluZWQnKVxuICAgIHRoaXMud2FybihcbiAgICAgICdgb3B0aW9ucy5jb250ZW50U2NyaXB0V3JhcHBlcmAgaXMgZGVwcmVjYXRlZC5cXG5QbGVhc2UgdXNlIGBvcHRpb25zLndyYXBDb250ZW50U2NyaXB0YCcsXG4gICAgKVxuXG4gIGlmIChpc01WMihjYWNoZS5tYW5pZmVzdCkpXG4gICAgLy8gTVYyIG1hbmlmZXN0IGlzIGhhbmRsZWQgaW4gYGdlbmVyYXRlQnVuZGxlYFxuICAgIHJldHVyblxuXG4gIGlmIChicm93c2VyUG9seWZpbGwpXG4gICAgdGhpcy53YXJuKFxuICAgICAgW1xuICAgICAgICAnYG9wdGlvbnMuYnJvd3NlclBvbHlmaWxsYCBpcyBkZXByZWNhdGVkIGZvciBNVjMgYW5kIGRvZXMgbm90aGluZyBpbnRlcm5hbGx5JyxcbiAgICAgICAgJ1NlZTogaHR0cHM6Ly9leHRlbmQtY2hyb21lLmRldi9yb2xsdXAtcGx1Z2luI212My1mYXEnLFxuICAgICAgXS5qb2luKCdcXG4nKSxcbiAgICApXG5cbiAgaWYgKFxuICAgIC8vIFRoaXMgc2hvdWxkIGJlIGFuIGVtcHR5IG9iamVjdFxuICAgIHR5cGVvZiBkeW5hbWljSW1wb3J0V3JhcHBlciAhPT0gJ29iamVjdCcgfHxcbiAgICBPYmplY3Qua2V5cyhkeW5hbWljSW1wb3J0V3JhcHBlcikubGVuZ3RoID4gMFxuICApXG4gICAgdGhpcy53YXJuKCdgb3B0aW9ucy5keW5hbWljSW1wb3J0V3JhcHBlcmAgaXMgbm90IHJlcXVpcmVkIGZvciBNVjMnKVxuXG4gIGlmIChwdWJsaWNLZXkpXG4gICAgdGhpcy53YXJuKFxuICAgICAgW1xuICAgICAgICAnYG9wdGlvbnMucHVibGljS2V5YCBpcyBkZXByZWNhdGVkIGZvciBNVjMsJyxcbiAgICAgICAgJ3BsZWFzZSB1c2UgYG9wdGlvbnMuZXh0ZW5kTWFuaWZlc3RgIGluc3RlYWQnLFxuICAgICAgICAnc2VlOiBodHRwczovL2V4dGVuZC1jaHJvbWUuZGV2L3JvbGx1cC1wbHVnaW4jbXYzLWZhcScsXG4gICAgICBdLmpvaW4oJ1xcbicpLFxuICAgIClcbn1cbiIsImltcG9ydCB7IGNvZGUgYXMgY3RXcmFwcGVyU2NyaXB0IH0gZnJvbSAnY29kZSAuL2Jyb3dzZXIvY29udGVudFNjcmlwdFdyYXBwZXIudHMnXG5pbXBvcnQgeyBjb3NtaWNvbmZpZ1N5bmMgfSBmcm9tICdjb3NtaWNvbmZpZydcbmltcG9ydCBmcyBmcm9tICdmcy1leHRyYSdcbmltcG9ydCB7IEpTT05QYXRoIH0gZnJvbSAnanNvbnBhdGgtcGx1cydcbmltcG9ydCBtZW1vaXplIGZyb20gJ21lbSdcbmltcG9ydCBwYXRoLCB7IGJhc2VuYW1lLCByZWxhdGl2ZSB9IGZyb20gJ3BhdGgnXG5pbXBvcnQgeyBFbWl0dGVkQXNzZXQsIE91dHB1dENodW5rIH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHNsYXNoIGZyb20gJ3NsYXNoJ1xuaW1wb3J0IHsgaXNDaHVuaywgaXNQcmVzZW50LCBub3JtYWxpemVGaWxlbmFtZSB9IGZyb20gJy4uL2hlbHBlcnMnXG5pbXBvcnQgeyBpc01WMiwgaXNNVjMgfSBmcm9tICcuLi9tYW5pZmVzdC10eXBlcydcbmltcG9ydCB7XG4gIE1hbmlmZXN0SW5wdXRQbHVnaW4sXG4gIE1hbmlmZXN0SW5wdXRQbHVnaW5DYWNoZSxcbiAgTWFuaWZlc3RJbnB1dFBsdWdpbk9wdGlvbnMsXG59IGZyb20gJy4uL3BsdWdpbi1vcHRpb25zJ1xuaW1wb3J0IHsgY2xvbmVPYmplY3QgfSBmcm9tICcuL2Nsb25lT2JqZWN0J1xuaW1wb3J0IHsgcHJlcEltcG9ydFdyYXBwZXJTY3JpcHQgfSBmcm9tICcuL2R5bmFtaWNJbXBvcnRXcmFwcGVyJ1xuaW1wb3J0IHsgZ2V0SW5wdXRNYW5pZmVzdFBhdGggfSBmcm9tICcuL2dldElucHV0TWFuaWZlc3RQYXRoJ1xuaW1wb3J0IHsgY29tYmluZVBlcm1zIH0gZnJvbSAnLi9tYW5pZmVzdC1wYXJzZXIvY29tYmluZSdcbmltcG9ydCB7IGRlcml2ZUZpbGVzLCBkZXJpdmVQZXJtaXNzaW9ucyB9IGZyb20gJy4vbWFuaWZlc3QtcGFyc2VyL2luZGV4J1xuaW1wb3J0IHsgdmFsaWRhdGVNYW5pZmVzdCB9IGZyb20gJy4vbWFuaWZlc3QtcGFyc2VyL3ZhbGlkYXRlJ1xuaW1wb3J0IHsgcmVkdWNlVG9SZWNvcmQgfSBmcm9tICcuL3JlZHVjZVRvUmVjb3JkJ1xuaW1wb3J0IHtcbiAgZ2V0SW1wb3J0Q29udGVudFNjcmlwdEZpbGVOYW1lLFxuICB1cGRhdGVNYW5pZmVzdFYzLFxufSBmcm9tICcuL3VwZGF0ZU1hbmlmZXN0J1xuaW1wb3J0IHsgd2FybkRlcHJlY2F0ZWRPcHRpb25zIH0gZnJvbSAnLi93YXJuRGVwcmVjYXRlZE9wdGlvbnMnXG5cbmV4cG9ydCBjb25zdCBleHBsb3JlciA9IGNvc21pY29uZmlnU3luYygnbWFuaWZlc3QnLCB7XG4gIGNhY2hlOiBmYWxzZSxcbiAgbG9hZGVyczoge1xuICAgICcudHMnOiAoZmlsZVBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgcmVxdWlyZSgnZXNidWlsZC1ydW5uZXIvcmVnaXN0ZXInKVxuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby12YXItcmVxdWlyZXNcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHJlcXVpcmUoZmlsZVBhdGgpXG5cbiAgICAgIHJldHVybiByZXN1bHQuZGVmYXVsdCA/PyByZXN1bHRcbiAgICB9LFxuICB9LFxufSlcblxuY29uc3QgbmFtZSA9ICdtYW5pZmVzdC1pbnB1dCdcblxuLy8gV2UgdXNlIGEgc3R1YiBpZiB0aGUgbWFuaWZlc3QgaGFzIG5vIHNjcmlwdHNcbi8vICAgZWcsIGEgQ1NTIG9ubHkgQ2hyb21lIEV4dGVuc2lvblxuZXhwb3J0IGNvbnN0IHN0dWJDaHVua05hbWVGb3JDc3NPbmx5Q3J4ID1cbiAgJ3N0dWJfX2Nzcy1vbmx5LWNocm9tZS1leHRlbnNpb24tbWFuaWZlc3QnXG5leHBvcnQgY29uc3QgaW1wb3J0V3JhcHBlckNodW5rTmFtZVByZWZpeCA9ICdfX1JQQ0UtaW1wb3J0LXdyYXBwZXInXG5cbmNvbnN0IG5wbVBrZ0RldGFpbHMgPVxuICBwcm9jZXNzLmVudi5ucG1fcGFja2FnZV9uYW1lICYmXG4gIHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX3ZlcnNpb24gJiZcbiAgcHJvY2Vzcy5lbnYubnBtX3BhY2thZ2VfZGVzY3JpcHRpb25cbiAgICA/IHtcbiAgICAgICAgbmFtZTogcHJvY2Vzcy5lbnYubnBtX3BhY2thZ2VfbmFtZSxcbiAgICAgICAgdmVyc2lvbjogcHJvY2Vzcy5lbnYubnBtX3BhY2thZ2VfdmVyc2lvbixcbiAgICAgICAgZGVzY3JpcHRpb246IHByb2Nlc3MuZW52Lm5wbV9wYWNrYWdlX2Rlc2NyaXB0aW9uLFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICBuYW1lOiAnJyxcbiAgICAgICAgdmVyc2lvbjogJycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnJyxcbiAgICAgIH1cblxuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cbi8qICAgICAgICAgICAgICAgIE1BTklGRVNULUlOUFVUICAgICAgICAgICAgICAgICovXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuXG5leHBvcnQgZnVuY3Rpb24gbWFuaWZlc3RJbnB1dChcbiAge1xuICAgIGJyb3dzZXJQb2x5ZmlsbCA9IGZhbHNlLFxuICAgIGNvbnRlbnRTY3JpcHRXcmFwcGVyID0gdHJ1ZSxcbiAgICBjcm9zc0Jyb3dzZXIgPSBmYWxzZSxcbiAgICBkeW5hbWljSW1wb3J0V3JhcHBlciA9IHt9LFxuICAgIGV4dGVuZE1hbmlmZXN0ID0ge30sXG4gICAgZmlyc3RDbGFzc01hbmlmZXN0ID0gdHJ1ZSxcbiAgICBpaWZlSnNvblBhdGhzID0gW10sXG4gICAgcGtnID0gbnBtUGtnRGV0YWlscyxcbiAgICBwdWJsaWNLZXksXG4gICAgdmVyYm9zZSA9IHRydWUsXG4gICAgd3JhcENvbnRlbnRTY3JpcHRzID0gdHJ1ZSxcbiAgICBjYWNoZSA9IHtcbiAgICAgIGFzc2V0Q2hhbmdlZDogZmFsc2UsXG4gICAgICBhc3NldHM6IFtdLFxuICAgICAgY29udGVudFNjcmlwdHM6IFtdLFxuICAgICAgY29udGVudFNjcmlwdENvZGU6IHt9LFxuICAgICAgY29udGVudFNjcmlwdElkczoge30sXG4gICAgICBpaWZlOiBbXSxcbiAgICAgIGlucHV0OiBbXSxcbiAgICAgIGlucHV0QXJ5OiBbXSxcbiAgICAgIGlucHV0T2JqOiB7fSxcbiAgICAgIHBlcm1zSGFzaDogJycsXG4gICAgICByZWFkRmlsZTogbmV3IE1hcDxzdHJpbmcsIGFueT4oKSxcbiAgICAgIHNyY0RpcjogbnVsbCxcbiAgICB9IGFzIE1hbmlmZXN0SW5wdXRQbHVnaW5DYWNoZSxcbiAgfSA9IHt9IGFzIE1hbmlmZXN0SW5wdXRQbHVnaW5PcHRpb25zLFxuKTogTWFuaWZlc3RJbnB1dFBsdWdpbiB7XG4gIGNvbnN0IHJlYWRBc3NldEFzQnVmZmVyID0gbWVtb2l6ZShcbiAgICAoZmlsZXBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgcmV0dXJuIGZzLnJlYWRGaWxlKGZpbGVwYXRoKVxuICAgIH0sXG4gICAge1xuICAgICAgY2FjaGU6IGNhY2hlLnJlYWRGaWxlLFxuICAgIH0sXG4gIClcblxuICAvKiAtLS0tLS0tLS0tLS0tLS0tLS0gREVQUkVDQVRJT05TIC0tLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgLy8gY29udGVudFNjcmlwdFdyYXBwZXIgPSB3cmFwQ29udGVudFNjcmlwdHNcblxuICAvKiAtLS0tLS0tLS0tLSBIT09LUyBDTE9TVVJFUyBTVEFSVCAtLS0tLS0tLS0tLSAqL1xuXG4gIGxldCBtYW5pZmVzdFBhdGg6IHN0cmluZ1xuXG4gIGNvbnN0IG1hbmlmZXN0TmFtZSA9ICdtYW5pZmVzdC5qc29uJ1xuXG4gIC8qIC0tLS0tLS0tLS0tLSBIT09LUyBDTE9TVVJFUyBFTkQgLS0tLS0tLS0tLS0tICovXG5cbiAgLyogLSBTRVRVUCBEWU5BTUlDIElNUE9SVCBMT0FERVIgU0NSSVBUIFNUQVJUIC0gKi9cblxuICBsZXQgd3JhcHBlclNjcmlwdCA9ICcnXG4gIGlmIChkeW5hbWljSW1wb3J0V3JhcHBlciAhPT0gZmFsc2UpIHtcbiAgICB3cmFwcGVyU2NyaXB0ID0gcHJlcEltcG9ydFdyYXBwZXJTY3JpcHQoZHluYW1pY0ltcG9ydFdyYXBwZXIpXG4gIH1cblxuICAvKiAtLSBTRVRVUCBEWU5BTUlDIElNUE9SVCBMT0FERVIgU0NSSVBUIEVORCAtLSAqL1xuXG4gIC8qIC0tLS0tLS0tLS0tLS0tLSBwbHVnaW4gb2JqZWN0IC0tLS0tLS0tLS0tLS0tICovXG4gIHJldHVybiB7XG4gICAgbmFtZSxcblxuICAgIGJyb3dzZXJQb2x5ZmlsbCxcbiAgICBjcm9zc0Jyb3dzZXIsXG5cbiAgICBnZXQgc3JjRGlyKCkge1xuICAgICAgcmV0dXJuIGNhY2hlLnNyY0RpclxuICAgIH0sXG5cbiAgICBnZXQgZm9ybWF0TWFwKCkge1xuICAgICAgcmV0dXJuIHsgaWlmZTogY2FjaGUuaWlmZSB9XG4gICAgfSxcblxuICAgIC8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXG4gICAgLyogICAgICAgICAgICAgICAgIE9QVElPTlMgSE9PSyAgICAgICAgICAgICAgICAgKi9cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuXG4gICAgb3B0aW9ucyhvcHRpb25zKSB7XG4gICAgICAvKiAtLS0tLS0tLS0tLSBMT0FEIEFORCBQUk9DRVNTIE1BTklGRVNUIC0tLS0tLS0tLS0tICovXG5cbiAgICAgIC8vIERvIG5vdCByZWxvYWQgbWFuaWZlc3Qgd2l0aG91dCBjaGFuZ2VzXG4gICAgICBpZiAoIWNhY2hlLm1hbmlmZXN0KSB7XG4gICAgICAgIGNvbnN0IHsgaW5wdXRNYW5pZmVzdFBhdGgsIC4uLmNhY2hlVmFsdWVzIH0gPVxuICAgICAgICAgIGdldElucHV0TWFuaWZlc3RQYXRoKG9wdGlvbnMpXG5cbiAgICAgICAgT2JqZWN0LmFzc2lnbihjYWNoZSwgY2FjaGVWYWx1ZXMpXG5cbiAgICAgICAgY29uc3QgY29uZmlnUmVzdWx0ID0gZXhwbG9yZXIubG9hZChpbnB1dE1hbmlmZXN0UGF0aCkgYXMge1xuICAgICAgICAgIGZpbGVwYXRoOiBzdHJpbmdcbiAgICAgICAgICBjb25maWc6IGNocm9tZS5ydW50aW1lLk1hbmlmZXN0XG4gICAgICAgICAgaXNFbXB0eT86IHRydWVcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb25maWdSZXN1bHQuaXNFbXB0eSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgJHtvcHRpb25zLmlucHV0fSBpcyBhbiBlbXB0eSBmaWxlLmApXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IG9wdGlvbnNfcGFnZSwgb3B0aW9uc191aSB9ID0gY29uZmlnUmVzdWx0LmNvbmZpZ1xuICAgICAgICBpZiAoaXNQcmVzZW50KG9wdGlvbnNfdWkpICYmIGlzUHJlc2VudChvcHRpb25zX3BhZ2UpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJ29wdGlvbnNfdWkgYW5kIG9wdGlvbnNfcGFnZSBjYW5ub3QgYm90aCBiZSBkZWZpbmVkIGluIG1hbmlmZXN0Lmpzb24uJyxcbiAgICAgICAgICApXG4gICAgICAgIH1cblxuICAgICAgICBtYW5pZmVzdFBhdGggPSBjb25maWdSZXN1bHQuZmlsZXBhdGhcbiAgICAgICAgY2FjaGUuc3JjRGlyID0gcGF0aC5kaXJuYW1lKG1hbmlmZXN0UGF0aClcblxuICAgICAgICBsZXQgZXh0ZW5kZWRNYW5pZmVzdDogUGFydGlhbDxjaHJvbWUucnVudGltZS5NYW5pZmVzdD5cbiAgICAgICAgaWYgKHR5cGVvZiBleHRlbmRNYW5pZmVzdCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIGV4dGVuZGVkTWFuaWZlc3QgPSBleHRlbmRNYW5pZmVzdChjb25maWdSZXN1bHQuY29uZmlnKVxuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBleHRlbmRNYW5pZmVzdCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICBleHRlbmRlZE1hbmlmZXN0ID0ge1xuICAgICAgICAgICAgLi4uY29uZmlnUmVzdWx0LmNvbmZpZyxcbiAgICAgICAgICAgIC4uLmV4dGVuZE1hbmlmZXN0LFxuICAgICAgICAgIH0gYXMgUGFydGlhbDxjaHJvbWUucnVudGltZS5NYW5pZmVzdD5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBleHRlbmRlZE1hbmlmZXN0ID0gY29uZmlnUmVzdWx0LmNvbmZpZ1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZnVsbE1hbmlmZXN0ID0ge1xuICAgICAgICAgIC8vIE1WMiBpcyBkZWZhdWx0XG4gICAgICAgICAgbWFuaWZlc3RfdmVyc2lvbjogMixcbiAgICAgICAgICBuYW1lOiBwa2cubmFtZSxcbiAgICAgICAgICAvLyB2ZXJzaW9uIG11c3QgYmUgYWxsIGRpZ2l0cyB3aXRoIHVwIHRvIHRocmVlIGRvdHNcbiAgICAgICAgICB2ZXJzaW9uOiBbLi4uKHBrZy52ZXJzaW9uPy5tYXRjaEFsbCgvXFxkKy9nKSA/PyBbXSldLmpvaW4oJy4nKSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogcGtnLmRlc2NyaXB0aW9uLFxuICAgICAgICAgIC4uLmV4dGVuZGVkTWFuaWZlc3QsXG4gICAgICAgIH0gYXMgY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RcblxuICAgICAgICAvLyBJZiB0aGUgbWFuaWZlc3QgaXMgdGhlIHNvdXJjZSBvZiB0cnV0aCBmb3IgaW5wdXRzXG4gICAgICAgIC8vICAgYGZhbHNlYCBtZWFucyB0aGF0IGFsbCBpbnB1dHMgbXVzdCBjb21lIGZyb20gUm9sbHVwIGNvbmZpZ1xuICAgICAgICBpZiAoZmlyc3RDbGFzc01hbmlmZXN0KSB7XG4gICAgICAgICAgLy8gQW55IHNjcmlwdHMgZnJvbSBoZXJlIHdpbGwgYmUgcmVnZW5lcmF0ZWQgYXMgSUlGRSdzXG4gICAgICAgICAgY2FjaGUuaWlmZSA9IGlpZmVKc29uUGF0aHNcbiAgICAgICAgICAgIC5tYXAoKGpzb25QYXRoKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IEpTT05QYXRoKHtcbiAgICAgICAgICAgICAgICBwYXRoOiBqc29uUGF0aCxcbiAgICAgICAgICAgICAgICBqc29uOiBmdWxsTWFuaWZlc3QsXG4gICAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5mbGF0KEluZmluaXR5KVxuXG4gICAgICAgICAgLy8gRGVyaXZlIGVudHJ5IHBhdGhzIGZyb20gbWFuaWZlc3RcbiAgICAgICAgICBjb25zdCB7IGpzLCBodG1sLCBjc3MsIGltZywgb3RoZXJzLCBjb250ZW50U2NyaXB0cyB9ID0gZGVyaXZlRmlsZXMoXG4gICAgICAgICAgICBmdWxsTWFuaWZlc3QsXG4gICAgICAgICAgICBjYWNoZS5zcmNEaXIsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNvbnRlbnRTY3JpcHRzOiB0cnVlLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApXG5cbiAgICAgICAgICBjYWNoZS5jb250ZW50U2NyaXB0cyA9IGNvbnRlbnRTY3JpcHRzXG5cbiAgICAgICAgICAvLyBDYWNoZSBkZXJpdmVkIGlucHV0c1xuICAgICAgICAgIGNhY2hlLmlucHV0ID0gWy4uLmNhY2hlLmlucHV0QXJ5LCAuLi5qcywgLi4uaHRtbF1cblxuICAgICAgICAgIGNhY2hlLmFzc2V0cyA9IFtcbiAgICAgICAgICAgIC8vIERlZHVwZSBhc3NldHNcbiAgICAgICAgICAgIC4uLm5ldyBTZXQoWy4uLmNzcywgLi4uaW1nLCAuLi5vdGhlcnNdKSxcbiAgICAgICAgICBdXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZmluYWxNYW5pZmVzdDogY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RcbiAgICAgICAgaWYgKGlzTVYzKGZ1bGxNYW5pZmVzdCkpIHtcbiAgICAgICAgICBmaW5hbE1hbmlmZXN0ID0gdXBkYXRlTWFuaWZlc3RWMyhcbiAgICAgICAgICAgIGZ1bGxNYW5pZmVzdCxcbiAgICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICAgICB3cmFwQ29udGVudFNjcmlwdHMsXG4gICAgICAgICAgICBjYWNoZSxcbiAgICAgICAgICApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZmluYWxNYW5pZmVzdCA9IGZ1bGxNYW5pZmVzdFxuICAgICAgICB9XG5cbiAgICAgICAgY2FjaGUubWFuaWZlc3QgPSB2YWxpZGF0ZU1hbmlmZXN0KGZpbmFsTWFuaWZlc3QpXG4gICAgICB9XG4gICAgICAvKiAtLS0tLS0tLS0tLS0tLS0gRU5EIExPQUQgTUFOSUZFU1QgLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgICAgIC8vIEZpbmFsIGBvcHRpb25zLmlucHV0YCBpcyBhbiBvYmplY3RcbiAgICAgIC8vICAgdGhpcyBncmFudHMgZnVsbCBjb21wYXRpYmlsaXR5IHdpdGggYWxsIFJvbGx1cCBvcHRpb25zXG4gICAgICBjb25zdCBmaW5hbElucHV0ID0gY2FjaGUuaW5wdXQucmVkdWNlKFxuICAgICAgICByZWR1Y2VUb1JlY29yZChjYWNoZS5zcmNEaXIpLFxuICAgICAgICBjYWNoZS5pbnB1dE9iaixcbiAgICAgIClcblxuICAgICAgLy8gVXNlIGEgc3R1YiBpZiBubyBqcyBzY3JpcHRzXG4gICAgICBpZiAoT2JqZWN0LmtleXMoZmluYWxJbnB1dCkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGZpbmFsSW5wdXRbc3R1YkNodW5rTmFtZUZvckNzc09ubHlDcnhdID0gc3R1YkNodW5rTmFtZUZvckNzc09ubHlDcnhcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHsgLi4ub3B0aW9ucywgaW5wdXQ6IGZpbmFsSW5wdXQgfVxuICAgIH0sXG5cbiAgICBhc3luYyBidWlsZFN0YXJ0KCkge1xuICAgICAgLyogLS0tLS0tLS0tLS0tIFdBVENIIEFTU0VUUyBGT1IgQ0hBTkdFUyAtLS0tLS0tLS0tLSAqL1xuXG4gICAgICB0aGlzLmFkZFdhdGNoRmlsZShtYW5pZmVzdFBhdGgpXG5cbiAgICAgIGNhY2hlLmFzc2V0cy5mb3JFYWNoKChzcmNQYXRoKSA9PiB7XG4gICAgICAgIHRoaXMuYWRkV2F0Y2hGaWxlKHNyY1BhdGgpXG4gICAgICB9KVxuXG4gICAgICAvKiAtLS0tLS0tLS0tLS0tLS0tLS0gRU1JVCBBU1NFVFMgLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgICAgIGNvbnN0IGFzc2V0czogRW1pdHRlZEFzc2V0W10gPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgY2FjaGUuYXNzZXRzLm1hcChhc3luYyAoc3JjUGF0aCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IGF3YWl0IHJlYWRBc3NldEFzQnVmZmVyKHNyY1BhdGgpXG5cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgdHlwZTogJ2Fzc2V0JyBhcyBjb25zdCxcbiAgICAgICAgICAgIHNvdXJjZSxcbiAgICAgICAgICAgIGZpbGVOYW1lOiBwYXRoLnJlbGF0aXZlKGNhY2hlLnNyY0RpciEsIHNyY1BhdGgpLFxuICAgICAgICAgIH1cbiAgICAgICAgfSksXG4gICAgICApXG5cbiAgICAgIGFzc2V0cy5mb3JFYWNoKChhc3NldCkgPT4ge1xuICAgICAgICB0aGlzLmVtaXRGaWxlKGFzc2V0KVxuICAgICAgfSlcblxuICAgICAgd2FybkRlcHJlY2F0ZWRPcHRpb25zLmNhbGwoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIHtcbiAgICAgICAgICBicm93c2VyUG9seWZpbGwsXG4gICAgICAgICAgY3Jvc3NCcm93c2VyLFxuICAgICAgICAgIGR5bmFtaWNJbXBvcnRXcmFwcGVyLFxuICAgICAgICAgIGZpcnN0Q2xhc3NNYW5pZmVzdCxcbiAgICAgICAgICBpaWZlSnNvblBhdGhzLFxuICAgICAgICAgIHB1YmxpY0tleSxcbiAgICAgICAgfSxcbiAgICAgICAgY2FjaGUsXG4gICAgICApXG5cbiAgICAgIC8vIE1WMiBtYW5pZmVzdCBpcyBoYW5kbGVkIGluIGBnZW5lcmF0ZUJ1bmRsZWBcbiAgICAgIGlmIChpc01WMihjYWNoZS5tYW5pZmVzdCkpIHJldHVyblxuXG4gICAgICAvKiAtLS0tLS0tLS0tIEVNSVQgQ09OVEVOVCBTQ1JJUFQgV1JBUFBFUlMgLS0tLS0tLS0tICovXG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLS0tLSBFTUlUIE1WMyBNQU5JRkVTVCAtLS0tLS0tLS0tLS0tLS0gKi9cblxuICAgICAgY29uc3QgbWFuaWZlc3RCb2R5ID0gY2xvbmVPYmplY3QoY2FjaGUubWFuaWZlc3QhKVxuICAgICAgY29uc3QgbWFuaWZlc3RKc29uID0gSlNPTi5zdHJpbmdpZnkobWFuaWZlc3RCb2R5LCB1bmRlZmluZWQsIDIpLnJlcGxhY2UoXG4gICAgICAgIC9cXC5banRdc3g/XCIvZyxcbiAgICAgICAgJy5qc1wiJyxcbiAgICAgIClcblxuICAgICAgLy8gRW1pdCBtYW5pZmVzdC5qc29uXG4gICAgICB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgdHlwZTogJ2Fzc2V0JyxcbiAgICAgICAgZmlsZU5hbWU6IG1hbmlmZXN0TmFtZSxcbiAgICAgICAgc291cmNlOiBtYW5pZmVzdEpzb24sXG4gICAgICB9KVxuICAgIH0sXG5cbiAgICBhc3luYyByZXNvbHZlSWQoc291cmNlKSB7XG4gICAgICByZXR1cm4gc291cmNlID09PSBzdHViQ2h1bmtOYW1lRm9yQ3NzT25seUNyeCB8fFxuICAgICAgICBzb3VyY2Uuc3RhcnRzV2l0aChpbXBvcnRXcmFwcGVyQ2h1bmtOYW1lUHJlZml4KVxuICAgICAgICA/IHNvdXJjZVxuICAgICAgICA6IG51bGxcbiAgICB9LFxuXG4gICAgbG9hZChpZCkge1xuICAgICAgaWYgKGlkID09PSBzdHViQ2h1bmtOYW1lRm9yQ3NzT25seUNyeCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvZGU6IGBjb25zb2xlLmxvZygke3N0dWJDaHVua05hbWVGb3JDc3NPbmx5Q3J4fSlgLFxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICB3cmFwQ29udGVudFNjcmlwdHMgJiZcbiAgICAgICAgaXNNVjMoY2FjaGUubWFuaWZlc3QpICYmXG4gICAgICAgIGlkLnN0YXJ0c1dpdGgoaW1wb3J0V3JhcHBlckNodW5rTmFtZVByZWZpeClcbiAgICAgICkge1xuICAgICAgICBjb25zdCBbLCB0YXJnZXRdID0gaWQuc3BsaXQoJzonKVxuICAgICAgICBjb25zdCBjb2RlID0gY3RXcmFwcGVyU2NyaXB0LnJlcGxhY2UoJyVQQVRIJScsIEpTT04uc3RyaW5naWZ5KHRhcmdldCkpXG4gICAgICAgIHJldHVybiB7IGNvZGUgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gbnVsbFxuICAgIH0sXG5cbiAgICB0cmFuc2Zvcm0oY29kZSwgaWQpIHtcbiAgICAgIGlmIChcbiAgICAgICAgd3JhcENvbnRlbnRTY3JpcHRzICYmXG4gICAgICAgIGlzTVYzKGNhY2hlLm1hbmlmZXN0KSAmJlxuICAgICAgICBjYWNoZS5jb250ZW50U2NyaXB0cy5pbmNsdWRlcyhpZClcbiAgICAgICkge1xuICAgICAgICAvLyBVc2Ugc2xhc2ggdG8gZ3VhcmFudGVlIHN1cHBvcnQgV2luZG93c1xuICAgICAgICBjb25zdCB0YXJnZXQgPSBgJHtzbGFzaChyZWxhdGl2ZShjYWNoZS5zcmNEaXIhLCBpZCkpXG4gICAgICAgICAgLnNwbGl0KCcuJylcbiAgICAgICAgICAuc2xpY2UoMCwgLTEpXG4gICAgICAgICAgLmpvaW4oJy4nKX0uanNgXG5cbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSBnZXRJbXBvcnRDb250ZW50U2NyaXB0RmlsZU5hbWUodGFyZ2V0KVxuXG4gICAgICAgIC8vIEVtaXQgY29udGVudCBzY3JpcHQgd3JhcHBlclxuICAgICAgICB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgICBpZDogYCR7aW1wb3J0V3JhcHBlckNodW5rTmFtZVByZWZpeH06JHt0YXJnZXR9YCxcbiAgICAgICAgICB0eXBlOiAnY2h1bmsnLFxuICAgICAgICAgIGZpbGVOYW1lLFxuICAgICAgICB9KVxuICAgICAgfVxuXG4gICAgICAvLyBObyBzb3VyY2UgdHJhbnNmb3JtYXRpb24gdG9vayBwbGFjZVxuICAgICAgcmV0dXJuIHsgY29kZSwgbWFwOiBudWxsIH1cbiAgICB9LFxuXG4gICAgd2F0Y2hDaGFuZ2UoaWQpIHtcbiAgICAgIGlmIChpZC5lbmRzV2l0aChtYW5pZmVzdE5hbWUpKSB7XG4gICAgICAgIC8vIER1bXAgY2FjaGUubWFuaWZlc3QgaWYgbWFuaWZlc3QgY2hhbmdlc1xuICAgICAgICBkZWxldGUgY2FjaGUubWFuaWZlc3RcbiAgICAgICAgY2FjaGUuYXNzZXRDaGFuZ2VkID0gZmFsc2VcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEZvcmNlIG5ldyByZWFkIG9mIGNoYW5nZWQgYXNzZXRcbiAgICAgICAgY2FjaGUuYXNzZXRDaGFuZ2VkID0gY2FjaGUucmVhZEZpbGUuZGVsZXRlKGlkKVxuICAgICAgfVxuICAgIH0sXG5cbiAgICAvKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xuICAgIC8qICAgICAgICAgICAgICAgIEdFTkVSQVRFQlVORExFICAgICAgICAgICAgICAgICovXG4gICAgLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cblxuICAgIGdlbmVyYXRlQnVuZGxlKG9wdGlvbnMsIGJ1bmRsZSkge1xuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0gQ0xFQU4gVVAgU1RVQiAtLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICBkZWxldGUgYnVuZGxlW3N0dWJDaHVua05hbWVGb3JDc3NPbmx5Q3J4ICsgJy5qcyddXG5cbiAgICAgIC8vIFdlIGRvbid0IHN1cHBvcnQgY29tcGxldGVseSBlbXB0eSBidW5kbGVzXG4gICAgICBpZiAoT2JqZWN0LmtleXMoYnVuZGxlKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICdUaGUgQ2hyb21lIGV4dGVuc2lvbiBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIGFzc2V0IChodG1sIG9yIGNzcykgb3Igc2NyaXB0IGZpbGUuJyxcbiAgICAgICAgKVxuICAgICAgfVxuXG4gICAgICAvLyBNVjMgaXMgaGFuZGxlZCBpbiBgYnVpbGRTdGFydGAgdG8gc3VwcG9ydCBWaXRlXG4gICAgICBpZiAoaXNNVjMoY2FjaGUubWFuaWZlc3QpKSByZXR1cm5cblxuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuICAgICAgLyogICAgICAgICAgICAgICAgIEVNSVQgTVYyIE1BTklGRVNUICAgICAgICAgICAgICAgICAqL1xuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICAvKiAtLS0tLS0tLS0tLS0gREVSSVZFIFBFUk1JU1NJT05TIFNUQVJUIC0tLS0tLS0tLS0tICovXG5cbiAgICAgIGxldCBwZXJtaXNzaW9uczogc3RyaW5nW10gPSBbXVxuICAgICAgLy8gR2V0IG1vZHVsZSBpZHMgZm9yIGFsbCBjaHVua3NcbiAgICAgIGlmIChjYWNoZS5hc3NldENoYW5nZWQgJiYgY2FjaGUucGVybXNIYXNoKSB7XG4gICAgICAgIC8vIFBlcm1pc3Npb25zIGRpZCBub3QgY2hhbmdlXG4gICAgICAgIHBlcm1pc3Npb25zID0gSlNPTi5wYXJzZShjYWNoZS5wZXJtc0hhc2gpIGFzIHN0cmluZ1tdXG5cbiAgICAgICAgY2FjaGUuYXNzZXRDaGFuZ2VkID0gZmFsc2VcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGNodW5rcyA9IE9iamVjdC52YWx1ZXMoYnVuZGxlKS5maWx0ZXIoaXNDaHVuaylcblxuICAgICAgICAvLyBQZXJtaXNzaW9ucyBtYXkgaGF2ZSBjaGFuZ2VkXG4gICAgICAgIHBlcm1pc3Npb25zID0gQXJyYXkuZnJvbShcbiAgICAgICAgICBjaHVua3MucmVkdWNlKGRlcml2ZVBlcm1pc3Npb25zLCBuZXcgU2V0PHN0cmluZz4oKSksXG4gICAgICAgIClcblxuICAgICAgICBjb25zdCBwZXJtc0hhc2ggPSBKU09OLnN0cmluZ2lmeShwZXJtaXNzaW9ucylcblxuICAgICAgICBpZiAodmVyYm9zZSAmJiBwZXJtaXNzaW9ucy5sZW5ndGgpIHtcbiAgICAgICAgICBpZiAoIWNhY2hlLnBlcm1zSGFzaCkge1xuICAgICAgICAgICAgdGhpcy53YXJuKGBEZXRlY3RlZCBwZXJtaXNzaW9uczogJHtwZXJtaXNzaW9ucy50b1N0cmluZygpfWApXG4gICAgICAgICAgfSBlbHNlIGlmIChwZXJtc0hhc2ggIT09IGNhY2hlLnBlcm1zSGFzaCkge1xuICAgICAgICAgICAgdGhpcy53YXJuKGBEZXRlY3RlZCBuZXcgcGVybWlzc2lvbnM6ICR7cGVybWlzc2lvbnMudG9TdHJpbmcoKX1gKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNhY2hlLnBlcm1zSGFzaCA9IHBlcm1zSGFzaFxuICAgICAgfVxuXG4gICAgICBjb25zdCBjbG9uZWRNYW5pZmVzdCA9IGNsb25lT2JqZWN0KFxuICAgICAgICBjYWNoZS5tYW5pZmVzdCxcbiAgICAgICkgYXMgY2hyb21lLnJ1bnRpbWUuTWFuaWZlc3RWMlxuXG4gICAgICBjb25zdCBtYW5pZmVzdEJvZHkgPSB7XG4gICAgICAgIC4uLmNsb25lZE1hbmlmZXN0LFxuICAgICAgICBwZXJtaXNzaW9uczogY29tYmluZVBlcm1zKFxuICAgICAgICAgIHBlcm1pc3Npb25zLFxuICAgICAgICAgIGNsb25lZE1hbmlmZXN0LnBlcm1pc3Npb25zIHx8IFtdLFxuICAgICAgICApLFxuICAgICAgfVxuXG4gICAgICBjb25zdCB7XG4gICAgICAgIGJhY2tncm91bmQ6IHsgc2NyaXB0czogYmdzID0gW10gfSA9IHt9LFxuICAgICAgICBjb250ZW50X3NjcmlwdHM6IGN0cyA9IFtdLFxuICAgICAgICB3ZWJfYWNjZXNzaWJsZV9yZXNvdXJjZXM6IHdhciA9IFtdLFxuICAgICAgfSA9IG1hbmlmZXN0Qm9keVxuXG4gICAgICAvKiAtLS0tLS0tLS0tLS0gU0VUVVAgQkFDS0dST1VORCBTQ1JJUFRTIC0tLS0tLS0tLS0tICovXG5cbiAgICAgIC8vIEVtaXQgYmFja2dyb3VuZCBzY3JpcHQgd3JhcHBlcnNcbiAgICAgIGlmIChiZ3MubGVuZ3RoICYmIHdyYXBwZXJTY3JpcHQubGVuZ3RoKSB7XG4gICAgICAgIC8vIGJhY2tncm91bmQgZXhpc3RzIGJlY2F1c2UgYmdzIGhhcyBzY3JpcHRzXG4gICAgICAgIG1hbmlmZXN0Qm9keS5iYWNrZ3JvdW5kIS5zY3JpcHRzID0gYmdzXG4gICAgICAgICAgLm1hcChub3JtYWxpemVGaWxlbmFtZSlcbiAgICAgICAgICAubWFwKChzY3JpcHRQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgIC8vIExvYWRlciBzY3JpcHQgZXhpc3RzIGJlY2F1c2Ugb2YgdHlwZSBndWFyZCBhYm92ZVxuICAgICAgICAgICAgY29uc3Qgc291cmNlID1cbiAgICAgICAgICAgICAgLy8gUGF0aCB0byBtb2R1bGUgYmVpbmcgbG9hZGVkXG4gICAgICAgICAgICAgIHdyYXBwZXJTY3JpcHQucmVwbGFjZShcbiAgICAgICAgICAgICAgICAnJVBBVEglJyxcbiAgICAgICAgICAgICAgICAvLyBGaXggcGF0aCBzbGFzaGVzIHRvIHN1cHBvcnQgV2luZG93c1xuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNsYXNoKHJlbGF0aXZlKCdhc3NldHMnLCBzY3JpcHRQYXRoKSkpLFxuICAgICAgICAgICAgICApXG5cbiAgICAgICAgICAgIGNvbnN0IGFzc2V0SWQgPSB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgICAgICAgdHlwZTogJ2Fzc2V0JyxcbiAgICAgICAgICAgICAgc291cmNlLFxuICAgICAgICAgICAgICBuYW1lOiBiYXNlbmFtZShzY3JpcHRQYXRoKSxcbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmdldEZpbGVOYW1lKGFzc2V0SWQpXG4gICAgICAgICAgfSlcbiAgICAgICAgICAubWFwKChwKSA9PiBzbGFzaChwKSlcbiAgICAgIH1cblxuICAgICAgLyogLS0tLS0tLS0tLSBFTkQgU0VUVVAgQkFDS0dST1VORCBTQ1JJUFRTIC0tLS0tLS0tLSAqL1xuXG4gICAgICAvKiAtLS0tLS0tLS0tLS0tIFNFVFVQIENPTlRFTlQgU0NSSVBUUyAtLS0tLS0tLS0tLS0tICovXG5cbiAgICAgIGNvbnN0IGNvbnRlbnRTY3JpcHRzID0gY3RzLnJlZHVjZShcbiAgICAgICAgKHIsIHsganMgPSBbXSB9KSA9PiBbLi4uciwgLi4uanNdLFxuICAgICAgICBbXSBhcyBzdHJpbmdbXSxcbiAgICAgIClcblxuICAgICAgaWYgKGNvbnRlbnRTY3JpcHRXcmFwcGVyICYmIGNvbnRlbnRTY3JpcHRzLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBtZW1vaXplZEVtaXR0ZXIgPSBtZW1vaXplKChzY3JpcHRQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICBjb25zdCBzb3VyY2UgPSBjdFdyYXBwZXJTY3JpcHQucmVwbGFjZShcbiAgICAgICAgICAgICclUEFUSCUnLFxuICAgICAgICAgICAgLy8gRml4IHBhdGggc2xhc2hlcyB0byBzdXBwb3J0IFdpbmRvd3NcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNsYXNoKHJlbGF0aXZlKCdhc3NldHMnLCBzY3JpcHRQYXRoKSkpLFxuICAgICAgICAgIClcblxuICAgICAgICAgIGNvbnN0IGFzc2V0SWQgPSB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgICAgICBzb3VyY2UsXG4gICAgICAgICAgICBuYW1lOiBiYXNlbmFtZShzY3JpcHRQYXRoKSxcbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgcmV0dXJuIHRoaXMuZ2V0RmlsZU5hbWUoYXNzZXRJZClcbiAgICAgICAgfSlcblxuICAgICAgICAvLyBTZXR1cCBjb250ZW50IHNjcmlwdCBpbXBvcnQgd3JhcHBlclxuICAgICAgICBtYW5pZmVzdEJvZHkuY29udGVudF9zY3JpcHRzID0gY3RzLm1hcCgoeyBqcywgLi4ucmVzdCB9KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHR5cGVvZiBqcyA9PT0gJ3VuZGVmaW5lZCdcbiAgICAgICAgICAgID8gcmVzdFxuICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAganM6IGpzXG4gICAgICAgICAgICAgICAgICAubWFwKG5vcm1hbGl6ZUZpbGVuYW1lKVxuICAgICAgICAgICAgICAgICAgLm1hcChtZW1vaXplZEVtaXR0ZXIpXG4gICAgICAgICAgICAgICAgICAubWFwKChwKSA9PiBzbGFzaChwKSksXG4gICAgICAgICAgICAgICAgLi4ucmVzdCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICB9KVxuXG4gICAgICAgIC8vIG1ha2UgYWxsIGltcG9ydHMgJiBkeW5hbWljIGltcG9ydHMgd2ViX2FjY19yZXNcbiAgICAgICAgY29uc3QgaW1wb3J0cyA9IE9iamVjdC52YWx1ZXMoYnVuZGxlKVxuICAgICAgICAgIC5maWx0ZXIoKHgpOiB4IGlzIE91dHB1dENodW5rID0+IHgudHlwZSA9PT0gJ2NodW5rJylcbiAgICAgICAgICAucmVkdWNlKFxuICAgICAgICAgICAgKHIsIHsgaXNFbnRyeSwgZmlsZU5hbWUgfSkgPT5cbiAgICAgICAgICAgICAgLy8gR2V0IGltcG9ydGVkIGZpbGVuYW1lc1xuICAgICAgICAgICAgICAhaXNFbnRyeSA/IFsuLi5yLCBmaWxlTmFtZV0gOiByLFxuICAgICAgICAgICAgW10gYXMgc3RyaW5nW10sXG4gICAgICAgICAgKVxuXG4gICAgICAgIG1hbmlmZXN0Qm9keS53ZWJfYWNjZXNzaWJsZV9yZXNvdXJjZXMgPSBBcnJheS5mcm9tKFxuICAgICAgICAgIG5ldyBTZXQoW1xuICAgICAgICAgICAgLi4ud2FyLFxuICAgICAgICAgICAgLy8gRkVBVFVSRTogZmlsdGVyIG91dCBpbXBvcnRzIGZvciBiYWNrZ3JvdW5kP1xuICAgICAgICAgICAgLi4uaW1wb3J0cyxcbiAgICAgICAgICAgIC8vIE5lZWQgdG8gYmUgd2ViIGFjY2Vzc2libGUgYi9jIG9mIGltcG9ydFxuICAgICAgICAgICAgLi4uY29udGVudFNjcmlwdHMsXG4gICAgICAgICAgXSksXG4gICAgICAgICkubWFwKChwKSA9PiBzbGFzaChwKSlcblxuICAgICAgICAvKiAtLS0tLS0tLS0tLSBFTkQgU0VUVVAgQ09OVEVOVCBTQ1JJUFRTIC0tLS0tLS0tLS0tICovXG4gICAgICB9XG5cbiAgICAgIC8qIC0tLS0tLS0tLSBTVEFCTEUgRVhURU5TSU9OIElEIEJFR0lOIC0tLS0tLS0tICovXG5cbiAgICAgIGlmIChwdWJsaWNLZXkpIHtcbiAgICAgICAgbWFuaWZlc3RCb2R5LmtleSA9IHB1YmxpY0tleVxuICAgICAgfVxuXG4gICAgICAvKiAtLS0tLS0tLS0tIFNUQUJMRSBFWFRFTlNJT04gSUQgRU5EIC0tLS0tLS0tLSAqL1xuXG4gICAgICAvKiAtLS0tLS0tLS0tLSBPVVRQVVQgTUFOSUZFU1QuSlNPTiBCRUdJTiAtLS0tLS0tLS0tICovXG5cbiAgICAgIGNvbnN0IG1hbmlmZXN0SnNvbiA9IEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0Qm9keSwgbnVsbCwgMikucmVwbGFjZShcbiAgICAgICAgL1xcLltqdF1zeD9cIi9nLFxuICAgICAgICAnLmpzXCInLFxuICAgICAgKVxuXG4gICAgICAvLyBFbWl0IG1hbmlmZXN0Lmpzb25cbiAgICAgIHRoaXMuZW1pdEZpbGUoe1xuICAgICAgICB0eXBlOiAnYXNzZXQnLFxuICAgICAgICBmaWxlTmFtZTogbWFuaWZlc3ROYW1lLFxuICAgICAgICBzb3VyY2U6IG1hbmlmZXN0SnNvbixcbiAgICAgIH0pXG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLSBPVVRQVVQgTUFOSUZFU1QuSlNPTiBFTkQgLS0tLS0tLS0tLS0gKi9cbiAgICB9LFxuICB9XG59XG5cbmV4cG9ydCBkZWZhdWx0IG1hbmlmZXN0SW5wdXRcbiIsImltcG9ydCB7IGNvZGUgYXMgZXhlY3V0ZVNjcmlwdFBvbHlmaWxsIH0gZnJvbSAnY29kZSAuL2Jyb3dzZXIvZXhlY3V0ZVNjcmlwdFBvbHlmaWxsLnRzJ1xuaW1wb3J0IGZzIGZyb20gJ2ZzLWV4dHJhJ1xuaW1wb3J0IHsgUGx1Z2luIH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHsgaXNBc3NldCB9IGZyb20gJy4uL2hlbHBlcnMnXG5pbXBvcnQgeyBpc01WMyB9IGZyb20gJy4uL21hbmlmZXN0LXR5cGVzJ1xuaW1wb3J0IHsgQ2hyb21lRXh0ZW5zaW9uUGx1Z2luLCBNYW5pZmVzdElucHV0UGx1Z2luIH0gZnJvbSAnLi4vcGx1Z2luLW9wdGlvbnMnXG5cbmNvbnN0IGRlZmF1bHRPcHRpb25zID0geyBleGVjdXRlU2NyaXB0OiB0cnVlIH1cbmV4cG9ydCBmdW5jdGlvbiBicm93c2VyUG9seWZpbGwoe1xuICBicm93c2VyUG9seWZpbGw6IG9wdGlvbnMgPSBkZWZhdWx0T3B0aW9ucyxcbn06IFBpY2s8TWFuaWZlc3RJbnB1dFBsdWdpbiwgJ2Jyb3dzZXJQb2x5ZmlsbCc+KTogUGljazxcbiAgUmVxdWlyZWQ8UGx1Z2luPixcbiAgJ25hbWUnIHwgJ2dlbmVyYXRlQnVuZGxlJ1xuPiB7XG4gIGlmIChvcHRpb25zID09PSBmYWxzZSlcbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogJ25vLW9wJyxcbiAgICAgIGdlbmVyYXRlQnVuZGxlKCkge30sXG4gICAgfVxuICBlbHNlIGlmIChvcHRpb25zID09PSB0cnVlKSBvcHRpb25zID0gZGVmYXVsdE9wdGlvbnNcbiAgY29uc3QgeyBleGVjdXRlU2NyaXB0ID0gdHJ1ZSB9ID0gb3B0aW9uc1xuXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdmFyLXJlcXVpcmVzXG4gIGNvbnN0IGNvbnZlcnQgPSByZXF1aXJlKCdjb252ZXJ0LXNvdXJjZS1tYXAnKVxuICBjb25zdCBwb2x5ZmlsbFBhdGggPSByZXF1aXJlLnJlc29sdmUoJ3dlYmV4dGVuc2lvbi1wb2x5ZmlsbCcpXG4gIGNvbnN0IHNyYyA9IGZzLnJlYWRGaWxlU3luYyhwb2x5ZmlsbFBhdGgsICd1dGYtOCcpXG4gIGNvbnN0IG1hcCA9IGZzLnJlYWRKc29uU3luYyhwb2x5ZmlsbFBhdGggKyAnLm1hcCcpXG5cbiAgY29uc3QgYnJvd3NlclBvbHlmaWxsU3JjID0gW1xuICAgIGNvbnZlcnQucmVtb3ZlTWFwRmlsZUNvbW1lbnRzKHNyYyksXG4gICAgY29udmVydC5mcm9tT2JqZWN0KG1hcCkudG9Db21tZW50KCksXG4gIF0uam9pbignXFxuJylcblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdicm93c2VyLXBvbHlmaWxsJyxcbiAgICBnZW5lcmF0ZUJ1bmRsZSh7IHBsdWdpbnMgPSBbXSB9LCBidW5kbGUpIHtcbiAgICAgIGNvbnN0IGZpcmVmb3hQbHVnaW4gPSBwbHVnaW5zLmZpbmQoKHsgbmFtZSB9KSA9PiBuYW1lID09PSAnZmlyZWZveC1hZGRvbicpXG4gICAgICBjb25zdCBjaHJvbWVFeHRlbnNpb25QbHVnaW4gPSBwbHVnaW5zLmZpbmQoXG4gICAgICAgICh7IG5hbWUgfSkgPT4gbmFtZSA9PT0gJ2Nocm9tZS1leHRlbnNpb24nLFxuICAgICAgKSBhcyBDaHJvbWVFeHRlbnNpb25QbHVnaW5cblxuICAgICAgaWYgKFxuICAgICAgICBmaXJlZm94UGx1Z2luICYmXG4gICAgICAgICFjaHJvbWVFeHRlbnNpb25QbHVnaW4uX3BsdWdpbnMubWFuaWZlc3QuY3Jvc3NCcm93c2VyXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIC8vIERvbid0IG5lZWQgdG8gYWRkIGl0XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1hbmlmZXN0QXNzZXQgPSBidW5kbGVbJ21hbmlmZXN0Lmpzb24nXVxuICAgICAgaWYgKCFpc0Fzc2V0KG1hbmlmZXN0QXNzZXQpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgYG1hbmlmZXN0Lmpzb24gbXVzdCBiZSBhbiBPdXRwdXRBc3NldCwgcmVjZWl2ZWQgXCIke3R5cGVvZiBtYW5pZmVzdEFzc2V0fVwiYCxcbiAgICAgICAgKVxuICAgICAgfVxuICAgICAgY29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKFxuICAgICAgICBtYW5pZmVzdEFzc2V0LnNvdXJjZSBhcyBzdHJpbmcsXG4gICAgICApIGFzIGNocm9tZS5ydW50aW1lLk1hbmlmZXN0XG5cbiAgICAgIC8qIC0tLS0tLS0tLS0tLS0gRU1JVCBCUk9XU0VSIFBPTFlGSUxMIC0tLS0tLS0tLS0tLS0gKi9cblxuICAgICAgLy8gQnJvd3NlciBwb2x5ZmlsbCBpcyBub3Qgc3VwcG9ydGVkIGZvciBNVjMsIHRoZXJlIGFyZSBiZXR0ZXIgd2F5cyB0byBkbyB0aGlzOlxuICAgICAgLy8gICBgaW1wb3J0IGJyb3dzZXIgZnJvbSBcIndlYmV4dGVuc2lvbi1wb2x5ZmlsbFwiO2BcbiAgICAgIC8vICAgU2VlOiBodHRwczovL2dpdGh1Yi5jb20vTHVzaXRvL3dlYmV4dGVuc2lvbi1wb2x5ZmlsbC10cyNtaWdyYXRpb24tZ3VpZGUtZnJvbS13ZWJleHRlbnNpb24tcG9seWZpbGwtdHNcbiAgICAgIGlmIChpc01WMyhtYW5pZmVzdCkpIHJldHVyblxuXG4gICAgICBjb25zdCBicElkID0gdGhpcy5lbWl0RmlsZSh7XG4gICAgICAgIHR5cGU6ICdhc3NldCcsXG4gICAgICAgIHNvdXJjZTogYnJvd3NlclBvbHlmaWxsU3JjLFxuICAgICAgICBmaWxlTmFtZTogJ2Fzc2V0cy9icm93c2VyLXBvbHlmaWxsLmpzJyxcbiAgICAgIH0pXG5cbiAgICAgIGNvbnN0IGJyb3dzZXJQb2x5ZmlsbFBhdGggPSB0aGlzLmdldEZpbGVOYW1lKGJwSWQpXG5cbiAgICAgIGlmIChleGVjdXRlU2NyaXB0KSB7XG4gICAgICAgIGNvbnN0IGV4SWQgPSB0aGlzLmVtaXRGaWxlKHtcbiAgICAgICAgICB0eXBlOiAnYXNzZXQnLFxuICAgICAgICAgIHNvdXJjZTogZXhlY3V0ZVNjcmlwdFBvbHlmaWxsLnJlcGxhY2UoXG4gICAgICAgICAgICAnJUJST1dTRVJfUE9MWUZJTExfUEFUSCUnLFxuICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoYnJvd3NlclBvbHlmaWxsUGF0aCksXG4gICAgICAgICAgKSxcbiAgICAgICAgICBmaWxlTmFtZTogJ2Fzc2V0cy9icm93c2VyLXBvbHlmaWxsLWV4ZWN1dGVTY3JpcHQuanMnLFxuICAgICAgICB9KVxuXG4gICAgICAgIGNvbnN0IGV4ZWN1dGVTY3JpcHRQb2x5ZmlsbFBhdGggPSB0aGlzLmdldEZpbGVOYW1lKGV4SWQpXG5cbiAgICAgICAgLy8gVE9ETzogc3VwcG9ydCB0aGlzIGluIE1WM1xuICAgICAgICBtYW5pZmVzdC5iYWNrZ3JvdW5kPy5zY3JpcHRzPy51bnNoaWZ0KGV4ZWN1dGVTY3JpcHRQb2x5ZmlsbFBhdGgpXG4gICAgICB9XG5cbiAgICAgIC8vIFRPRE86IHN1cHBvcnQgdGhpcyBpbiBNVjNcbiAgICAgIG1hbmlmZXN0LmJhY2tncm91bmQ/LnNjcmlwdHM/LnVuc2hpZnQoYnJvd3NlclBvbHlmaWxsUGF0aClcbiAgICAgIG1hbmlmZXN0LmNvbnRlbnRfc2NyaXB0cz8uZm9yRWFjaCgoc2NyaXB0KSA9PiB7XG4gICAgICAgIHNjcmlwdC5qcz8udW5zaGlmdChicm93c2VyUG9seWZpbGxQYXRoKVxuICAgICAgfSlcblxuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tLSBVUERBVEUgTUFOSUZFU1QgLS0tLS0tLS0tLS0tLS0tLSAqL1xuICAgICAgbWFuaWZlc3RBc3NldC5zb3VyY2UgPSBKU09OLnN0cmluZ2lmeShtYW5pZmVzdClcbiAgICB9LFxuICB9XG59XG4iLCJpbXBvcnQgeyBiYXNlbmFtZSB9IGZyb20gJ3BhdGgnXG5pbXBvcnQgeyBPdXRwdXRBc3NldCwgT3V0cHV0Q2h1bmssIFBsdWdpbiB9IGZyb20gJ3JvbGx1cCdcblxuaW50ZXJmYWNlIE1hbmlmZXN0QXNzZXQgZXh0ZW5kcyBPdXRwdXRBc3NldCB7XG4gIHNvdXJjZTogc3RyaW5nXG59XG5cbmV4cG9ydCB0eXBlIFZhbGlkYXRlTmFtZXNQbHVnaW4gPSBQaWNrPFxuICBSZXF1aXJlZDxQbHVnaW4+LFxuICAnbmFtZScgfCAnZ2VuZXJhdGVCdW5kbGUnXG4+XG5cbmV4cG9ydCBjb25zdCB2YWxpZGF0ZU5hbWVzID0gKCk6IFZhbGlkYXRlTmFtZXNQbHVnaW4gPT4gKHtcbiAgbmFtZTogJ3ZhbGlkYXRlLW5hbWVzJyxcblxuICBnZW5lcmF0ZUJ1bmRsZShvcHRpb25zLCBidW5kbGUpIHtcbiAgICBjb25zdCBjaHVua3MgPSBPYmplY3QudmFsdWVzKGJ1bmRsZSkuZmlsdGVyKFxuICAgICAgKHgpOiB4IGlzIE91dHB1dENodW5rID0+IHgudHlwZSA9PT0gJ2NodW5rJyxcbiAgICApXG5cbiAgICAvLyBGaWxlcyBjYW5ub3Qgc3RhcnQgd2l0aCBcIl9cIiBpbiBDaHJvbWUgRXh0ZW5zaW9ucywgYnV0IGZvbGRlcnMgQ0FOIHN0YXJ0IHdpdGggXCJfXCJcbiAgICAvLyBSb2xsdXAgbWF5IG91dHB1dCBhIGhlbHBlciBmaWxlIHRoYXQgc3RhcnRzIHdpdGggXCJfY29tbW9uanNIZWxwZXJzXCJcbiAgICAvLyBMb29wIHRocm91Z2ggZWFjaCBmaWxlIGFuZCBjaGVjayBmb3IgXCJfY29tbW9uanNIZWxwZXJzXCIgaW4gZmlsZW5hbWVcbiAgICBPYmplY3Qua2V5cyhidW5kbGUpXG4gICAgICAuZmlsdGVyKChmaWxlTmFtZSkgPT4gYmFzZW5hbWUoZmlsZU5hbWUpLnN0YXJ0c1dpdGgoJ19jb21tb25qc0hlbHBlcnMnKSlcbiAgICAgIC5mb3JFYWNoKChmaWxlTmFtZSkgPT4ge1xuICAgICAgICAvLyBPbmx5IHJlcGxhY2UgZmlyc3QgaW5zdGFuY2VcbiAgICAgICAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGZpbGVOYW1lKVxuICAgICAgICBjb25zdCBbYmFzZSwgLi4ucmVzdF0gPSBmaWxlTmFtZS5zcGxpdCgnLycpLnJldmVyc2UoKVxuICAgICAgICBjb25zdCBmaXhlZCA9IFtiYXNlLnNsaWNlKDEpLCAuLi5yZXN0XS5yZXZlcnNlKCkuam9pbignLycpXG5cbiAgICAgICAgLy8gRml4IG1hbmlmZXN0XG4gICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gYnVuZGxlWydtYW5pZmVzdC5qc29uJ10gYXMgTWFuaWZlc3RBc3NldFxuICAgICAgICBtYW5pZmVzdC5zb3VyY2UgPSBtYW5pZmVzdC5zb3VyY2UucmVwbGFjZShyZWdleCwgZml4ZWQpXG5cbiAgICAgICAgLy8gQ2hhbmdlIGJ1bmRsZSBrZXlcbiAgICAgICAgY29uc3QgY2h1bmsgPSBidW5kbGVbZmlsZU5hbWVdXG4gICAgICAgIGRlbGV0ZSBidW5kbGVbZmlsZU5hbWVdXG4gICAgICAgIGJ1bmRsZVtmaXhlZF0gPSBjaHVua1xuXG4gICAgICAgIC8vIEZpeCBjaHVua1xuICAgICAgICBjaHVuay5maWxlTmFtZSA9IGZpeGVkXG5cbiAgICAgICAgLy8gRmluZCBpbXBvcnRzIGFuZCBmaXhcbiAgICAgICAgY2h1bmtzXG4gICAgICAgICAgLmZpbHRlcigoeyBpbXBvcnRzIH0pID0+IGltcG9ydHMuaW5jbHVkZXMoZmlsZU5hbWUpKVxuICAgICAgICAgIC5mb3JFYWNoKChjaHVuaykgPT4ge1xuICAgICAgICAgICAgLy8gRml4IGltcG9ydHMgbGlzdFxuICAgICAgICAgICAgY2h1bmsuaW1wb3J0cyA9IGNodW5rLmltcG9ydHMubWFwKChpKSA9PlxuICAgICAgICAgICAgICBpID09PSBmaWxlTmFtZSA/IGZpeGVkIDogaSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC8vIEZpeCBpbXBvcnRzIGluIGNvZGVcbiAgICAgICAgICAgIGNodW5rLmNvZGUgPSBjaHVuay5jb2RlLnJlcGxhY2UocmVnZXgsIGZpeGVkKVxuICAgICAgICAgIH0pXG4gICAgICB9KVxuICB9LFxufSlcbiIsImltcG9ydCBwYXRoIGZyb20gJ3BhdGgnXG5pbXBvcnQgeyBPdXRwdXRCdW5kbGUgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyBQbHVnaW4gfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyBpc0NodW5rIH0gZnJvbSAnLi4vaGVscGVycydcblxuZXhwb3J0IGNvbnN0IHJlc29sdmVGcm9tQnVuZGxlID0gKGJ1bmRsZTogT3V0cHV0QnVuZGxlKTogUGx1Z2luID0+ICh7XG4gIG5hbWU6ICdyZXNvbHZlLWZyb20tYnVuZGxlJyxcbiAgcmVzb2x2ZUlkKHNvdXJjZSwgaW1wb3J0ZXIpIHtcbiAgICBpZiAodHlwZW9mIGltcG9ydGVyID09PSAndW5kZWZpbmVkJykge1xuICAgICAgcmV0dXJuIHNvdXJjZVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBkaXJuYW1lID0gcGF0aC5kaXJuYW1lKGltcG9ydGVyKVxuICAgICAgY29uc3QgcmVzb2x2ZWQgPSBwYXRoLmpvaW4oZGlybmFtZSwgc291cmNlKVxuXG4gICAgICAvLyBpZiBpdCdzIG5vdCBpbiB0aGUgYnVuZGxlLFxuICAgICAgLy8gICB0ZWxsIFJvbGx1cCBub3QgdG8gdHJ5IHRvIHJlc29sdmUgaXRcbiAgICAgIHJldHVybiByZXNvbHZlZCBpbiBidW5kbGUgPyByZXNvbHZlZCA6IGZhbHNlXG4gICAgfVxuICB9LFxuICBsb2FkKGlkKSB7XG4gICAgY29uc3QgY2h1bmsgPSBidW5kbGVbaWRdXG5cbiAgICBpZiAoaXNDaHVuayhjaHVuaykpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvZGU6IGNodW5rLmNvZGUsXG4gICAgICAgIG1hcDogY2h1bmsubWFwLFxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBhbnl0aGluZyBub3QgaW4gdGhlIGJ1bmRsZSBpcyBleHRlcm5hbFxuICAgICAgLy8gIHRoaXMgZG9lc24ndCBtYWtlIHNlbnNlIGZvciBhIGNocm9tZSBleHRlbnNpb24sXG4gICAgICAvLyAgICBidXQgd2Ugc2hvdWxkIGxldCBSb2xsdXAgaGFuZGxlIGl0XG4gICAgICByZXR1cm4gbnVsbFxuICAgIH1cbiAgfSxcbn0pXG4iLCJpbXBvcnQgcGF0aCBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgT3V0cHV0Q2h1bmsgfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyBSb2xsdXBPcHRpb25zIH0gZnJvbSAncm9sbHVwJ1xuaW1wb3J0IHsgUGx1Z2luLCBPdXRwdXRCdW5kbGUsIFBsdWdpbkNvbnRleHQsIHJvbGx1cCB9IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IHJlc29sdmVGcm9tQnVuZGxlIH0gZnJvbSAnLi9yZXNvbHZlRnJvbUJ1bmRsZSdcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZ2VuZXJhdGVCdW5kbGUoXG4gIHRoaXM6IFBsdWdpbkNvbnRleHQsXG4gIHsgaW5wdXQsIG91dHB1dCB9OiBSb2xsdXBPcHRpb25zLFxuICBidW5kbGU6IE91dHB1dEJ1bmRsZSxcbik6IFByb21pc2U8T3V0cHV0QnVuZGxlPiB7XG4gIGlmICghb3V0cHV0IHx8IEFycmF5LmlzQXJyYXkob3V0cHV0KSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ29wdGlvbnMub3V0cHV0IG11c3QgYmUgYW4gT3V0cHV0T3B0aW9ucyBvYmplY3QnKVxuICB9XG5cbiAgaWYgKHR5cGVvZiBpbnB1dCA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFxuICAgICAgJ29wdGlvbnMuaW5wdXQgc2hvdWxkIGJlIGFuIG9iamVjdCwgc3RyaW5nIGFycmF5IG9yIHN0cmluZycsXG4gICAgKVxuICB9XG5cbiAgLy8gRG9uJ3QgZG8gYW55dGhpbmcgaWYgaW5wdXQgaXMgYW4gZW1wdHkgYXJyYXlcbiAgaWYgKEFycmF5LmlzQXJyYXkoaW5wdXQpICYmIGlucHV0Lmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7fVxuICB9XG5cbiAgY29uc3QgeyBmb3JtYXQsIGNodW5rRmlsZU5hbWVzOiBjZm4gPSAnJywgc291cmNlbWFwIH0gPSBvdXRwdXRcblxuICBjb25zdCBjaHVua0ZpbGVOYW1lcyA9IHBhdGguam9pbihwYXRoLmRpcm5hbWUoY2ZuIGFzIHN0cmluZyksICdbbmFtZV0uanMnKVxuXG4gIC8vIFRyYW5zZm9ybSBpbnB1dCBhcnJheSB0byBpbnB1dCBvYmplY3RcbiAgY29uc3QgaW5wdXRWYWx1ZSA9IEFycmF5LmlzQXJyYXkoaW5wdXQpXG4gICAgPyBpbnB1dC5yZWR1Y2UoKHIsIHgpID0+IHtcbiAgICAgICAgY29uc3QgeyBkaXIsIG5hbWUgfSA9IHBhdGgucGFyc2UoeClcbiAgICAgICAgcmV0dXJuIHsgLi4uciwgW3BhdGguam9pbihkaXIsIG5hbWUpXTogeCB9XG4gICAgICB9LCB7fSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KVxuICAgIDogaW5wdXRcblxuICBjb25zdCBidWlsZCA9IGF3YWl0IHJvbGx1cCh7XG4gICAgaW5wdXQ6IGlucHV0VmFsdWUsXG4gICAgcGx1Z2luczogW3Jlc29sdmVGcm9tQnVuZGxlKGJ1bmRsZSldLFxuICB9KVxuXG4gIGxldCBfYjogT3V0cHV0QnVuZGxlXG4gIGF3YWl0IGJ1aWxkLmdlbmVyYXRlKHtcbiAgICBmb3JtYXQsXG4gICAgc291cmNlbWFwLFxuICAgIGNodW5rRmlsZU5hbWVzLFxuICAgIHBsdWdpbnM6IFtcbiAgICAgIHtcbiAgICAgICAgbmFtZTogJ2dldC1idW5kbGUnLFxuICAgICAgICBnZW5lcmF0ZUJ1bmRsZShvLCBiKSB7XG4gICAgICAgICAgX2IgPSBiXG4gICAgICAgIH0sXG4gICAgICB9IGFzIFBsdWdpbixcbiAgICBdLFxuICB9KVxuICBjb25zdCBuZXdCdW5kbGUgPSBfYiFcblxuICBpZiAodHlwZW9mIGlucHV0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgZGVsZXRlIGJ1bmRsZVtpbnB1dFZhbHVlXVxuXG4gICAgY29uc3QgYnVuZGxlS2V5ID0gcGF0aC5iYXNlbmFtZShpbnB1dFZhbHVlKVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIFtpbnB1dFZhbHVlXToge1xuICAgICAgICAuLi4obmV3QnVuZGxlW2J1bmRsZUtleV0gYXMgT3V0cHV0Q2h1bmspLFxuICAgICAgICBmaWxlTmFtZTogaW5wdXRWYWx1ZSxcbiAgICAgIH0sXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIFJlbW92ZSByZWdlbmVyYXRlZCBlbnRyaWVzIGZyb20gYnVuZGxlXG4gICAgT2JqZWN0LnZhbHVlcyhpbnB1dFZhbHVlKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIGRlbGV0ZSBidW5kbGVba2V5XVxuICAgIH0pXG5cbiAgICByZXR1cm4gbmV3QnVuZGxlXG4gIH1cbn1cbiIsImltcG9ydCB7XG4gIFBsdWdpbixcbiAgT3V0cHV0QnVuZGxlLFxuICBPdXRwdXRPcHRpb25zLFxuICBQbHVnaW5Db250ZXh0LFxuICBNb2R1bGVGb3JtYXQsXG59IGZyb20gJ3JvbGx1cCdcbmltcG9ydCB7IGlzQ2h1bmsgfSBmcm9tICcuLi9oZWxwZXJzJ1xuaW1wb3J0IHsgTWFuaWZlc3RJbnB1dFBsdWdpbiB9IGZyb20gJy4uL3BsdWdpbi1vcHRpb25zJ1xuaW1wb3J0IHsgcmVnZW5lcmF0ZUJ1bmRsZSB9IGZyb20gJy4vcmVnZW5lcmF0ZUJ1bmRsZSdcblxuZXhwb3J0IGZ1bmN0aW9uIG1peGVkRm9ybWF0KFxuICBvcHRpb25zOiBQaWNrPE1hbmlmZXN0SW5wdXRQbHVnaW4sICdmb3JtYXRNYXAnPixcbik6IFBpY2s8UmVxdWlyZWQ8UGx1Z2luPiwgJ25hbWUnIHwgJ2dlbmVyYXRlQnVuZGxlJz4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICdtaXhlZC1mb3JtYXQnLFxuICAgIGFzeW5jIGdlbmVyYXRlQnVuZGxlKFxuICAgICAgdGhpczogUGx1Z2luQ29udGV4dCxcbiAgICAgIHsgZm9ybWF0LCBjaHVua0ZpbGVOYW1lcywgc291cmNlbWFwIH06IE91dHB1dE9wdGlvbnMsXG4gICAgICBidW5kbGU6IE91dHB1dEJ1bmRsZSxcbiAgICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAgIGNvbnN0IHsgZm9ybWF0TWFwIH0gPSBvcHRpb25zIC8vIHRoaXMgbWlnaHQgbm90IGJlIGRlZmluZWQgdXBvbiBpbml0XG5cbiAgICAgIGlmICh0eXBlb2YgZm9ybWF0TWFwID09PSAndW5kZWZpbmVkJykgcmV0dXJuXG5cbiAgICAgIGNvbnN0IGZvcm1hdHMgPSBPYmplY3QuZW50cmllcyhmb3JtYXRNYXApLmZpbHRlcihcbiAgICAgICAgKHgpOiB4IGlzIFtNb2R1bGVGb3JtYXQsIHN0cmluZ1tdIHwgUmVjb3JkPHN0cmluZywgc3RyaW5nPl0gPT5cbiAgICAgICAgICB0eXBlb2YgeFsxXSAhPT0gJ3VuZGVmaW5lZCcsXG4gICAgICApXG5cbiAgICAgIHtcbiAgICAgICAgY29uc3QgYWxsSW5wdXQgPSBmb3JtYXRzLmZsYXRNYXAoKFssIGlucHV0c10pID0+XG4gICAgICAgICAgQXJyYXkuaXNBcnJheShpbnB1dHMpID8gaW5wdXRzIDogT2JqZWN0LnZhbHVlcyhpbnB1dHMgfHwge30pLFxuICAgICAgICApXG4gICAgICAgIGNvbnN0IGFsbElucHV0U2V0ID0gbmV3IFNldChhbGxJbnB1dClcbiAgICAgICAgaWYgKGFsbElucHV0Lmxlbmd0aCAhPT0gYWxsSW5wdXRTZXQuc2l6ZSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignZm9ybWF0cyBzaG91bGQgbm90IGhhdmUgZHVwbGljYXRlIGlucHV0cycpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVE9ETzogaGFuZGxlIGRpZmZlcmVudCBraW5kcyBvZiBmb3JtYXRzIGRpZmZlcmVudGx5P1xuICAgICAgY29uc3QgYnVuZGxlcyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgICAvLyBDb25maWd1cmVkIGZvcm1hdHNcbiAgICAgICAgZm9ybWF0cy5mbGF0TWFwKChbZiwgaW5wdXRzXSkgPT5cbiAgICAgICAgICAoQXJyYXkuaXNBcnJheShpbnB1dHMpID8gaW5wdXRzIDogT2JqZWN0LnZhbHVlcyhpbnB1dHMpKS5tYXAoXG4gICAgICAgICAgICAoaW5wdXQpID0+XG4gICAgICAgICAgICAgIHJlZ2VuZXJhdGVCdW5kbGUuY2FsbChcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIGlucHV0LFxuICAgICAgICAgICAgICAgICAgb3V0cHV0OiB7XG4gICAgICAgICAgICAgICAgICAgIGZvcm1hdDogZixcbiAgICAgICAgICAgICAgICAgICAgY2h1bmtGaWxlTmFtZXMsXG4gICAgICAgICAgICAgICAgICAgIHNvdXJjZW1hcCxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBidW5kbGUsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgKSxcbiAgICAgICAgKSxcbiAgICAgIClcblxuICAgICAgLy8gQmFzZSBmb3JtYXQgKEVTTSlcbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCByZWdlbmVyYXRlQnVuZGxlLmNhbGwoXG4gICAgICAgIHRoaXMsXG4gICAgICAgIHtcbiAgICAgICAgICBpbnB1dDogT2JqZWN0LmVudHJpZXMoYnVuZGxlKVxuICAgICAgICAgICAgLmZpbHRlcigoWywgZmlsZV0pID0+IGlzQ2h1bmsoZmlsZSkgJiYgZmlsZS5pc0VudHJ5KVxuICAgICAgICAgICAgLm1hcCgoW2tleV0pID0+IGtleSksXG4gICAgICAgICAgb3V0cHV0OiB7IGZvcm1hdCwgY2h1bmtGaWxlTmFtZXMsIHNvdXJjZW1hcCB9LFxuICAgICAgICB9LFxuICAgICAgICBidW5kbGUsXG4gICAgICApXG5cbiAgICAgIC8vIEVtcHR5IGJ1bmRsZVxuICAgICAgT2JqZWN0LmVudHJpZXMoYnVuZGxlKVxuICAgICAgICAuZmlsdGVyKChbLCB2XSkgPT4gaXNDaHVuayh2KSlcbiAgICAgICAgLmZvckVhY2goKFtrZXldKSA9PiB7XG4gICAgICAgICAgZGVsZXRlIGJ1bmRsZVtrZXldXG4gICAgICAgIH0pXG5cbiAgICAgIC8vIFJlZmlsbCBidW5kbGVcbiAgICAgIE9iamVjdC5hc3NpZ24oYnVuZGxlLCBiYXNlLCAuLi5idW5kbGVzKVxuICAgIH0sXG4gIH1cbn1cbiIsIi8qIC0tLS0tLS0tLS0tLS0tLS0tLS0gRklMRU5BTUVTIC0tLS0tLS0tLS0tLS0tLS0tLS0gKi9cblxuZXhwb3J0IGNvbnN0IGJhY2tncm91bmRQYWdlUmVsb2FkZXIgPSAnYmFja2dyb3VuZC1wYWdlLXJlbG9hZGVyLmpzJ1xuZXhwb3J0IGNvbnN0IGNvbnRlbnRTY3JpcHRSZWxvYWRlciA9ICdjb250ZW50LXNjcmlwdC1yZWxvYWRlci5qcydcbmV4cG9ydCBjb25zdCB0aW1lc3RhbXBGaWxlbmFtZSA9ICd0aW1lc3RhbXAuanNvbidcblxuLyogLS0tLS0tLS0tLS0tLS0tLS0tIFBMQUNFSE9MREVSUyAtLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG5leHBvcnQgY29uc3QgdGltZXN0YW1wUGF0aFBsYWNlaG9sZGVyID0gJyVUSU1FU1RBTVBfUEFUSCUnXG5leHBvcnQgY29uc3QgbG9hZE1lc3NhZ2VQbGFjZWhvbGRlciA9ICclTE9BRF9NRVNTQUdFJSdcbmV4cG9ydCBjb25zdCBjdFNjcmlwdFBhdGhQbGFjZWhvbGRlciA9ICclQ09OVEVOVF9TQ1JJUFRfUEFUSCUnXG5leHBvcnQgY29uc3QgdW5yZWdpc3RlclNlcnZpY2VXb3JrZXJzUGxhY2Vob2xkZXIgPVxuICAnJVVOUkVHSVNURVJfU0VSVklDRV9XT1JLRVJTJSdcbmV4cG9ydCBjb25zdCBleGVjdXRlU2NyaXB0UGxhY2Vob2xkZXIgPSAnJUVYRUNVVEVfU0NSSVBUJSdcbiIsImltcG9ydCB7IGNvZGUgYXMgYmdDbGllbnRDb2RlIH0gZnJvbSAnY29kZSAuL2NsaWVudC9iYWNrZ3JvdW5kLnRzJ1xuaW1wb3J0IHsgY29kZSBhcyBjdENsaWVudENvZGUgfSBmcm9tICdjb2RlIC4vY2xpZW50L2NvbnRlbnQudHMnXG5pbXBvcnQgeyBvdXRwdXRKc29uIH0gZnJvbSAnZnMtZXh0cmEnXG5pbXBvcnQgeyBzZXQgfSBmcm9tICdsb2Rhc2gnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCdcbmltcG9ydCB7IE91dHB1dENodW5rLCBQbHVnaW4gfSBmcm9tICdyb2xsdXAnXG5pbXBvcnQgeyB1cGRhdGVNYW5pZmVzdCB9IGZyb20gJy4uL2hlbHBlcnMnXG5pbXBvcnQge1xuICBiYWNrZ3JvdW5kUGFnZVJlbG9hZGVyLFxuICBjb250ZW50U2NyaXB0UmVsb2FkZXIsXG4gIGN0U2NyaXB0UGF0aFBsYWNlaG9sZGVyLFxuICBleGVjdXRlU2NyaXB0UGxhY2Vob2xkZXIsXG4gIGxvYWRNZXNzYWdlUGxhY2Vob2xkZXIsXG4gIHRpbWVzdGFtcEZpbGVuYW1lLFxuICB0aW1lc3RhbXBQYXRoUGxhY2Vob2xkZXIsXG4gIHVucmVnaXN0ZXJTZXJ2aWNlV29ya2Vyc1BsYWNlaG9sZGVyLFxufSBmcm9tICcuL0NPTlNUQU5UUydcblxuY29uc3QgZGVsYXkgPSAobXM6IG51bWJlcikgPT4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpKVxuXG5leHBvcnQgdHlwZSBTaW1wbGVSZWxvYWRlclBsdWdpbiA9IFBpY2s8XG4gIFJlcXVpcmVkPFBsdWdpbj4sXG4gICduYW1lJyB8ICdnZW5lcmF0ZUJ1bmRsZScgfCAnd3JpdGVCdW5kbGUnXG4+XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2ltcGxlUmVsb2FkZXJPcHRpb25zIHtcbiAgZXhlY3V0ZVNjcmlwdD86IGJvb2xlYW5cbiAgdW5yZWdpc3RlclNlcnZpY2VXb3JrZXJzPzogYm9vbGVhblxuICByZWxvYWREZWxheT86IG51bWJlclxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNpbXBsZVJlbG9hZGVyQ2FjaGUge1xuICBiZ1NjcmlwdFBhdGg/OiBzdHJpbmdcbiAgY3RTY3JpcHRQYXRoPzogc3RyaW5nXG4gIHRpbWVzdGFtcFBhdGg/OiBzdHJpbmdcbiAgb3V0cHV0RGlyPzogc3RyaW5nXG4gIGxvYWRNZXNzYWdlPzogc3RyaW5nXG4gIG1hbmlmZXN0VmVyc2lvbj86IDIgfCAzXG59XG5cbi8vIFVzZWQgZm9yIHRlc3RpbmdcbmV4cG9ydCBjb25zdCBfaW50ZXJuYWxDYWNoZTogU2ltcGxlUmVsb2FkZXJDYWNoZSA9IHt9XG5cbmV4cG9ydCBjb25zdCBzaW1wbGVSZWxvYWRlciA9IChcbiAge1xuICAgIGV4ZWN1dGVTY3JpcHQgPSB0cnVlLFxuICAgIHVucmVnaXN0ZXJTZXJ2aWNlV29ya2VycyA9IHRydWUsXG4gICAgcmVsb2FkRGVsYXkgPSAxMDAsXG4gIH0gPSB7fSBhcyBTaW1wbGVSZWxvYWRlck9wdGlvbnMsXG4gIGNhY2hlID0ge30gYXMgU2ltcGxlUmVsb2FkZXJDYWNoZSxcbik6IFNpbXBsZVJlbG9hZGVyUGx1Z2luIHwgdW5kZWZpbmVkID0+IHtcbiAgaWYgKCFwcm9jZXNzLmVudi5ST0xMVVBfV0FUQ0gpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkXG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdjaHJvbWUtZXh0ZW5zaW9uLXNpbXBsZS1yZWxvYWRlcicsXG5cbiAgICBnZW5lcmF0ZUJ1bmRsZSh7IGRpciB9LCBidW5kbGUpIHtcbiAgICAgIGNvbnN0IGRhdGUgPSBuZXcgRGF0ZSgpXG4gICAgICBjb25zdCB0aW1lID0gYCR7ZGF0ZS5nZXRGdWxsWWVhcigpLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgJzAnKX0tJHsoXG4gICAgICAgIGRhdGUuZ2V0TW9udGgoKSArIDFcbiAgICAgIClcbiAgICAgICAgLnRvU3RyaW5nKClcbiAgICAgICAgLnBhZFN0YXJ0KDIsICcwJyl9LSR7ZGF0ZS5nZXREYXRlKCkudG9TdHJpbmcoKS5wYWRTdGFydCgyLCAnMCcpfSAke2RhdGVcbiAgICAgICAgLmdldEhvdXJzKClcbiAgICAgICAgLnRvU3RyaW5nKClcbiAgICAgICAgLnBhZFN0YXJ0KDIsICcwJyl9OiR7ZGF0ZVxuICAgICAgICAuZ2V0TWludXRlcygpXG4gICAgICAgIC50b1N0cmluZygpXG4gICAgICAgIC5wYWRTdGFydCgyLCAnMCcpfToke2RhdGUuZ2V0U2Vjb25kcygpLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgJzAnKX1gXG5cbiAgICAgIGNhY2hlLm91dHB1dERpciA9IGRpclxuICAgICAgY2FjaGUubG9hZE1lc3NhZ2UgPSBbXG4gICAgICAgICdERVZFTE9QTUVOVCBidWlsZCB3aXRoIHNpbXBsZSBhdXRvLXJlbG9hZGVyJyxcbiAgICAgICAgYFske3RpbWV9XSB3YWl0aW5nIGZvciBjaGFuZ2VzLi4uYCxcbiAgICAgIF0uam9pbignXFxuJylcblxuICAgICAgLyogLS0tLS0tLS0tLS0tLS0tIEVNSVQgQ0xJRU5UIEZJTEVTIC0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gICAgICBjb25zdCBlbWl0ID0gKG5hbWU6IHN0cmluZywgc291cmNlOiBzdHJpbmcsIGlzRmlsZU5hbWU/OiBib29sZWFuKSA9PiB7XG4gICAgICAgIGNvbnN0IGlkID0gdGhpcy5lbWl0RmlsZSh7XG4gICAgICAgICAgdHlwZTogJ2Fzc2V0JyxcbiAgICAgICAgICBbaXNGaWxlTmFtZSA/ICdmaWxlTmFtZScgOiAnbmFtZSddOiBuYW1lLFxuICAgICAgICAgIHNvdXJjZSxcbiAgICAgICAgfSlcblxuICAgICAgICByZXR1cm4gdGhpcy5nZXRGaWxlTmFtZShpZClcbiAgICAgIH1cblxuICAgICAgY2FjaGUudGltZXN0YW1wUGF0aCA9IGVtaXQoXG4gICAgICAgIHRpbWVzdGFtcEZpbGVuYW1lLFxuICAgICAgICBKU09OLnN0cmluZ2lmeShEYXRlLm5vdygpKSxcbiAgICAgICAgdHJ1ZSxcbiAgICAgIClcblxuICAgICAgY2FjaGUuY3RTY3JpcHRQYXRoID0gZW1pdChcbiAgICAgICAgY29udGVudFNjcmlwdFJlbG9hZGVyLFxuICAgICAgICBjdENsaWVudENvZGUucmVwbGFjZShcbiAgICAgICAgICBsb2FkTWVzc2FnZVBsYWNlaG9sZGVyLFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGNhY2hlLmxvYWRNZXNzYWdlKSxcbiAgICAgICAgKSxcbiAgICAgIClcblxuICAgICAgY2FjaGUuYmdTY3JpcHRQYXRoID0gZW1pdChcbiAgICAgICAgYmFja2dyb3VuZFBhZ2VSZWxvYWRlcixcbiAgICAgICAgYmdDbGllbnRDb2RlXG4gICAgICAgICAgLnJlcGxhY2UodGltZXN0YW1wUGF0aFBsYWNlaG9sZGVyLCBjYWNoZS50aW1lc3RhbXBQYXRoKVxuICAgICAgICAgIC5yZXBsYWNlKGxvYWRNZXNzYWdlUGxhY2Vob2xkZXIsIEpTT04uc3RyaW5naWZ5KGNhY2hlLmxvYWRNZXNzYWdlKSlcbiAgICAgICAgICAucmVwbGFjZShjdFNjcmlwdFBhdGhQbGFjZWhvbGRlciwgSlNPTi5zdHJpbmdpZnkoY2FjaGUuY3RTY3JpcHRQYXRoKSlcbiAgICAgICAgICAucmVwbGFjZShleGVjdXRlU2NyaXB0UGxhY2Vob2xkZXIsIEpTT04uc3RyaW5naWZ5KGV4ZWN1dGVTY3JpcHQpKVxuICAgICAgICAgIC5yZXBsYWNlKFxuICAgICAgICAgICAgdW5yZWdpc3RlclNlcnZpY2VXb3JrZXJzUGxhY2Vob2xkZXIsXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh1bnJlZ2lzdGVyU2VydmljZVdvcmtlcnMpLFxuICAgICAgICAgICksXG4gICAgICApXG5cbiAgICAgIC8vIFVwZGF0ZSB0aGUgZXhwb3J0ZWQgY2FjaGVcbiAgICAgIE9iamVjdC5hc3NpZ24oX2ludGVybmFsQ2FjaGUsIGNhY2hlKVxuXG4gICAgICAvKiAtLS0tLS0tLS0tLS0tLS0tIFVQREFURSBNQU5JRkVTVCAtLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgICAgIHVwZGF0ZU1hbmlmZXN0KFxuICAgICAgICAobWFuaWZlc3QpID0+IHtcbiAgICAgICAgICAvKiAtLS0tLS0tLS0tLS0tLS0tIE1BTklGRVNUIFZFUlNJT04gLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgICAgICAgICBjYWNoZS5tYW5pZmVzdFZlcnNpb24gPSBtYW5pZmVzdC5tYW5pZmVzdF92ZXJzaW9uXG5cbiAgICAgICAgICAvKiAtLS0tLS0tLS0tLS0tLS0tLS0gREVTQ1JJUFRJT04gLS0tLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgICAgICAgICBtYW5pZmVzdC5kZXNjcmlwdGlvbiA9IGNhY2hlLmxvYWRNZXNzYWdlXG5cbiAgICAgICAgICAvKiAtLS0tLS0tLS0tLS0tLS0tIEJBQ0tHUk9VTkQgUEFHRSAtLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgICAgICAgICBpZiAoIWNhY2hlLmJnU2NyaXB0UGF0aClcbiAgICAgICAgICAgIHRoaXMuZXJyb3IoYGNhY2hlLmJnU2NyaXB0UGF0aCBpcyAke3R5cGVvZiBjYWNoZS5iZ1NjcmlwdFBhdGh9YClcblxuICAgICAgICAgIGlmIChtYW5pZmVzdC5tYW5pZmVzdF92ZXJzaW9uID09PSAzKSB7XG4gICAgICAgICAgICBjb25zdCBzd1BhdGggPVxuICAgICAgICAgICAgICBtYW5pZmVzdC5iYWNrZ3JvdW5kPy5zZXJ2aWNlX3dvcmtlciA/PyAnc2VydmljZV93b3JrZXIuanMnXG5cbiAgICAgICAgICAgIGNvbnN0IHN3Q29kZSA9IGBcbiAgICAgICAgICAgICAgLy8gU0lNUExFIFJFTE9BREVSIElNUE9SVFxuICAgICAgICAgICAgICBpbXBvcnQgXCIuLyR7Y2FjaGUuYmdTY3JpcHRQYXRofVwiXG4gICAgICAgICAgICBgLnRyaW0oKVxuXG4gICAgICAgICAgICBpZiAoIWJ1bmRsZVtzd1BhdGhdKSBlbWl0KHN3UGF0aCwgc3dDb2RlLCB0cnVlKVxuICAgICAgICAgICAgZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnN0IHN3ID0gYnVuZGxlW3N3UGF0aF0gYXMgT3V0cHV0Q2h1bmtcbiAgICAgICAgICAgICAgc3cuY29kZSA9IGBcbiAgICAgICAgICAgICAgJHtzd0NvZGV9XG4gICAgICAgICAgICAgICR7c3cuY29kZX1cbiAgICAgICAgICAgICAgYC50cmltKClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc2V0KG1hbmlmZXN0LCAnYmFja2dyb3VuZC5zZXJ2aWNlX3dvcmtlcicsIHN3UGF0aClcbiAgICAgICAgICAgIHNldChtYW5pZmVzdCwgJ2JhY2tncm91bmQudHlwZScsICdtb2R1bGUnKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzZXQoXG4gICAgICAgICAgICAgIG1hbmlmZXN0LFxuICAgICAgICAgICAgICAnYmFja2dyb3VuZC5zY3JpcHRzJyxcbiAgICAgICAgICAgICAgKG1hbmlmZXN0LmJhY2tncm91bmQ/LnNjcmlwdHMgPz8gW10pLmNvbmNhdChbY2FjaGUuYmdTY3JpcHRQYXRoXSksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBzZXQobWFuaWZlc3QsICdiYWNrZ3JvdW5kLnBlcnNpc3RlbnQnLCB0cnVlKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8qIC0tLS0tLS0tLS0tLS0tLS0gQ09OVEVOVCBTQ1JJUFRTIC0tLS0tLS0tLS0tLS0tLS0gKi9cblxuICAgICAgICAgIGlmICghY2FjaGUuY3RTY3JpcHRQYXRoKVxuICAgICAgICAgICAgdGhpcy5lcnJvcihgY2FjaGUuY3RTY3JpcHRQYXRoIGlzICR7dHlwZW9mIGNhY2hlLmN0U2NyaXB0UGF0aH1gKVxuXG4gICAgICAgICAgY29uc3QgeyBjb250ZW50X3NjcmlwdHM6IGN0U2NyaXB0cyB9ID0gbWFuaWZlc3RcblxuICAgICAgICAgIG1hbmlmZXN0LmNvbnRlbnRfc2NyaXB0cyA9IGN0U2NyaXB0cz8ubWFwKCh7IGpzID0gW10sIC4uLnJlc3QgfSkgPT4gKHtcbiAgICAgICAgICAgIGpzOiBbY2FjaGUuY3RTY3JpcHRQYXRoISwgLi4uanNdLFxuICAgICAgICAgICAgLi4ucmVzdCxcbiAgICAgICAgICB9KSlcblxuICAgICAgICAgIHJldHVybiBtYW5pZmVzdFxuICAgICAgICB9LFxuICAgICAgICBidW5kbGUsXG4gICAgICAgIHRoaXMuZXJyb3IsXG4gICAgICApXG5cbiAgICAgIC8vIFdlJ2xsIHdyaXRlIHRoaXMgZmlsZSBvdXJzZWx2ZXMsIHdlIGp1c3QgbmVlZCBhIHNhZmUgcGF0aCB0byB3cml0ZSB0aGUgdGltZXN0YW1wXG4gICAgICBkZWxldGUgYnVuZGxlW2NhY2hlLnRpbWVzdGFtcFBhdGhdXG4gICAgfSxcblxuICAgIC8qIC0tLS0tLS0tLS0tLS0tIFdSSVRFIFRJTUVTVEFNUCBGSUxFIC0tLS0tLS0tLS0tLS0gKi9cbiAgICBhc3luYyB3cml0ZUJ1bmRsZSgpIHtcbiAgICAgIC8vIFNvbWV0aW1lcyBDaHJvbWUgc2F5cyB0aGUgbWFuaWZlc3QgaXNuJ3QgdmFsaWQsIHNvIHdlIG5lZWQgdG8gd2FpdCBhIGJpdFxuICAgICAgcmVsb2FkRGVsYXkgPiAwICYmIChhd2FpdCBkZWxheShyZWxvYWREZWxheSkpXG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IG91dHB1dEpzb24oXG4gICAgICAgICAgam9pbihjYWNoZS5vdXRwdXREaXIhLCBjYWNoZS50aW1lc3RhbXBQYXRoISksXG4gICAgICAgICAgRGF0ZS5ub3coKSxcbiAgICAgICAgKVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Vycm9yTGlrZShlcnIpKSB7XG4gICAgICAgICAgdGhpcy5lcnJvcihgVW5hYmxlIHRvIHVwZGF0ZSB0aW1lc3RhbXAgZmlsZTpcXG5cXHQke2Vyci5tZXNzYWdlfWApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5lcnJvcignVW5hYmxlIHRvIHVwZGF0ZSB0aW1lc3RhbXAgZmlsZScpXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuICB9XG59XG5cbmludGVyZmFjZSBFcnJvckxpa2Uge1xuICBtZXNzYWdlOiBzdHJpbmdcbn1cbmZ1bmN0aW9uIGlzRXJyb3JMaWtlKHg6IHVua25vd24pOiB4IGlzIEVycm9yTGlrZSB7XG4gIHJldHVybiB0eXBlb2YgeCA9PT0gJ29iamVjdCcgJiYgeCAhPT0gbnVsbCAmJiAnbWVzc2FnZScgaW4geFxufVxuIiwiaW1wb3J0IGh0bWxJbnB1dHMgZnJvbSAnLi9odG1sLWlucHV0cydcbmltcG9ydCBtYW5pZmVzdElucHV0IGZyb20gJy4vbWFuaWZlc3QtaW5wdXQnXG5pbXBvcnQgeyBicm93c2VyUG9seWZpbGwgYXMgYiB9IGZyb20gJy4vYnJvd3Nlci1wb2x5ZmlsbCdcbmltcG9ydCB7IHZhbGlkYXRlTmFtZXMgYXMgdiB9IGZyb20gJy4vdmFsaWRhdGUtbmFtZXMnXG5pbXBvcnQgeyByZWFkSlNPTlN5bmMgfSBmcm9tICdmcy1leHRyYSdcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJ1xuXG5pbXBvcnQgeyBDaHJvbWVFeHRlbnNpb25PcHRpb25zLCBDaHJvbWVFeHRlbnNpb25QbHVnaW4gfSBmcm9tICcuL3BsdWdpbi1vcHRpb25zJ1xuaW1wb3J0IHsgbWl4ZWRGb3JtYXQgYXMgbSB9IGZyb20gJy4vbWl4ZWQtZm9ybWF0J1xuXG5leHBvcnQgeyBzaW1wbGVSZWxvYWRlciB9IGZyb20gJy4vcGx1Z2luLXJlbG9hZGVyLXNpbXBsZSdcblxuZXhwb3J0IHR5cGUgeyBNYW5pZmVzdFYyLCBNYW5pZmVzdFYzIH0gZnJvbSAnLi9tYW5pZmVzdC10eXBlcydcblxuZXhwb3J0IGNvbnN0IGNocm9tZUV4dGVuc2lvbiA9IChcbiAgb3B0aW9ucyA9IHt9IGFzIENocm9tZUV4dGVuc2lvbk9wdGlvbnMsXG4pOiBDaHJvbWVFeHRlbnNpb25QbHVnaW4gPT4ge1xuICAvKiAtLS0tLS0tLS0tLS0tLS0gTE9BRCBQQUNLQUdFLkpTT04gLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgdHJ5IHtcbiAgICBjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKHByb2Nlc3MuY3dkKCksICdwYWNrYWdlLmpzb24nKVxuICAgIG9wdGlvbnMucGtnID0gb3B0aW9ucy5wa2cgfHwgcmVhZEpTT05TeW5jKHBhY2thZ2VKc29uUGF0aClcbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tZW1wdHlcbiAgfSBjYXRjaCAoZXJyb3IpIHt9XG5cbiAgLyogLS0tLS0tLS0tLS0tLS0tLS0gU0VUVVAgUExVR0lOUyAtLS0tLS0tLS0tLS0tLS0tLSAqL1xuXG4gIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RJbnB1dChvcHRpb25zKVxuICBjb25zdCBodG1sID0gaHRtbElucHV0cyhtYW5pZmVzdClcbiAgY29uc3QgdmFsaWRhdGUgPSB2KClcbiAgY29uc3QgYnJvd3NlciA9IGIobWFuaWZlc3QpXG4gIGNvbnN0IG1peGVkRm9ybWF0ID0gbShtYW5pZmVzdClcblxuICAvKiAtLS0tLS0tLS0tLS0tLS0tLSBSRVRVUk4gUExVR0lOIC0tLS0tLS0tLS0tLS0tLS0tICovXG5cbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAnY2hyb21lLWV4dGVuc2lvbicsXG5cbiAgICAvLyBGb3IgdGVzdGluZ1xuICAgIF9wbHVnaW5zOiB7IG1hbmlmZXN0LCBodG1sLCB2YWxpZGF0ZSB9LFxuXG4gICAgY29uZmlnOiAoKSA9PiB7XG4gICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICdQbGVhc2UgcnVuIGBucG0gaSByb2xsdXAtcGx1Z2luLWNocm9tZS1leHRlbnNpb25AYmV0YWAgdG8gdXNlIHdpdGggVml0ZS4nLFxuICAgICAgKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAnW2Nocm9tZS1leHRlbnNpb25dIFZpdGUgc3VwcG9ydCBpcyBmb3IgUlBDRSB2NCBhbmQgYWJvdmUuIFRoaXMgaXMgUlBDRSB2My42LjcuJyxcbiAgICAgIClcbiAgICB9LFxuXG4gICAgYXN5bmMgb3B0aW9ucyhvcHRpb25zKSB7XG4gICAgICB0cnkge1xuICAgICAgICAvLyByZXR1cm4gW21hbmlmZXN0LCBodG1sXS5yZWR1Y2UoKG9wdHMsIHBsdWdpbikgPT4ge1xuICAgICAgICAvLyAgIGNvbnN0IHJlc3VsdCA9IHBsdWdpbi5vcHRpb25zLmNhbGwodGhpcywgb3B0cylcblxuICAgICAgICAvLyAgIHJldHVybiByZXN1bHQgfHwgb3B0aW9uc1xuICAgICAgICAvLyB9LCBvcHRpb25zKVxuICAgICAgICBsZXQgcmVzdWx0ID0gb3B0aW9uc1xuICAgICAgICBmb3IgKGNvbnN0IHBsdWdpbiBvZiBbbWFuaWZlc3QsIGh0bWxdKSB7XG4gICAgICAgICAgY29uc3QgciA9IGF3YWl0IHBsdWdpbi5vcHRpb25zLmNhbGwodGhpcywgcmVzdWx0KVxuICAgICAgICAgIHJlc3VsdCA9IHIgPz8gcmVzdWx0XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdFxuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgY29uc3QgbWFuaWZlc3RFcnJvciA9XG4gICAgICAgICAgJ1RoZSBtYW5pZmVzdCBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIHNjcmlwdCBvciBIVE1MIGZpbGUuJ1xuICAgICAgICBjb25zdCBodG1sRXJyb3IgPVxuICAgICAgICAgICdBdCBsZWFzdCBvbmUgSFRNTCBmaWxlIG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgc2NyaXB0LidcblxuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJlxuICAgICAgICAgIChlcnJvci5tZXNzYWdlID09PSBtYW5pZmVzdEVycm9yIHx8IGVycm9yLm1lc3NhZ2UgPT09IGh0bWxFcnJvcilcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgJ0EgQ2hyb21lIGV4dGVuc2lvbiBtdXN0IGhhdmUgYXQgbGVhc3Qgb25lIHNjcmlwdCBvciBIVE1MIGZpbGUuJyxcbiAgICAgICAgICApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3JcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0sXG5cbiAgICBhc3luYyBidWlsZFN0YXJ0KG9wdGlvbnMpIHtcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgbWFuaWZlc3QuYnVpbGRTdGFydC5jYWxsKHRoaXMsIG9wdGlvbnMpLFxuICAgICAgICBodG1sLmJ1aWxkU3RhcnQuY2FsbCh0aGlzLCBvcHRpb25zKSxcbiAgICAgIF0pXG4gICAgfSxcblxuICAgIGFzeW5jIHJlc29sdmVJZCguLi5hcmdzKSB7XG4gICAgICByZXR1cm4gbWFuaWZlc3QucmVzb2x2ZUlkLmNhbGwodGhpcywgLi4uYXJncylcbiAgICB9LFxuXG4gICAgYXN5bmMgbG9hZChpZCkge1xuICAgICAgcmV0dXJuIG1hbmlmZXN0LmxvYWQuY2FsbCh0aGlzLCBpZClcbiAgICB9LFxuXG4gICAgdHJhbnNmb3JtKHNvdXJjZSwgaWQpIHtcbiAgICAgIHJldHVybiBtYW5pZmVzdC50cmFuc2Zvcm0uY2FsbCh0aGlzLCBzb3VyY2UsIGlkKVxuICAgIH0sXG5cbiAgICB3YXRjaENoYW5nZSguLi5hcmdzKSB7XG4gICAgICBtYW5pZmVzdC53YXRjaENoYW5nZS5jYWxsKHRoaXMsIC4uLmFyZ3MpXG4gICAgICBodG1sLndhdGNoQ2hhbmdlLmNhbGwodGhpcywgLi4uYXJncylcbiAgICB9LFxuXG4gICAgYXN5bmMgZ2VuZXJhdGVCdW5kbGUoLi4uYXJncykge1xuICAgICAgYXdhaXQgbWFuaWZlc3QuZ2VuZXJhdGVCdW5kbGUuY2FsbCh0aGlzLCAuLi5hcmdzKVxuICAgICAgYXdhaXQgdmFsaWRhdGUuZ2VuZXJhdGVCdW5kbGUuY2FsbCh0aGlzLCAuLi5hcmdzKVxuICAgICAgYXdhaXQgYnJvd3Nlci5nZW5lcmF0ZUJ1bmRsZS5jYWxsKHRoaXMsIC4uLmFyZ3MpXG4gICAgICAvLyBUT0RPOiBzaG91bGQgc2tpcCB0aGlzIGlmIG5vdCBuZWVkZWRcbiAgICAgIGF3YWl0IG1peGVkRm9ybWF0LmdlbmVyYXRlQnVuZGxlLmNhbGwodGhpcywgLi4uYXJncylcbiAgICB9LFxuICB9XG59XG4iXSwibmFtZXMiOlsibmFtZSIsImV4cGxpY2l0U2NyaXB0IiwiaW1wbGljaXRTY3JpcHQiLCJkaWZmIiwiX251bGxpc2hDb2FsZXNjZSIsIl9vcHRpb25hbENoYWluIiwiY3RXcmFwcGVyU2NyaXB0IiwiZXhlY3V0ZVNjcmlwdFBvbHlmaWxsIiwiY3RDbGllbnRDb2RlIiwiYmdDbGllbnRDb2RlIiwidiIsImIiLCJtaXhlZEZvcm1hdCIsIm0iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7OztBQUtBLE1BQUEsR0FBQTtBQUNBLEVBQUEsQ0FBQSxFQUFBO0FBQ0EsRUFBQSxDQUFBLENBQUE7QUFDQSxJQUFBLENBQUEsRUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0EsU0FBQSxPQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsRUFBQSxPQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsSUFBQSxLQUFBLE9BQUE7QUFDQSxDQUFBO0FBY0E7QUFDQSxTQUFBLE9BQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxFQUFBLE9BQUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxPQUFBO0FBQ0EsQ0FBQTtBQUNBO0FBQ0EsU0FBQSxRQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsRUFBQSxPQUFBLE9BQUEsQ0FBQSxLQUFBLFFBQUE7QUFDQSxDQUFBO0FBQ0E7QUFDQSxTQUFBLFdBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxFQUFBLE9BQUEsT0FBQSxDQUFBLEtBQUEsV0FBQTtBQUNBLENBQUE7QUFDQTtBQUNBLFNBQUEsTUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLEVBQUEsT0FBQSxDQUFBLEtBQUEsSUFBQTtBQUNBLENBQUE7QUFDQTtBQUNBLFNBQUEsU0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLEVBQUEsT0FBQSxDQUFBLFdBQUEsQ0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxDQUFBO0FBQ0E7QUFDQSxNQUFBLGlCQUFBLEdBQUEsQ0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxZQUFBLEVBQUEsS0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsY0FBQSxHQUFBO0FBQ0EsRUFBQSxPQUFBO0FBQ0EsRUFBQSxNQUFBO0FBQ0EsRUFBQSxXQUFBO0FBQ0EsS0FBQTtBQUNBLEVBQUEsSUFBQTtBQUNBLElBQUEsTUFBQSxXQUFBLEdBQUEsZ0JBQUE7QUFDQSxJQUFBLE1BQUEsYUFBQSxHQUFBLE1BQUEsQ0FBQSxXQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsSUFBQSxDQUFBLGFBQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxJQUFBLEtBQUEsQ0FBQSwrQ0FBQSxDQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLFFBQUEsR0FBQSxJQUFBLENBQUEsS0FBQSxDQUFBLGFBQUEsQ0FBQSxNQUFBLEdBQUE7QUFDQTtBQUNBLElBQUEsTUFBQSxNQUFBLEdBQUEsT0FBQSxDQUFBLFFBQUEsRUFBQTtBQUNBO0FBQ0EsSUFBQSxhQUFBLENBQUEsTUFBQSxHQUFBLElBQUEsQ0FBQSxTQUFBLENBQUEsTUFBQSxFQUFBLFNBQUEsRUFBQSxDQUFBLEVBQUE7QUFDQSxHQUFBLENBQUEsT0FBQSxLQUFBLEVBQUE7QUFDQSxJQUFBLElBQUEsV0FBQSxJQUFBLEtBQUEsWUFBQSxLQUFBLEVBQUE7QUFDQSxNQUFBLFdBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0EsS0FBQSxNQUFBO0FBQ0EsTUFBQSxNQUFBLEtBQUE7QUFDQSxLQUFBO0FBQ0EsR0FBQTtBQUNBO0FBQ0EsRUFBQSxPQUFBLE1BQUE7QUFDQTs7QUN6RUEsU0FBQSxjQUFBLENBQUEsTUFBQSxFQUFBO0FBQ0EsRUFBQSxJQUFBLE1BQUEsS0FBQSxJQUFBLElBQUEsT0FBQSxNQUFBLEtBQUEsV0FBQSxFQUFBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsSUFBQSxTQUFBLENBQUEsNkJBQUEsQ0FBQTtBQUNBLEdBQUE7QUFDQTtBQUNBLEVBQUEsT0FBQSxDQUFBLFdBQUEsRUFBQSxRQUFBLEtBQUE7QUFDQSxJQUFBLE1BQUEsSUFBQSxHQUFBLFFBQUEsQ0FBQSxNQUFBLEVBQUEsUUFBQSxDQUFBLENBQUEsS0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQSxFQUFBO0FBQ0E7QUFDQSxJQUFBLElBQUEsSUFBQSxJQUFBLFdBQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxJQUFBLEtBQUE7QUFDQSxRQUFBLENBQUEsbUVBQUEsRUFBQSxRQUFBLENBQUEsb0JBQUEsRUFBQSxXQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsT0FBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxFQUFBLEdBQUEsV0FBQSxFQUFBLENBQUEsSUFBQSxHQUFBLFFBQUEsRUFBQTtBQUNBLEdBQUE7QUFDQTs7QUNOQSxNQUFBLFFBQUE7QUFDQSxFQUFBLENBQUEsUUFBQTtBQUNBLEVBQUEsQ0FBQSxRQUFBLEtBQUE7QUFDQSxJQUFBLE1BQUEsUUFBQSxHQUFBLEVBQUEsQ0FBQSxZQUFBLENBQUEsUUFBQSxFQUFBLE1BQUEsRUFBQTtBQUNBLElBQUEsTUFBQSxDQUFBLEdBQUEsT0FBQSxDQUFBLElBQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsRUFBQSxFQUFBLFFBQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQTtBQUNBLElBQUE7QUFDQTtBQUNBLE1BQUEsZUFBQTtBQUNBLEVBQUEsQ0FBQSxFQUFBLFFBQUEsRUFBQSxRQUFBLEVBQUE7QUFDQSxFQUFBLENBQUEsQ0FBQSxLQUFBO0FBQ0EsSUFBQSxNQUFBLFdBQUEsR0FBQSxJQUFBLENBQUEsT0FBQSxDQUFBLFFBQUEsRUFBQTtBQUNBO0FBQ0EsSUFBQSxJQUFBLE9BQUE7QUFDQSxJQUFBLElBQUEsQ0FBQSxDQUFBLFVBQUEsQ0FBQSxHQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxHQUFBLElBQUEsQ0FBQSxRQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsRUFBQSxFQUFBLFFBQUEsRUFBQTtBQUNBLEtBQUEsTUFBQTtBQUNBLE1BQUEsTUFBQSxHQUFBLElBQUEsQ0FBQSxRQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsRUFBQSxFQUFBLFdBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxJQUFBLENBQUEsSUFBQSxDQUFBLE1BQUEsRUFBQSxDQUFBLENBQUE7QUFDQSxJQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxjQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxDQUFBLENBQUEsUUFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEscUJBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLGdCQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxpQkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsZ0JBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLFlBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLGlCQUFBO0FBQ0EsRUFBQSxDQUFBLEVBQUEsZUFBQSxFQUFBO0FBQ0EsRUFBQSxDQUFBLENBQUEsS0FBQTtBQUNBLElBQUEsY0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLE9BQUEsSUFBQSxDQUFBLE1BQUEsRUFBQSxRQUFBLENBQUE7QUFDQSxPQUFBLElBQUEsQ0FBQSxLQUFBLEVBQUEsQ0FBQSxDQUFBLEVBQUEsS0FBQSxLQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxRQUFBLE1BQUEsUUFBQSxHQUFBLEtBQUEsQ0FBQSxPQUFBLENBQUEsWUFBQSxFQUFBLEtBQUEsRUFBQTtBQUNBO0FBQ0EsUUFBQSxPQUFBLFFBQUE7QUFDQSxPQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsSUFBQSxlQUFBLEVBQUE7QUFDQSxNQUFBLE1BQUEsSUFBQSxHQUFBLENBQUEsQ0FBQSxNQUFBLEVBQUE7QUFDQSxNQUFBO0FBQ0EsUUFBQSxlQUFBLEtBQUEsSUFBQTtBQUNBLFNBQUEsT0FBQSxlQUFBLEtBQUEsUUFBQSxJQUFBLGVBQUEsQ0FBQSxhQUFBLENBQUE7QUFDQSxRQUFBO0FBQ0EsUUFBQSxJQUFBLENBQUEsT0FBQTtBQUNBLFVBQUEsbUVBQUE7QUFDQSxVQUFBO0FBQ0EsT0FBQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLENBQUEsT0FBQSxDQUFBLHFEQUFBLEVBQUE7QUFDQSxLQUFBO0FBQ0E7QUFDQSxJQUFBLE9BQUEsQ0FBQTtBQUNBLElBQUE7QUFDQTtBQUNBLE1BQUEsVUFBQSxHQUFBLENBQUEsQ0FBQSxLQUFBLGNBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxPQUFBLEdBQUE7QUFDQTtBQUNBLE1BQUEsWUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsVUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxlQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLFNBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLENBQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSw0QkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsZ0JBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLGlCQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxnQkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsWUFBQSxDQUFBO0FBQ0EsS0FBQSxPQUFBLEdBQUE7QUFDQTtBQUNBLE1BQUEsV0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsU0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxlQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLENBQUEsQ0FBQSxNQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxvQkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsaUJBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLGtCQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxpQkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsYUFBQSxDQUFBO0FBQ0EsS0FBQSxPQUFBLEdBQUE7QUFDQTtBQUNBLE1BQUEsV0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsTUFBQSxDQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxlQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE9BQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLENBQUEsQ0FBQSxLQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxrQkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsbUJBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLGdCQUFBLENBQUE7QUFDQSxLQUFBLE9BQUEsR0FBQTtBQUNBO0FBQ0EsTUFBQSxXQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxDQUFBLENBQUEsa0JBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLGlCQUFBLENBQUE7QUFDQSxLQUFBLEdBQUEsQ0FBQSxrQkFBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUEsaUJBQUEsQ0FBQTtBQUNBLEtBQUEsT0FBQSxHQUFBO0FBQ0E7QUFDQSxNQUFBLFVBQUEsR0FBQSxDQUFBLENBQUEsS0FBQTtBQUNBLEVBQUEsT0FBQTtBQUNBLElBQUEsR0FBQSxPQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUE7QUFDQSxJQUFBLEdBQUEsV0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsSUFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBO0FBQ0EsR0FBQTtBQUNBLEtBQUEsTUFBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLGVBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBOztBQzdIQSxNQUFBLE1BQUEsR0FBQSxDQUFBLElBQUEsS0FBQSxVQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsRUFBQTtBQUNBO0FBQ0EsTUFBQUEsTUFBQSxHQUFBLGNBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBQSxVQUFBO0FBQ0EsRUFBQSxpQkFBQTtBQUNBO0FBQ0EsRUFBQSxLQUFBLEdBQUE7QUFDQSxJQUFBLE9BQUEsRUFBQSxFQUFBO0FBQ0EsSUFBQSxJQUFBLEVBQUEsRUFBQTtBQUNBLElBQUEsS0FBQSxFQUFBLEVBQUE7QUFDQSxJQUFBLEVBQUEsRUFBQSxFQUFBO0FBQ0EsSUFBQSxHQUFBLEVBQUEsRUFBQTtBQUNBLElBQUEsR0FBQSxFQUFBLEVBQUE7QUFDQSxJQUFBLEtBQUEsRUFBQSxFQUFBO0FBQ0EsR0FBQTtBQUNBLEVBQUE7QUFDQSxFQUFBLE9BQUE7QUFDQSxVQUFBQSxNQUFBO0FBQ0EsSUFBQSxLQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUEsT0FBQSxDQUFBLE9BQUEsRUFBQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLEVBQUEsTUFBQSxFQUFBLEdBQUEsa0JBQUE7QUFDQTtBQUNBLE1BQUEsSUFBQSxNQUFBLEVBQUE7QUFDQSxRQUFBLEtBQUEsQ0FBQSxNQUFBLEdBQUEsT0FBQTtBQUNBLE9BQUEsTUFBQTtBQUNBLFFBQUEsTUFBQSxJQUFBLFNBQUEsQ0FBQSxnQ0FBQSxDQUFBO0FBQ0EsT0FBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLElBQUEsTUFBQTtBQUNBLE1BQUEsSUFBQSxPQUFBLE9BQUEsQ0FBQSxLQUFBLEtBQUEsUUFBQSxFQUFBO0FBQ0EsUUFBQSxLQUFBLEdBQUEsQ0FBQSxPQUFBLENBQUEsS0FBQSxFQUFBO0FBQ0EsT0FBQSxNQUFBLElBQUEsS0FBQSxDQUFBLE9BQUEsQ0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxRQUFBLEtBQUEsR0FBQSxDQUFBLEdBQUEsT0FBQSxDQUFBLEtBQUEsRUFBQTtBQUNBLE9BQUEsTUFBQSxJQUFBLE9BQUEsT0FBQSxDQUFBLEtBQUEsS0FBQSxRQUFBLEVBQUE7QUFDQSxRQUFBLEtBQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLE9BQUEsQ0FBQSxLQUFBLEVBQUE7QUFDQSxPQUFBLE1BQUE7QUFDQSxRQUFBLE1BQUEsSUFBQSxTQUFBLENBQUEsQ0FBQSx3QkFBQSxFQUFBLE9BQUEsT0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxLQUFBLENBQUEsSUFBQSxHQUFBLEtBQUEsQ0FBQSxNQUFBLENBQUEsTUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxLQUFBLENBQUEsSUFBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLEVBQUEsT0FBQSxPQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsS0FBQSxDQUFBLEtBQUEsR0FBQSxLQUFBLENBQUEsSUFBQSxDQUFBLEdBQUEsQ0FBQSxRQUFBLENBQUEsTUFBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsS0FBQSxDQUFBLEVBQUEsR0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsQ0FBQSxHQUFBLENBQUEsWUFBQSxDQUFBLEVBQUE7QUFDQSxRQUFBLEtBQUEsQ0FBQSxHQUFBLEdBQUEsT0FBQSxDQUFBLEtBQUEsQ0FBQSxLQUFBLENBQUEsR0FBQSxDQUFBLFdBQUEsQ0FBQSxFQUFBO0FBQ0EsUUFBQSxLQUFBLENBQUEsR0FBQSxHQUFBLE9BQUEsQ0FBQSxLQUFBLENBQUEsS0FBQSxDQUFBLEdBQUEsQ0FBQSxVQUFBLENBQUEsRUFBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLE9BQUEsR0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsQ0FBQSxHQUFBLENBQUEsV0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0EsUUFBQSxLQUFBLENBQUEsS0FBQSxHQUFBLEtBQUEsQ0FBQSxNQUFBLENBQUEsR0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsTUFBQSxDQUFBLEtBQUEsQ0FBQSxFQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0EsUUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLE9BQUEsQ0FBQSxpQkFBQSxDQUFBLGlCQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0EsUUFBQSxJQUFBLEtBQUEsQ0FBQSxLQUFBLENBQUEsTUFBQSxLQUFBLENBQUEsRUFBQTtBQUNBLFVBQUEsTUFBQSxJQUFBLEtBQUE7QUFDQSxZQUFBLHVEQUFBO0FBQ0EsV0FBQTtBQUNBLFNBQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxPQUFBO0FBQ0EsUUFBQSxHQUFBLE9BQUE7QUFDQSxRQUFBLEtBQUEsRUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLE1BQUEsQ0FBQSxjQUFBLENBQUEsaUJBQUEsQ0FBQSxNQUFBLENBQUEsRUFBQSxFQUFBLENBQUE7QUFDQSxPQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsVUFBQSxHQUFBO0FBQ0EsTUFBQSxNQUFBLEVBQUEsTUFBQSxFQUFBLEdBQUEsa0JBQUE7QUFDQTtBQUNBLE1BQUEsSUFBQSxNQUFBLEVBQUE7QUFDQSxRQUFBLEtBQUEsQ0FBQSxNQUFBLEdBQUEsT0FBQTtBQUNBLE9BQUEsTUFBQTtBQUNBLFFBQUEsTUFBQSxJQUFBLFNBQUEsQ0FBQSxnQ0FBQSxDQUFBO0FBQ0EsT0FBQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLE1BQUEsR0FBQSxDQUFBLEdBQUEsS0FBQSxDQUFBLEdBQUEsRUFBQSxHQUFBLEtBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsS0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxDQUFBLEtBQUEsS0FBQTtBQUNBLFFBQUEsSUFBQSxDQUFBLFlBQUEsQ0FBQSxLQUFBLEVBQUE7QUFDQSxPQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsTUFBQSxRQUFBLEdBQUEsTUFBQSxDQUFBLEdBQUEsQ0FBQSxPQUFBLEtBQUEsS0FBQTtBQUNBO0FBQ0EsUUFBQSxNQUFBLE1BQUEsR0FBQSxNQUFBLFFBQUEsQ0FBQSxLQUFBLEVBQUE7QUFDQSxRQUFBLE1BQUEsUUFBQSxHQUFBLFFBQUEsQ0FBQSxNQUFBLEVBQUEsS0FBQSxFQUFBO0FBQ0E7QUFDQSxRQUFBLElBQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxVQUFBLElBQUEsRUFBQSxPQUFBO0FBQ0EsVUFBQSxNQUFBO0FBQ0EsVUFBQSxRQUFBO0FBQ0EsU0FBQSxFQUFBO0FBQ0EsT0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLEtBQUEsQ0FBQSxLQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxLQUFBO0FBQ0EsUUFBQSxNQUFBLE1BQUEsR0FBQSxDQUFBLENBQUEsSUFBQSxHQUFBO0FBQ0EsUUFBQSxNQUFBLFFBQUEsR0FBQSxRQUFBLENBQUEsTUFBQSxFQUFBLENBQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLFVBQUEsSUFBQSxFQUFBLE9BQUE7QUFDQSxVQUFBLE1BQUE7QUFDQSxVQUFBLFFBQUE7QUFDQSxTQUFBLEVBQUE7QUFDQSxPQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsTUFBQSxPQUFBLENBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsV0FBQSxDQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUEsSUFBQSxFQUFBLENBQUEsUUFBQSxDQUFBLE9BQUEsQ0FBQSxJQUFBLEVBQUEsQ0FBQSxRQUFBLENBQUEsZUFBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsS0FBQSxDQUFBLEtBQUEsR0FBQSxHQUFBO0FBQ0EsT0FBQTtBQUNBLEtBQUE7QUFDQSxHQUFBO0FBQ0E7Ozs7QUNySkEsU0FBQSxLQUFBO0FBQ0EsRUFBQSxDQUFBO0FBQ0EsRUFBQTtBQUNBLEVBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxNQUFBLElBQUEsU0FBQSxDQUFBLHVCQUFBLENBQUE7QUFDQSxFQUFBLE9BQUEsQ0FBQSxDQUFBLGdCQUFBLEtBQUEsQ0FBQTtBQUNBLENBQUE7QUFDQTtBQUNBLFNBQUEsS0FBQTtBQUNBLEVBQUEsQ0FBQTtBQUNBLEVBQUE7QUFDQSxFQUFBLElBQUEsQ0FBQSxTQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUEsTUFBQSxJQUFBLFNBQUEsQ0FBQSx1QkFBQSxDQUFBO0FBQ0EsRUFBQSxPQUFBLENBQUEsQ0FBQSxnQkFBQSxLQUFBLENBQUE7QUFDQTs7QUNoQ0EsTUFBQSxXQUFBLEdBQUEsQ0FBQSxHQUFBLEtBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxJQUFBLENBQUEsU0FBQSxDQUFBLEdBQUEsQ0FBQTs7Ozs7O0FDR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQUEsdUJBQUEsQ0FBQTtBQUNBLEVBQUEsVUFBQSxHQUFBLENBQUE7QUFDQSxFQUFBLFVBQUEsR0FBQSxFQUFBO0FBQ0EsRUFBQSxZQUFBLEdBQUEsQ0FBQSxXQUFBLENBQUE7QUFDQSxDQUFBLEVBQUE7QUFDQSxFQUFBLE1BQUEsS0FBQSxHQUFBLElBQUEsQ0FBQSxTQUFBLENBQUEsVUFBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLE1BQUEsR0FBQSxVQUFBLENBQUEsTUFBQTtBQUNBLE1BQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxVQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsRUFBQSxLQUFBLEVBQUEsQ0FBQSxPQUFBLENBQUEsV0FBQSxFQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxNQUFBLE1BQUE7QUFDQSxFQUFBLE1BQUEsT0FBQSxHQUFBLElBQUEsQ0FBQSxTQUFBLENBQUEsWUFBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsTUFBQSxHQUFBO0FBQ0EsSUFBQSxNQUFBO0FBQ0EsUUFBQUMsTUFBQSxDQUFBLE9BQUEsQ0FBQSxVQUFBLEVBQUEsTUFBQSxDQUFBO0FBQ0EsUUFBQUMsTUFBQSxDQUFBLE9BQUEsQ0FBQSxXQUFBLEVBQUEsT0FBQSxDQUFBO0FBQ0EsSUFBQSxPQUFBLENBQUEsU0FBQSxFQUFBLEtBQUEsRUFBQTtBQUNBO0FBQ0EsRUFBQSxPQUFBLE1BQUE7QUFDQTs7QUMvQkEsTUFBQSxrQkFBQSxHQUFBLENBQUEsUUFBQTtBQUNBLEVBQUEsUUFBQSxDQUFBLFFBQUEsQ0FBQSxDQUFBLFVBQUEsQ0FBQSxVQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsZ0JBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxFQUFBLEtBQUEsRUFBQSxLQUFBO0FBQ0EsRUFBQSxJQUFBLFdBQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxJQUFBLE1BQUEsSUFBQSxLQUFBO0FBQ0EsTUFBQSxDQUFBLGlEQUFBLEVBQUEsSUFBQSxDQUFBLFNBQUE7QUFDQSxRQUFBLEtBQUE7QUFDQSxPQUFBLENBQUEsQ0FBQTtBQUNBLEtBQUE7QUFDQSxFQUFBLElBQUEsQ0FBQSxVQUFBLENBQUEsUUFBQSxDQUFBO0FBQ0EsSUFBQSxNQUFBLElBQUEsS0FBQSxDQUFBLENBQUEseUJBQUEsRUFBQSxRQUFBLENBQUEsZUFBQSxDQUFBLENBQUE7QUFDQTtBQUNBLEVBQUEsT0FBQSxRQUFBO0FBQ0EsRUFBQTtBQUNBO0FBQ0EsU0FBQSxvQkFBQSxDQUFBLE9BQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxDQUFBO0FBQ0EsRUFBQSxJQUFBLEtBQUEsQ0FBQSxPQUFBLENBQUEsT0FBQSxDQUFBLEtBQUEsQ0FBQSxFQUFBO0FBQ0EsSUFBQSxNQUFBLGFBQUEsR0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLFNBQUEsQ0FBQSxrQkFBQSxFQUFBO0FBQ0EsSUFBQSxNQUFBLFFBQUEsR0FBQTtBQUNBLE1BQUEsR0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEVBQUEsYUFBQSxDQUFBO0FBQ0EsTUFBQSxHQUFBLE9BQUEsQ0FBQSxLQUFBLENBQUEsS0FBQSxDQUFBLGFBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxNQUFBO0FBQ0EsSUFBQSxNQUFBLGlCQUFBLEdBQUEsZ0JBQUE7QUFDQSxNQUFBLE9BQUEsQ0FBQSxLQUFBLENBQUEsYUFBQSxDQUFBO0FBQ0EsTUFBQSxPQUFBO0FBQ0EsTUFBQTtBQUNBO0FBQ0EsSUFBQSxPQUFBLEVBQUEsaUJBQUEsRUFBQSxRQUFBLEVBQUE7QUFDQSxHQUFBLE1BQUEsSUFBQSxPQUFBLE9BQUEsQ0FBQSxLQUFBLEtBQUEsUUFBQSxFQUFBO0FBQ0EsSUFBQSxNQUFBLGlCQUFBLEdBQUEsZ0JBQUEsQ0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLFFBQUEsRUFBQSxPQUFBLEVBQUE7QUFDQSxJQUFBLE1BQUEsUUFBQSxHQUFBLFdBQUEsQ0FBQSxPQUFBLENBQUEsS0FBQSxFQUFBO0FBQ0EsSUFBQSxPQUFBLFFBQUEsQ0FBQSxVQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxFQUFBLGlCQUFBLEVBQUEsUUFBQSxFQUFBO0FBQ0EsR0FBQSxNQUFBLElBQUEsUUFBQSxDQUFBLE9BQUEsQ0FBQSxLQUFBLENBQUEsRUFBQTtBQUNBLElBQUEsTUFBQSxpQkFBQSxHQUFBLGdCQUFBLENBQUEsT0FBQSxDQUFBLEtBQUEsRUFBQSxPQUFBLEVBQUE7QUFDQSxJQUFBLE9BQUEsRUFBQSxpQkFBQSxFQUFBO0FBQ0EsR0FBQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLElBQUEsU0FBQTtBQUNBLElBQUEsQ0FBQSxxQ0FBQSxFQUFBLE9BQUEsT0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxHQUFBO0FBQ0E7O0FDcERBLE1BQUEsWUFBQSxHQUFBO0FBQ0EsRUFBQSxHQUFBLFdBQUE7QUFDQSxLQUFBO0FBQ0EsRUFBQSxNQUFBLEVBQUEsS0FBQSxFQUFBLE1BQUEsRUFBQSxHQUFBLENBQUEsV0FBQSxDQUFBLElBQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxPQUFBLElBQUEsS0FBQSxXQUFBLENBQUE7QUFDQSxLQUFBLE1BQUE7QUFDQSxNQUFBLENBQUEsRUFBQSxLQUFBLEVBQUEsTUFBQSxFQUFBLEVBQUEsSUFBQSxLQUFBO0FBQ0EsUUFBQSxJQUFBLElBQUEsQ0FBQSxVQUFBLENBQUEsR0FBQSxDQUFBLEVBQUE7QUFDQSxVQUFBLE1BQUEsQ0FBQSxHQUFBLENBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLFNBQUEsTUFBQTtBQUNBLFVBQUEsS0FBQSxDQUFBLEdBQUEsQ0FBQSxJQUFBLEVBQUE7QUFDQSxTQUFBO0FBQ0E7QUFDQSxRQUFBLE9BQUEsRUFBQSxLQUFBLEVBQUEsTUFBQSxFQUFBO0FBQ0EsT0FBQTtBQUNBLE1BQUEsRUFBQSxLQUFBLEVBQUEsSUFBQSxHQUFBLEVBQUEsRUFBQSxNQUFBLEVBQUEsSUFBQSxHQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUE7QUFDQTtBQUNBLEVBQUEsT0FBQSxDQUFBLEdBQUEsS0FBQSxDQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQSxLQUFBLENBQUEsTUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBOztBQ3JCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSw4Q0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsU0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsaURBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLGVBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLHVEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0EsTUFBQSxZQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxvREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsT0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsK0NBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLGtCQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSwwREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLHFCQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSw2REFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLHFCQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSw2REFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLGNBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLHNEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsYUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEscURBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSwyQ0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLFlBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLG9EQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsU0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsaURBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxZQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxvREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLGtCQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSwwREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLGtCQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSwwREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLFlBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLG9EQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsR0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsMkNBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxXQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxtREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLE9BQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLCtDQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsUUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsZ0RBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxJQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSw0Q0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLE9BQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLCtDQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsVUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsa0RBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxlQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSx1REFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLGFBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLHFEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsV0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsbURBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxZQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxvREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLEtBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLDZDQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsZUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsdURBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxPQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSwrQ0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLFNBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLGlEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsS0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsNkNBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxRQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxnREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLGVBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLHVEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsT0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsK0NBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxVQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxrREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsUUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsZ0RBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSwyQ0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLFNBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLGlEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsZ0JBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLHdEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsV0FBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsbURBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxTQUFBLEdBQUEsQ0FBQSxDQUFBO0FBQ0EsRUFBQSxpREFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLGFBQUEsR0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLHFEQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE1BQUEsVUFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsa0RBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQSxrQkFBQSxHQUFBLENBQUEsQ0FBQTtBQUNBLEVBQUEsVUFBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxRQUFBLENBQUEsWUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FDMUdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxpQkFBQSxHQUFBLENBQUEsR0FBQSxFQUFBLEVBQUEsSUFBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLENBQUEsT0FBQSxDQUFBLFdBQUEsQ0FBQTtBQUNBLEtBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsS0FBQSxHQUFBLEtBQUEsU0FBQSxDQUFBO0FBQ0EsS0FBQSxNQUFBLENBQUEsQ0FBQSxHQUFBLEVBQUEsQ0FBQSxLQUFBLEVBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQTtBQUNBLEtBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsS0FBQSxHQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxHQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBQSxXQUFBO0FBQ0EsRUFBQSxRQUFBO0FBQ0EsRUFBQSxNQUFBO0FBQ0EsRUFBQSxPQUFBO0FBQ0EsRUFBQTtBQUNBLEVBQUEsSUFBQSxRQUFBLENBQUEsZ0JBQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxJQUFBLE9BQUEsY0FBQSxDQUFBLFFBQUEsRUFBQSxNQUFBLEVBQUEsT0FBQSxDQUFBO0FBQ0EsR0FBQSxNQUFBO0FBQ0EsSUFBQSxPQUFBLGNBQUEsQ0FBQSxRQUFBLEVBQUEsTUFBQSxFQUFBLE9BQUEsQ0FBQTtBQUNBLEdBQUE7QUFDQSxDQUFBO0FBQ0E7QUFDQSxTQUFBLGNBQUE7QUFDQSxFQUFBLFFBQUE7QUFDQSxFQUFBLE1BQUE7QUFDQSxFQUFBLE9BQUE7QUFDQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLE9BQUEsR0FBQSxRQUFBLENBQUEsUUFBQSxDQUFBLGNBQUEsQ0FBQTtBQUNBLE1BQUEsQ0FBQSwyQkFBQSxDQUFBO0FBQ0EsTUFBQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsS0FBQSxHQUFBLEdBQUE7QUFDQSxJQUFBLFFBQUE7QUFDQSxJQUFBLDBCQUFBO0FBQ0EsSUFBQSxFQUFBO0FBQ0EsR0FBQTtBQUNBLEtBQUEsT0FBQSxDQUFBLENBQUEsRUFBQSxTQUFBLEVBQUEsS0FBQSxTQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxPQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxDQUFBLEtBQUE7QUFDQSxNQUFBLElBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLFFBQUEsTUFBQSxLQUFBLEdBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUEsRUFBQSxHQUFBLEVBQUEsTUFBQSxFQUFBLEVBQUE7QUFDQSxRQUFBLE9BQUEsQ0FBQSxHQUFBLENBQUEsRUFBQSxHQUFBLEtBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxNQUFBLEVBQUEsRUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLE9BQUEsTUFBQTtBQUNBLFFBQUEsT0FBQSxDQUFBLEdBQUEsQ0FBQSxFQUFBLENBQUEsQ0FBQTtBQUNBLE9BQUE7QUFDQSxLQUFBLEVBQUEsRUFBQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsY0FBQSxHQUFBLEdBQUE7QUFDQSxJQUFBLFFBQUE7QUFDQSxJQUFBLGlCQUFBO0FBQ0EsSUFBQSxFQUFBO0FBQ0EsR0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxFQUFBLEVBQUEsR0FBQSxFQUFBLEVBQUEsS0FBQSxDQUFBLEdBQUEsQ0FBQSxFQUFBLEdBQUEsRUFBQSxDQUFBLEVBQUEsRUFBQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsRUFBQSxHQUFBO0FBQ0EsSUFBQSxHQUFBLEtBQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsWUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSwyQkFBQSxDQUFBO0FBQ0EsSUFBQSxJQUFBLE9BQUEsQ0FBQSxjQUFBLEdBQUEsY0FBQSxHQUFBLEVBQUEsQ0FBQTtBQUNBLElBQUE7QUFDQTtBQUNBLEVBQUEsTUFBQSxJQUFBLEdBQUE7QUFDQSxJQUFBLEdBQUEsS0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsS0FBQSxVQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLENBQUEsUUFBQSxFQUFBLGNBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxpQkFBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLENBQUEsUUFBQSxFQUFBLGVBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxzQkFBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxzQkFBQSxFQUFBLEVBQUEsQ0FBQSxDQUFBO0FBQ0EsSUFBQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLEdBQUEsR0FBQTtBQUNBLElBQUEsR0FBQSxLQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxRQUFBLENBQUEsTUFBQSxDQUFBLENBQUE7QUFDQSxJQUFBLEdBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxpQkFBQSxFQUFBLEVBQUEsRUFBQSxDQUFBLE1BQUE7QUFDQSxNQUFBLENBQUEsQ0FBQSxFQUFBLEVBQUEsR0FBQSxHQUFBLEVBQUEsRUFBQSxLQUFBLENBQUEsR0FBQSxDQUFBLEVBQUEsR0FBQSxHQUFBLENBQUE7QUFDQSxNQUFBLEVBQUE7QUFDQSxLQUFBO0FBQ0EsSUFBQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLEdBQUEsR0FBQTtBQUNBLElBQUEsR0FBQSxLQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLE1BQUEsNENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsS0FBQTtBQUNBLElBQUEsSUFBQSxNQUFBLENBQUEsTUFBQSxDQUFBLEdBQUEsQ0FBQSxRQUFBLEVBQUEsT0FBQSxFQUFBLEVBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxJQUFBLElBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxHQUFBLENBQUEsUUFBQSxFQUFBLHFCQUFBLEVBQUEsRUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLElBQUE7QUFDQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLE1BQUEsR0FBQUMsVUFBQSxDQUFBLEtBQUEsRUFBQSxHQUFBLEVBQUEsY0FBQSxFQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsR0FBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLE9BQUE7QUFDQSxJQUFBLEdBQUEsRUFBQSxRQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsSUFBQSxjQUFBLEVBQUEsUUFBQSxDQUFBLGNBQUEsQ0FBQTtBQUNBLElBQUEsRUFBQSxFQUFBLFFBQUEsQ0FBQSxFQUFBLENBQUE7QUFDQSxJQUFBLElBQUEsRUFBQSxRQUFBLENBQUEsSUFBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLEVBQUEsUUFBQSxDQUFBLEdBQUEsQ0FBQTtBQUNBLElBQUEsTUFBQSxFQUFBLFFBQUEsQ0FBQSxNQUFBLENBQUE7QUFDQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLFNBQUEsUUFBQSxDQUFBLEdBQUEsRUFBQTtBQUNBLElBQUEsT0FBQSxDQUFBLEdBQUEsSUFBQSxHQUFBLENBQUEsR0FBQSxDQUFBLE1BQUEsQ0FBQSxRQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxLQUFBLElBQUEsQ0FBQSxNQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxHQUFBO0FBQ0EsQ0FBQTtBQUNBO0FBQ0EsU0FBQSxjQUFBO0FBQ0EsRUFBQSxRQUFBO0FBQ0EsRUFBQSxNQUFBO0FBQ0EsRUFBQSxPQUFBO0FBQ0EsRUFBQTtBQUNBLEVBQUEsTUFBQSxPQUFBLEdBQUEsUUFBQSxDQUFBLFFBQUEsQ0FBQSxjQUFBLENBQUE7QUFDQSxNQUFBLENBQUEsMkJBQUEsQ0FBQTtBQUNBLE1BQUEsR0FBQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLEtBQUEsR0FBQSxHQUFBO0FBQ0EsSUFBQSxRQUFBO0FBQ0EsSUFBQSwwQkFBQTtBQUNBLElBQUEsRUFBQTtBQUNBLEdBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxPQUFBLENBQUE7QUFDQSxLQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxDQUFBLEtBQUE7QUFDQSxNQUFBLElBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLFFBQUEsTUFBQSxLQUFBLEdBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUEsRUFBQSxHQUFBLEVBQUEsTUFBQSxFQUFBLEVBQUE7QUFDQSxRQUFBLE9BQUEsQ0FBQSxHQUFBLENBQUEsRUFBQSxHQUFBLEtBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxNQUFBLEVBQUEsRUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLE9BQUEsTUFBQTtBQUNBLFFBQUEsT0FBQSxDQUFBLEdBQUEsQ0FBQSxFQUFBLENBQUEsQ0FBQTtBQUNBLE9BQUE7QUFDQSxLQUFBLEVBQUEsRUFBQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsY0FBQSxHQUFBLEdBQUE7QUFDQSxJQUFBLFFBQUE7QUFDQSxJQUFBLGlCQUFBO0FBQ0EsSUFBQSxFQUFBO0FBQ0EsR0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxFQUFBLEVBQUEsR0FBQSxFQUFBLEVBQUEsS0FBQSxDQUFBLEdBQUEsQ0FBQSxFQUFBLEdBQUEsRUFBQSxDQUFBLEVBQUEsRUFBQSxHQUFBO0FBQ0EsRUFBQSxNQUFBLEVBQUEsR0FBQTtBQUNBLElBQUEsR0FBQSxLQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQSxLQUFBLFlBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxJQUFBLEdBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxvQkFBQSxFQUFBLEVBQUEsRUFBQTtBQUNBLElBQUEsSUFBQSxPQUFBLENBQUEsY0FBQSxHQUFBLGNBQUEsR0FBQSxFQUFBLENBQUE7QUFDQSxJQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsSUFBQSxHQUFBO0FBQ0EsSUFBQSxHQUFBLEtBQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsVUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxpQkFBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLENBQUEsUUFBQSxFQUFBLGNBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxpQkFBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLENBQUEsUUFBQSxFQUFBLGVBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSw4QkFBQSxDQUFBO0FBQ0EsSUFBQSxHQUFBLENBQUEsUUFBQSxFQUFBLDJCQUFBLENBQUE7QUFDQSxJQUFBLEdBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxHQUFBLENBQUEsUUFBQSxFQUFBLHNCQUFBLEVBQUEsRUFBQSxDQUFBLENBQUE7QUFDQSxJQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsR0FBQSxHQUFBO0FBQ0EsSUFBQSxHQUFBLEtBQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLFFBQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQTtBQUNBLElBQUEsR0FBQSxHQUFBLENBQUEsUUFBQSxFQUFBLGlCQUFBLEVBQUEsRUFBQSxFQUFBLENBQUEsTUFBQTtBQUNBLE1BQUEsQ0FBQSxDQUFBLEVBQUEsRUFBQSxHQUFBLEdBQUEsRUFBQSxFQUFBLEtBQUEsQ0FBQSxHQUFBLENBQUEsRUFBQSxHQUFBLEdBQUEsQ0FBQTtBQUNBLE1BQUEsRUFBQTtBQUNBLEtBQUE7QUFDQSxJQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsYUFBQSxHQUFBO0FBQ0EsSUFBQSw2QkFBQTtBQUNBLElBQUEsMEJBQUE7QUFDQSxHQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsR0FBQSxFQUFBLEtBQUEsS0FBQTtBQUNBLElBQUEsTUFBQSxNQUFBLEdBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxLQUFBLEVBQUEsRUFBQSxFQUFBO0FBQ0E7QUFDQSxJQUFBLElBQUEsT0FBQSxNQUFBLEtBQUEsUUFBQSxFQUFBO0FBQ0EsTUFBQSxHQUFBLENBQUEsR0FBQSxDQUFBLE1BQUEsRUFBQTtBQUNBLEtBQUEsTUFBQTtBQUNBLE1BQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxPQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsR0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxHQUFBO0FBQ0EsR0FBQSxFQUFBLElBQUEsR0FBQSxFQUFBLEVBQUE7QUFDQTtBQUNBLEVBQUEsTUFBQSxHQUFBLEdBQUE7QUFDQSxJQUFBLEdBQUEsYUFBQTtBQUNBLElBQUEsR0FBQSxLQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLE1BQUEsNENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsS0FBQTtBQUNBLElBQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLEdBQUEsQ0FBQSxRQUFBLEVBQUEsT0FBQSxFQUFBLEVBQUEsQ0FBQSxDQUFBO0FBQ0EsSUFBQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsTUFBQSxHQUFBQSxVQUFBLENBQUEsS0FBQSxFQUFBLEdBQUEsRUFBQSxjQUFBLEVBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxHQUFBLEVBQUE7QUFDQTtBQUNBLEVBQUEsT0FBQTtBQUNBLElBQUEsR0FBQSxFQUFBLFFBQUEsQ0FBQSxHQUFBLENBQUE7QUFDQSxJQUFBLGNBQUEsRUFBQSxRQUFBLENBQUEsY0FBQSxDQUFBO0FBQ0EsSUFBQSxFQUFBLEVBQUEsUUFBQSxDQUFBLEVBQUEsQ0FBQTtBQUNBLElBQUEsSUFBQSxFQUFBLFFBQUEsQ0FBQSxJQUFBLENBQUE7QUFDQSxJQUFBLEdBQUEsRUFBQSxRQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsSUFBQSxNQUFBLEVBQUEsUUFBQSxDQUFBLE1BQUEsQ0FBQTtBQUNBLEdBQUE7QUFDQTtBQUNBLEVBQUEsU0FBQSxRQUFBLENBQUEsR0FBQSxFQUFBO0FBQ0EsSUFBQSxPQUFBLENBQUEsR0FBQSxJQUFBLEdBQUEsQ0FBQSxHQUFBLENBQUEsTUFBQSxDQUFBLFFBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsSUFBQSxDQUFBLE1BQUEsRUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLEdBQUE7QUFDQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUM5TUEsU0FBQUMsa0JBQUEsQ0FBQSxHQUFBLEVBQUEsS0FBQSxFQUFBLEVBQUEsSUFBQSxHQUFBLElBQUEsSUFBQSxFQUFBLEVBQUEsT0FBQSxHQUFBLENBQUEsRUFBQSxNQUFBLEVBQUEsT0FBQSxLQUFBLEVBQUEsQ0FBQSxFQUFBLEVBQUEsQ0FBQSxTQUFBQyxnQkFBQSxDQUFBLEdBQUEsRUFBQSxFQUFBLElBQUEsYUFBQSxHQUFBLFNBQUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxNQUFBLEVBQUEsRUFBQSxNQUFBLEVBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxNQUFBLEVBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxFQUFBLEtBQUEsZ0JBQUEsSUFBQSxFQUFBLEtBQUEsY0FBQSxLQUFBLEtBQUEsSUFBQSxJQUFBLEVBQUEsRUFBQSxPQUFBLFNBQUEsQ0FBQSxFQUFBLENBQUEsSUFBQSxFQUFBLEtBQUEsUUFBQSxJQUFBLEVBQUEsS0FBQSxnQkFBQSxFQUFBLEVBQUEsYUFBQSxHQUFBLEtBQUEsQ0FBQSxDQUFBLEtBQUEsR0FBQSxFQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsRUFBQSxNQUFBLElBQUEsRUFBQSxLQUFBLE1BQUEsSUFBQSxFQUFBLEtBQUEsY0FBQSxFQUFBLEVBQUEsS0FBQSxHQUFBLEVBQUEsQ0FBQSxDQUFBLEdBQUEsSUFBQSxLQUFBLEtBQUEsQ0FBQSxJQUFBLENBQUEsYUFBQSxFQUFBLEdBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLGFBQUEsR0FBQSxTQUFBLENBQUEsRUFBQSxFQUFBLENBQUEsT0FBQSxLQUFBLENBQUEsRUFLQTtBQUNBLE1BQUEsR0FBQSxHQUFBLElBQUEsR0FBQSxDQUFBO0FBQ0EsRUFBQSxPQUFBLEVBQUEsQ0FBQSxNQUFBLEVBQUEsU0FBQSxFQUFBLFNBQUEsQ0FBQTtBQUNBLEVBQUEsTUFBQSxFQUFBLEtBQUE7QUFDQSxFQUFBLE9BQUEsRUFBQSxJQUFBO0FBQ0EsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxHQUFBLENBQUEsU0FBQSxDQUFBLGNBQUEsRUFBQSxJQUFBLEVBQUE7QUFDQSxHQUFBLENBQUEsU0FBQSxDQUFBLGVBQUEsRUFBQSxJQUFBLEVBQUE7QUFDQSxHQUFBLENBQUEsU0FBQSxDQUFBLHlCQUFBLEVBQUEsSUFBQSxFQUFBO0FBQ0EsR0FBQSxDQUFBLFNBQUEsQ0FBQSxXQUFBLEVBQUEsSUFBQSxFQUFBO0FBQ0EsR0FBQSxDQUFBLFNBQUEsQ0FBQSxZQUFBLEVBQUEsSUFBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLFNBQUEsR0FBQSxHQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsRUFBQTtBQUNBO0FBQ0EsTUFBQSxZQUFBO0FBQ0EsRUFBQSxDQUFBLE1BQUE7QUFDQSxFQUFBLENBQUEsT0FBQTtBQUNBLElBQUEsV0FBQSxDQUFBLE1BQUEsQ0FBQSxPQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsTUFBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLGdCQUFBLEdBQUEsWUFBQSxDQUFBLFNBQUEsRUFBQTtBQUNBLE1BQUEsZ0JBQUEsR0FBQSxZQUFBLENBQUEsU0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLGFBQUEsR0FBQSxDQUFBLDBCQUFBLEVBQUEsMEJBQUEsRUFBQTtBQUNBO0FBQ0EsU0FBQSxnQkFBQTtBQUNBLEVBQUEsUUFBQTtBQUNBLEVBQUE7QUFDQSxFQUFBLE1BQUEsS0FBQSxHQUFBLFNBQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQSxFQUFBLElBQUEsS0FBQSxLQUFBLElBQUEsRUFBQSxPQUFBLFFBQUE7QUFDQTtBQUNBLEVBQUEsTUFBQSxRQUFBLEdBQUEsWUFBQSxDQUFBLFFBQUEsRUFBQTtBQUNBLEVBQUEsTUFBQSxPQUFBO0FBQ0EsSUFBQSxRQUFBLENBQUEsZ0JBQUEsS0FBQSxDQUFBLEdBQUEsZ0JBQUEsR0FBQSxpQkFBQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLElBQUEsS0FBQTtBQUNBLElBQUE7QUFDQSxNQUFBLGtEQUFBO0FBQ0EsTUFBQSxJQUFBRCxrQkFBQSxDQUFBQyxnQkFBQSxDQUFBLENBQUEsU0FBQSxFQUFBLFFBQUEsRUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLE1BQUE7QUFDQSxFQUFBLGdCQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxNQUFBLEVBQUEsTUFBQSxFQUFBLEVBQUEsSUFBQSxFQUFBLENBQUEsQ0FBQSxFQUFBLE9BQUEsRUFBQSxLQUFBLE9BQUEsSUFBQSxDQUFBLGFBQUEsQ0FBQSxRQUFBLENBQUEsT0FBQSxDQUFBLENBQUE7QUFDQSxFQUFBLFFBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLEdBQUEsRUFBQSxNQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUEsS0FBQTtBQUNBLFVBQUEsTUFBQSxVQUFBLEdBQUEsQ0FBQSxDQUFBLEVBQUEsQ0FBQSxDQUFBLFVBQUE7QUFDQSxhQUFBLEtBQUEsQ0FBQSxHQUFBLENBQUE7QUFDQSxhQUFBLEtBQUEsQ0FBQSxDQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxhQUFBLE1BQUEsQ0FBQSxhQUFBLENBQUE7QUFDQSxhQUFBLElBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsVUFBQSxNQUFBLElBQUEsR0FBQUQsa0JBQUEsQ0FBQSxPQUFBLENBQUEsVUFBQSxDQUFBLEVBQUEsUUFBQSxDQUFBLENBQUEsT0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFVBQUEsSUFBQSxDQUFBLENBQUEsWUFBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxZQUFBLE9BQUEsQ0FBQSxXQUFBLEVBQUEsSUFBQSxDQUFBLENBQUE7QUFDQSxXQUFBO0FBQ0E7QUFDQSxVQUFBLE9BQUEsQ0FBQSxFQUFBLEVBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxRQUFBLENBQUEsQ0FBQSxDQUFBLFlBQUEsQ0FBQSxDQUFBLENBQUEsS0FBQTtBQUNBLFlBQUEsQ0FBQSxDQUFBLFlBQUE7QUFDQSxXQUFBLEVBQUEsRUFBQSxJQUFBLENBQUEsQ0FBQTtBQUNBLFNBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxLQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQTtBQUNBLEdBQUE7QUFDQTs7QUMvREEsTUFBQSxvQkFBQSxHQUFBLENBQUEsQ0FBQSxLQUFBO0FBQ0E7QUFDQTtBQUNBLEVBQUEsTUFBQSxDQUFBLE1BQUEsRUFBQSxJQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsQ0FBQSxDQUFBLEVBQUEsSUFBQSxFQUFBLENBQUEsQ0FBQSxHQUFBLElBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLFVBQUEsR0FBQSxJQUFBLEtBQUEsS0FBQTtBQUNBLEVBQUEsTUFBQSxJQUFBLEdBQUEsVUFBQSxHQUFBLENBQUEsRUFBQSxDQUFBLENBQUEsS0FBQSxFQUFBLENBQUEsQ0FBQSxDQUFBLEdBQUEsS0FBQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsRUFBQSxNQUFBLEVBQUEsR0FBQSxJQUFBLEdBQUEsQ0FBQSxDQUFBLE9BQUEsRUFBQSxJQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLEdBQUEsSUFBQSxDQUFBLEdBQUEsTUFBQSxDQUFBLEtBQUEsQ0FBQSxLQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLENBQUEsQ0FBQSxFQUFBLENBQUEsQ0FBQSxHQUFBLElBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLEtBQUEsR0FBQSxVQUFBLEdBQUEsQ0FBQSxDQUFBLEVBQUEsSUFBQSxFQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxFQUFBLENBQUEsR0FBQSxLQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsRUFBQSxPQUFBLFFBQUEsQ0FBQSxDQUFBLEVBQUEsTUFBQSxDQUFBLEdBQUEsRUFBQSxLQUFBLENBQUEsRUFBQSxDQUFBLENBQUE7QUFDQTs7QUNyQkEsU0FBQUEsa0JBQUEsQ0FBQSxHQUFBLEVBQUEsS0FBQSxFQUFBLEVBQUEsSUFBQSxHQUFBLElBQUEsSUFBQSxFQUFBLEVBQUEsT0FBQSxHQUFBLENBQUEsRUFBQSxNQUFBLEVBQUEsT0FBQSxLQUFBLEVBQUEsQ0FBQSxFQUFBLEVBQUEsQ0FBQSxTQUFBQyxnQkFBQSxDQUFBLEdBQUEsRUFBQSxFQUFBLElBQUEsYUFBQSxHQUFBLFNBQUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxNQUFBLEVBQUEsRUFBQSxNQUFBLEVBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxNQUFBLEVBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxFQUFBLEtBQUEsZ0JBQUEsSUFBQSxFQUFBLEtBQUEsY0FBQSxLQUFBLEtBQUEsSUFBQSxJQUFBLEVBQUEsRUFBQSxPQUFBLFNBQUEsQ0FBQSxFQUFBLENBQUEsSUFBQSxFQUFBLEtBQUEsUUFBQSxJQUFBLEVBQUEsS0FBQSxnQkFBQSxFQUFBLEVBQUEsYUFBQSxHQUFBLEtBQUEsQ0FBQSxDQUFBLEtBQUEsR0FBQSxFQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsRUFBQSxNQUFBLElBQUEsRUFBQSxLQUFBLE1BQUEsSUFBQSxFQUFBLEtBQUEsY0FBQSxFQUFBLEVBQUEsS0FBQSxHQUFBLEVBQUEsQ0FBQSxDQUFBLEdBQUEsSUFBQSxLQUFBLEtBQUEsQ0FBQSxJQUFBLENBQUEsYUFBQSxFQUFBLEdBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLGFBQUEsR0FBQSxTQUFBLENBQUEsRUFBQSxFQUFBLENBQUEsT0FBQSxLQUFBLENBQUEsRUFNQTtBQUNBLFNBQUEsOEJBQUEsQ0FBQSxNQUFBLEVBQUE7QUFDQSxFQUFBLE1BQUEsSUFBQSxHQUFBLFFBQUEsQ0FBQSxNQUFBLEVBQUE7QUFDQSxFQUFBLE9BQUEsTUFBQSxDQUFBLE9BQUEsQ0FBQSxJQUFBLEVBQUEsQ0FBQSxPQUFBLEVBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLENBQUE7QUFDQTtBQUNBLFNBQUEsZ0JBQUE7QUFDQSxFQUFBLENBQUE7QUFDQSxFQUFBLE9BQUE7QUFDQSxFQUFBLGtCQUFBO0FBQ0EsRUFBQSxLQUFBO0FBQ0EsRUFBQTtBQUNBLEVBQUEsTUFBQSxRQUFBLEdBQUEsV0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0EsRUFBQSxJQUFBLFFBQUEsQ0FBQSxVQUFBLEVBQUE7QUFDQSxJQUFBLFFBQUEsQ0FBQSxVQUFBLENBQUEsSUFBQSxHQUFBLFNBQUE7QUFDQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUEsUUFBQSxDQUFBLGVBQUEsRUFBQTtBQUNBLElBQUEsTUFBQSxFQUFBLE1BQUEsR0FBQSxFQUFBLEVBQUEsR0FBQSxRQUFBO0FBQ0EsSUFBQSxNQUFBLEVBQUEsY0FBQSxHQUFBLHlCQUFBLEVBQUEsR0FBQSxLQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsQ0FBQTtBQUNBLFFBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLFFBQUEsT0FBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLEdBQUEsR0FBQSxlQUFBO0FBQ0E7QUFDQSxJQUFBLEtBQUEsQ0FBQSxjQUFBLEdBQUEsSUFBQTtBQUNBO0FBQ0E7QUFDQSxJQUFBLElBQUEsS0FBQSxDQUFBLE9BQUEsQ0FBQSxNQUFBLENBQUEsRUFBQTtBQUNBLE1BQUE7QUFDQTtBQUNBLFFBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQUQsa0JBQUEsQ0FBQSxDQUFBLENBQUEsY0FBQSxFQUFBLFFBQUEsUUFBQSxDQUFBLENBQUEsQ0FBQSxFQUFBLElBQUEsR0FBQSxFQUFBLENBQUE7QUFDQSxXQUFBLElBQUEsR0FBQSxDQUFBO0FBQ0E7QUFDQTtBQUNBLFFBQUEsTUFBQSxJQUFBLFNBQUE7QUFDQSxVQUFBLDZEQUFBO0FBQ0EsU0FBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsQ0FBQSxPQUFBLENBQUEsQ0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLGNBQUEsR0FBQSxHQUFBLENBQUEsRUFBQTtBQUNBLEtBQUEsTUFBQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLENBQUEsY0FBQSxHQUFBLElBQUE7QUFDQSxLQUFBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsVUFBQSxHQUFBLFFBQUEsQ0FBQSxlQUFBO0FBQ0EsT0FBQSxPQUFBLENBQUEsQ0FBQSxFQUFBLE9BQUEsRUFBQSxLQUFBQSxrQkFBQSxDQUFBLE9BQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxPQUFBLE1BQUEsQ0FBQUEsa0JBQUEsQ0FBQSxRQUFBLENBQUEsZ0JBQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxPQUFBLEdBQUEsQ0FBQSxvQkFBQSxFQUFBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsT0FBQSxHQUFBLEtBQUEsQ0FBQSxJQUFBLENBQUEsSUFBQSxHQUFBLENBQUEsVUFBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsTUFBQSxTQUFBLEdBQUE7QUFDQSxNQUFBLEtBQUE7QUFDQSxRQUFBLENBQUEsRUFBQSxHQUFBO0FBQ0EsV0FBQSxLQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsV0FBQSxJQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsV0FBQSxPQUFBLENBQUEsVUFBQSxFQUFBLEdBQUEsQ0FBQTtBQUNBLFdBQUEsT0FBQSxDQUFBLFFBQUEsRUFBQSxHQUFBLENBQUE7QUFDQSxXQUFBLE9BQUEsQ0FBQSxRQUFBLEVBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLE9BQUE7QUFDQSxNQUFBLEdBQUEsS0FBQSxDQUFBLGNBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLEtBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQSxLQUFBLENBQUEsTUFBQSxFQUFBLENBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxNQUFBO0FBQ0E7QUFDQSxJQUFBLElBQUEsa0JBQUEsRUFBQTtBQUNBLE1BQUEsUUFBQSxDQUFBLGVBQUEsR0FBQSxRQUFBLENBQUEsZUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsTUFBQTtBQUNBLFFBQUEsR0FBQSxDQUFBO0FBQ0EsUUFBQSxFQUFBLEVBQUFDLGdCQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUEsUUFBQSxFQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsRUFBQSxFQUFBLGdCQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxHQUFBLEVBQUEsTUFBQSxFQUFBLEVBQUEsSUFBQSxFQUFBLENBQUEsOEJBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxPQUFBLENBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsUUFBQSxDQUFBLHdCQUFBLEdBQUFELGtCQUFBLENBQUEsUUFBQSxDQUFBLHdCQUFBLEVBQUEsUUFBQSxFQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0EsSUFBQSxRQUFBLENBQUEsd0JBQUEsQ0FBQSxJQUFBLENBQUE7QUFDQSxNQUFBLFNBQUE7QUFDQSxNQUFBLE9BQUE7QUFDQSxLQUFBLEVBQUE7QUFDQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLE9BQUEsUUFBQTtBQUNBOztBQ3hGQSxTQUFBQyxnQkFBQSxDQUFBLEdBQUEsRUFBQSxFQUFBLElBQUEsYUFBQSxHQUFBLFNBQUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxNQUFBLEVBQUEsRUFBQSxNQUFBLEVBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxNQUFBLEVBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxFQUFBLEtBQUEsZ0JBQUEsSUFBQSxFQUFBLEtBQUEsY0FBQSxLQUFBLEtBQUEsSUFBQSxJQUFBLEVBQUEsRUFBQSxPQUFBLFNBQUEsQ0FBQSxFQUFBLENBQUEsSUFBQSxFQUFBLEtBQUEsUUFBQSxJQUFBLEVBQUEsS0FBQSxnQkFBQSxFQUFBLEVBQUEsYUFBQSxHQUFBLEtBQUEsQ0FBQSxDQUFBLEtBQUEsR0FBQSxFQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsRUFBQSxNQUFBLElBQUEsRUFBQSxLQUFBLE1BQUEsSUFBQSxFQUFBLEtBQUEsY0FBQSxFQUFBLEVBQUEsS0FBQSxHQUFBLEVBQUEsQ0FBQSxDQUFBLEdBQUEsSUFBQSxLQUFBLEtBQUEsQ0FBQSxJQUFBLENBQUEsYUFBQSxFQUFBLEdBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLGFBQUEsR0FBQSxTQUFBLENBQUEsRUFBQSxFQUFBLENBQUEsT0FBQSxLQUFBLENBQUEsRUFBQTtBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxTQUFBLHFCQUFBO0FBQ0E7QUFDQSxFQUFBO0FBQ0EsSUFBQSxlQUFBO0FBQ0EsSUFBQSxZQUFBO0FBQ0EsSUFBQSxvQkFBQTtBQUNBLElBQUEsa0JBQUE7QUFDQSxJQUFBLGFBQUE7QUFDQSxJQUFBLFNBQUE7QUFDQSxJQUFBLG9CQUFBO0FBQ0EsR0FBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUEsS0FBQTtBQUNBLEVBQUE7QUFDQTtBQUNBLEVBQUEsSUFBQSxZQUFBLEVBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSwrQ0FBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUEsQ0FBQSxrQkFBQTtBQUNBLElBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSwrREFBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUFBLGdCQUFBLENBQUEsQ0FBQSxhQUFBLEVBQUEsZ0JBQUEsRUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLEVBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSx1Q0FBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUEsT0FBQSxvQkFBQSxLQUFBLFdBQUE7QUFDQSxJQUFBLElBQUEsQ0FBQSxJQUFBO0FBQ0EsTUFBQSx1RkFBQTtBQUNBLE1BQUE7QUFDQTtBQUNBLEVBQUEsSUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUEsZUFBQTtBQUNBLElBQUEsSUFBQSxDQUFBLElBQUE7QUFDQSxNQUFBO0FBQ0EsUUFBQSw2RUFBQTtBQUNBLFFBQUEsc0RBQUE7QUFDQSxPQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQTtBQUNBLE1BQUE7QUFDQTtBQUNBLEVBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxvQkFBQSxLQUFBLFFBQUE7QUFDQSxJQUFBLE1BQUEsQ0FBQSxJQUFBLENBQUEsb0JBQUEsQ0FBQSxDQUFBLE1BQUEsR0FBQSxDQUFBO0FBQ0E7QUFDQSxJQUFBLElBQUEsQ0FBQSxJQUFBLENBQUEsd0RBQUEsRUFBQTtBQUNBO0FBQ0EsRUFBQSxJQUFBLFNBQUE7QUFDQSxJQUFBLElBQUEsQ0FBQSxJQUFBO0FBQ0EsTUFBQTtBQUNBLFFBQUEsNENBQUE7QUFDQSxRQUFBLDZDQUFBO0FBQ0EsUUFBQSxzREFBQTtBQUNBLE9BQUEsQ0FBQSxJQUFBLENBQUEsSUFBQSxDQUFBO0FBQ0EsTUFBQTtBQUNBOztBQ3JFQSxTQUFBRCxrQkFBQSxDQUFBLEdBQUEsRUFBQSxLQUFBLEVBQUEsRUFBQSxJQUFBLEdBQUEsSUFBQSxJQUFBLEVBQUEsRUFBQSxPQUFBLEdBQUEsQ0FBQSxFQUFBLE1BQUEsRUFBQSxPQUFBLEtBQUEsRUFBQSxDQUFBLEVBQUEsRUFBQSxDQUFBLFNBQUFDLGdCQUFBLENBQUEsR0FBQSxFQUFBLEVBQUEsSUFBQSxhQUFBLEdBQUEsU0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLEdBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsR0FBQSxDQUFBLE1BQUEsRUFBQSxFQUFBLE1BQUEsRUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLE1BQUEsRUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLEVBQUEsS0FBQSxnQkFBQSxJQUFBLEVBQUEsS0FBQSxjQUFBLEtBQUEsS0FBQSxJQUFBLElBQUEsRUFBQSxFQUFBLE9BQUEsU0FBQSxDQUFBLEVBQUEsQ0FBQSxJQUFBLEVBQUEsS0FBQSxRQUFBLElBQUEsRUFBQSxLQUFBLGdCQUFBLEVBQUEsRUFBQSxhQUFBLEdBQUEsS0FBQSxDQUFBLENBQUEsS0FBQSxHQUFBLEVBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxFQUFBLE1BQUEsSUFBQSxFQUFBLEtBQUEsTUFBQSxJQUFBLEVBQUEsS0FBQSxjQUFBLEVBQUEsRUFBQSxLQUFBLEdBQUEsRUFBQSxDQUFBLENBQUEsR0FBQSxJQUFBLEtBQUEsS0FBQSxDQUFBLElBQUEsQ0FBQSxhQUFBLEVBQUEsR0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsYUFBQSxHQUFBLFNBQUEsQ0FBQSxFQUFBLEVBQUEsQ0FBQSxPQUFBLEtBQUEsQ0FBQSxFQTJCQTtBQUNBLE1BQUEsUUFBQSxHQUFBLGVBQUEsQ0FBQSxVQUFBLEVBQUE7QUFDQSxFQUFBLEtBQUEsRUFBQSxLQUFBO0FBQ0EsRUFBQSxPQUFBLEVBQUE7QUFDQSxJQUFBLEtBQUEsRUFBQSxDQUFBLFFBQUEsS0FBQTtBQUNBLE1BQUEsT0FBQSxDQUFBLHlCQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsTUFBQSxNQUFBLEdBQUEsT0FBQSxDQUFBLFFBQUEsRUFBQTtBQUNBO0FBQ0EsTUFBQSxPQUFBRCxrQkFBQSxDQUFBLE1BQUEsQ0FBQSxPQUFBLEVBQUEsUUFBQSxNQUFBLENBQUEsQ0FBQTtBQUNBLEtBQUE7QUFDQSxHQUFBO0FBQ0EsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLElBQUEsR0FBQSxpQkFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsMEJBQUE7QUFDQSxFQUFBLDJDQUFBO0FBQ0EsTUFBQSw0QkFBQSxHQUFBLHdCQUFBO0FBQ0E7QUFDQSxNQUFBLGFBQUE7QUFDQSxFQUFBLE9BQUEsQ0FBQSxHQUFBLENBQUEsZ0JBQUE7QUFDQSxFQUFBLE9BQUEsQ0FBQSxHQUFBLENBQUEsbUJBQUE7QUFDQSxFQUFBLE9BQUEsQ0FBQSxHQUFBLENBQUEsdUJBQUE7QUFDQSxNQUFBO0FBQ0EsUUFBQSxJQUFBLEVBQUEsT0FBQSxDQUFBLEdBQUEsQ0FBQSxnQkFBQTtBQUNBLFFBQUEsT0FBQSxFQUFBLE9BQUEsQ0FBQSxHQUFBLENBQUEsbUJBQUE7QUFDQSxRQUFBLFdBQUEsRUFBQSxPQUFBLENBQUEsR0FBQSxDQUFBLHVCQUFBO0FBQ0EsT0FBQTtBQUNBLE1BQUE7QUFDQSxRQUFBLElBQUEsRUFBQSxFQUFBO0FBQ0EsUUFBQSxPQUFBLEVBQUEsRUFBQTtBQUNBLFFBQUEsV0FBQSxFQUFBLEVBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQUEsYUFBQTtBQUNBLEVBQUE7QUFDQSxJQUFBLGVBQUEsR0FBQSxLQUFBO0FBQ0EsSUFBQSxvQkFBQSxHQUFBLElBQUE7QUFDQSxJQUFBLFlBQUEsR0FBQSxLQUFBO0FBQ0EsSUFBQSxvQkFBQSxHQUFBLEVBQUE7QUFDQSxJQUFBLGNBQUEsR0FBQSxFQUFBO0FBQ0EsSUFBQSxrQkFBQSxHQUFBLElBQUE7QUFDQSxJQUFBLGFBQUEsR0FBQSxFQUFBO0FBQ0EsSUFBQSxHQUFBLEdBQUEsYUFBQTtBQUNBLElBQUEsU0FBQTtBQUNBLElBQUEsT0FBQSxHQUFBLElBQUE7QUFDQSxJQUFBLGtCQUFBLEdBQUEsSUFBQTtBQUNBLElBQUEsS0FBQSxHQUFBO0FBQ0EsTUFBQSxZQUFBLEVBQUEsS0FBQTtBQUNBLE1BQUEsTUFBQSxFQUFBLEVBQUE7QUFDQSxNQUFBLGNBQUEsRUFBQSxFQUFBO0FBQ0EsTUFBQSxpQkFBQSxFQUFBLEVBQUE7QUFDQSxNQUFBLGdCQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUEsSUFBQSxFQUFBLEVBQUE7QUFDQSxNQUFBLEtBQUEsRUFBQSxFQUFBO0FBQ0EsTUFBQSxRQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUEsUUFBQSxFQUFBLEVBQUE7QUFDQSxNQUFBLFNBQUEsRUFBQSxFQUFBO0FBQ0EsTUFBQSxRQUFBLEVBQUEsSUFBQSxHQUFBLEVBQUE7QUFDQSxNQUFBLE1BQUEsRUFBQSxJQUFBO0FBQ0EsS0FBQTtBQUNBLEdBQUEsR0FBQSxFQUFBO0FBQ0EsRUFBQTtBQUNBLEVBQUEsTUFBQSxpQkFBQSxHQUFBLE9BQUE7QUFDQSxJQUFBLENBQUEsUUFBQSxLQUFBO0FBQ0EsTUFBQSxPQUFBLEVBQUEsQ0FBQSxRQUFBLENBQUEsUUFBQSxDQUFBO0FBQ0EsS0FBQTtBQUNBLElBQUE7QUFDQSxNQUFBLEtBQUEsRUFBQSxLQUFBLENBQUEsUUFBQTtBQUNBLEtBQUE7QUFDQSxJQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLElBQUEsYUFBQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLFlBQUEsR0FBQSxnQkFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLElBQUEsYUFBQSxHQUFBLEdBQUE7QUFDQSxFQUFBLElBQUEsb0JBQUEsS0FBQSxLQUFBLEVBQUE7QUFDQSxJQUFBLGFBQUEsR0FBQSx1QkFBQSxDQUFBLG9CQUFBLEVBQUE7QUFDQSxHQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLE9BQUE7QUFDQSxJQUFBLElBQUE7QUFDQTtBQUNBLElBQUEsZUFBQTtBQUNBLElBQUEsWUFBQTtBQUNBO0FBQ0EsSUFBQSxJQUFBLE1BQUEsR0FBQTtBQUNBLE1BQUEsT0FBQSxLQUFBLENBQUEsTUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsSUFBQSxTQUFBLEdBQUE7QUFDQSxNQUFBLE9BQUEsRUFBQSxJQUFBLEVBQUEsS0FBQSxDQUFBLElBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBQSxPQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLENBQUEsS0FBQSxDQUFBLFFBQUEsRUFBQTtBQUNBLFFBQUEsTUFBQSxFQUFBLGlCQUFBLEVBQUEsR0FBQSxXQUFBLEVBQUE7QUFDQSxVQUFBLG9CQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0E7QUFDQSxRQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsS0FBQSxFQUFBLFdBQUEsRUFBQTtBQUNBO0FBQ0EsUUFBQSxNQUFBLFlBQUEsR0FBQSxRQUFBLENBQUEsSUFBQSxDQUFBLGlCQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsUUFBQSxJQUFBLFlBQUEsQ0FBQSxPQUFBLEVBQUE7QUFDQSxVQUFBLE1BQUEsSUFBQSxLQUFBLENBQUEsQ0FBQSxFQUFBLE9BQUEsQ0FBQSxLQUFBLENBQUEsa0JBQUEsQ0FBQSxDQUFBO0FBQ0EsU0FBQTtBQUNBO0FBQ0EsUUFBQSxNQUFBLEVBQUEsWUFBQSxFQUFBLFVBQUEsRUFBQSxHQUFBLFlBQUEsQ0FBQSxPQUFBO0FBQ0EsUUFBQSxJQUFBLFNBQUEsQ0FBQSxVQUFBLENBQUEsSUFBQSxTQUFBLENBQUEsWUFBQSxDQUFBLEVBQUE7QUFDQSxVQUFBLE1BQUEsSUFBQSxLQUFBO0FBQ0EsWUFBQSxzRUFBQTtBQUNBLFdBQUE7QUFDQSxTQUFBO0FBQ0E7QUFDQSxRQUFBLFlBQUEsR0FBQSxZQUFBLENBQUEsU0FBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLE1BQUEsR0FBQSxJQUFBLENBQUEsT0FBQSxDQUFBLFlBQUEsRUFBQTtBQUNBO0FBQ0EsUUFBQSxJQUFBLGlCQUFBO0FBQ0EsUUFBQSxJQUFBLE9BQUEsY0FBQSxLQUFBLFVBQUEsRUFBQTtBQUNBLFVBQUEsZ0JBQUEsR0FBQSxjQUFBLENBQUEsWUFBQSxDQUFBLE1BQUEsRUFBQTtBQUNBLFNBQUEsTUFBQSxJQUFBLE9BQUEsY0FBQSxLQUFBLFFBQUEsRUFBQTtBQUNBLFVBQUEsZ0JBQUEsR0FBQTtBQUNBLFlBQUEsR0FBQSxZQUFBLENBQUEsTUFBQTtBQUNBLFlBQUEsR0FBQSxjQUFBO0FBQ0EsWUFBQTtBQUNBLFNBQUEsTUFBQTtBQUNBLFVBQUEsZ0JBQUEsR0FBQSxZQUFBLENBQUEsT0FBQTtBQUNBLFNBQUE7QUFDQTtBQUNBLFFBQUEsTUFBQSxZQUFBLEdBQUE7QUFDQTtBQUNBLFVBQUEsZ0JBQUEsRUFBQSxDQUFBO0FBQ0EsVUFBQSxJQUFBLEVBQUEsR0FBQSxDQUFBLElBQUE7QUFDQTtBQUNBLFVBQUEsT0FBQSxFQUFBLENBQUEsSUFBQUEsa0JBQUEsQ0FBQUMsZ0JBQUEsQ0FBQSxDQUFBLEdBQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxPQUFBLEVBQUEsZ0JBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLFFBQUEsRUFBQSxNQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUEsUUFBQSxFQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsVUFBQSxXQUFBLEVBQUEsR0FBQSxDQUFBLFdBQUE7QUFDQSxVQUFBLEdBQUEsZ0JBQUE7QUFDQSxVQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsUUFBQSxJQUFBLGtCQUFBLEVBQUE7QUFDQTtBQUNBLFVBQUEsS0FBQSxDQUFBLElBQUEsR0FBQSxhQUFBO0FBQ0EsYUFBQSxHQUFBLENBQUEsQ0FBQSxRQUFBLEtBQUE7QUFDQSxjQUFBLE1BQUEsTUFBQSxHQUFBLFFBQUEsQ0FBQTtBQUNBLGdCQUFBLElBQUEsRUFBQSxRQUFBO0FBQ0EsZ0JBQUEsSUFBQSxFQUFBLFlBQUE7QUFDQSxlQUFBLEVBQUE7QUFDQTtBQUNBLGNBQUEsT0FBQSxNQUFBO0FBQ0EsYUFBQSxDQUFBO0FBQ0EsYUFBQSxJQUFBLENBQUEsUUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLFVBQUEsTUFBQSxFQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsR0FBQSxFQUFBLEdBQUEsRUFBQSxNQUFBLEVBQUEsY0FBQSxFQUFBLEdBQUEsV0FBQTtBQUNBLFlBQUEsWUFBQTtBQUNBLFlBQUEsS0FBQSxDQUFBLE1BQUE7QUFDQSxZQUFBO0FBQ0EsY0FBQSxjQUFBLEVBQUEsSUFBQTtBQUNBLGFBQUE7QUFDQSxZQUFBO0FBQ0E7QUFDQSxVQUFBLEtBQUEsQ0FBQSxjQUFBLEdBQUEsZUFBQTtBQUNBO0FBQ0E7QUFDQSxVQUFBLEtBQUEsQ0FBQSxLQUFBLEdBQUEsQ0FBQSxHQUFBLEtBQUEsQ0FBQSxRQUFBLEVBQUEsR0FBQSxFQUFBLEVBQUEsR0FBQSxJQUFBLEVBQUE7QUFDQTtBQUNBLFVBQUEsS0FBQSxDQUFBLE1BQUEsR0FBQTtBQUNBO0FBQ0EsWUFBQSxHQUFBLElBQUEsR0FBQSxDQUFBLENBQUEsR0FBQSxHQUFBLEVBQUEsR0FBQSxHQUFBLEVBQUEsR0FBQSxNQUFBLENBQUEsQ0FBQTtBQUNBLFlBQUE7QUFDQSxTQUFBO0FBQ0E7QUFDQSxRQUFBLElBQUEsY0FBQTtBQUNBLFFBQUEsSUFBQSxLQUFBLENBQUEsWUFBQSxDQUFBLEVBQUE7QUFDQSxVQUFBLGFBQUEsR0FBQSxnQkFBQTtBQUNBLFlBQUEsWUFBQTtBQUNBLFlBQUEsT0FBQTtBQUNBLFlBQUEsa0JBQUE7QUFDQSxZQUFBLEtBQUE7QUFDQSxZQUFBO0FBQ0EsU0FBQSxNQUFBO0FBQ0EsVUFBQSxhQUFBLEdBQUEsYUFBQTtBQUNBLFNBQUE7QUFDQTtBQUNBLFFBQUEsS0FBQSxDQUFBLFFBQUEsR0FBQSxnQkFBQSxDQUFBLGFBQUEsRUFBQTtBQUNBLE9BQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsTUFBQSxVQUFBLEdBQUEsS0FBQSxDQUFBLEtBQUEsQ0FBQSxNQUFBO0FBQ0EsUUFBQSxjQUFBLENBQUEsS0FBQSxDQUFBLE1BQUEsQ0FBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLFFBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxNQUFBLENBQUEsSUFBQSxDQUFBLFVBQUEsQ0FBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxRQUFBLFVBQUEsQ0FBQSwwQkFBQSxDQUFBLEdBQUEsMkJBQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQSxNQUFBLE9BQUEsRUFBQSxHQUFBLE9BQUEsRUFBQSxLQUFBLEVBQUEsVUFBQSxFQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLFVBQUEsR0FBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLElBQUEsQ0FBQSxZQUFBLENBQUEsWUFBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLEtBQUEsQ0FBQSxNQUFBLENBQUEsT0FBQSxDQUFBLENBQUEsT0FBQSxLQUFBO0FBQ0EsUUFBQSxJQUFBLENBQUEsWUFBQSxDQUFBLE9BQUEsRUFBQTtBQUNBLE9BQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsTUFBQSxNQUFBLEdBQUEsTUFBQSxPQUFBLENBQUEsR0FBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLE1BQUEsQ0FBQSxHQUFBLENBQUEsT0FBQSxPQUFBLEtBQUE7QUFDQSxVQUFBLE1BQUEsTUFBQSxHQUFBLE1BQUEsaUJBQUEsQ0FBQSxPQUFBLEVBQUE7QUFDQTtBQUNBLFVBQUEsT0FBQTtBQUNBLFlBQUEsSUFBQSxFQUFBLE9BQUE7QUFDQSxZQUFBLE1BQUE7QUFDQSxZQUFBLFFBQUEsRUFBQSxJQUFBLENBQUEsUUFBQSxDQUFBLEtBQUEsQ0FBQSxNQUFBLEVBQUEsT0FBQSxDQUFBO0FBQ0EsV0FBQTtBQUNBLFNBQUEsQ0FBQTtBQUNBLFFBQUE7QUFDQTtBQUNBLE1BQUEsTUFBQSxDQUFBLE9BQUEsQ0FBQSxDQUFBLEtBQUEsS0FBQTtBQUNBLFFBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQSxLQUFBLEVBQUE7QUFDQSxPQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEscUJBQUEsQ0FBQSxJQUFBO0FBQ0EsUUFBQSxJQUFBO0FBQ0EsUUFBQTtBQUNBLFVBQUEsZUFBQTtBQUNBLFVBQUEsWUFBQTtBQUNBLFVBQUEsb0JBQUE7QUFDQSxVQUFBLGtCQUFBO0FBQ0EsVUFBQSxhQUFBO0FBQ0EsVUFBQSxTQUFBO0FBQ0EsU0FBQTtBQUNBLFFBQUEsS0FBQTtBQUNBLFFBQUE7QUFDQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLEtBQUEsQ0FBQSxLQUFBLENBQUEsUUFBQSxDQUFBLEVBQUEsTUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsWUFBQSxHQUFBLFdBQUEsQ0FBQSxLQUFBLENBQUEsUUFBQSxFQUFBO0FBQ0EsTUFBQSxNQUFBLFlBQUEsR0FBQSxJQUFBLENBQUEsU0FBQSxDQUFBLFlBQUEsRUFBQSxTQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUEsT0FBQTtBQUNBLFFBQUEsYUFBQTtBQUNBLFFBQUEsTUFBQTtBQUNBLFFBQUE7QUFDQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLENBQUEsUUFBQSxDQUFBO0FBQ0EsUUFBQSxJQUFBLEVBQUEsT0FBQTtBQUNBLFFBQUEsUUFBQSxFQUFBLFlBQUE7QUFDQSxRQUFBLE1BQUEsRUFBQSxZQUFBO0FBQ0EsT0FBQSxFQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLFNBQUEsQ0FBQSxNQUFBLEVBQUE7QUFDQSxNQUFBLE9BQUEsTUFBQSxLQUFBLDBCQUFBO0FBQ0EsUUFBQSxNQUFBLENBQUEsVUFBQSxDQUFBLDRCQUFBLENBQUE7QUFDQSxVQUFBLE1BQUE7QUFDQSxVQUFBLElBQUE7QUFDQSxLQUFBO0FBQ0E7QUFDQSxJQUFBLElBQUEsQ0FBQSxFQUFBLEVBQUE7QUFDQSxNQUFBLElBQUEsRUFBQSxLQUFBLDBCQUFBLEVBQUE7QUFDQSxRQUFBLE9BQUE7QUFDQSxVQUFBLElBQUEsRUFBQSxDQUFBLFlBQUEsRUFBQSwwQkFBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLFNBQUE7QUFDQSxPQUFBLE1BQUE7QUFDQSxRQUFBLGtCQUFBO0FBQ0EsUUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLFFBQUEsRUFBQSxDQUFBLFVBQUEsQ0FBQSw0QkFBQSxDQUFBO0FBQ0EsUUFBQTtBQUNBLFFBQUEsTUFBQSxHQUFBLE1BQUEsQ0FBQSxHQUFBLEVBQUEsQ0FBQSxLQUFBLENBQUEsR0FBQSxFQUFBO0FBQ0EsUUFBQSxNQUFBLElBQUEsR0FBQUMsTUFBQSxDQUFBLE9BQUEsQ0FBQSxRQUFBLEVBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxNQUFBLENBQUEsRUFBQTtBQUNBLFFBQUEsT0FBQSxFQUFBLElBQUEsRUFBQTtBQUNBLE9BQUE7QUFDQTtBQUNBLE1BQUEsT0FBQSxJQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxTQUFBLENBQUEsSUFBQSxFQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUE7QUFDQSxRQUFBLGtCQUFBO0FBQ0EsUUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLGNBQUEsQ0FBQSxRQUFBLENBQUEsRUFBQSxDQUFBO0FBQ0EsUUFBQTtBQUNBO0FBQ0EsUUFBQSxNQUFBLE1BQUEsR0FBQSxDQUFBLEVBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQSxLQUFBLENBQUEsTUFBQSxFQUFBLEVBQUEsQ0FBQSxDQUFBO0FBQ0EsV0FBQSxLQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsV0FBQSxLQUFBLENBQUEsQ0FBQSxFQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsV0FBQSxJQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsR0FBQSxFQUFBO0FBQ0E7QUFDQSxRQUFBLE1BQUEsUUFBQSxHQUFBLDhCQUFBLENBQUEsTUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLFFBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLFVBQUEsRUFBQSxFQUFBLENBQUEsRUFBQSw0QkFBQSxDQUFBLENBQUEsRUFBQSxNQUFBLENBQUEsQ0FBQTtBQUNBLFVBQUEsSUFBQSxFQUFBLE9BQUE7QUFDQSxVQUFBLFFBQUE7QUFDQSxTQUFBLEVBQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsT0FBQSxFQUFBLElBQUEsRUFBQSxHQUFBLEVBQUEsSUFBQSxFQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxXQUFBLENBQUEsRUFBQSxFQUFBO0FBQ0EsTUFBQSxJQUFBLEVBQUEsQ0FBQSxRQUFBLENBQUEsWUFBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsT0FBQSxLQUFBLENBQUEsU0FBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLFlBQUEsR0FBQSxNQUFBO0FBQ0EsT0FBQSxNQUFBO0FBQ0E7QUFDQSxRQUFBLEtBQUEsQ0FBQSxZQUFBLEdBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQSxNQUFBLENBQUEsRUFBQSxFQUFBO0FBQ0EsT0FBQTtBQUNBLEtBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBQSxjQUFBLENBQUEsT0FBQSxFQUFBLE1BQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE9BQUEsTUFBQSxDQUFBLDBCQUFBLEdBQUEsS0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxNQUFBLENBQUEsSUFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxRQUFBLE1BQUEsSUFBQSxLQUFBO0FBQ0EsVUFBQSxpRkFBQTtBQUNBLFNBQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxLQUFBLENBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQSxFQUFBLE1BQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxXQUFBLEdBQUEsR0FBQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLEtBQUEsQ0FBQSxZQUFBLElBQUEsS0FBQSxDQUFBLFNBQUEsRUFBQTtBQUNBO0FBQ0EsUUFBQSxXQUFBLEdBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxLQUFBLENBQUEsU0FBQSxFQUFBO0FBQ0E7QUFDQSxRQUFBLEtBQUEsQ0FBQSxZQUFBLEdBQUEsTUFBQTtBQUNBLE9BQUEsTUFBQTtBQUNBLFFBQUEsTUFBQSxNQUFBLEdBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxNQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLFFBQUEsV0FBQSxHQUFBLEtBQUEsQ0FBQSxJQUFBO0FBQ0EsVUFBQSxNQUFBLENBQUEsTUFBQSxDQUFBLGlCQUFBLEVBQUEsSUFBQSxHQUFBLEVBQUEsQ0FBQTtBQUNBLFVBQUE7QUFDQTtBQUNBLFFBQUEsTUFBQSxTQUFBLEdBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxXQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsSUFBQSxPQUFBLElBQUEsV0FBQSxDQUFBLE1BQUEsRUFBQTtBQUNBLFVBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxTQUFBLEVBQUE7QUFDQSxZQUFBLElBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxzQkFBQSxFQUFBLFdBQUEsQ0FBQSxRQUFBLEVBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxXQUFBLE1BQUEsSUFBQSxTQUFBLEtBQUEsS0FBQSxDQUFBLFNBQUEsRUFBQTtBQUNBLFlBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLDBCQUFBLEVBQUEsV0FBQSxDQUFBLFFBQUEsRUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLFdBQUE7QUFDQSxTQUFBO0FBQ0E7QUFDQSxRQUFBLEtBQUEsQ0FBQSxTQUFBLEdBQUEsVUFBQTtBQUNBLE9BQUE7QUFDQTtBQUNBLE1BQUEsTUFBQSxjQUFBLEdBQUEsV0FBQTtBQUNBLFFBQUEsS0FBQSxDQUFBLFFBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsWUFBQSxHQUFBO0FBQ0EsUUFBQSxHQUFBLGNBQUE7QUFDQSxRQUFBLFdBQUEsRUFBQSxZQUFBO0FBQ0EsVUFBQSxXQUFBO0FBQ0EsVUFBQSxjQUFBLENBQUEsV0FBQSxJQUFBLEVBQUE7QUFDQSxTQUFBO0FBQ0EsUUFBQTtBQUNBO0FBQ0EsTUFBQSxNQUFBO0FBQ0EsUUFBQSxVQUFBLEVBQUEsRUFBQSxPQUFBLEVBQUEsR0FBQSxHQUFBLEVBQUEsRUFBQSxHQUFBLEVBQUE7QUFDQSxRQUFBLGVBQUEsRUFBQSxHQUFBLEdBQUEsRUFBQTtBQUNBLFFBQUEsd0JBQUEsRUFBQSxHQUFBLEdBQUEsRUFBQTtBQUNBLE9BQUEsR0FBQSxhQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLElBQUEsR0FBQSxDQUFBLE1BQUEsSUFBQSxhQUFBLENBQUEsTUFBQSxFQUFBO0FBQ0E7QUFDQSxRQUFBLFlBQUEsQ0FBQSxVQUFBLENBQUEsT0FBQSxHQUFBLEdBQUE7QUFDQSxXQUFBLEdBQUEsQ0FBQSxpQkFBQSxDQUFBO0FBQ0EsV0FBQSxHQUFBLENBQUEsQ0FBQSxVQUFBLEtBQUE7QUFDQTtBQUNBLFlBQUEsTUFBQSxNQUFBO0FBQ0E7QUFDQSxjQUFBLGFBQUEsQ0FBQSxPQUFBO0FBQ0EsZ0JBQUEsUUFBQTtBQUNBO0FBQ0EsZ0JBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxLQUFBLENBQUEsUUFBQSxDQUFBLFFBQUEsRUFBQSxVQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsZ0JBQUE7QUFDQTtBQUNBLFlBQUEsTUFBQSxPQUFBLEdBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLGNBQUEsSUFBQSxFQUFBLE9BQUE7QUFDQSxjQUFBLE1BQUE7QUFDQSxjQUFBLElBQUEsRUFBQSxRQUFBLENBQUEsVUFBQSxDQUFBO0FBQ0EsYUFBQSxFQUFBO0FBQ0E7QUFDQSxZQUFBLE9BQUEsSUFBQSxDQUFBLFdBQUEsQ0FBQSxPQUFBLENBQUE7QUFDQSxXQUFBLENBQUE7QUFDQSxXQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsS0FBQSxLQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsTUFBQSxjQUFBLEdBQUEsR0FBQSxDQUFBLE1BQUE7QUFDQSxRQUFBLENBQUEsQ0FBQSxFQUFBLEVBQUEsRUFBQSxHQUFBLEVBQUEsRUFBQSxLQUFBLENBQUEsR0FBQSxDQUFBLEVBQUEsR0FBQSxFQUFBLENBQUE7QUFDQSxRQUFBLEVBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQSxNQUFBLElBQUEsb0JBQUEsSUFBQSxjQUFBLENBQUEsTUFBQSxFQUFBO0FBQ0EsUUFBQSxNQUFBLGVBQUEsR0FBQSxPQUFBLENBQUEsQ0FBQSxVQUFBLEtBQUE7QUFDQSxVQUFBLE1BQUEsTUFBQSxHQUFBQSxNQUFBLENBQUEsT0FBQTtBQUNBLFlBQUEsUUFBQTtBQUNBO0FBQ0EsWUFBQSxJQUFBLENBQUEsU0FBQSxDQUFBLEtBQUEsQ0FBQSxRQUFBLENBQUEsUUFBQSxFQUFBLFVBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxZQUFBO0FBQ0E7QUFDQSxVQUFBLE1BQUEsT0FBQSxHQUFBLElBQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxZQUFBLElBQUEsRUFBQSxPQUFBO0FBQ0EsWUFBQSxNQUFBO0FBQ0EsWUFBQSxJQUFBLEVBQUEsUUFBQSxDQUFBLFVBQUEsQ0FBQTtBQUNBLFdBQUEsRUFBQTtBQUNBO0FBQ0EsVUFBQSxPQUFBLElBQUEsQ0FBQSxXQUFBLENBQUEsT0FBQSxDQUFBO0FBQ0EsU0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLFFBQUEsWUFBQSxDQUFBLGVBQUEsR0FBQSxHQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsRUFBQSxFQUFBLEVBQUEsR0FBQSxJQUFBLEVBQUEsS0FBQTtBQUNBLFVBQUEsT0FBQSxPQUFBLEVBQUEsS0FBQSxXQUFBO0FBQ0EsY0FBQSxJQUFBO0FBQ0EsY0FBQTtBQUNBLGdCQUFBLEVBQUEsRUFBQSxFQUFBO0FBQ0EsbUJBQUEsR0FBQSxDQUFBLGlCQUFBLENBQUE7QUFDQSxtQkFBQSxHQUFBLENBQUEsZUFBQSxDQUFBO0FBQ0EsbUJBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxLQUFBLEtBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLGdCQUFBLEdBQUEsSUFBQTtBQUNBLGVBQUE7QUFDQSxTQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0EsUUFBQSxNQUFBLE9BQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQTtBQUNBLFdBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxJQUFBLEtBQUEsT0FBQSxDQUFBO0FBQ0EsV0FBQSxNQUFBO0FBQ0EsWUFBQSxDQUFBLENBQUEsRUFBQSxFQUFBLE9BQUEsRUFBQSxRQUFBLEVBQUE7QUFDQTtBQUNBLGNBQUEsQ0FBQSxPQUFBLEdBQUEsQ0FBQSxHQUFBLENBQUEsRUFBQSxRQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsWUFBQSxFQUFBO0FBQ0EsWUFBQTtBQUNBO0FBQ0EsUUFBQSxZQUFBLENBQUEsd0JBQUEsR0FBQSxLQUFBLENBQUEsSUFBQTtBQUNBLFVBQUEsSUFBQSxHQUFBLENBQUE7QUFDQSxZQUFBLEdBQUEsR0FBQTtBQUNBO0FBQ0EsWUFBQSxHQUFBLE9BQUE7QUFDQTtBQUNBLFlBQUEsR0FBQSxjQUFBO0FBQ0EsV0FBQSxDQUFBO0FBQ0EsU0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsS0FBQSxLQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0EsT0FBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsSUFBQSxTQUFBLEVBQUE7QUFDQSxRQUFBLFlBQUEsQ0FBQSxHQUFBLEdBQUEsVUFBQTtBQUNBLE9BQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLFlBQUEsR0FBQSxJQUFBLENBQUEsU0FBQSxDQUFBLFlBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxDQUFBLENBQUEsT0FBQTtBQUNBLFFBQUEsYUFBQTtBQUNBLFFBQUEsTUFBQTtBQUNBLFFBQUE7QUFDQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLENBQUEsUUFBQSxDQUFBO0FBQ0EsUUFBQSxJQUFBLEVBQUEsT0FBQTtBQUNBLFFBQUEsUUFBQSxFQUFBLFlBQUE7QUFDQSxRQUFBLE1BQUEsRUFBQSxZQUFBO0FBQ0EsT0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLEtBQUE7QUFDQSxHQUFBO0FBQ0E7Ozs7QUM3akJBLFNBQUFELGdCQUFBLENBQUEsR0FBQSxFQUFBLEVBQUEsSUFBQSxhQUFBLEdBQUEsU0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLEdBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsR0FBQSxDQUFBLE1BQUEsRUFBQSxFQUFBLE1BQUEsRUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLE1BQUEsRUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLEVBQUEsS0FBQSxnQkFBQSxJQUFBLEVBQUEsS0FBQSxjQUFBLEtBQUEsS0FBQSxJQUFBLElBQUEsRUFBQSxFQUFBLE9BQUEsU0FBQSxDQUFBLEVBQUEsQ0FBQSxJQUFBLEVBQUEsS0FBQSxRQUFBLElBQUEsRUFBQSxLQUFBLGdCQUFBLEVBQUEsRUFBQSxhQUFBLEdBQUEsS0FBQSxDQUFBLENBQUEsS0FBQSxHQUFBLEVBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxFQUFBLE1BQUEsSUFBQSxFQUFBLEtBQUEsTUFBQSxJQUFBLEVBQUEsS0FBQSxjQUFBLEVBQUEsRUFBQSxLQUFBLEdBQUEsRUFBQSxDQUFBLENBQUEsR0FBQSxJQUFBLEtBQUEsS0FBQSxDQUFBLElBQUEsQ0FBQSxhQUFBLEVBQUEsR0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsYUFBQSxHQUFBLFNBQUEsQ0FBQSxFQUFBLEVBQUEsQ0FBQSxPQUFBLEtBQUEsQ0FBQSxFQUtBO0FBQ0E7QUFDQSxNQUFBLGNBQUEsR0FBQSxFQUFBLGFBQUEsRUFBQSxJQUFBLEdBQUE7QUFDQSxTQUFBLGVBQUEsQ0FBQTtBQUNBLEVBQUEsZUFBQSxFQUFBLE9BQUEsR0FBQSxjQUFBO0FBQ0EsQ0FBQTtBQUNBO0FBQ0E7QUFDQSxDQUFBO0FBQ0EsRUFBQSxJQUFBLE9BQUEsS0FBQSxLQUFBO0FBQ0EsSUFBQSxPQUFBO0FBQ0EsTUFBQSxJQUFBLEVBQUEsT0FBQTtBQUNBLE1BQUEsY0FBQSxHQUFBLEVBQUE7QUFDQSxLQUFBO0FBQ0EsT0FBQSxJQUFBLE9BQUEsS0FBQSxJQUFBLEVBQUEsT0FBQSxHQUFBLGVBQUE7QUFDQSxFQUFBLE1BQUEsRUFBQSxhQUFBLEdBQUEsSUFBQSxFQUFBLEdBQUEsUUFBQTtBQUNBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsT0FBQSxHQUFBLE9BQUEsQ0FBQSxvQkFBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLFlBQUEsR0FBQSxPQUFBLENBQUEsT0FBQSxDQUFBLHVCQUFBLEVBQUE7QUFDQSxFQUFBLE1BQUEsR0FBQSxHQUFBLEVBQUEsQ0FBQSxZQUFBLENBQUEsWUFBQSxFQUFBLE9BQUEsRUFBQTtBQUNBLEVBQUEsTUFBQSxHQUFBLEdBQUEsRUFBQSxDQUFBLFlBQUEsQ0FBQSxZQUFBLEdBQUEsTUFBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsa0JBQUEsR0FBQTtBQUNBLElBQUEsT0FBQSxDQUFBLHFCQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsSUFBQSxPQUFBLENBQUEsVUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLFNBQUEsRUFBQTtBQUNBLEdBQUEsQ0FBQSxJQUFBLENBQUEsSUFBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLE9BQUE7QUFDQSxJQUFBLElBQUEsRUFBQSxrQkFBQTtBQUNBLElBQUEsY0FBQSxDQUFBLEVBQUEsT0FBQSxHQUFBLEVBQUEsRUFBQSxFQUFBLE1BQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxhQUFBLEdBQUEsT0FBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEVBQUEsSUFBQSxFQUFBLEtBQUEsSUFBQSxLQUFBLGVBQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxxQkFBQSxHQUFBLE9BQUEsQ0FBQSxJQUFBO0FBQ0EsUUFBQSxDQUFBLEVBQUEsSUFBQSxFQUFBLEtBQUEsSUFBQSxLQUFBLGtCQUFBO0FBQ0EsUUFBQTtBQUNBO0FBQ0EsTUFBQTtBQUNBLFFBQUEsYUFBQTtBQUNBLFFBQUEsQ0FBQSxxQkFBQSxDQUFBLFFBQUEsQ0FBQSxRQUFBLENBQUEsWUFBQTtBQUNBLFFBQUE7QUFDQSxRQUFBLE1BQUE7QUFDQSxPQUFBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsYUFBQSxHQUFBLE1BQUEsQ0FBQSxlQUFBLEVBQUE7QUFDQSxNQUFBLElBQUEsQ0FBQSxPQUFBLENBQUEsYUFBQSxDQUFBLEVBQUE7QUFDQSxRQUFBLE1BQUEsSUFBQSxTQUFBO0FBQ0EsVUFBQSxDQUFBLGdEQUFBLEVBQUEsT0FBQSxhQUFBLENBQUEsQ0FBQSxDQUFBO0FBQ0EsU0FBQTtBQUNBLE9BQUE7QUFDQSxNQUFBLE1BQUEsUUFBQSxHQUFBLElBQUEsQ0FBQSxLQUFBO0FBQ0EsUUFBQSxhQUFBLENBQUEsTUFBQTtBQUNBLFFBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLElBQUEsS0FBQSxDQUFBLFFBQUEsQ0FBQSxFQUFBLE1BQUE7QUFDQTtBQUNBLE1BQUEsTUFBQSxJQUFBLEdBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLFFBQUEsSUFBQSxFQUFBLE9BQUE7QUFDQSxRQUFBLE1BQUEsRUFBQSxrQkFBQTtBQUNBLFFBQUEsUUFBQSxFQUFBLDRCQUFBO0FBQ0EsT0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsbUJBQUEsR0FBQSxJQUFBLENBQUEsV0FBQSxDQUFBLElBQUEsRUFBQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLGFBQUEsRUFBQTtBQUNBLFFBQUEsTUFBQSxJQUFBLEdBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQTtBQUNBLFVBQUEsSUFBQSxFQUFBLE9BQUE7QUFDQSxVQUFBLE1BQUEsRUFBQUUsTUFBQSxDQUFBLE9BQUE7QUFDQSxZQUFBLHlCQUFBO0FBQ0EsWUFBQSxJQUFBLENBQUEsU0FBQSxDQUFBLG1CQUFBLENBQUE7QUFDQSxXQUFBO0FBQ0EsVUFBQSxRQUFBLEVBQUEsMENBQUE7QUFDQSxTQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsTUFBQSx5QkFBQSxHQUFBLElBQUEsQ0FBQSxXQUFBLENBQUEsSUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLFFBQUFGLGdCQUFBLENBQUEsQ0FBQSxRQUFBLEVBQUEsUUFBQSxFQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsVUFBQSxFQUFBLGdCQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxPQUFBLEVBQUEsZ0JBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLE9BQUEsRUFBQSxNQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSx5QkFBQSxDQUFBLENBQUEsRUFBQTtBQUNBLE9BQUE7QUFDQTtBQUNBO0FBQ0EsTUFBQUEsZ0JBQUEsQ0FBQSxDQUFBLFFBQUEsRUFBQSxRQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxVQUFBLEVBQUEsZ0JBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLE9BQUEsRUFBQSxnQkFBQSxFQUFBLEVBQUEsSUFBQSxFQUFBLENBQUEsT0FBQSxFQUFBLE1BQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLG1CQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0EsTUFBQUEsZ0JBQUEsQ0FBQSxDQUFBLFFBQUEsRUFBQSxRQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxlQUFBLEVBQUEsZ0JBQUEsRUFBQSxHQUFBLElBQUEsR0FBQSxDQUFBLE9BQUEsRUFBQSxNQUFBLEVBQUEsR0FBQSxJQUFBLEdBQUEsQ0FBQSxDQUFBLE1BQUEsS0FBQTtBQUNBLFFBQUFBLGdCQUFBLENBQUEsQ0FBQSxNQUFBLEVBQUEsUUFBQSxFQUFBLEdBQUEsSUFBQSxHQUFBLENBQUEsRUFBQSxFQUFBLGdCQUFBLEVBQUEsR0FBQSxJQUFBLEdBQUEsQ0FBQSxPQUFBLEVBQUEsTUFBQSxFQUFBLEdBQUEsSUFBQSxHQUFBLENBQUEsbUJBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxPQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsYUFBQSxDQUFBLE1BQUEsR0FBQSxJQUFBLENBQUEsU0FBQSxDQUFBLFFBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQSxHQUFBO0FBQ0E7O0FDdkZBLE1BQUEsYUFBQSxHQUFBLE9BQUE7QUFDQSxFQUFBLElBQUEsRUFBQSxnQkFBQTtBQUNBO0FBQ0EsRUFBQSxjQUFBLENBQUEsT0FBQSxFQUFBLE1BQUEsRUFBQTtBQUNBLElBQUEsTUFBQSxNQUFBLEdBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxNQUFBO0FBQ0EsTUFBQSxDQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsSUFBQSxLQUFBLE9BQUE7QUFDQSxNQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsQ0FBQSxJQUFBLENBQUEsTUFBQSxDQUFBO0FBQ0EsT0FBQSxNQUFBLENBQUEsQ0FBQSxRQUFBLEtBQUEsUUFBQSxDQUFBLFFBQUEsQ0FBQSxDQUFBLFVBQUEsQ0FBQSxrQkFBQSxDQUFBLENBQUE7QUFDQSxPQUFBLE9BQUEsQ0FBQSxDQUFBLFFBQUEsS0FBQTtBQUNBO0FBQ0EsUUFBQSxNQUFBLEtBQUEsR0FBQSxJQUFBLE1BQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQSxRQUFBLE1BQUEsQ0FBQSxJQUFBLEVBQUEsR0FBQSxJQUFBLENBQUEsR0FBQSxRQUFBLENBQUEsS0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLE9BQUEsR0FBQTtBQUNBLFFBQUEsTUFBQSxLQUFBLEdBQUEsQ0FBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsQ0FBQSxFQUFBLEdBQUEsSUFBQSxDQUFBLENBQUEsT0FBQSxFQUFBLENBQUEsSUFBQSxDQUFBLEdBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQSxRQUFBLE1BQUEsUUFBQSxHQUFBLE1BQUEsQ0FBQSxlQUFBLEVBQUE7QUFDQSxRQUFBLFFBQUEsQ0FBQSxNQUFBLEdBQUEsUUFBQSxDQUFBLE1BQUEsQ0FBQSxPQUFBLENBQUEsS0FBQSxFQUFBLEtBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQSxRQUFBLE1BQUEsS0FBQSxHQUFBLE1BQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQSxRQUFBLE9BQUEsTUFBQSxDQUFBLFFBQUEsRUFBQTtBQUNBLFFBQUEsTUFBQSxDQUFBLEtBQUEsQ0FBQSxHQUFBLE1BQUE7QUFDQTtBQUNBO0FBQ0EsUUFBQSxLQUFBLENBQUEsUUFBQSxHQUFBLE1BQUE7QUFDQTtBQUNBO0FBQ0EsUUFBQSxNQUFBO0FBQ0EsV0FBQSxNQUFBLENBQUEsQ0FBQSxFQUFBLE9BQUEsRUFBQSxLQUFBLE9BQUEsQ0FBQSxRQUFBLENBQUEsUUFBQSxDQUFBLENBQUE7QUFDQSxXQUFBLE9BQUEsQ0FBQSxDQUFBLEtBQUEsS0FBQTtBQUNBO0FBQ0EsWUFBQSxLQUFBLENBQUEsT0FBQSxHQUFBLEtBQUEsQ0FBQSxPQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQTtBQUNBLGNBQUEsQ0FBQSxLQUFBLFFBQUEsR0FBQSxLQUFBLEdBQUEsQ0FBQTtBQUNBLGNBQUE7QUFDQTtBQUNBLFlBQUEsS0FBQSxDQUFBLElBQUEsR0FBQSxLQUFBLENBQUEsSUFBQSxDQUFBLE9BQUEsQ0FBQSxLQUFBLEVBQUEsS0FBQSxFQUFBO0FBQ0EsV0FBQSxFQUFBO0FBQ0EsT0FBQSxFQUFBO0FBQ0EsR0FBQTtBQUNBLENBQUE7O0FDbkRBLE1BQUEsaUJBQUEsR0FBQSxDQUFBLE1BQUEsTUFBQTtBQUNBLEVBQUEsSUFBQSxFQUFBLHFCQUFBO0FBQ0EsRUFBQSxTQUFBLENBQUEsTUFBQSxFQUFBLFFBQUEsRUFBQTtBQUNBLElBQUEsSUFBQSxPQUFBLFFBQUEsS0FBQSxXQUFBLEVBQUE7QUFDQSxNQUFBLE9BQUEsTUFBQTtBQUNBLEtBQUEsTUFBQTtBQUNBLE1BQUEsTUFBQSxPQUFBLEdBQUEsSUFBQSxDQUFBLE9BQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQSxNQUFBLE1BQUEsUUFBQSxHQUFBLElBQUEsQ0FBQSxJQUFBLENBQUEsT0FBQSxFQUFBLE1BQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsT0FBQSxRQUFBLElBQUEsTUFBQSxHQUFBLFFBQUEsR0FBQSxLQUFBO0FBQ0EsS0FBQTtBQUNBLEdBQUE7QUFDQSxFQUFBLElBQUEsQ0FBQSxFQUFBLEVBQUE7QUFDQSxJQUFBLE1BQUEsS0FBQSxHQUFBLE1BQUEsQ0FBQSxFQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsSUFBQSxPQUFBLENBQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxNQUFBLE9BQUE7QUFDQSxRQUFBLElBQUEsRUFBQSxLQUFBLENBQUEsSUFBQTtBQUNBLFFBQUEsR0FBQSxFQUFBLEtBQUEsQ0FBQSxHQUFBO0FBQ0EsT0FBQTtBQUNBLEtBQUEsTUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsT0FBQSxJQUFBO0FBQ0EsS0FBQTtBQUNBLEdBQUE7QUFDQSxDQUFBOztBQzVCQSxlQUFBLGdCQUFBO0FBQ0E7QUFDQSxFQUFBLEVBQUEsS0FBQSxFQUFBLE1BQUEsRUFBQTtBQUNBLEVBQUEsTUFBQTtBQUNBLEVBQUE7QUFDQSxFQUFBLElBQUEsQ0FBQSxNQUFBLElBQUEsS0FBQSxDQUFBLE9BQUEsQ0FBQSxNQUFBLENBQUEsRUFBQTtBQUNBLElBQUEsTUFBQSxJQUFBLFNBQUEsQ0FBQSxnREFBQSxDQUFBO0FBQ0EsR0FBQTtBQUNBO0FBQ0EsRUFBQSxJQUFBLE9BQUEsS0FBQSxLQUFBLFdBQUEsRUFBQTtBQUNBLElBQUEsTUFBQSxJQUFBLFNBQUE7QUFDQSxNQUFBLDJEQUFBO0FBQ0EsS0FBQTtBQUNBLEdBQUE7QUFDQTtBQUNBO0FBQ0EsRUFBQSxJQUFBLEtBQUEsQ0FBQSxPQUFBLENBQUEsS0FBQSxDQUFBLElBQUEsS0FBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLEVBQUE7QUFDQSxJQUFBLE9BQUEsRUFBQTtBQUNBLEdBQUE7QUFDQTtBQUNBLEVBQUEsTUFBQSxFQUFBLE1BQUEsRUFBQSxjQUFBLEVBQUEsR0FBQSxHQUFBLEVBQUEsRUFBQSxTQUFBLEVBQUEsR0FBQSxPQUFBO0FBQ0E7QUFDQSxFQUFBLE1BQUEsY0FBQSxHQUFBLElBQUEsQ0FBQSxJQUFBLENBQUEsSUFBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsRUFBQSxXQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLFVBQUEsR0FBQSxLQUFBLENBQUEsT0FBQSxDQUFBLEtBQUEsQ0FBQTtBQUNBLE1BQUEsS0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxDQUFBLEtBQUE7QUFDQSxRQUFBLE1BQUEsRUFBQSxHQUFBLEVBQUEsSUFBQSxFQUFBLEdBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQSxRQUFBLE9BQUEsRUFBQSxHQUFBLENBQUEsRUFBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQSxFQUFBLElBQUEsQ0FBQSxHQUFBLENBQUEsRUFBQTtBQUNBLE9BQUEsRUFBQSxFQUFBLEVBQUE7QUFDQSxNQUFBLE1BQUE7QUFDQTtBQUNBLEVBQUEsTUFBQSxLQUFBLEdBQUEsTUFBQSxNQUFBLENBQUE7QUFDQSxJQUFBLEtBQUEsRUFBQSxVQUFBO0FBQ0EsSUFBQSxPQUFBLEVBQUEsQ0FBQSxpQkFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBO0FBQ0EsR0FBQSxFQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUEsR0FBQTtBQUNBLEVBQUEsTUFBQSxLQUFBLENBQUEsUUFBQSxDQUFBO0FBQ0EsSUFBQSxNQUFBO0FBQ0EsSUFBQSxTQUFBO0FBQ0EsSUFBQSxjQUFBO0FBQ0EsSUFBQSxPQUFBLEVBQUE7QUFDQSxNQUFBO0FBQ0EsUUFBQSxJQUFBLEVBQUEsWUFBQTtBQUNBLFFBQUEsY0FBQSxDQUFBLENBQUEsRUFBQSxDQUFBLEVBQUE7QUFDQSxVQUFBLEVBQUEsR0FBQSxFQUFBO0FBQ0EsU0FBQTtBQUNBLE9BQUE7QUFDQSxLQUFBO0FBQ0EsR0FBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLFNBQUEsR0FBQSxHQUFBO0FBQ0E7QUFDQSxFQUFBLElBQUEsT0FBQSxVQUFBLEtBQUEsUUFBQSxFQUFBO0FBQ0EsSUFBQSxPQUFBLE1BQUEsQ0FBQSxVQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsTUFBQSxTQUFBLEdBQUEsSUFBQSxDQUFBLFFBQUEsQ0FBQSxVQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsT0FBQTtBQUNBLE1BQUEsQ0FBQSxVQUFBLEdBQUE7QUFDQSxRQUFBLElBQUEsU0FBQSxDQUFBLFNBQUEsQ0FBQSxFQUFBO0FBQ0EsUUFBQSxRQUFBLEVBQUEsVUFBQTtBQUNBLE9BQUE7QUFDQSxLQUFBO0FBQ0EsR0FBQSxNQUFBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsVUFBQSxDQUFBLENBQUEsT0FBQSxDQUFBLENBQUEsR0FBQSxLQUFBO0FBQ0EsTUFBQSxPQUFBLE1BQUEsQ0FBQSxHQUFBLEVBQUE7QUFDQSxLQUFBLEVBQUE7QUFDQTtBQUNBLElBQUEsT0FBQSxTQUFBO0FBQ0EsR0FBQTtBQUNBOztBQ25FQSxTQUFBLFdBQUE7QUFDQSxFQUFBLE9BQUE7QUFDQSxFQUFBO0FBQ0EsRUFBQSxPQUFBO0FBQ0EsSUFBQSxJQUFBLEVBQUEsY0FBQTtBQUNBLElBQUEsTUFBQSxjQUFBO0FBQ0E7QUFDQSxNQUFBLEVBQUEsTUFBQSxFQUFBLGNBQUEsRUFBQSxTQUFBLEVBQUE7QUFDQSxNQUFBLE1BQUE7QUFDQSxNQUFBO0FBQ0EsTUFBQSxNQUFBLEVBQUEsU0FBQSxFQUFBLEdBQUEsUUFBQTtBQUNBO0FBQ0EsTUFBQSxJQUFBLE9BQUEsU0FBQSxLQUFBLFdBQUEsRUFBQSxNQUFBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsT0FBQSxHQUFBLE1BQUEsQ0FBQSxPQUFBLENBQUEsU0FBQSxDQUFBLENBQUEsTUFBQTtBQUNBLFFBQUEsQ0FBQSxDQUFBO0FBQ0EsVUFBQSxPQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsS0FBQSxXQUFBO0FBQ0EsUUFBQTtBQUNBO0FBQ0EsTUFBQTtBQUNBLFFBQUEsTUFBQSxRQUFBLEdBQUEsT0FBQSxDQUFBLE9BQUEsQ0FBQSxDQUFBLEdBQUEsTUFBQSxDQUFBO0FBQ0EsVUFBQSxLQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsQ0FBQSxHQUFBLE1BQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLE1BQUEsSUFBQSxFQUFBLENBQUE7QUFDQSxVQUFBO0FBQ0EsUUFBQSxNQUFBLFdBQUEsR0FBQSxJQUFBLEdBQUEsQ0FBQSxRQUFBLEVBQUE7QUFDQSxRQUFBLElBQUEsUUFBQSxDQUFBLE1BQUEsS0FBQSxXQUFBLENBQUEsSUFBQSxFQUFBO0FBQ0EsVUFBQSxNQUFBLElBQUEsS0FBQSxDQUFBLDBDQUFBLENBQUE7QUFDQSxTQUFBO0FBQ0EsT0FBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsT0FBQSxHQUFBLE1BQUEsT0FBQSxDQUFBLEdBQUE7QUFDQTtBQUNBLFFBQUEsT0FBQSxDQUFBLE9BQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxFQUFBLE1BQUEsQ0FBQTtBQUNBLFVBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsQ0FBQSxHQUFBLE1BQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLE1BQUEsQ0FBQSxFQUFBLEdBQUE7QUFDQSxZQUFBLENBQUEsS0FBQTtBQUNBLGNBQUEsZ0JBQUEsQ0FBQSxJQUFBO0FBQ0EsZ0JBQUEsSUFBQTtBQUNBLGdCQUFBO0FBQ0Esa0JBQUEsS0FBQTtBQUNBLGtCQUFBLE1BQUEsRUFBQTtBQUNBLG9CQUFBLE1BQUEsRUFBQSxDQUFBO0FBQ0Esb0JBQUEsY0FBQTtBQUNBLG9CQUFBLFNBQUE7QUFDQSxtQkFBQTtBQUNBLGlCQUFBO0FBQ0EsZ0JBQUEsTUFBQTtBQUNBLGVBQUE7QUFDQSxXQUFBO0FBQ0EsU0FBQTtBQUNBLFFBQUE7QUFDQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLElBQUEsR0FBQSxNQUFBLGdCQUFBLENBQUEsSUFBQTtBQUNBLFFBQUEsSUFBQTtBQUNBLFFBQUE7QUFDQSxVQUFBLEtBQUEsRUFBQSxNQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsQ0FBQTtBQUNBLGFBQUEsTUFBQSxDQUFBLENBQUEsR0FBQSxJQUFBLENBQUEsS0FBQSxPQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsSUFBQSxDQUFBLE9BQUEsQ0FBQTtBQUNBLGFBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsS0FBQSxHQUFBLENBQUE7QUFDQSxVQUFBLE1BQUEsRUFBQSxFQUFBLE1BQUEsRUFBQSxjQUFBLEVBQUEsU0FBQSxFQUFBO0FBQ0EsU0FBQTtBQUNBLFFBQUEsTUFBQTtBQUNBLFFBQUE7QUFDQTtBQUNBO0FBQ0EsTUFBQSxNQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsQ0FBQTtBQUNBLFNBQUEsTUFBQSxDQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsS0FBQSxPQUFBLENBQUEsQ0FBQSxDQUFBLENBQUE7QUFDQSxTQUFBLE9BQUEsQ0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBLEtBQUE7QUFDQSxVQUFBLE9BQUEsTUFBQSxDQUFBLEdBQUEsRUFBQTtBQUNBLFNBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsTUFBQSxFQUFBLElBQUEsRUFBQSxHQUFBLE9BQUEsRUFBQTtBQUNBLEtBQUE7QUFDQSxHQUFBO0FBQ0E7Ozs7OztBQ3JGQTtBQUNBO0FBQ0EsTUFBQSxzQkFBQSxHQUFBLDhCQUFBO0FBQ0EsTUFBQSxxQkFBQSxHQUFBLDZCQUFBO0FBQ0EsTUFBQSxpQkFBQSxHQUFBLGlCQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSx3QkFBQSxHQUFBLG1CQUFBO0FBQ0EsTUFBQSxzQkFBQSxHQUFBLGlCQUFBO0FBQ0EsTUFBQSx1QkFBQSxHQUFBLHdCQUFBO0FBQ0EsTUFBQSxtQ0FBQTtBQUNBLEVBQUEsK0JBQUE7QUFDQSxNQUFBLHdCQUFBLEdBQUE7O0FDYkEsU0FBQUQsa0JBQUEsQ0FBQSxHQUFBLEVBQUEsS0FBQSxFQUFBLEVBQUEsSUFBQSxHQUFBLElBQUEsSUFBQSxFQUFBLEVBQUEsT0FBQSxHQUFBLENBQUEsRUFBQSxNQUFBLEVBQUEsT0FBQSxLQUFBLEVBQUEsQ0FBQSxFQUFBLEVBQUEsQ0FBQSxTQUFBLGNBQUEsQ0FBQSxHQUFBLEVBQUEsRUFBQSxJQUFBLGFBQUEsR0FBQSxTQUFBLENBQUEsQ0FBQSxJQUFBLEtBQUEsR0FBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxPQUFBLENBQUEsR0FBQSxHQUFBLENBQUEsTUFBQSxFQUFBLEVBQUEsTUFBQSxFQUFBLEdBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsTUFBQSxFQUFBLEdBQUEsR0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsRUFBQSxLQUFBLGdCQUFBLElBQUEsRUFBQSxLQUFBLGNBQUEsS0FBQSxLQUFBLElBQUEsSUFBQSxFQUFBLEVBQUEsT0FBQSxTQUFBLENBQUEsRUFBQSxDQUFBLElBQUEsRUFBQSxLQUFBLFFBQUEsSUFBQSxFQUFBLEtBQUEsZ0JBQUEsRUFBQSxFQUFBLGFBQUEsR0FBQSxLQUFBLENBQUEsQ0FBQSxLQUFBLEdBQUEsRUFBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEVBQUEsTUFBQSxJQUFBLEVBQUEsS0FBQSxNQUFBLElBQUEsRUFBQSxLQUFBLGNBQUEsRUFBQSxFQUFBLEtBQUEsR0FBQSxFQUFBLENBQUEsQ0FBQSxHQUFBLElBQUEsS0FBQSxLQUFBLENBQUEsSUFBQSxDQUFBLGFBQUEsRUFBQSxHQUFBLElBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxhQUFBLEdBQUEsU0FBQSxDQUFBLEVBQUEsRUFBQSxDQUFBLE9BQUEsS0FBQSxDQUFBLEVBaUJBO0FBQ0EsTUFBQSxLQUFBLEdBQUEsQ0FBQSxFQUFBLEtBQUEsSUFBQSxPQUFBLENBQUEsQ0FBQSxPQUFBLEtBQUEsVUFBQSxDQUFBLE9BQUEsRUFBQSxFQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBQSxjQUFBLEdBQUEsR0FBQTtBQUNBO0FBQ0EsTUFBQSxjQUFBLEdBQUE7QUFDQSxFQUFBO0FBQ0EsSUFBQSxhQUFBLEdBQUEsSUFBQTtBQUNBLElBQUEsd0JBQUEsR0FBQSxJQUFBO0FBQ0EsSUFBQSxXQUFBLEdBQUEsR0FBQTtBQUNBLEdBQUEsR0FBQSxFQUFBO0FBQ0EsRUFBQSxLQUFBLEdBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQSxFQUFBLElBQUEsQ0FBQSxPQUFBLENBQUEsR0FBQSxDQUFBLFlBQUEsRUFBQTtBQUNBLElBQUEsT0FBQSxTQUFBO0FBQ0EsR0FBQTtBQUNBO0FBQ0EsRUFBQSxPQUFBO0FBQ0EsSUFBQSxJQUFBLEVBQUEsa0NBQUE7QUFDQTtBQUNBLElBQUEsY0FBQSxDQUFBLEVBQUEsR0FBQSxFQUFBLEVBQUEsTUFBQSxFQUFBO0FBQ0EsTUFBQSxNQUFBLElBQUEsR0FBQSxJQUFBLElBQUEsR0FBQTtBQUNBLE1BQUEsTUFBQSxJQUFBLEdBQUEsQ0FBQSxFQUFBLElBQUEsQ0FBQSxXQUFBLEVBQUEsQ0FBQSxRQUFBLEVBQUEsQ0FBQSxRQUFBLENBQUEsQ0FBQSxFQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLFFBQUEsSUFBQSxDQUFBLFFBQUEsRUFBQSxHQUFBLENBQUE7QUFDQTtBQUNBLFNBQUEsUUFBQSxFQUFBO0FBQ0EsU0FBQSxRQUFBLENBQUEsQ0FBQSxFQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxJQUFBLENBQUEsT0FBQSxFQUFBLENBQUEsUUFBQSxFQUFBLENBQUEsUUFBQSxDQUFBLENBQUEsRUFBQSxHQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUEsSUFBQTtBQUNBLFNBQUEsUUFBQSxFQUFBO0FBQ0EsU0FBQSxRQUFBLEVBQUE7QUFDQSxTQUFBLFFBQUEsQ0FBQSxDQUFBLEVBQUEsR0FBQSxDQUFBLENBQUEsQ0FBQSxFQUFBLElBQUE7QUFDQSxTQUFBLFVBQUEsRUFBQTtBQUNBLFNBQUEsUUFBQSxFQUFBO0FBQ0EsU0FBQSxRQUFBLENBQUEsQ0FBQSxFQUFBLEdBQUEsQ0FBQSxDQUFBLENBQUEsRUFBQSxJQUFBLENBQUEsVUFBQSxFQUFBLENBQUEsUUFBQSxFQUFBLENBQUEsUUFBQSxDQUFBLENBQUEsRUFBQSxHQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLEtBQUEsQ0FBQSxTQUFBLEdBQUEsSUFBQTtBQUNBLE1BQUEsS0FBQSxDQUFBLFdBQUEsR0FBQTtBQUNBLFFBQUEsNkNBQUE7QUFDQSxRQUFBLENBQUEsQ0FBQSxFQUFBLElBQUEsQ0FBQSx3QkFBQSxDQUFBO0FBQ0EsT0FBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsSUFBQSxHQUFBLENBQUEsSUFBQSxFQUFBLE1BQUEsRUFBQSxVQUFBLEtBQUE7QUFDQSxRQUFBLE1BQUEsRUFBQSxHQUFBLElBQUEsQ0FBQSxRQUFBLENBQUE7QUFDQSxVQUFBLElBQUEsRUFBQSxPQUFBO0FBQ0EsVUFBQSxDQUFBLFVBQUEsR0FBQSxVQUFBLEdBQUEsTUFBQSxHQUFBLElBQUE7QUFDQSxVQUFBLE1BQUE7QUFDQSxTQUFBLEVBQUE7QUFDQTtBQUNBLFFBQUEsT0FBQSxJQUFBLENBQUEsV0FBQSxDQUFBLEVBQUEsQ0FBQTtBQUNBLFFBQUE7QUFDQTtBQUNBLE1BQUEsS0FBQSxDQUFBLGFBQUEsR0FBQSxJQUFBO0FBQ0EsUUFBQSxpQkFBQTtBQUNBLFFBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQSxFQUFBLENBQUE7QUFDQSxRQUFBLElBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQSxNQUFBLEtBQUEsQ0FBQSxZQUFBLEdBQUEsSUFBQTtBQUNBLFFBQUEscUJBQUE7QUFDQSxRQUFBSSxJQUFBLENBQUEsT0FBQTtBQUNBLFVBQUEsc0JBQUE7QUFDQSxVQUFBLElBQUEsQ0FBQSxTQUFBLENBQUEsS0FBQSxDQUFBLFdBQUEsQ0FBQTtBQUNBLFNBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQSxNQUFBLEtBQUEsQ0FBQSxZQUFBLEdBQUEsSUFBQTtBQUNBLFFBQUEsc0JBQUE7QUFDQSxRQUFBQyxNQUFBO0FBQ0EsV0FBQSxPQUFBLENBQUEsd0JBQUEsRUFBQSxLQUFBLENBQUEsYUFBQSxDQUFBO0FBQ0EsV0FBQSxPQUFBLENBQUEsc0JBQUEsRUFBQSxJQUFBLENBQUEsU0FBQSxDQUFBLEtBQUEsQ0FBQSxXQUFBLENBQUEsQ0FBQTtBQUNBLFdBQUEsT0FBQSxDQUFBLHVCQUFBLEVBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxLQUFBLENBQUEsWUFBQSxDQUFBLENBQUE7QUFDQSxXQUFBLE9BQUEsQ0FBQSx3QkFBQSxFQUFBLElBQUEsQ0FBQSxTQUFBLENBQUEsYUFBQSxDQUFBLENBQUE7QUFDQSxXQUFBLE9BQUE7QUFDQSxZQUFBLG1DQUFBO0FBQ0EsWUFBQSxJQUFBLENBQUEsU0FBQSxDQUFBLHdCQUFBLENBQUE7QUFDQSxXQUFBO0FBQ0EsUUFBQTtBQUNBO0FBQ0E7QUFDQSxNQUFBLE1BQUEsQ0FBQSxNQUFBLENBQUEsY0FBQSxFQUFBLEtBQUEsRUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsY0FBQTtBQUNBLFFBQUEsQ0FBQSxRQUFBLEtBQUE7QUFDQTtBQUNBO0FBQ0EsVUFBQSxLQUFBLENBQUEsZUFBQSxHQUFBLFFBQUEsQ0FBQSxpQkFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFVBQUEsUUFBQSxDQUFBLFdBQUEsR0FBQSxLQUFBLENBQUEsWUFBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFVBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxZQUFBO0FBQ0EsWUFBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsc0JBQUEsRUFBQSxPQUFBLEtBQUEsQ0FBQSxZQUFBLENBQUEsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxVQUFBLElBQUEsUUFBQSxDQUFBLGdCQUFBLEtBQUEsQ0FBQSxFQUFBO0FBQ0EsWUFBQSxNQUFBLE1BQUE7QUFDQSxjQUFBTCxrQkFBQSxDQUFBLGNBQUEsQ0FBQSxDQUFBLFFBQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxVQUFBLEVBQUEsZ0JBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLGNBQUEsQ0FBQSxDQUFBLEVBQUEsUUFBQSxtQkFBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFlBQUEsTUFBQSxNQUFBLEdBQUEsQ0FBQTtBQUNBO0FBQ0Esd0JBQUEsRUFBQSxLQUFBLENBQUEsWUFBQSxDQUFBO0FBQ0EsWUFBQSxDQUFBLENBQUEsSUFBQSxHQUFBO0FBQ0E7QUFDQSxZQUFBLElBQUEsQ0FBQSxNQUFBLENBQUEsTUFBQSxDQUFBLEVBQUEsSUFBQSxDQUFBLE1BQUEsRUFBQSxNQUFBLEVBQUEsSUFBQSxFQUFBO0FBQ0EsaUJBQUE7QUFDQSxjQUFBLE1BQUEsRUFBQSxHQUFBLE1BQUEsQ0FBQSxNQUFBLEVBQUE7QUFDQSxjQUFBLEVBQUEsQ0FBQSxJQUFBLEdBQUEsQ0FBQTtBQUNBLGNBQUEsRUFBQSxNQUFBLENBQUE7QUFDQSxjQUFBLEVBQUEsRUFBQSxDQUFBLElBQUEsQ0FBQTtBQUNBLGNBQUEsQ0FBQSxDQUFBLElBQUEsR0FBQTtBQUNBLGFBQUE7QUFDQTtBQUNBLFlBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSwyQkFBQSxFQUFBLE1BQUEsRUFBQTtBQUNBLFlBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSxpQkFBQSxFQUFBLFFBQUEsRUFBQTtBQUNBLFdBQUEsTUFBQTtBQUNBLFlBQUEsR0FBQTtBQUNBLGNBQUEsUUFBQTtBQUNBLGNBQUEsb0JBQUE7QUFDQSxjQUFBLENBQUFBLGtCQUFBLENBQUEsY0FBQSxDQUFBLENBQUEsUUFBQSxFQUFBLFFBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLFVBQUEsRUFBQSxnQkFBQSxFQUFBLEVBQUEsSUFBQSxFQUFBLENBQUEsT0FBQSxDQUFBLENBQUEsRUFBQSxRQUFBLEVBQUEsQ0FBQSxDQUFBLEVBQUEsTUFBQSxDQUFBLENBQUEsS0FBQSxDQUFBLFlBQUEsQ0FBQSxDQUFBO0FBQ0EsY0FBQTtBQUNBLFlBQUEsR0FBQSxDQUFBLFFBQUEsRUFBQSx1QkFBQSxFQUFBLElBQUEsRUFBQTtBQUNBLFdBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxVQUFBLElBQUEsQ0FBQSxLQUFBLENBQUEsWUFBQTtBQUNBLFlBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLHNCQUFBLEVBQUEsT0FBQSxLQUFBLENBQUEsWUFBQSxDQUFBLENBQUEsRUFBQTtBQUNBO0FBQ0EsVUFBQSxNQUFBLEVBQUEsZUFBQSxFQUFBLFNBQUEsRUFBQSxHQUFBLFNBQUE7QUFDQTtBQUNBLFVBQUEsUUFBQSxDQUFBLGVBQUEsR0FBQSxjQUFBLENBQUEsQ0FBQSxTQUFBLEVBQUEsZ0JBQUEsRUFBQSxFQUFBLElBQUEsRUFBQSxDQUFBLEdBQUEsRUFBQSxNQUFBLEVBQUEsRUFBQSxJQUFBLEVBQUEsQ0FBQSxDQUFBLEVBQUEsRUFBQSxHQUFBLEVBQUEsRUFBQSxHQUFBLElBQUEsRUFBQSxNQUFBO0FBQ0EsWUFBQSxFQUFBLEVBQUEsQ0FBQSxLQUFBLENBQUEsWUFBQSxFQUFBLEdBQUEsRUFBQSxDQUFBO0FBQ0EsWUFBQSxHQUFBLElBQUE7QUFDQSxXQUFBLENBQUEsQ0FBQSxDQUFBLEVBQUE7QUFDQTtBQUNBLFVBQUEsT0FBQSxRQUFBO0FBQ0EsU0FBQTtBQUNBLFFBQUEsTUFBQTtBQUNBLFFBQUEsSUFBQSxDQUFBLEtBQUE7QUFDQSxRQUFBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsT0FBQSxNQUFBLENBQUEsS0FBQSxDQUFBLGFBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLFdBQUEsR0FBQTtBQUNBO0FBQ0EsTUFBQSxXQUFBLEdBQUEsQ0FBQSxLQUFBLE1BQUEsS0FBQSxDQUFBLFdBQUEsQ0FBQSxFQUFBO0FBQ0E7QUFDQSxNQUFBLElBQUE7QUFDQSxRQUFBLE1BQUEsVUFBQTtBQUNBLFVBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxTQUFBLEVBQUEsS0FBQSxDQUFBLGFBQUEsQ0FBQTtBQUNBLFVBQUEsSUFBQSxDQUFBLEdBQUEsRUFBQTtBQUNBLFVBQUE7QUFDQSxPQUFBLENBQUEsT0FBQSxHQUFBLEVBQUE7QUFDQSxRQUFBLElBQUEsV0FBQSxDQUFBLEdBQUEsQ0FBQSxFQUFBO0FBQ0EsVUFBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsb0NBQUEsRUFBQSxHQUFBLENBQUEsT0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLFNBQUEsTUFBQTtBQUNBLFVBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxpQ0FBQSxFQUFBO0FBQ0EsU0FBQTtBQUNBLE9BQUE7QUFDQSxLQUFBO0FBQ0EsR0FBQTtBQUNBLEVBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQUEsV0FBQSxDQUFBLENBQUEsRUFBQTtBQUNBLEVBQUEsT0FBQSxPQUFBLENBQUEsS0FBQSxRQUFBLElBQUEsQ0FBQSxLQUFBLElBQUEsSUFBQSxTQUFBLElBQUEsQ0FBQTtBQUNBOztBQ3ROQSxTQUFBLGdCQUFBLENBQUEsR0FBQSxFQUFBLEtBQUEsRUFBQSxFQUFBLElBQUEsR0FBQSxJQUFBLElBQUEsRUFBQSxFQUFBLE9BQUEsR0FBQSxDQUFBLEVBQUEsTUFBQSxFQUFBLE9BQUEsS0FBQSxFQUFBLENBQUEsRUFBQSxFQVdBO0FBQ0E7QUFDQTtBQUNBLE1BQUEsZUFBQSxHQUFBO0FBQ0EsRUFBQSxPQUFBLEdBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBO0FBQ0EsRUFBQSxJQUFBO0FBQ0EsSUFBQSxNQUFBLGVBQUEsR0FBQSxJQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsRUFBQSxFQUFBLGNBQUEsRUFBQTtBQUNBLElBQUEsT0FBQSxDQUFBLEdBQUEsR0FBQSxPQUFBLENBQUEsR0FBQSxJQUFBLFlBQUEsQ0FBQSxlQUFBLEVBQUE7QUFDQTtBQUNBLEdBQUEsQ0FBQSxPQUFBLEtBQUEsRUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsRUFBQSxNQUFBLFFBQUEsR0FBQSxhQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLElBQUEsR0FBQSxVQUFBLENBQUEsUUFBQSxFQUFBO0FBQ0EsRUFBQSxNQUFBLFFBQUEsR0FBQU0sYUFBQSxHQUFBO0FBQ0EsRUFBQSxNQUFBLE9BQUEsR0FBQUMsZUFBQSxDQUFBLFFBQUEsRUFBQTtBQUNBLEVBQUEsTUFBQUMsYUFBQSxHQUFBQyxXQUFBLENBQUEsUUFBQSxFQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsRUFBQSxPQUFBO0FBQ0EsSUFBQSxJQUFBLEVBQUEsa0JBQUE7QUFDQTtBQUNBO0FBQ0EsSUFBQSxRQUFBLEVBQUEsRUFBQSxRQUFBLEVBQUEsSUFBQSxFQUFBLFFBQUEsRUFBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLEVBQUEsTUFBQTtBQUNBLE1BQUEsT0FBQSxDQUFBLElBQUE7QUFDQSxRQUFBLDBFQUFBO0FBQ0EsUUFBQTtBQUNBLE1BQUEsTUFBQSxJQUFBLEtBQUE7QUFDQSxRQUFBLGdGQUFBO0FBQ0EsT0FBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsTUFBQSxPQUFBLENBQUEsT0FBQSxFQUFBO0FBQ0EsTUFBQSxJQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFFBQUEsSUFBQSxNQUFBLEdBQUEsUUFBQTtBQUNBLFFBQUEsS0FBQSxNQUFBLE1BQUEsSUFBQSxDQUFBLFFBQUEsRUFBQSxJQUFBLENBQUEsRUFBQTtBQUNBLFVBQUEsTUFBQSxDQUFBLEdBQUEsTUFBQSxNQUFBLENBQUEsT0FBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsTUFBQSxFQUFBO0FBQ0EsVUFBQSxNQUFBLEdBQUEsZ0JBQUEsQ0FBQSxDQUFBLEVBQUEsUUFBQSxNQUFBLENBQUEsRUFBQTtBQUNBLFNBQUE7QUFDQSxRQUFBLE9BQUEsTUFBQTtBQUNBLE9BQUEsQ0FBQSxPQUFBLEtBQUEsRUFBQTtBQUNBLFFBQUEsTUFBQSxhQUFBO0FBQ0EsVUFBQSwyREFBQTtBQUNBLFFBQUEsTUFBQSxTQUFBO0FBQ0EsVUFBQSx3REFBQTtBQUNBO0FBQ0EsUUFBQTtBQUNBLFVBQUEsS0FBQSxZQUFBLEtBQUE7QUFDQSxXQUFBLEtBQUEsQ0FBQSxPQUFBLEtBQUEsYUFBQSxJQUFBLEtBQUEsQ0FBQSxPQUFBLEtBQUEsU0FBQSxDQUFBO0FBQ0EsVUFBQTtBQUNBLFVBQUEsTUFBQSxJQUFBLEtBQUE7QUFDQSxZQUFBLGdFQUFBO0FBQ0EsV0FBQTtBQUNBLFNBQUEsTUFBQTtBQUNBLFVBQUEsTUFBQSxLQUFBO0FBQ0EsU0FBQTtBQUNBLE9BQUE7QUFDQSxLQUFBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsVUFBQSxDQUFBLE9BQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxPQUFBLENBQUEsR0FBQSxDQUFBO0FBQ0EsUUFBQSxRQUFBLENBQUEsVUFBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsT0FBQSxDQUFBO0FBQ0EsUUFBQSxJQUFBLENBQUEsVUFBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsT0FBQSxDQUFBO0FBQ0EsT0FBQSxFQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxNQUFBLFNBQUEsQ0FBQSxHQUFBLElBQUEsRUFBQTtBQUNBLE1BQUEsT0FBQSxRQUFBLENBQUEsU0FBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsR0FBQSxJQUFBLENBQUE7QUFDQSxLQUFBO0FBQ0E7QUFDQSxJQUFBLE1BQUEsSUFBQSxDQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUEsT0FBQSxRQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsRUFBQSxDQUFBO0FBQ0EsS0FBQTtBQUNBO0FBQ0EsSUFBQSxTQUFBLENBQUEsTUFBQSxFQUFBLEVBQUEsRUFBQTtBQUNBLE1BQUEsT0FBQSxRQUFBLENBQUEsU0FBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsTUFBQSxFQUFBLEVBQUEsQ0FBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsV0FBQSxDQUFBLEdBQUEsSUFBQSxFQUFBO0FBQ0EsTUFBQSxRQUFBLENBQUEsV0FBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsR0FBQSxJQUFBLEVBQUE7QUFDQSxNQUFBLElBQUEsQ0FBQSxXQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsRUFBQSxHQUFBLElBQUEsRUFBQTtBQUNBLEtBQUE7QUFDQTtBQUNBLElBQUEsTUFBQSxjQUFBLENBQUEsR0FBQSxJQUFBLEVBQUE7QUFDQSxNQUFBLE1BQUEsUUFBQSxDQUFBLGNBQUEsQ0FBQSxJQUFBLENBQUEsSUFBQSxFQUFBLEdBQUEsSUFBQSxFQUFBO0FBQ0EsTUFBQSxNQUFBLFFBQUEsQ0FBQSxjQUFBLENBQUEsSUFBQSxDQUFBLElBQUEsRUFBQSxHQUFBLElBQUEsRUFBQTtBQUNBLE1BQUEsTUFBQSxPQUFBLENBQUEsY0FBQSxDQUFBLElBQUEsQ0FBQSxJQUFBLEVBQUEsR0FBQSxJQUFBLEVBQUE7QUFDQTtBQUNBLE1BQUEsTUFBQUQsYUFBQSxDQUFBLGNBQUEsQ0FBQSxJQUFBLENBQUEsSUFBQSxFQUFBLEdBQUEsSUFBQSxFQUFBO0FBQ0EsS0FBQTtBQUNBLEdBQUE7QUFDQTs7OzsifQ==
