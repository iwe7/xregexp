/*!
 * XRegExp
 * <xregexp.com>
 * Steven Levithan (c) 2007-present MIT License
 */

/**
 * XRegExp provides augmented, extensible regular expressions. You get additional regex syntax and
 * flags, beyond what browsers support natively. XRegExp is also a regex utility belt with tools to
 * make your client-side grepping simpler and more powerful, while freeing you from related
 * cross-browser inconsistencies.
 */
// ==--------------------------==
// Private stuff
// ==--------------------------==
// Property name used for extended regex instance data
const REGEX_DATA = 'xregexp'; // Optional features that can be installed and uninstalled

const features = {
  astral: false,
  namespacing: false
}; // Native methods to use and restore ('native' is an ES3 reserved keyword)

const nativ = {
  exec: RegExp.prototype.exec,
  test: RegExp.prototype.test,
  match: String.prototype.match,
  replace: String.prototype.replace,
  split: String.prototype.split
}; // Storage for fixed/extended native methods

const fixed = {}; // Storage for regexes cached by `XRegExp.cache`

let regexCache = {}; // Storage for pattern details cached by the `XRegExp` constructor

let patternCache = {}; // Storage for regex syntax tokens added internally or by `XRegExp.addToken`

const tokens = []; // Token scopes

const defaultScope = 'default';
const classScope = 'class'; // Regexes that match native regex syntax, including octals

const nativeTokens = {
  // Any native multicharacter token in default scope, or any single character
  'default': /\\(?:0(?:[0-3][0-7]{0,2}|[4-7][0-7]?)?|[1-9]\d*|x[\dA-Fa-f]{2}|u(?:[\dA-Fa-f]{4}|{[\dA-Fa-f]+})|c[A-Za-z]|[\s\S])|\(\?(?:[:=!]|<[=!])|[?*+]\?|{\d+(?:,\d*)?}\??|[\s\S]/,
  // Any native multicharacter token in character class scope, or any single character
  'class': /\\(?:[0-3][0-7]{0,2}|[4-7][0-7]?|x[\dA-Fa-f]{2}|u(?:[\dA-Fa-f]{4}|{[\dA-Fa-f]+})|c[A-Za-z]|[\s\S])|[\s\S]/
}; // Any backreference or dollar-prefixed character in replacement strings

const replacementToken = /\$(?:{([\w$]+)}|<([\w$]+)>|(\d\d?|[\s\S]))/g; // Check for correct `exec` handling of nonparticipating capturing groups

const correctExecNpcg = nativ.exec.call(/()??/, '')[1] === undefined; // Check for ES6 `flags` prop support

const hasFlagsProp = /x/.flags !== undefined; // Shortcut to `Object.prototype.toString`

const toString = {}.toString;

function hasNativeFlag(flag) {
  // Can't check based on the presence of properties/getters since browsers might support such
  // properties even when they don't support the corresponding flag in regex construction (tested
  // in Chrome 48, where `'unicode' in /x/` is true but trying to construct a regex with flag `u`
  // throws an error)
  let isSupported = true;

  try {
    // Can't use regex literals for testing even in a `try` because regex literals with
    // unsupported flags cause a compilation error in IE
    var x = new RegExp('', flag);
    isSupported = !!x || true; // thwart ROLLUP tree-shaking; see https://github.com/rollup/rollup/issues/2181
  } catch (exception) {
    isSupported = false;
  }

  return isSupported;
} // Check for ES6 `u` flag support


const hasNativeU = hasNativeFlag('u'); // Check for ES6 `y` flag support

const hasNativeY = hasNativeFlag('y'); // Tracker for known flags, including addon flags

const registeredFlags = {
  g: true,
  i: true,
  m: true,
  u: hasNativeU,
  y: hasNativeY
};
/**
 * Determine whether two regexes match for purposes of detecting whether the
 * XRegExp produced regex can work in a native environment *without having XRegExp around*.
 *
 * @private
 * @param  {String} re1
 * @param  {String} re2
 * @return {Boolean}     TRUE when regexes match
 */

function areRegexesIdenticalForNativity(re1, re2) {
  // fix the isNotNative check for the `[]` and `[^]` fixups
  // we might have done on the source regex:
  //
  // we don't care about the difference between `[]` and `[^]`:
  // XRegExp doesn't transform the one to the other, so we're safe
  // to treat them as the same in here: we are only after determining
  // whether these regexes are the same, i.e. is XRegExp has produced
  // a 'native' regex equivalent that can work *without* having
  // XRegExp around.
  re1 = re1 && re1.replace(/\[(\^?)\]|\[\\s\\S\]|\\b\\B/, '[]');
  re2 = re2 && re2.replace(/\[(\^?)\]|\[\\s\\S\]|\\b\\B/, '[]');
  return re1 === re2;
}
/**
 * Attaches extended data and `XRegExp.prototype` properties to a regex object.
 *
 * @private
 * @param {RegExp} regex Regex to augment.
 * @param {Array} captureNames Array with capture names, or `null`.
 * @param {String} xSource XRegExp pattern used to generate `regex`, or `null` if N/A.
 * @param {String} xFlags XRegExp flags used to generate `regex`, or `null` if N/A.
 * @param {Boolean} [isNotNative=false] Whether the regex requires some XRegExp specific feature.
 * @param {Boolean} [isInternalOnly=false] Whether the regex will be used only for internal
 *   operations, and never exposed to users. For internal-only regexes, we can improve perf by
 *   skipping some operations like attaching `XRegExp.prototype` properties.
 * @returns {RegExp} Augmented regex.
 */


function augment(regex, captureNames, xSource, xFlags, isNotNative, isInternalOnly) {
  regex[REGEX_DATA] = {
    captureNames
  };

  if (isInternalOnly) {
    return regex;
  } // Can't auto-inherit these since the XRegExp constructor returns a nonprimitive value


  if (regex.__proto__) {
    regex.__proto__ = XRegExp.prototype;
  } else {
    for (const p in XRegExp.prototype) {
      // An `XRegExp.prototype.hasOwnProperty(p)` check wouldn't be worth it here, since this
      // is performance sensitive, and enumerable `Object.prototype` or `RegExp.prototype`
      // extensions exist on `regex.prototype` anyway
      regex[p] = XRegExp.prototype[p];
    }
  }

  regex[REGEX_DATA].source = xSource; // Emulate the ES6 `flags` prop by ensuring flags are in alphabetical order

  regex[REGEX_DATA].flags = xFlags ? xFlags.split('').sort().join('') : xFlags; // signal whether the given regex is a standard RegExp one ('native') or does require
  // one or more XRegExp specific features:

  regex[REGEX_DATA].isNative = !isNotNative;
  return regex;
}
/**
 * Removes any duplicate characters from the provided string.
 *
 * @private
 * @param {String} str String to remove duplicate characters from.
 * @returns {String} String with any duplicate characters removed.
 */


function clipDuplicates(str) {
  return nativ.replace.call(str, /([\s\S])(?=[\s\S]*\1)/g, '');
}
/**
 * Copies a regex object while preserving extended data and augmenting with `XRegExp.prototype`
 * properties. The copy has a fresh `lastIndex` property (set to zero). Allows adding and removing
 * flags g and y while copying the regex.
 *
 * @private
 * @param {RegExp} regex Regex to copy.
 * @param {Object} [options] Options object with optional properties:
 *   - `addG` {Boolean} Add flag g while copying the regex.
 *   - `addY` {Boolean} Add flag y while copying the regex.
 *   - `removeG` {Boolean} Remove flag g while copying the regex.
 *   - `removeY` {Boolean} Remove flag y while copying the regex.
 *   - `isInternalOnly` {Boolean} Whether the copied regex will be used only for internal
 *     operations, and never exposed to users. For internal-only regexes, we can improve perf by
 *     skipping some operations like attaching `XRegExp.prototype` properties.
 *   - `source` {String} Overrides `<regex>.source`, for special cases.
 * @returns {RegExp} Copy of the provided regex, possibly with modified flags.
 */


function copyRegex(regex, options) {
  if (!XRegExp.isRegExp(regex)) {
    throw new TypeError('Type RegExp expected');
  }

  const xData = regex[REGEX_DATA] || {};
  let flags = getNativeFlags(regex);
  let flagsToAdd = '';
  let flagsToRemove = '';
  let xregexpSource = null;
  let xregexpFlags = null;
  options = options || {};

  if (options.removeG) {
    flagsToRemove += 'g';
  }

  if (options.removeY) {
    flagsToRemove += 'y';
  }

  if (flagsToRemove) {
    flags = nativ.replace.call(flags, new RegExp(`[${flagsToRemove}]+`, 'g'), '');
  }

  if (options.addG) {
    flagsToAdd += 'g';
  }

  if (options.addY) {
    flagsToAdd += 'y';
  }

  if (flagsToAdd) {
    flags = clipDuplicates(flags + flagsToAdd);
  }

  if (!options.isInternalOnly) {
    if (xData.source !== undefined) {
      xregexpSource = xData.source;
    } // null or undefined; don't want to add to `flags` if the previous value was null, since
    // that indicates we're not tracking original precompilation flags


    if (xData.flags != null) {
      // Flags are only added for non-internal regexes by `XRegExp.globalize`. Flags are never
      // removed for non-internal regexes, so don't need to handle it
      xregexpFlags = flagsToAdd ? clipDuplicates(xData.flags + flagsToAdd) : xData.flags;
    }
  } // Augment with `XRegExp.prototype` properties, but use the native `RegExp` constructor to avoid
  // searching for special tokens. That would be wrong for regexes constructed by `RegExp`, and
  // unnecessary for regexes constructed by `XRegExp` because the regex has already undergone the
  // translation to native regex syntax


  const hasCaptureNames = hasNamedCapture(regex); // Strip all but custom flags, except the 'A' flag

  let customFlags = flags;

  if (xregexpFlags) {
    customFlags += xregexpFlags;
  }

  customFlags = nativ.replace.call(clipDuplicates(customFlags), /[Agimuy]+/g, '');
  regex = augment(new RegExp(options.source || regex.source, flags), hasCaptureNames ? xData.captureNames.slice(0) : null, xregexpSource, xregexpFlags, customFlags || hasCaptureNames || !areRegexesIdenticalForNativity(regex.source, xregexpSource), options.isInternalOnly);
  return regex;
}
/**
 * Converts hexadecimal to decimal.
 *
 * @private
 * @param {String} hex
 * @returns {Number}
 */


function dec(hex) {
  return parseInt(hex, 16);
}
/**
 * Returns a pattern that can be used in a native RegExp in place of an ignorable token such as an
 * inline comment or whitespace with flag x. This is used directly as a token handler function
 * passed to `XRegExp.addToken`.
 *
 * @private
 * @param {String} match Match arg of `XRegExp.addToken` handler
 * @param {String} scope Scope arg of `XRegExp.addToken` handler
 * @param {String} flags Flags arg of `XRegExp.addToken` handler
 * @returns {String} Either '' or '(?:)', depending on which is needed in the context of the match.
 */


function getContextualTokenSeparator(match, scope, flags) {
  if ( // No need to separate tokens if at the beginning or end of a group
  match.input[match.index - 1] === '(' || match.input[match.index + match[0].length] === ')' || // No need to separate tokens if before or after a `|`
  match.input[match.index - 1] === '|' || match.input[match.index + match[0].length] === '|' || // No need to separate tokens if at the beginning or end of the pattern
  match.index < 1 || match.index + match[0].length >= match.input.length || // No need to separate tokens if at the beginning of a noncapturing group or lookahead.
  // The way this is written relies on:
  // - The search regex matching only 3-char strings.
  // - Although `substr` gives chars from the end of the string if given a negative index,
  //   the resulting substring will be too short to match. Ex: `'abcd'.substr(-1, 3) === 'd'`
  nativ.test.call(/^\(\?[:=!]/, match.input.substr(match.index - 3, 3)) || // Avoid separating tokens when the following token is a quantifier
  isQuantifierNext(match.input, match.index + match[0].length, flags)) {
    return '';
  } // Keep tokens separated. This avoids e.g. inadvertedly changing `\1 1` or `\1(?#)1` to `\11`.
  // This also ensures all tokens remain as discrete atoms, e.g. it avoids converting the syntax
  // error `(? :` into `(?:`.


  return '(?:)';
}
/**
 * Returns native `RegExp` flags used by a regex object.
 *
 * @private
 * @param {RegExp} regex Regex to check.
 * @returns {String} Native flags in use.
 */


function getNativeFlags(regex) {
  return hasFlagsProp ? regex.flags : // Explicitly using `RegExp.prototype.toString` (rather than e.g. `String` or concatenation
  // with an empty string) allows this to continue working predictably when
  // `XRegExp.proptotype.toString` is overridden
  nativ.exec.call(/\/([a-z]*)$/i, RegExp.prototype.toString.call(regex))[1];
}
/**
 * Determines whether a regex has extended instance data used to track capture names.
 *
 * @private
 * @param {RegExp} regex Regex to check.
 * @returns {Boolean} Whether the regex uses named capture.
 */


function hasNamedCapture(regex) {
  return !!(regex[REGEX_DATA] && regex[REGEX_DATA].captureNames);
}
/**
 * Converts decimal to hexadecimal.
 *
 * @private
 * @param {Number|String} dec
 * @returns {String}
 */


function hex(dec) {
  return parseInt(dec, 10).toString(16);
}
/**
 * Checks whether the next nonignorable token after the specified position is a quantifier.
 *
 * @private
 * @param {String} pattern Pattern to search within.
 * @param {Number} pos Index in `pattern` to search at.
 * @param {String} flags Flags used by the pattern.
 * @returns {Boolean} Whether the next nonignorable token is a quantifier.
 */


function isQuantifierNext(pattern, pos, flags) {
  const inlineCommentPattern = '\\(\\?#[^)]*\\)';
  const lineCommentPattern = '#[^#\\n]*';
  const quantifierPattern = '[?*+]|{\\d+(?:,\\d*)?}';
  return nativ.test.call(flags.includes('x') ? // Ignore any leading whitespace, line comments, and inline comments
  new RegExp(`^(?:\\s|${lineCommentPattern}|${inlineCommentPattern})*(?:${quantifierPattern})`) : // Ignore any leading inline comments
  new RegExp(`^(?:${inlineCommentPattern})*(?:${quantifierPattern})`), pattern.slice(pos));
}
/**
 * Determines whether a value is of the specified type, by resolving its internal [[Class]].
 *
 * @private
 * @param {*} value Object to check.
 * @param {String} type Type to check for, in TitleCase.
 * @returns {Boolean} Whether the object matches the type.
 */


function isType(value, type) {
  return toString.call(value) === `[object ${type}]`;
}
/**
 * Adds leading zeros if shorter than four characters. Used for fixed-length hexadecimal values.
 *
 * @private
 * @param {String} str
 * @returns {String}
 */


function pad4(str) {
  while (str.length < 4) {
    str = `0${str}`;
  }

  return str;
}
/**
 * Checks for flag-related errors, and strips/applies flags in a leading mode modifier. Offloads
 * the flag preparation logic from the `XRegExp` constructor.
 *
 * @private
 * @param {String} pattern Regex pattern, possibly with a leading mode modifier.
 * @param {String} flags Any combination of flags.
 * @returns {Object} Object with properties `pattern` and `flags`.
 */


function prepareFlags(pattern, flags) {
  // Recent browsers throw on duplicate flags, so copy this behavior for nonnative flags
  if (clipDuplicates(flags) !== flags) {
    throw new SyntaxError(`Invalid duplicate regex flag ${flags}`);
  } // Strip and apply a leading mode modifier with any combination of flags except g or y


  const output = nativ.replace.call(pattern, /^\(\?([\w$]+)\)/, function ($0, $1) {
    if (nativ.test.call(/[gy]/, $1)) {
      throw new SyntaxError(`Cannot use flag g or y in mode modifier ${$0}`);
    } // Allow duplicate flags within the mode modifier


    flags = clipDuplicates(flags + $1);
    return '';
  }); // Throw on unknown native or nonnative flags

  for (let i = 0; i < flags.length; ++i) {
    if (!registeredFlags[flags[i]]) {
      throw new SyntaxError(`Unknown regex flag ${flags[i]}`);
    }
  }

  return {
    pattern: output,
    flags
  };
}
/**
 * Prepares an options object from the given value.
 *
 * @private
 * @param {String|Object} value Value to convert to an options object.
 * @returns {Object} Options object.
 */


function prepareOptions(value) {
  const options = {};

  if (isType(value, 'String')) {
    XRegExp.forEach(value, /[^\s,]+/, match => {
      options[match] = true;
    });
    return options;
  }

  return value;
}
/**
 * Registers a flag so it doesn't throw an 'unknown flag' error.
 *
 * @private
 * @param {String} flag Single-character flag to register.
 */


function registerFlag(flag) {
  if (!/^[\w$]$/.test(flag)) {
    throw new Error('Flag must be a single character A-Za-z0-9_$');
  }

  registeredFlags[flag] = true;
}
/**
 * Runs built-in and custom regex syntax tokens in reverse insertion order at the specified
 * position, until a match is found.
 *
 * @private
 * @param {String} pattern Original pattern from which an XRegExp object is being built.
 * @param {String} flags Flags being used to construct the regex.
 * @param {Number} pos Position to search for tokens within `pattern`.
 * @param {Number} scope Regex scope to apply: 'default' or 'class'.
 * @param {Object} context Context object to use for token handler functions.
 * @returns {Object} Object with properties `matchLength`, `output`, and `reparse`; or `null`.
 */


function runTokens(pattern, flags, pos, scope, context) {
  let i = tokens.length;
  const leadChar = pattern[pos];
  let result = null;
  let match;
  let t; // Run in reverse insertion order

  while (i--) {
    t = tokens[i];

    if (t.leadChar && t.leadChar !== leadChar || t.scope !== scope && t.scope !== 'all' || t.flag && !flags.includes(t.flag)) {
      continue;
    }

    match = XRegExp.exec(pattern, t.regex, pos, 'sticky');

    if (match) {
      result = {
        matchLength: match[0].length,
        output: t.handler.call(context, match, scope, flags),
        reparse: t.reparse
      }; // Finished with token tests

      break;
    }
  }

  return result;
}
/**
 * Enables or disables implicit astral mode opt-in. When enabled, flag A is automatically added to
 * all new regexes created by XRegExp. This causes an error to be thrown when creating regexes if
 * the Unicode Base addon is not available, since flag A is registered by that addon.
 *
 * @private
 * @param {Boolean} on `true` to enable; `false` to disable.
 */


function setAstral(on) {
  features.astral = on;
}
/**
 * Adds named capture groups to the `groups` property of match arrays. See here for details:
 * https://github.com/tc39/proposal-regexp-named-groups
 *
 * @private
 * @param {Boolean} on `true` to enable; `false` to disable.
 */


function setNamespacing(on) {
  features.namespacing = on;
}
/**
 * Returns the object, or throws an error if it is `null` or `undefined`. This is used to follow
 * the ES5 abstract operation `ToObject`.
 *
 * @private
 * @param {*} value Object to check and return.
 * @returns {*} The provided object.
 */


function toObject(value) {
  // null or undefined
  if (value == null) {
    throw new TypeError('Cannot convert null or undefined to object');
  }

  return value;
}
/**
 * Returns an Array that is the list of given patterns to be joined. Patterns can be provided as
 * regex objects or strings. Metacharacters are escaped in patterns provided as strings.
 * Backreferences in provided regex objects are automatically renumbered to work correctly. Native
 * flags used by provided regexes are ignored in favor of the `flags` argument.
 *
 * @private
 * @param {Array} patterns Regexes and strings to combine.
 * @returns {Array} modified patterns RegExps and Strings to be combined.
 */


function prepareJoin(patterns) {
  let numCaptures = 0;
  let numPriorCaptures;
  let captureNames;

  function rewrite(match, paren, backref) {
    const name = captureNames[numCaptures - numPriorCaptures]; // Capturing group

    if (paren) {
      ++numCaptures; // If the current capture has a name, preserve the name

      if (name) {
        return `(?<${name}>`;
      } // Backreference

    } else if (backref) {
      // Rewrite the backreference
      return `\\${+backref + numPriorCaptures}`;
    }

    return match;
  }

  if (!(isType(patterns, 'Array') && patterns.length)) {
    throw new TypeError('Must provide a nonempty array of patterns to merge');
  }

  const parts = /(\()(?!\?)|\\([1-9]\d*)|\\[\s\S]|\[(?:[^\\\]]|\\[\s\S])*\]/g;
  const output = [];
  let pattern;

  for (let i = 0; i < patterns.length; ++i) {
    pattern = patterns[i];

    if (XRegExp.isRegExp(pattern)) {
      numPriorCaptures = numCaptures;
      captureNames = pattern[REGEX_DATA] && pattern[REGEX_DATA].captureNames || []; // Rewrite backreferences. Passing to XRegExp dies on octals and ensures patterns are
      // independently valid; helps keep this simple. Named captures are put back

      output.push(nativ.replace.call(XRegExp(pattern.source).source, parts, rewrite));
    } else {
      output.push(XRegExp.escape(pattern));
    }
  }

  return output;
} // ==--------------------------==
// Constructor
// ==--------------------------==

/**
 * Creates an extended regular expression object for matching text with a pattern. Differs from a
 * native regular expression in that additional syntax and flags are supported. The returned object
 * is in fact a native `RegExp` and works with all native methods.
 *
 * @class XRegExp
 * @constructor
 * @param {String|RegExp} pattern Regex pattern string, or an existing regex object to copy.
 * @param {String} [flags] Any combination of flags.
 *   Native flags:
 *     - `g` - global
 *     - `i` - ignore case
 *     - `m` - multiline anchors
 *     - `u` - unicode (ES6)
 *     - `y` - sticky (Firefox 3+, ES6)
 *   Additional XRegExp flags:
 *     - `n` - explicit capture
 *     - `s` - dot matches all (aka singleline)
 *     - `x` - free-spacing and line comments (aka extended)
 *     - `A` - astral (requires the Unicode Base addon)
 *   Flags cannot be provided when constructing one `RegExp` from another.
 * @returns {RegExp} Extended regular expression object.
 * @example
 *
 * // With named capture and flag x
 * XRegExp(`(?<year>  [0-9]{4} ) -?  # year
 *          (?<month> [0-9]{2} ) -?  # month
 *          (?<day>   [0-9]{2} )     # day`, 'x');
 *
 * // Providing a regex object copies it. Native regexes are recompiled using native (not XRegExp)
 * // syntax. Copies maintain extended data, are augmented with `XRegExp.prototype` properties, and
 * // have fresh `lastIndex` properties (set to zero).
 * XRegExp(/regex/);
 */


function XRegExp(pattern, flags) {
  if (XRegExp.isRegExp(pattern)) {
    if (flags !== undefined) {
      throw new TypeError('Cannot supply flags when copying a RegExp');
    }

    return copyRegex(pattern);
  } // Copy the argument behavior of `RegExp`


  pattern = pattern === undefined ? '' : String(pattern);
  flags = flags === undefined ? '' : String(flags);

  if (XRegExp.isInstalled('astral') && !flags.includes('A')) {
    // This causes an error to be thrown if the Unicode Base addon is not available
    flags += 'A';
  }

  if (!patternCache[pattern]) {
    patternCache[pattern] = {};
  }

  let appliedFlags;

  if (!patternCache[pattern][flags]) {
    const context = {
      hasNamedCapture: false,
      captureNames: []
    };
    let scope = defaultScope;
    let output = '';
    let pos = 0;
    let result; // Check for flag-related errors, and strip/apply flags in a leading mode modifier

    const applied = prepareFlags(pattern, flags);
    let appliedPattern = applied.pattern;
    appliedFlags = applied.flags; // Use XRegExp's tokens to translate the pattern to a native regex pattern.
    // `appliedPattern.length` may change on each iteration if tokens use `reparse`

    while (pos < appliedPattern.length) {
      do {
        // Check for custom tokens at the current position
        result = runTokens(appliedPattern, appliedFlags, pos, scope, context); // If the matched token used the `reparse` option, splice its output into the
        // pattern before running tokens again at the same position

        if (result && result.reparse) {
          appliedPattern = appliedPattern.slice(0, pos) + result.output + appliedPattern.slice(pos + result.matchLength);
        }
      } while (result && result.reparse);

      if (result) {
        output += result.output;
        pos += result.matchLength || 1;
      } else {
        // Get the native token at the current position
        const token = XRegExp.exec(appliedPattern, nativeTokens[scope], pos, 'sticky')[0];
        output += token;
        pos += token.length;

        if (token === '[' && scope === defaultScope) {
          scope = classScope;
        } else if (token === ']' && scope === classScope) {
          scope = defaultScope;
        }
      }
    }

    patternCache[pattern][flags] = {
      // Use basic cleanup to collapse repeated empty groups like `(?:)(?:)` to `(?:)`. Empty
      // groups are sometimes inserted during regex transpilation in order to keep tokens
      // separated. However, more than one empty group in a row is never needed.
      pattern: nativ.replace.call(output, /(?:\(\?:\))+/g, '(?:)'),
      // Strip all but native flags
      flags: nativ.replace.call(appliedFlags, /[^gimuy]+/g, ''),
      // `context.captureNames` has an item for each capturing group, even if unnamed
      captures: context.hasNamedCapture ? context.captureNames : null
    };
  }

  const generated = patternCache[pattern][flags]; // Strip all but custom flags, except the 'A' flag

  let customFlags = flags;

  if (appliedFlags) {
    customFlags += appliedFlags;
  }

  customFlags = nativ.replace.call(clipDuplicates(customFlags), /[Agimuy]+/g, '');
  return augment(new RegExp(generated.pattern, generated.flags), generated.captures, pattern, flags, customFlags || generated.captures || !areRegexesIdenticalForNativity(pattern, generated.pattern));
} // Add `RegExp.prototype` to the prototype chain


XRegExp.prototype = new RegExp(); // ==--------------------------==
// Public properties
// ==--------------------------==

/**
 * The XRegExp version number as a string containing three dot-separated parts. For example,
 * '2.0.0-beta-3'.
 *
 * @static
 * @memberOf XRegExp
 * @type String
 */

XRegExp.version = '4.2.0-30'; // ==--------------------------==
// Public methods
// ==--------------------------==
// Intentionally undocumented; used in tests and addons

XRegExp._clipDuplicates = clipDuplicates;
XRegExp._hasNativeFlag = hasNativeFlag;

XRegExp._registeredFlags = function _getRegisteredFlags() {
  return registeredFlags;
};

XRegExp._dec = dec;
XRegExp._hex = hex;
XRegExp._pad4 = pad4;
/**
 * Extends XRegExp syntax and allows custom flags. This is used internally and can be used to
 * create XRegExp addons. If more than one token can match the same string, the last added wins.
 *
 * @memberOf XRegExp
 * @param {RegExp} regex Regex object that matches the new token.
 * @param {Function} handler Function that returns a new pattern string (using native regex syntax)
 *   to replace the matched token within all future XRegExp regexes. Has access to persistent
 *   properties of the regex being built, through `this`. Invoked with three arguments:
 *   - The match array, with named backreference properties.
 *   - The regex scope where the match was found: 'default' or 'class'.
 *   - The flags used by the regex, including any flags in a leading mode modifier.
 *   The handler function becomes part of the XRegExp construction process, so be careful not to
 *   construct XRegExps within the function or you will trigger infinite recursion.
 * @param {Object} [options] Options object with optional properties:
 *   - `scope` {String} Scope where the token applies: 'default', 'class', or 'all'.
 *   - `flag` {String} Single-character flag that triggers the token. This also registers the
 *     flag, which prevents XRegExp from throwing an 'unknown flag' error when the flag is used.
 *   - `optionalFlags` {String} Any custom flags checked for within the token `handler` that are
 *     not required to trigger the token. This registers the flags, to prevent XRegExp from
 *     throwing an 'unknown flag' error when any of the flags are used.
 *   - `reparse` {Boolean} Whether the `handler` function's output should not be treated as
 *     final, and instead be reparseable by other tokens (including the current token). Allows
 *     token chaining or deferring.
 *   - `leadChar` {String} Single character that occurs at the beginning of any successful match
 *     of the token (not always applicable). This doesn't change the behavior of the token unless
 *     you provide an erroneous value. However, providing it can increase the token's performance
 *     since the token can be skipped at any positions where this character doesn't appear.
 * @example
 *
 * // Basic usage: Add \a for the ALERT control code
 * XRegExp.addToken(
 *   /\\a/,
 *   () => '\\x07',
 *   {scope: 'all'}
 * );
 * XRegExp('\\a[\\a-\\n]+').test('\x07\n\x07'); // -> true
 *
 * // Add the U (ungreedy) flag from PCRE and RE2, which reverses greedy and lazy quantifiers.
 * // Since `scope` is not specified, it uses 'default' (i.e., transformations apply outside of
 * // character classes only)
 * XRegExp.addToken(
 *   /([?*+]|{\d+(?:,\d*)?})(\??)/,
 *   (match) => `${match[1]}${match[2] ? '' : '?'}`,
 *   {flag: 'U'}
 * );
 * XRegExp('a+', 'U').exec('aaa')[0]; // -> 'a'
 * XRegExp('a+?', 'U').exec('aaa')[0]; // -> 'aaa'
 */

XRegExp.addToken = (regex, handler, options) => {
  options = options || {};
  let optionalFlags = options.optionalFlags;

  if (options.flag) {
    registerFlag(options.flag);
  }

  if (optionalFlags) {
    optionalFlags = nativ.split.call(optionalFlags, '');

    for (let i = 0; i < optionalFlags.length; ++i) {
      registerFlag(optionalFlags[i]);
    }
  } // Add to the private list of syntax tokens


  tokens.push({
    regex: copyRegex(regex, {
      addG: true,
      addY: hasNativeY,
      isInternalOnly: true
    }),
    handler,
    scope: options.scope || defaultScope,
    flag: options.flag,
    reparse: options.reparse,
    leadChar: options.leadChar
  }); // Reset the pattern cache used by the `XRegExp` constructor, since the same pattern and flags
  // might now produce different results

  XRegExp.cache.flush('patterns');
};
/**
 * Caches and returns the result of calling `XRegExp(pattern, flags)`. On any subsequent call with
 * the same pattern and flag combination, the cached copy of the regex is returned.
 *
 * @memberOf XRegExp
 * @param {String} pattern Regex pattern string.
 * @param {String} [flags] Any combination of XRegExp flags.
 * @returns {RegExp} Cached XRegExp object.
 * @example
 *
 * while (match = XRegExp.cache('.', 'gs').exec(str)) {
 *   // The regex is compiled once only
 * }
 */


XRegExp.cache = (pattern, flags) => {
  if (!regexCache[pattern]) {
    regexCache[pattern] = {};
  }

  return regexCache[pattern][flags] || (regexCache[pattern][flags] = XRegExp(pattern, flags));
}; // Intentionally undocumented; used in tests


XRegExp.cache.flush = cacheName => {
  if (cacheName === 'patterns') {
    // Flush the pattern cache used by the `XRegExp` constructor
    patternCache = {};
  } else {
    // Flush the regex cache populated by `XRegExp.cache`
    regexCache = {};
  }
};
/**
 * Escapes any regular expression metacharacters, for use when matching literal strings. The result
 * can safely be used at any point within a regex that uses any flags.
 *
 * @memberOf XRegExp
 * @param {String} str String to escape.
 * @returns {String} String with regex metacharacters escaped.
 * @example
 *
 * XRegExp.escape('Escaped? <.>');
 * // -> 'Escaped\?\ <\.>'
 */


XRegExp.escape = str => nativ.replace.call(toObject(str), /[-\[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
/**
 * Executes a regex search in a specified string. Returns a match array or `null`. If the provided
 * regex uses named capture, named backreference properties are included on the match array.
 * Optional `pos` and `sticky` arguments specify the search start position, and whether the match
 * must start at the specified position only. The `lastIndex` property of the provided regex is not
 * used, but is updated for compatibility. Also fixes browser bugs compared to the native
 * `RegExp.prototype.exec` and can be used reliably cross-browser.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {RegExp} regex Regex to search with.
 * @param {Number} [pos=0] Zero-based index at which to start the search.
 * @param {Boolean|String} [sticky=false] Whether the match must start at the specified position
 *   only. The string `'sticky'` is accepted as an alternative to `true`.
 * @returns {Array} Match array with named backreference properties, or `null`.
 * @example
 *
 * // Basic use, with named backreference
 * let match = XRegExp.exec('U+2620', XRegExp('U\\+(?<hex>[0-9A-F]{4})'));
 * match.hex; // -> '2620'
 *
 * // With pos and sticky, in a loop
 * let pos = 2, result = [], match;
 * while (match = XRegExp.exec('<1><2><3><4>5<6>', /<(\d)>/, pos, 'sticky')) {
 *   result.push(match[1]);
 *   pos = match.index + match[0].length;
 * }
 * // result -> ['2', '3', '4']
 */


XRegExp.exec = (str, regex, pos, sticky) => {
  let cacheKey = 'g';
  let addY = false;
  let fakeY = false;
  let match;
  addY = hasNativeY && !!(sticky || regex.sticky && sticky !== false);

  if (addY) {
    cacheKey += 'y';
  } else if (sticky) {
    // Simulate sticky matching by appending an empty capture to the original regex. The
    // resulting regex will succeed no matter what at the current index (set with `lastIndex`),
    // and will not search the rest of the subject string. We'll know that the original regex
    // has failed if that last capture is `''` rather than `undefined` (i.e., if that last
    // capture participated in the match).
    fakeY = true;
    cacheKey += 'FakeY';
  }

  regex[REGEX_DATA] = regex[REGEX_DATA] || {}; // Shares cached copies with `XRegExp.match`/`replace`

  const r2 = regex[REGEX_DATA][cacheKey] || (regex[REGEX_DATA][cacheKey] = copyRegex(regex, {
    addG: true,
    addY,
    source: fakeY ? `${regex.source}|()` : undefined,
    removeY: sticky === false,
    isInternalOnly: true
  }));
  pos = pos || 0;
  r2.lastIndex = pos; // Fixed `exec` required for `lastIndex` fix, named backreferences, etc.

  match = fixed.exec.call(r2, str); // Get rid of the capture added by the pseudo-sticky matcher if needed. An empty string means
  // the original regexp failed (see above).

  if (fakeY && match && match.pop() === '') {
    match = null;
  }

  if (regex.global) {
    regex.lastIndex = match ? r2.lastIndex : 0;
  }

  return match;
};
/**
 * Executes a provided function once per regex match. Searches always start at the beginning of the
 * string and continue until the end, regardless of the state of the regex's `global` property and
 * initial `lastIndex`.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {RegExp} regex Regex to search with.
 * @param {Function} callback Function to execute for each match. Invoked with four arguments:
 *   - The match array, with named backreference properties.
 *   - The zero-based match index.
 *   - The string being traversed.
 *   - The regex object being used to traverse the string.
 * @example
 *
 * // Extracts every other digit from a string
 * const evens = [];
 * XRegExp.forEach('1a2345', /\d/, (match, i) => {
 *   if (i % 2) evens.push(+match[0]);
 * });
 * // evens -> [2, 4]
 */


XRegExp.forEach = (str, regex, callback) => {
  let pos = 0;
  let i = -1;
  let match;

  while (match = XRegExp.exec(str, regex, pos)) {
    // Because `regex` is provided to `callback`, the function could use the deprecated/
    // nonstandard `RegExp.prototype.compile` to mutate the regex. However, since `XRegExp.exec`
    // doesn't use `lastIndex` to set the search position, this can't lead to an infinite loop,
    // at least. Actually, because of the way `XRegExp.exec` caches globalized versions of
    // regexes, mutating the regex will not have any effect on the iteration or matched strings,
    // which is a nice side effect that brings extra safety.
    callback(match, ++i, str, regex);
    pos = match.index + (match[0].length || 1);
  }
};
/**
 * Copies a regex object and adds flag `g`. The copy maintains extended data, is augmented with
 * `XRegExp.prototype` properties, and has a fresh `lastIndex` property (set to zero). Native
 * regexes are not recompiled using XRegExp syntax.
 *
 * @memberOf XRegExp
 * @param {RegExp} regex Regex to globalize.
 * @returns {RegExp} Copy of the provided regex with flag `g` added.
 * @example
 *
 * const globalCopy = XRegExp.globalize(/regex/);
 * globalCopy.global; // -> true
 */


XRegExp.globalize = regex => copyRegex(regex, {
  addG: true
});
/**
 * Installs optional features according to the specified options. Can be undone using
 * `XRegExp.uninstall`.
 *
 * @memberOf XRegExp
 * @param {Object|String} options Options object or string.
 * @example
 *
 * // With an options object
 * XRegExp.install({
 *   // Enables support for astral code points in Unicode addons (implicitly sets flag A)
 *   astral: true,
 *
 *   // Adds named capture groups to the `groups` property of matches
 *   namespacing: true
 * });
 *
 * // With an options string
 * XRegExp.install('astral namespacing');
 */


XRegExp.install = options => {
  options = prepareOptions(options);

  if (!features.astral && options.astral) {
    setAstral(true);
  }

  if (!features.namespacing && options.namespacing) {
    setNamespacing(true);
  }
};
/**
 * Checks whether an individual optional feature is installed.
 *
 * @memberOf XRegExp
 * @param {String} feature Name of the feature to check. One of:
 *   - `astral`
 *   - `namespacing`
 * @returns {Boolean} Whether the feature is installed.
 * @example
 *
 * XRegExp.isInstalled('astral');
 */


XRegExp.isInstalled = feature => !!features[feature];
/**
 * Returns `true` if an object is a regex; `false` if it isn't. This works correctly for regexes
 * created in another frame, when `instanceof` and `constructor` checks would fail.
 *
 * @memberOf XRegExp
 * @param {*} value Object to check.
 * @returns {Boolean} Whether the object is a `RegExp` object.
 * @example
 *
 * XRegExp.isRegExp('string'); // -> false
 * XRegExp.isRegExp(/regex/i); // -> true
 * XRegExp.isRegExp(RegExp('^', 'm')); // -> true
 * XRegExp.isRegExp(XRegExp('(?s).')); // -> true
 */


XRegExp.isRegExp = value => toString.call(value) === '[object RegExp]'; // isType(value, 'RegExp');

/**
 * Returns the first matched string, or in global mode, an array containing all matched strings.
 * This is essentially a more convenient re-implementation of `String.prototype.match` that gives
 * the result types you actually want (string instead of `exec`-style array in match-first mode,
 * and an empty array instead of `null` when no matches are found in match-all mode). It also lets
 * you override flag g and ignore `lastIndex`, and fixes browser bugs.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {RegExp} regex Regex to search with.
 * @param {String} [scope='one'] Use 'one' to return the first match as a string. Use 'all' to
 *   return an array of all matched strings. If not explicitly specified and `regex` uses flag g,
 *   `scope` is 'all'.
 * @returns {String|Array} In match-first mode: First match as a string, or `null`. In match-all
 *   mode: Array of all matched strings, or an empty array.
 * @example
 *
 * // Match first
 * XRegExp.match('abc', /\w/); // -> 'a'
 * XRegExp.match('abc', /\w/g, 'one'); // -> 'a'
 * XRegExp.match('abc', /x/g, 'one'); // -> null
 *
 * // Match all
 * XRegExp.match('abc', /\w/g); // -> ['a', 'b', 'c']
 * XRegExp.match('abc', /\w/, 'all'); // -> ['a', 'b', 'c']
 * XRegExp.match('abc', /x/, 'all'); // -> []
 */


XRegExp.match = (str, regex, scope) => {
  const global = regex.global && scope !== 'one' || scope === 'all';
  const cacheKey = (global ? 'g' : '') + (regex.sticky ? 'y' : '') || 'noGY';
  regex[REGEX_DATA] = regex[REGEX_DATA] || {}; // Shares cached copies with `XRegExp.exec`/`replace`

  const r2 = regex[REGEX_DATA][cacheKey] || (regex[REGEX_DATA][cacheKey] = copyRegex(regex, {
    addG: !!global,
    removeG: scope === 'one',
    isInternalOnly: true
  }));
  const result = nativ.match.call(toObject(str), r2);

  if (regex.global) {
    regex.lastIndex = scope === 'one' && result ? // Can't use `r2.lastIndex` since `r2` is nonglobal in this case
    result.index + result[0].length : 0;
  }

  return global ? result || [] : result && result[0];
};
/**
 * Retrieves the matches from searching a string using a chain of regexes that successively search
 * within previous matches. The provided `chain` array can contain regexes and or objects with
 * `regex` and `backref` properties. When a backreference is specified, the named or numbered
 * backreference is passed forward to the next regex or returned.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {Array} chain Regexes that each search for matches within preceding results.
 * @returns {Array} Matches by the last regex in the chain, or an empty array.
 * @example
 *
 * // Basic usage; matches numbers within <b> tags
 * XRegExp.matchChain('1 <b>2</b> 3 <b>4 a 56</b>', [
 *   XRegExp('(?is)<b>.*?</b>'),
 *   /\d+/
 * ]);
 * // -> ['2', '4', '56']
 *
 * // Passing forward and returning specific backreferences
 * html = '<a href="http://xregexp.com/api/">XRegExp</a>\
 *         <a href="http://www.google.com/">Google</a>';
 * XRegExp.matchChain(html, [
 *   {regex: /<a href="([^"]+)">/i, backref: 1},
 *   {regex: XRegExp('(?i)^https?://(?<domain>[^/?#]+)'), backref: 'domain'}
 * ]);
 * // -> ['xregexp.com', 'www.google.com']
 */


XRegExp.matchChain = (str, chain) => function recurseChain(values, level) {
  const item = chain[level].regex ? chain[level] : {
    regex: chain[level]
  };
  const matches = [];

  function addMatch(match) {
    if (item.backref) {
      const ERR_UNDEFINED_GROUP = `Backreference to undefined group: ${item.backref}`;
      const isNamedBackref = isNaN(item.backref);

      if (isNamedBackref && XRegExp.isInstalled('namespacing')) {
        // `groups` has `null` as prototype, so using `in` instead of `hasOwnProperty`
        if (!(item.backref in match.groups)) {
          throw new ReferenceError(ERR_UNDEFINED_GROUP);
        }
      } else if (!match.hasOwnProperty(item.backref)) {
        throw new ReferenceError(ERR_UNDEFINED_GROUP);
      }

      const backrefValue = isNamedBackref && XRegExp.isInstalled('namespacing') ? match.groups[item.backref] : match[item.backref];
      matches.push(backrefValue || '');
    } else {
      matches.push(match[0]);
    }
  }

  for (let i = 0; i < values.length; ++i) {
    XRegExp.forEach(values[i], item.regex, addMatch);
  }

  return level === chain.length - 1 || !matches.length ? matches : recurseChain(matches, level + 1);
}([str], 0);
/**
 * Returns a new string with one or all matches of a pattern replaced. The pattern can be a string
 * or regex, and the replacement can be a string or a function to be called for each match. To
 * perform a global search and replace, use the optional `scope` argument or include flag g if using
 * a regex. Replacement strings can use `${n}` or `$<n>` for named and numbered backreferences.
 * Replacement functions can use named backreferences via `arguments[0].name`. Also fixes browser
 * bugs compared to the native `String.prototype.replace` and can be used reliably cross-browser.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {RegExp|String} search Search pattern to be replaced.
 * @param {String|Function} replacement Replacement string or a function invoked to create it.
 *   Replacement strings can include special replacement syntax:
 *     - $$ - Inserts a literal $ character.
 *     - $&, $0 - Inserts the matched substring.
 *     - $` - Inserts the string that precedes the matched substring (left context).
 *     - $' - Inserts the string that follows the matched substring (right context).
 *     - $n, $nn - Where n/nn are digits referencing an existent capturing group, inserts
 *       backreference n/nn.
 *     - ${n}, $<n> - Where n is a name or any number of digits that reference an existent capturing
 *       group, inserts backreference n.
 *   Replacement functions are invoked with three or more arguments:
 *     - The matched substring (corresponds to $& above). Named backreferences are accessible as
 *       properties of this first argument.
 *     - 0..n arguments, one for each backreference (corresponding to $1, $2, etc. above).
 *     - The zero-based index of the match within the total search string.
 *     - The total string being searched.
 * @param {String} [scope='one'] Use 'one' to replace the first match only, or 'all'. If not
 *   explicitly specified and using a regex with flag g, `scope` is 'all'.
 * @returns {String} New string with one or all matches replaced.
 * @example
 *
 * // Regex search, using named backreferences in replacement string
 * const name = XRegExp('(?<first>\\w+) (?<last>\\w+)');
 * XRegExp.replace('John Smith', name, '$<last>, $<first>');
 * // -> 'Smith, John'
 *
 * // Regex search, using named backreferences in replacement function
 * XRegExp.replace('John Smith', name, (match) => `${match.last}, ${match.first}`);
 * // -> 'Smith, John'
 *
 * // String search, with replace-all
 * XRegExp.replace('RegExp builds RegExps', 'RegExp', 'XRegExp', 'all');
 * // -> 'XRegExp builds XRegExps'
 */


XRegExp.replace = (str, search, replacement, scope) => {
  const isRegex = XRegExp.isRegExp(search);
  const global = search.global && scope !== 'one' || scope === 'all';
  const cacheKey = (global ? 'g' : '') + (search.sticky ? 'y' : '') || 'noGY';
  let s2 = search;

  if (isRegex) {
    search[REGEX_DATA] = search[REGEX_DATA] || {}; // Shares cached copies with `XRegExp.exec`/`match`. Since a copy is used, `search`'s
    // `lastIndex` isn't updated *during* replacement iterations

    s2 = search[REGEX_DATA][cacheKey] || (search[REGEX_DATA][cacheKey] = copyRegex(search, {
      addG: !!global,
      removeG: scope === 'one',
      isInternalOnly: true
    }));
  } else if (global) {
    s2 = new RegExp(XRegExp.escape(String(search)), 'g');
  } // Fixed `replace` required for named backreferences, etc.


  const result = fixed.replace.call(toObject(str), s2, replacement);

  if (isRegex && search.global) {
    // Fixes IE, Safari bug (last tested IE 9, Safari 5.1)
    search.lastIndex = 0;
  }

  return result;
};
/**
 * Performs batch processing of string replacements. Used like `XRegExp.replace`, but accepts an
 * array of replacement details. Later replacements operate on the output of earlier replacements.
 * Replacement details are accepted as an array with a regex or string to search for, the
 * replacement string or function, and an optional scope of 'one' or 'all'. Uses the XRegExp
 * replacement text syntax, which supports named backreference properties via `${name}` or
 * `$<name>`.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {Array} replacements Array of replacement detail arrays.
 * @returns {String} New string with all replacements.
 * @example
 *
 * str = XRegExp.replaceEach(str, [
 *   [XRegExp('(?<name>a)'), 'z${name}'],
 *   [/b/gi, 'y'],
 *   [/c/g, 'x', 'one'], // scope 'one' overrides /g
 *   [/d/, 'w', 'all'],  // scope 'all' overrides lack of /g
 *   ['e', 'v', 'all'],  // scope 'all' allows replace-all for strings
 *   [/f/g, ($0) => $0.toUpperCase()]
 * ]);
 */


XRegExp.replaceEach = (str, replacements) => {
  for (let i = 0; i < replacements.length; ++i) {
    const r = replacements[i];
    str = XRegExp.replace(str, r[0], r[1], r[2]);
  }

  return str;
};
/**
 * Splits a string into an array of strings using a regex or string separator. Matches of the
 * separator are not included in the result array. However, if `separator` is a regex that contains
 * capturing groups, backreferences are spliced into the result each time `separator` is matched.
 * Fixes browser bugs compared to the native `String.prototype.split` and can be used reliably
 * cross-browser.
 *
 * @memberOf XRegExp
 * @param {String} str String to split.
 * @param {RegExp|String} separator Regex or string to use for separating the string.
 * @param {Number} [limit] Maximum number of items to include in the result array.
 * @returns {Array} Array of substrings.
 * @example
 *
 * // Basic use
 * XRegExp.split('a b c', ' ');
 * // -> ['a', 'b', 'c']
 *
 * // With limit
 * XRegExp.split('a b c', ' ', 2);
 * // -> ['a', 'b']
 *
 * // Backreferences in result array
 * XRegExp.split('..word1..', /([a-z]+)(\d+)/i);
 * // -> ['..', 'word', '1', '..']
 */


XRegExp.split = (str, separator, limit) => fixed.split.call(toObject(str), separator, limit);
/**
 * Executes a regex search in a specified string. Returns `true` or `false`. Optional `pos` and
 * `sticky` arguments specify the search start position, and whether the match must start at the
 * specified position only. The `lastIndex` property of the provided regex is not used, but is
 * updated for compatibility. Also fixes browser bugs compared to the native
 * `RegExp.prototype.test` and can be used reliably cross-browser.
 *
 * @memberOf XRegExp
 * @param {String} str String to search.
 * @param {RegExp} regex Regex to search with.
 * @param {Number} [pos=0] Zero-based index at which to start the search.
 * @param {Boolean|String} [sticky=false] Whether the match must start at the specified position
 *   only. The string `'sticky'` is accepted as an alternative to `true`.
 * @returns {Boolean} Whether the regex matched the provided value.
 * @example
 *
 * // Basic use
 * XRegExp.test('abc', /c/); // -> true
 *
 * // With pos and sticky
 * XRegExp.test('abc', /c/, 0, 'sticky'); // -> false
 * XRegExp.test('abc', /c/, 2, 'sticky'); // -> true
 */
// Do this the easy way :-)


XRegExp.test = (str, regex, pos, sticky) => !!XRegExp.exec(str, regex, pos, sticky);
/**
 * Uninstalls optional features according to the specified options. All optional features start out
 * uninstalled, so this is used to undo the actions of `XRegExp.install`.
 *
 * @memberOf XRegExp
 * @param {Object|String} options Options object or string.
 * @example
 *
 * // With an options object
 * XRegExp.uninstall({
 *   // Disables support for astral code points in Unicode addons
 *   astral: true,
 *
 *   // Don't add named capture groups to the `groups` property of matches
 *   namespacing: true
 * });
 *
 * // With an options string
 * XRegExp.uninstall('astral namespacing');
 */


XRegExp.uninstall = options => {
  options = prepareOptions(options);

  if (features.astral && options.astral) {
    setAstral(false);
  }

  if (features.namespacing && options.namespacing) {
    setNamespacing(false);
  }
};
/**
 * Returns an XRegExp object that is the concatenation of the given patterns. Patterns can be provided as
 * regex objects or strings. Metacharacters are escaped in patterns provided as strings.
 * Backreferences in provided regex objects are automatically renumbered to work correctly within
 * the larger combined pattern. Native flags used by provided regexes are ignored in favor of the
 * `flags` argument.
 *
 * @memberOf XRegExp
 * @param {Array} patterns Regexes and strings to combine.
 * @param {String|RegExp} separator Regex or string to use as the joining separator.
 * @param {String} [flags] Any combination of XRegExp flags.
 * @returns {RegExp} Union of the provided regexes and strings.
 * @example
 *
 * XRegExp.join(['a+b*c', /(dogs)\1/, /(cats)\1/], 'i');
 * // -> /a\+b\*c(dogs)\1(cats)\2/i
 */


XRegExp.join = function (patterns, separator, flags) {
  separator = separator || '';
  const separatorStr = XRegExp.isRegExp(separator) ? separator.source : XRegExp.escape(separator);
  const output = prepareJoin(patterns);
  return XRegExp(output.join(separatorStr), flags);
};
/**
 * Returns an XRegExp object that is the union of the given patterns. Patterns can be provided as
 * regex objects or strings. Metacharacters are escaped in patterns provided as strings.
 * Backreferences in provided regex objects are automatically renumbered to work correctly within
 * the larger combined pattern. Native flags used by provided regexes are ignored in favor of the
 * `flags` argument.
 *
 * @memberOf XRegExp
 * @param {Array} patterns Regexes and strings to combine.
 * @param {String} [flags] Any combination of XRegExp flags.
 * @param {Object} [options] Options object with optional properties:
 *   - `conjunction` {String} Type of conjunction to use: 'or' (default) or 'none'.
 * @returns {RegExp} Union of the provided regexes and strings.
 * @example
 *
 * XRegExp.union(['a+b*c', /(dogs)\1/, /(cats)\1/], 'i');
 * // -> /a\+b\*c|(dogs)\1|(cats)\2/i
 *
 * XRegExp.union([/man/, /bear/, /pig/], 'i', {conjunction: 'none'});
 * // -> /manbearpig/i
 */


XRegExp.union = (patterns, flags, options) => {
  options = options || {};
  const conjunction = options.conjunction || 'or';
  const separator = conjunction === 'none' ? '' : /|/;
  return XRegExp.join(patterns, separator, flags);
}; // ==--------------------------==
// Fixed/extended native methods
// ==--------------------------==

/**
 * Adds named capture support (with backreferences returned as `result.name`), and fixes browser
 * bugs in the native `RegExp.prototype.exec`. Use via `XRegExp.exec`.
 *
 * @memberOf RegExp
 * @param {String} str String to search.
 * @returns {Array} Match array with named backreference properties, or `null`.
 */


fixed.exec = function (str) {
  const origLastIndex = this.lastIndex;
  const match = nativ.exec.apply(this, arguments);

  if (match) {
    // Fix browsers whose `exec` methods don't return `undefined` for nonparticipating capturing
    // groups. This fixes IE 5.5-8, but not IE 9's quirks mode or emulation of older IEs. IE 9
    // in standards mode follows the spec.
    if (!correctExecNpcg && match.length > 1 && match.includes('')) {
      const r2 = copyRegex(this, {
        removeG: true,
        isInternalOnly: true
      }); // Using `str.slice(match.index)` rather than `match[0]` in case lookahead allowed
      // matching due to characters outside the match

      nativ.replace.call(String(str).slice(match.index), r2, (...args) => {
        const len = args.length; // Skip index 0 and the last 2

        for (let i = 1; i < len - 2; ++i) {
          if (args[i] === undefined) {
            match[i] = undefined;
          }
        }
      });
    } // Attach named capture properties


    let groupsObject = match;

    if (XRegExp.isInstalled('namespacing')) {
      // https://tc39.github.io/proposal-regexp-named-groups/#sec-regexpbuiltinexec
      match.groups = Object.create(null);
      groupsObject = match.groups;
    }

    if (this[REGEX_DATA] && this[REGEX_DATA].captureNames) {
      // Skip index 0
      for (let i = 1; i < match.length; ++i) {
        const name = this[REGEX_DATA].captureNames[i - 1];

        if (name) {
          if (match[i] != undefined || groupsObject[name] == undefined) {
            groupsObject[name] = match[i];
          }
        }
      }
    } // Fix browsers that increment `lastIndex` after zero-length matches


    if (this.global && !match[0].length && this.lastIndex > match.index) {
      this.lastIndex = match.index;
    }
  }

  if (!this.global) {
    // Fixes IE, Opera bug (last tested IE 9, Opera 11.6)
    this.lastIndex = origLastIndex;
  }

  return match;
};
/**
 * Fixes browser bugs in the native `RegExp.prototype.test`.
 *
 * @memberOf RegExp
 * @param {String} str String to search.
 * @returns {Boolean} Whether the regex matched the provided value.
 */


fixed.test = function (str) {
  // Do this the easy way :-)
  return !!fixed.exec.call(this, str);
};
/**
 * Adds named capture support (with backreferences returned as `result.name`), and fixes browser
 * bugs in the native `String.prototype.match`.
 *
 * @memberOf String
 * @param {RegExp|*} regex Regex to search with. If not a regex object, it is passed to `RegExp`.
 * @returns {Array} If `regex` uses flag g, an array of match strings or `null`. Without flag g,
 *   the result of calling `regex.exec(this)`.
 */


fixed.match = function (regex) {
  if (!XRegExp.isRegExp(regex)) {
    // Use the native `RegExp` rather than `XRegExp`
    regex = new RegExp(regex);
  } else if (regex.global) {
    const result = nativ.match.apply(this, arguments); // Fixes IE bug

    regex.lastIndex = 0;
    return result;
  }

  return fixed.exec.call(regex, toObject(this));
};
/**
 * Adds support for `${n}` (or `$<n>`) tokens for named and numbered backreferences in replacement
 * text, and provides named backreferences to replacement functions as `arguments[0].name`. Also
 * fixes browser bugs in replacement text syntax when performing a replacement using a nonregex
 * search value, and the value of a replacement regex's `lastIndex` property during replacement
 * iterations and upon completion. Note that this doesn't support SpiderMonkey's proprietary third
 * (`flags`) argument. Use via `XRegExp.replace`.
 *
 * @memberOf String
 * @param {RegExp|String} search Search pattern to be replaced.
 * @param {String|Function} replacement Replacement string or a function invoked to create it.
 * @returns {String} New string with one or all matches replaced.
 */


fixed.replace = function (search, replacement) {
  const isRegex = XRegExp.isRegExp(search);
  let origLastIndex;
  let captureNames;
  let result;

  if (isRegex) {
    if (search[REGEX_DATA]) {
      captureNames = search[REGEX_DATA].captureNames;
    } // Only needed if `search` is nonglobal


    origLastIndex = search.lastIndex;
  } else {
    search += ''; // Type-convert
  } // Don't use `typeof`; some older browsers return 'function' for regex objects


  if (isType(replacement, 'Function')) {
    // Stringifying `this` fixes a bug in IE < 9 where the last argument in replacement
    // functions isn't type-converted to a string
    result = nativ.replace.call(String(this), search, (...args) => {
      if (captureNames) {
        let groupsObject;

        if (XRegExp.isInstalled('namespacing')) {
          // https://tc39.github.io/proposal-regexp-named-groups/#sec-regexpbuiltinexec
          groupsObject = Object.create(null);
          args.push(groupsObject);
        } else {
          // Change the `args[0]` string primitive to a `String` object that can store
          // properties. This really does need to use `String` as a constructor
          args[0] = new String(args[0]);
          groupsObject = args[0];
        } // Store named backreferences


        for (let i = 0; i < captureNames.length; ++i) {
          if (captureNames[i]) {
            groupsObject[captureNames[i]] = args[i + 1];
          }
        }
      } // Update `lastIndex` before calling `replacement`. Fixes IE, Chrome, Firefox, Safari
      // bug (last tested IE 9, Chrome 17, Firefox 11, Safari 5.1)


      if (isRegex && search.global) {
        search.lastIndex = args[args.length - 2] + args[0].length;
      } // ES6 specs the context for replacement functions as `undefined`


      return replacement(...args);
    });
  } else {
    // Ensure that the last value of `args` will be a string when given nonstring `this`,
    // while still throwing on null or undefined context
    result = nativ.replace.call(this == null ? this : String(this), search, (...args) => {
      return nativ.replace.call(String(replacement), replacementToken, replacer);

      function replacer($0, bracketed, angled, dollarToken) {
        bracketed = bracketed || angled; // Named or numbered backreference with curly or angled braces

        if (bracketed) {
          // XRegExp behavior for `${n}` or `$<n>`:
          // 1. Backreference to numbered capture, if `n` is an integer. Use `0` for the
          //    entire match. Any number of leading zeros may be used.
          // 2. Backreference to named capture `n`, if it exists and is not an integer
          //    overridden by numbered capture. In practice, this does not overlap with
          //    numbered capture since XRegExp does not allow named capture to use a bare
          //    integer as the name.
          // 3. If the name or number does not refer to an existing capturing group, it's
          //    an error.
          let n = +bracketed; // Type-convert; drop leading zeros

          if (n <= args.length - 3) {
            return args[n] || '';
          } // Groups with the same name is an error, else would need `lastIndexOf`


          n = captureNames ? captureNames.indexOf(bracketed) : -1;

          if (n < 0) {
            throw new SyntaxError(`Backreference to undefined group ${$0}`);
          }

          return args[n + 1] || '';
        } // Else, special variable or numbered backreference without curly braces


        if (dollarToken === '$') {
          // $$
          return '$';
        }

        if (dollarToken === '&' || +dollarToken === 0) {
          // $&, $0 (not followed by 1-9), $00
          return args[0];
        }

        if (dollarToken === '`') {
          // $` (left context)
          return args[args.length - 1].slice(0, args[args.length - 2]);
        }

        if (dollarToken === "'") {
          // $' (right context)
          return args[args.length - 1].slice(args[args.length - 2] + args[0].length);
        } // Else, numbered backreference without braces


        dollarToken = +dollarToken; // Type-convert; drop leading zero
        // XRegExp behavior for `$n` and `$nn`:
        // - Backrefs end after 1 or 2 digits. Use `${..}` or `$<..>` for more digits.
        // - `$1` is an error if no capturing groups.
        // - `$10` is an error if less than 10 capturing groups. Use `${1}0` or `$<1>0`
        //   instead.
        // - `$01` is `$1` if at least one capturing group, else it's an error.
        // - `$0` (not followed by 1-9) and `$00` are the entire match.
        // Native behavior, for comparison:
        // - Backrefs end after 1 or 2 digits. Cannot reference capturing group 100+.
        // - `$1` is a literal `$1` if no capturing groups.
        // - `$10` is `$1` followed by a literal `0` if less than 10 capturing groups.
        // - `$01` is `$1` if at least one capturing group, else it's a literal `$01`.
        // - `$0` is a literal `$0`.

        if (!isNaN(dollarToken)) {
          if (dollarToken > args.length - 3) {
            throw new SyntaxError(`Backreference to undefined group ${$0}`);
          }

          return args[dollarToken] || '';
        } // `$` followed by an unsupported char is an error, unlike native JS


        throw new SyntaxError(`Invalid token ${$0}`);
      }
    });
  }

  if (isRegex) {
    if (search.global) {
      // Fixes IE, Safari bug (last tested IE 9, Safari 5.1)
      search.lastIndex = 0;
    } else {
      // Fixes IE, Opera bug (last tested IE 9, Opera 11.6)
      search.lastIndex = origLastIndex;
    }
  }

  return result;
};
/**
 * Fixes browser bugs in the native `String.prototype.split`. Use via `XRegExp.split`.
 *
 * @memberOf String
 * @param {RegExp|String} separator Regex or string to use for separating the string.
 * @param {Number} [limit] Maximum number of items to include in the result array.
 * @returns {Array} Array of substrings.
 */


fixed.split = function (separator, limit) {
  if (!XRegExp.isRegExp(separator)) {
    // Browsers handle nonregex split correctly, so use the faster native method
    return nativ.split.apply(this, arguments);
  }

  const str = String(this);
  const output = [];
  const origLastIndex = separator.lastIndex;
  let lastLastIndex = 0;
  let lastLength; // Values for `limit`, per the spec:
  // If undefined: pow(2,32) - 1
  // If 0, Infinity, or NaN: 0
  // If positive number: limit = floor(limit); if (limit >= pow(2,32)) limit -= pow(2,32);
  // If negative number: pow(2,32) - floor(abs(limit))
  // If other: Type-convert, then use the above rules
  // This line fails in very strange ways for some values of `limit` in Opera 10.5-10.63, unless
  // Opera Dragonfly is open (go figure). It works in at least Opera 9.5-10.1 and 11+

  limit = (limit === undefined ? -1 : limit) >>> 0;
  XRegExp.forEach(str, separator, match => {
    // This condition is not the same as `if (match[0].length)`
    if (match.index + match[0].length > lastLastIndex) {
      output.push(str.slice(lastLastIndex, match.index));

      if (match.length > 1 && match.index < str.length) {
        Array.prototype.push.apply(output, match.slice(1));
      }

      lastLength = match[0].length;
      lastLastIndex = match.index + lastLength;
    }
  });

  if (lastLastIndex === str.length) {
    if (!nativ.test.call(separator, '') || lastLength) {
      output.push('');
    }
  } else {
    output.push(str.slice(lastLastIndex));
  }

  separator.lastIndex = origLastIndex;
  return output.length > limit ? output.slice(0, limit) : output;
}; // ==--------------------------==
// Built-in syntax/flag tokens
// ==--------------------------==

/*
 * Letter escapes that natively match literal characters: `\a`, `\A`, etc. These should be
 * SyntaxErrors but are allowed in web reality. XRegExp makes them errors for cross-browser
 * consistency and to reserve their syntax, but lets them be superseded by addons.
 */


XRegExp.addToken(/\\([ABCE-RTUVXYZaeg-mopqyz]|c(?![A-Za-z])|u(?![\dA-Fa-f]{4}|{[\dA-Fa-f]+})|x(?![\dA-Fa-f]{2}))/, (match, scope) => {
  // \B is allowed in default scope only
  if (match[1] === 'B' && scope === defaultScope) {
    return match[0];
  }

  throw new SyntaxError(`Invalid escape ${match[0]}`);
}, {
  scope: 'all',
  leadChar: '\\'
});
/*
 * Unicode code point escape with curly braces: `\u{N..}`. `N..` is any one or more digit
 * hexadecimal number from 0-10FFFF, and can include leading zeros. Requires the native ES6 `u` flag
 * to support code points greater than U+FFFF. Avoids converting code points above U+FFFF to
 * surrogate pairs (which could be done without flag `u`), since that could lead to broken behavior
 * if you follow a `\u{N..}` token that references a code point above U+FFFF with a quantifier, or
 * if you use the same in a character class.
 */

XRegExp.addToken(/\\u{([\dA-Fa-f]+)}/, (match, scope, flags) => {
  const code = dec(match[1]);

  if (code > 0x10FFFF) {
    throw new SyntaxError(`Invalid Unicode code point ${match[0]}`);
  }

  if (code <= 0xFFFF) {
    // Converting to \uNNNN avoids needing to escape the literal character and keep it
    // separate from preceding tokens
    return `\\u${pad4(hex(code))}`;
  } // If `code` is between 0xFFFF and 0x10FFFF, require and defer to native handling


  if (hasNativeU && flags.includes('u')) {
    return match[0];
  }

  throw new SyntaxError('Cannot use Unicode code point above \\u{FFFF} without flag u');
}, {
  scope: 'all',
  leadChar: '\\'
});
/*
 * Empty character class: `[]` or `[^]`. This fixes a critical cross-browser syntax inconsistency.
 * Unless this is standardized (per the ES spec), regex syntax can't be accurately parsed because
 * character class endings can't be determined.
 */

XRegExp.addToken(/\[(\^?)\]/, // For cross-browser compatibility with ES3, convert [] to \b\B and [^] to [\s\S].
// (?!) should work like \b\B, but is unreliable in some versions of Firefox

/* eslint-disable no-confusing-arrow */
match => match[1] ? '[\\s\\S]' : '\\b\\B',
/* eslint-enable no-confusing-arrow */
{
  leadChar: '['
});
/*
 * Comment pattern: `(?# )`. Inline comments are an alternative to the line comments allowed in
 * free-spacing mode (flag x).
 */

XRegExp.addToken(/\(\?#[^)]*\)/, getContextualTokenSeparator, {
  leadChar: '('
});
/*
 * Whitespace and line comments, in free-spacing mode (aka extended mode, flag x) only.
 */

XRegExp.addToken(/\s+|#[^\n]*\n?/, getContextualTokenSeparator, {
  flag: 'x'
});
/*
 * Dot, in dotall mode (aka singleline mode, flag s) only.
 */

XRegExp.addToken(/\./, () => '[\\s\\S]', {
  flag: 's',
  leadChar: '.'
});
/*
 * Named backreference: `\k<name>`. Backreference names can use the characters A-Z, a-z, 0-9, _,
 * and $ only. Also allows numbered backreferences as `\k<n>`.
 */

XRegExp.addToken(/\\k<([\w$]+)>/, function (match) {
  // Groups with the same name is an error, else would need `lastIndexOf`
  const index = isNaN(match[1]) ? this.captureNames.indexOf(match[1]) + 1 : +match[1];
  const endIndex = match.index + match[0].length;

  if (!index || index > this.captureNames.length) {
    throw new SyntaxError(`Backreference to undefined group ${match[0]}`);
  } // Keep backreferences separate from subsequent literal numbers. This avoids e.g.
  // inadvertedly changing `(?<n>)\k<n>1` to `()\11`.


  return `\\${index}${endIndex === match.input.length || isNaN(match.input[endIndex]) ? '' : '(?:)'}`;
}, {
  leadChar: '\\'
});
/*
 * Numbered backreference or octal, plus any following digits: `\0`, `\11`, etc. Octals except `\0`
 * not followed by 0-9 and backreferences to unopened capture groups throw an error. Other matches
 * are returned unaltered. IE < 9 doesn't support backreferences above `\99` in regex syntax.
 */

XRegExp.addToken(/\\(\d+)/, function (match, scope) {
  if (!(scope === defaultScope && /^[1-9]/.test(match[1]) && +match[1] <= this.captureNames.length) && match[1] !== '0') {
    throw new SyntaxError(`Cannot use octal escape or backreference to undefined group ${match[0]}`);
  }

  return match[0];
}, {
  scope: 'all',
  leadChar: '\\'
});
/*
 * Named capturing group; match the opening delimiter only: `(?<name>`. Capture names can use the
 * characters A-Z, a-z, 0-9, _, and $ only. Names can't be integers. Supports Python-style
 * `(?P<name>` as an alternate syntax to avoid issues in some older versions of Opera which natively
 * supported the Python-style syntax. Otherwise, XRegExp might treat numbered backreferences to
 * Python-style named capture as octals.
 */

XRegExp.addToken(/\(\?P?<([\w$]+)>/, function (match) {
  // Disallow bare integers as names because named backreferences are added to match arrays
  // and therefore numeric properties may lead to incorrect lookups
  if (!isNaN(match[1])) {
    throw new SyntaxError(`Cannot use integer as capture name ${match[0]}`);
  }

  if (!XRegExp.isInstalled('namespacing') && (match[1] === 'length' || match[1] === '__proto__')) {
    throw new SyntaxError(`Cannot use reserved word as capture name ${match[0]}`);
  }

  if (this.captureNames.includes(match[1])) {
    throw new SyntaxError(`Cannot use same name for multiple groups ${match[0]}`);
  }

  this.captureNames.push(match[1]);
  this.hasNamedCapture = true;
  return '(';
}, {
  leadChar: '('
});
/*
 * Capturing group; match the opening parenthesis only. Required for support of named capturing
 * groups. Also adds explicit capture mode (flag n).
 */

XRegExp.addToken(/\((?!\?)/, function (match, scope, flags) {
  if (flags.includes('n')) {
    return '(?:';
  }

  this.captureNames.push(null);
  return '(';
}, {
  optionalFlags: 'n',
  leadChar: '('
});
/*!
 * XRegExp.build
 * <xregexp.com>
 * Steven Levithan (c) 2012-present MIT License
 * Inspired by Lea Verou's RegExp.create <lea.verou.me>
 */

var build = XRegExp => {
  const REGEX_DATA = 'xregexp';
  const subParts = /(\()(?!\?)|\\([1-9]\d*)|\\[\s\S]|\[(?:[^\\\]]|\\[\s\S])*\]/g;
  const parts = XRegExp.union([/\({{([\w$]+)}}\)|{{([\w$]+)}}/, subParts], 'g', {
    conjunction: 'or'
  });
  /**
   * Strips a leading `^` and trailing unescaped `$`, if both are present.
   *
   * @private
   * @param {String} pattern Pattern to process.
   * @returns {String} Pattern with edge anchors removed.
   */

  function deanchor(pattern) {
    // Allow any number of empty noncapturing groups before/after anchors, because regexes
    // built/generated by XRegExp sometimes include them
    const leadingAnchor = /^(?:\(\?:\))*\^/;
    const trailingAnchor = /\$(?:\(\?:\))*$/;

    if (leadingAnchor.test(pattern) && trailingAnchor.test(pattern) && // Ensure that the trailing `$` isn't escaped
    trailingAnchor.test(pattern.replace(/\\[\s\S]/g, ''))) {
      return pattern.replace(leadingAnchor, '').replace(trailingAnchor, '');
    }

    return pattern;
  }
  /**
   * Converts the provided value to an XRegExp. Native RegExp flags are not preserved.
   *
   * @private
   * @param {String|RegExp} value Value to convert.
   * @param {Boolean} [addFlagX] Whether to apply the `x` flag in cases when `value` is not
   *   already a regex generated by XRegExp
   * @returns {RegExp} XRegExp object with XRegExp syntax applied.
   */


  function asXRegExp(value, addFlagX) {
    const flags = addFlagX ? 'x' : '';
    return XRegExp.isRegExp(value) ? value[REGEX_DATA] && value[REGEX_DATA].captureNames ? // Don't recompile, to preserve capture names
    value : // Recompile as XRegExp
    XRegExp(value.source, flags) : // Compile string as XRegExp
    XRegExp(value, flags);
  }

  function interpolate(substitution) {
    return substitution instanceof RegExp ? substitution : XRegExp.escape(substitution);
  }

  function reduceToSubpatternsObject(subpatterns, interpolated, subpatternIndex) {
    subpatterns[`subpattern${subpatternIndex}`] = interpolated;
    return subpatterns;
  }

  function embedSubpatternAfter(raw, subpatternIndex, rawLiterals) {
    const hasSubpattern = subpatternIndex < rawLiterals.length - 1;
    return raw + (hasSubpattern ? `{{subpattern${subpatternIndex}}}` : '');
  }
  /**
   * Provides tagged template literals that create regexes with XRegExp syntax and flags. The
   * provided pattern is handled as a raw string, so backslashes don't need to be escaped.
   *
   * Interpolation of strings and regexes shares the features of `XRegExp.build`. Interpolated
   * patterns are treated as atomic units when quantified, interpolated strings have their special
   * characters escaped, a leading `^` and trailing unescaped `$` are stripped from interpolated
   * regexes if both are present, and any backreferences within an interpolated regex are
   * rewritten to work within the overall pattern.
   *
   * @memberOf XRegExp
   * @param {String} [flags] Any combination of XRegExp flags.
   * @returns {Function} Handler for template literals that construct regexes with XRegExp syntax.
   * @example
   *
   * const h12 = /1[0-2]|0?[1-9]/;
   * const h24 = /2[0-3]|[01][0-9]/;
   * const hours = XRegExp.tag('x')`${h12} : | ${h24}`;
   * const minutes = /^[0-5][0-9]$/;
   * // Note that explicitly naming the 'minutes' group is required for named backreferences
   * const time = XRegExp.tag('x')`^ ${hours} (?<minutes>${minutes}) $`;
   * time.test('10:59'); // -> true
   * XRegExp.exec('10:59', time).minutes; // -> '59'
   */


  XRegExp.tag = flags => (literals, ...substitutions) => {
    const subpatterns = substitutions.map(interpolate).reduce(reduceToSubpatternsObject, {});
    const pattern = literals.raw.map(embedSubpatternAfter).join('');
    return XRegExp.build(pattern, subpatterns, flags);
  };
  /**
   * Builds regexes using named subpatterns, for readability and pattern reuse. Backreferences in
   * the outer pattern and provided subpatterns are automatically renumbered to work correctly.
   * Native flags used by provided subpatterns are ignored in favor of the `flags` argument.
   *
   * @memberOf XRegExp
   * @param {String} pattern XRegExp pattern using `{{name}}` for embedded subpatterns. Allows
   *   `({{name}})` as shorthand for `(?<name>{{name}})`. Patterns cannot be embedded within
   *   character classes.
   * @param {Object} subs Lookup object for named subpatterns. Values can be strings or regexes. A
   *   leading `^` and trailing unescaped `$` are stripped from subpatterns, if both are present.
   * @param {String} [flags] Any combination of XRegExp flags.
   * @returns {RegExp} Regex with interpolated subpatterns.
   * @example
   *
   * const time = XRegExp.build('(?x)^ {{hours}} ({{minutes}}) $', {
   *   hours: XRegExp.build('{{h12}} : | {{h24}}', {
   *     h12: /1[0-2]|0?[1-9]/,
   *     h24: /2[0-3]|[01][0-9]/
   *   }, 'x'),
   *   minutes: /^[0-5][0-9]$/
   * });
   * time.test('10:59'); // -> true
   * XRegExp.exec('10:59', time).minutes; // -> '59'
   */


  XRegExp.build = (pattern, subs, flags) => {
    flags = flags || ''; // Used with `asXRegExp` calls for `pattern` and subpatterns in `subs`, to work around how
    // some browsers convert `RegExp('\n')` to a regex that contains the literal characters `\`
    // and `n`. See more details at <https://github.com/slevithan/xregexp/pull/163>.

    const addFlagX = flags.includes('x');
    const inlineFlags = /^\(\?([\w$]+)\)/.exec(pattern); // Add flags within a leading mode modifier to the overall pattern's flags

    if (inlineFlags) {
      flags = XRegExp._clipDuplicates(flags + inlineFlags[1]);
    }

    const data = {};

    for (const p in subs) {
      if (subs.hasOwnProperty(p)) {
        // Passing to XRegExp enables extended syntax and ensures independent validity,
        // lest an unescaped `(`, `)`, `[`, or trailing `\` breaks the `(?:)` wrapper. For
        // subpatterns provided as native regexes, it dies on octals and adds the property
        // used to hold extended regex instance data, for simplicity.
        const sub = asXRegExp(subs[p], addFlagX);
        data[p] = {
          // Deanchoring allows embedding independently useful anchored regexes. If you
          // really need to keep your anchors, double them (i.e., `^^...$$`).
          pattern: deanchor(sub.source),
          names: sub[REGEX_DATA].captureNames || []
        };
      }
    } // Passing to XRegExp dies on octals and ensures the outer pattern is independently valid;
    // helps keep this simple. Named captures will be put back.


    const patternAsRegex = asXRegExp(pattern, addFlagX); // 'Caps' is short for 'captures'

    let numCaps = 0;
    let numPriorCaps;
    let numOuterCaps = 0;
    const outerCapsMap = [0];
    const outerCapNames = patternAsRegex[REGEX_DATA].captureNames || [];
    const output = patternAsRegex.source.replace(parts, ($0, $1, $2, $3, $4) => {
      const subName = $1 || $2;
      let capName;
      let intro;
      let localCapIndex; // Named subpattern

      if (subName) {
        if (!data.hasOwnProperty(subName)) {
          throw new ReferenceError(`Undefined property ${$0}`);
        } // Named subpattern was wrapped in a capturing group


        if ($1) {
          capName = outerCapNames[numOuterCaps];
          outerCapsMap[++numOuterCaps] = ++numCaps; // If it's a named group, preserve the name. Otherwise, use the subpattern name
          // as the capture name

          intro = `(?<${capName || subName}>`;
        } else {
          intro = '(?:';
        }

        numPriorCaps = numCaps;
        const rewrittenSubpattern = data[subName].pattern.replace(subParts, (match, paren, backref) => {
          // Capturing group
          if (paren) {
            capName = data[subName].names[numCaps - numPriorCaps];
            ++numCaps; // If the current capture has a name, preserve the name

            if (capName) {
              return `(?<${capName}>`;
            } // Backreference

          } else if (backref) {
            localCapIndex = +backref - 1; // Rewrite the backreference

            return data[subName].names[localCapIndex] ? // Need to preserve the backreference name in case using flag `n`
            `\\k<${data[subName].names[localCapIndex]}>` : `\\${+backref + numPriorCaps}`;
          }

          return match;
        });
        return `${intro}${rewrittenSubpattern})`;
      } // Capturing group


      if ($3) {
        capName = outerCapNames[numOuterCaps];
        outerCapsMap[++numOuterCaps] = ++numCaps; // If the current capture has a name, preserve the name

        if (capName) {
          return `(?<${capName}>`;
        } // Backreference

      } else if ($4) {
        localCapIndex = +$4 - 1; // Rewrite the backreference

        return outerCapNames[localCapIndex] ? // Need to preserve the backreference name in case using flag `n`
        `\\k<${outerCapNames[localCapIndex]}>` : `\\${outerCapsMap[+$4]}`;
      }

      return $0;
    });
    return XRegExp(output, flags);
  };
}; // End of module

/*!
 * XRegExp.matchRecursive
 * <xregexp.com>
 * Steven Levithan (c) 2009-present MIT License
 */


var matchRecursive = XRegExp => {
  /**
   * Returns a match detail object composed of the provided values.
   *
   * @private
   */
  function row(name, value, start, end) {
    return {
      name,
      value,
      start,
      end
    };
  }
  /**
   * Returns an array of match strings between outermost left and right delimiters, or an array of
   * objects with detailed match parts and position data. An error is thrown if delimiters are
   * unbalanced within the data.
   *
   * @memberOf XRegExp
   * @param {String} str String to search.
   * @param {String} left Left delimiter as an XRegExp pattern.
   * @param {String} right Right delimiter as an XRegExp pattern.
   * @param {String} [flags] Any native or XRegExp flags, used for the left and right delimiters.
   * @param {Object} [options] Lets you specify `valueNames` and `escapeChar` options.
   * @returns {Array} Array of matches, or an empty array.
   * @example
   *
   * // Basic usage
   * let str = '(t((e))s)t()(ing)';
   * XRegExp.matchRecursive(str, '\\(', '\\)', 'g');
   * // -> ['t((e))s', '', 'ing']
   *
   * // Extended information mode with valueNames
   * str = 'Here is <div> <div>an</div></div> example';
   * XRegExp.matchRecursive(str, '<div\\s*>', '</div>', 'gi', {
   *   valueNames: ['between', 'left', 'match', 'right']
   * });
   * // -> [
   * // {name: 'between', value: 'Here is ',       start: 0,  end: 8},
   * // {name: 'left',    value: '<div>',          start: 8,  end: 13},
   * // {name: 'match',   value: ' <div>an</div>', start: 13, end: 27},
   * // {name: 'right',   value: '</div>',         start: 27, end: 33},
   * // {name: 'between', value: ' example',       start: 33, end: 41}
   * // ]
   *
   * // Omitting unneeded parts with null valueNames, and using escapeChar
   * str = '...{1}.\\{{function(x,y){return {y:x}}}';
   * XRegExp.matchRecursive(str, '{', '}', 'g', {
   *   valueNames: ['literal', null, 'value', null],
   *   escapeChar: '\\'
   * });
   * // -> [
   * // {name: 'literal', value: '...',  start: 0, end: 3},
   * // {name: 'value',   value: '1',    start: 4, end: 5},
   * // {name: 'literal', value: '.\\{', start: 6, end: 9},
   * // {name: 'value',   value: 'function(x,y){return {y:x}}', start: 10, end: 37}
   * // ]
   *
   * // Sticky mode via flag y
   * str = '<1><<<2>>><3>4<5>';
   * XRegExp.matchRecursive(str, '<', '>', 'gy');
   * // -> ['1', '<<2>>', '3']
   */


  XRegExp.matchRecursive = (str, left, right, flags, options) => {
    flags = flags || '';
    options = options || {};
    const global = flags.includes('g');
    const sticky = flags.includes('y'); // Flag `y` is controlled internally

    const basicFlags = flags.replace(/y/g, '');
    let escapeChar = options.escapeChar;
    const vN = options.valueNames;
    const output = [];
    let openTokens = 0;
    let delimStart = 0;
    let delimEnd = 0;
    let lastOuterEnd = 0;
    let outerStart;
    let innerStart;
    let leftMatch;
    let rightMatch;
    let esc;
    left = XRegExp(left, basicFlags);
    right = XRegExp(right, basicFlags);

    if (escapeChar) {
      if (escapeChar.length > 1) {
        throw new Error('Cannot use more than one escape character');
      }

      escapeChar = XRegExp.escape(escapeChar); // Example of concatenated `esc` regex:
      // `escapeChar`: '%'
      // `left`: '<'
      // `right`: '>'
      // Regex is: /(?:%[\S\s]|(?:(?!<|>)[^%])+)+/

      esc = new RegExp(`(?:${escapeChar}[\\S\\s]|(?:(?!${// Using `XRegExp.union` safely rewrites backreferences in `left` and `right`.
      // Intentionally not passing `basicFlags` to `XRegExp.union` since any syntax
      // transformation resulting from those flags was already applied to `left` and
      // `right` when they were passed through the XRegExp constructor above.
      XRegExp.union([left, right], '', {
        conjunction: 'or'
      }).source})[^${escapeChar}])+)+`, // Flags `gy` not needed here
      flags.replace(/[^imu]+/g, ''));
    }

    while (true) {
      // If using an escape character, advance to the delimiter's next starting position,
      // skipping any escaped characters in between
      if (escapeChar) {
        delimEnd += (XRegExp.exec(str, esc, delimEnd, 'sticky') || [''])[0].length;
      }

      leftMatch = XRegExp.exec(str, left, delimEnd);
      rightMatch = XRegExp.exec(str, right, delimEnd); // Keep the leftmost match only

      if (leftMatch && rightMatch) {
        if (leftMatch.index <= rightMatch.index) {
          rightMatch = null;
        } else {
          leftMatch = null;
        }
      } // Paths (LM: leftMatch, RM: rightMatch, OT: openTokens):
      // LM | RM | OT | Result
      // 1  | 0  | 1  | loop
      // 1  | 0  | 0  | loop
      // 0  | 1  | 1  | loop
      // 0  | 1  | 0  | throw
      // 0  | 0  | 1  | throw
      // 0  | 0  | 0  | break
      // The paths above don't include the sticky mode special case. The loop ends after the
      // first completed match if not `global`.


      if (leftMatch || rightMatch) {
        delimStart = (leftMatch || rightMatch).index;
        delimEnd = delimStart + (leftMatch || rightMatch)[0].length;
      } else if (!openTokens) {
        break;
      }

      if (sticky && !openTokens && delimStart > lastOuterEnd) {
        break;
      }

      if (leftMatch) {
        if (!openTokens) {
          outerStart = delimStart;
          innerStart = delimEnd;
        }

        ++openTokens;
      } else if (rightMatch && openTokens) {
        if (! --openTokens) {
          if (vN) {
            if (vN[0] && outerStart > lastOuterEnd) {
              output.push(row(vN[0], str.slice(lastOuterEnd, outerStart), lastOuterEnd, outerStart));
            }

            if (vN[1]) {
              output.push(row(vN[1], str.slice(outerStart, innerStart), outerStart, innerStart));
            }

            if (vN[2]) {
              output.push(row(vN[2], str.slice(innerStart, delimStart), innerStart, delimStart));
            }

            if (vN[3]) {
              output.push(row(vN[3], str.slice(delimStart, delimEnd), delimStart, delimEnd));
            }
          } else {
            output.push(str.slice(innerStart, delimStart));
          }

          lastOuterEnd = delimEnd;

          if (!global) {
            break;
          }
        }
      } else {
        throw new Error('Unbalanced delimiter found in string');
      } // If the delimiter matched an empty string, avoid an infinite loop


      if (delimStart === delimEnd) {
        ++delimEnd;
      }
    }

    if (global && !sticky && vN && vN[0] && str.length > lastOuterEnd) {
      output.push(row(vN[0], str.slice(lastOuterEnd), lastOuterEnd, str.length));
    }

    return output;
  };
}; // End of module

/*!
 * XRegExp Unicode Base
 * <xregexp.com>
 * Steven Levithan (c) 2008-present MIT License
 */


var unicodeBase = XRegExp => {
  /**
   * Adds base support for Unicode matching:
   * - Adds syntax `\p{..}` for matching Unicode tokens. Tokens can be inverted using `\P{..}` or
   *   `\p{^..}`. Token names ignore case, spaces, hyphens, and underscores. You can omit the
   *   braces for token names that are a single letter (e.g. `\pL` or `PL`).
   * - Adds flag A (astral), which enables 21-bit Unicode support.
   * - Adds the `XRegExp.addUnicodeData` method used by other addons to provide character data.
   *
   * Unicode Base relies on externally provided Unicode character data. Official addons are
   * available to provide data for Unicode categories, scripts, blocks, and properties.
   *
   * @requires XRegExp
   */
  // ==--------------------------==
  // Private stuff
  // ==--------------------------==
  // Storage for Unicode data
  const unicode = {}; // Reuse utils

  const dec = XRegExp._dec;
  const hex = XRegExp._hex;
  const pad4 = XRegExp._pad4; // Generates a token lookup name: lowercase, with hyphens, spaces, and underscores removed

  function normalize(name) {
    return name.replace(/[- _]+/g, '').toLowerCase();
  } // Gets the decimal code of a literal code unit, \xHH, \uHHHH, or a backslash-escaped literal


  function charCode(chr) {
    const esc = /^\\[xu](.+)/.exec(chr);
    return esc ? dec(esc[1]) : chr.charCodeAt(chr[0] === '\\' ? 1 : 0);
  } // Inverts a list of ordered BMP characters and ranges


  function invertBmp(range) {
    let output = '';
    let lastEnd = -1;
    XRegExp.forEach(range, /(\\x..|\\u....|\\?[\s\S])(?:-(\\x..|\\u....|\\?[\s\S]))?/, m => {
      const start = charCode(m[1]);

      if (start > lastEnd + 1) {
        output += `\\u${pad4(hex(lastEnd + 1))}`;

        if (start > lastEnd + 2) {
          output += `-\\u${pad4(hex(start - 1))}`;
        }
      }

      lastEnd = charCode(m[2] || m[1]);
    });

    if (lastEnd < 0xFFFF) {
      output += `\\u${pad4(hex(lastEnd + 1))}`;

      if (lastEnd < 0xFFFE) {
        output += '-\\uFFFF';
      }
    }

    return output;
  } // Generates an inverted BMP range on first use


  function cacheInvertedBmp(slug) {
    const prop = 'b!';
    return unicode[slug][prop] || (unicode[slug][prop] = invertBmp(unicode[slug].bmp));
  } // Combines and optionally negates BMP and astral data


  function buildAstral(slug, isNegated) {
    const item = unicode[slug];
    let combined = '';

    if (item.bmp && !item.isBmpLast) {
      combined = `[${item.bmp}]${item.astral ? '|' : ''}`;
    }

    if (item.astral) {
      combined += item.astral;
    }

    if (item.isBmpLast && item.bmp) {
      combined += `${item.astral ? '|' : ''}[${item.bmp}]`;
    } // Astral Unicode tokens always match a code point, never a code unit


    return isNegated ? `(?:(?!${combined})(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\0-\uFFFF]))` : `(?:${combined})`;
  } // Builds a complete astral pattern on first use


  function cacheAstral(slug, isNegated) {
    const prop = isNegated ? 'a!' : 'a=';
    return unicode[slug][prop] || (unicode[slug][prop] = buildAstral(slug, isNegated));
  } // ==--------------------------==
  // Core functionality
  // ==--------------------------==

  /*
   * Add astral mode (flag A) and Unicode token syntax: `\p{..}`, `\P{..}`, `\p{^..}`, `\pC`.
   */


  XRegExp.addToken( // Use `*` instead of `+` to avoid capturing `^` as the token name in `\p{^}`
  /\\([pP])(?:{(\^?)([^}]*)}|([A-Za-z]))/, (match, scope, flags) => {
    const ERR_DOUBLE_NEG = 'Invalid double negation ';
    const ERR_UNKNOWN_NAME = 'Unknown Unicode token ';
    const ERR_UNKNOWN_REF = 'Unicode token missing data ';
    const ERR_ASTRAL_ONLY = 'Astral mode required for Unicode token ';
    const ERR_ASTRAL_IN_CLASS = 'Astral mode does not support Unicode tokens within character classes'; // Negated via \P{..} or \p{^..}

    let isNegated = match[1] === 'P' || !!match[2]; // Switch from BMP (0-FFFF) to astral (0-10FFFF) mode via flag A

    const isAstralMode = flags.includes('A'); // Token lookup name. Check `[4]` first to avoid passing `undefined` via `\p{}`

    let slug = normalize(match[4] || match[3]); // Token data object

    let item = unicode[slug];

    if (match[1] === 'P' && match[2]) {
      throw new SyntaxError(ERR_DOUBLE_NEG + match[0]);
    }

    if (!unicode.hasOwnProperty(slug)) {
      throw new SyntaxError(ERR_UNKNOWN_NAME + match[0]);
    } // Switch to the negated form of the referenced Unicode token


    if (item.inverseOf) {
      slug = normalize(item.inverseOf);

      if (!unicode.hasOwnProperty(slug)) {
        throw new ReferenceError(`${ERR_UNKNOWN_REF + match[0]} -> ${item.inverseOf}`);
      }

      item = unicode[slug];
      isNegated = !isNegated;
    }

    if (!(item.bmp || isAstralMode)) {
      throw new SyntaxError(ERR_ASTRAL_ONLY + match[0]);
    }

    if (isAstralMode) {
      if (scope === 'class') {
        throw new SyntaxError(ERR_ASTRAL_IN_CLASS);
      }

      return cacheAstral(slug, isNegated);
    }

    return scope === 'class' ? isNegated ? cacheInvertedBmp(slug) : item.bmp : `${(isNegated ? '[^' : '[') + item.bmp}]`;
  }, {
    scope: 'all',
    optionalFlags: 'A',
    leadChar: '\\'
  });
  /**
   * Adds to the list of Unicode tokens that XRegExp regexes can match via `\p` or `\P`.
   *
   * @memberOf XRegExp
   * @param {Array} data Objects with named character ranges. Each object may have properties
   *   `name`, `alias`, `isBmpLast`, `inverseOf`, `bmp`, and `astral`. All but `name` are
   *   optional, although one of `bmp` or `astral` is required (unless `inverseOf` is set). If
   *   `astral` is absent, the `bmp` data is used for BMP and astral modes. If `bmp` is absent,
   *   the name errors in BMP mode but works in astral mode. If both `bmp` and `astral` are
   *   provided, the `bmp` data only is used in BMP mode, and the combination of `bmp` and
   *   `astral` data is used in astral mode. `isBmpLast` is needed when a token matches orphan
   *   high surrogates *and* uses surrogate pairs to match astral code points. The `bmp` and
   *   `astral` data should be a combination of literal characters and `\xHH` or `\uHHHH` escape
   *   sequences, with hyphens to create ranges. Any regex metacharacters in the data should be
   *   escaped, apart from range-creating hyphens. The `astral` data can additionally use
   *   character classes and alternation, and should use surrogate pairs to represent astral code
   *   points. `inverseOf` can be used to avoid duplicating character data if a Unicode token is
   *   defined as the exact inverse of another token.
   * @example
   *
   * // Basic use
   * XRegExp.addUnicodeData([{
   *   name: 'XDigit',
   *   alias: 'Hexadecimal',
   *   bmp: '0-9A-Fa-f'
   * }]);
   * XRegExp('\\p{XDigit}:\\p{Hexadecimal}+').test('0:3D'); // -> true
   */

  XRegExp.addUnicodeData = data => {
    const ERR_NO_NAME = 'Unicode token requires name';
    const ERR_NO_DATA = 'Unicode token has no character data ';
    let item;

    for (let i = 0; i < data.length; ++i) {
      item = data[i];

      if (!item.name) {
        throw new Error(ERR_NO_NAME);
      }

      if (!(item.inverseOf || item.bmp || item.astral)) {
        throw new Error(ERR_NO_DATA + item.name);
      }

      unicode[normalize(item.name)] = item;

      if (item.alias) {
        unicode[normalize(item.alias)] = item;
      }
    } // Reset the pattern cache used by the `XRegExp` constructor, since the same pattern and
    // flags might now produce different results


    XRegExp.cache.flush('patterns');
  };
  /**
   * @ignore
   *
   * Return a reference to the internal Unicode definition structure for the given Unicode
   * Property if the given name is a legal Unicode Property for use in XRegExp `\p` or `\P` regex
   * constructs.
   *
   * @memberOf XRegExp
   * @param {String} name Name by which the Unicode Property may be recognized (case-insensitive),
   *   e.g. `'N'` or `'Number'`. The given name is matched against all registered Unicode
   *   Properties and Property Aliases.
   * @returns {Object} Reference to definition structure when the name matches a Unicode Property.
   *
   * @note
   * For more info on Unicode Properties, see also http://unicode.org/reports/tr18/#Categories.
   *
   * @note
   * This method is *not* part of the officially documented API and may change or be removed in
   * the future. It is meant for userland code that wishes to reuse the (large) internal Unicode
   * structures set up by XRegExp as a single point of Unicode 'knowledge' in the application.
   *
   * See some example usage of this functionality, used as a boolean check if the given name
   * is legal and to obtain internal structural data:
   * - `function prepareMacros(...)` in https://github.com/GerHobbelt/jison-lex/blob/master/regexp-lexer.js#L885
   * - `function generateRegexesInitTableCode(...)` in https://github.com/GerHobbelt/jison-lex/blob/master/regexp-lexer.js#L1999
   *
   * Note that the second function in the example (`function generateRegexesInitTableCode(...)`)
   * uses a approach without using this API to obtain a Unicode range spanning regex for use in environments
   * which do not support XRegExp by simply expanding the XRegExp instance to a String through
   * the `map()` mapping action and subsequent `join()`.
   */


  XRegExp._getUnicodeProperty = name => {
    const slug = normalize(name);
    return unicode[slug];
  };
}; // End of module


var blocks = [{
  'name': 'InAdlam',
  'astral': '\uD83A[\uDD00-\uDD5F]'
}, {
  'name': 'InAegean_Numbers',
  'astral': '\uD800[\uDD00-\uDD3F]'
}, {
  'name': 'InAhom',
  'astral': '\uD805[\uDF00-\uDF3F]'
}, {
  'name': 'InAlchemical_Symbols',
  'astral': '\uD83D[\uDF00-\uDF7F]'
}, {
  'name': 'InAlphabetic_Presentation_Forms',
  'bmp': '\uFB00-\uFB4F'
}, {
  'name': 'InAnatolian_Hieroglyphs',
  'astral': '\uD811[\uDC00-\uDE7F]'
}, {
  'name': 'InAncient_Greek_Musical_Notation',
  'astral': '\uD834[\uDE00-\uDE4F]'
}, {
  'name': 'InAncient_Greek_Numbers',
  'astral': '\uD800[\uDD40-\uDD8F]'
}, {
  'name': 'InAncient_Symbols',
  'astral': '\uD800[\uDD90-\uDDCF]'
}, {
  'name': 'InArabic',
  'bmp': '\u0600-\u06FF'
}, {
  'name': 'InArabic_Extended_A',
  'bmp': '\u08A0-\u08FF'
}, {
  'name': 'InArabic_Mathematical_Alphabetic_Symbols',
  'astral': '\uD83B[\uDE00-\uDEFF]'
}, {
  'name': 'InArabic_Presentation_Forms_A',
  'bmp': '\uFB50-\uFDFF'
}, {
  'name': 'InArabic_Presentation_Forms_B',
  'bmp': '\uFE70-\uFEFF'
}, {
  'name': 'InArabic_Supplement',
  'bmp': '\u0750-\u077F'
}, {
  'name': 'InArmenian',
  'bmp': '\u0530-\u058F'
}, {
  'name': 'InArrows',
  'bmp': '\u2190-\u21FF'
}, {
  'name': 'InAvestan',
  'astral': '\uD802[\uDF00-\uDF3F]'
}, {
  'name': 'InBalinese',
  'bmp': '\u1B00-\u1B7F'
}, {
  'name': 'InBamum',
  'bmp': '\uA6A0-\uA6FF'
}, {
  'name': 'InBamum_Supplement',
  'astral': '\uD81A[\uDC00-\uDE3F]'
}, {
  'name': 'InBasic_Latin',
  'bmp': '\0-\x7F'
}, {
  'name': 'InBassa_Vah',
  'astral': '\uD81A[\uDED0-\uDEFF]'
}, {
  'name': 'InBatak',
  'bmp': '\u1BC0-\u1BFF'
}, {
  'name': 'InBengali',
  'bmp': '\u0980-\u09FF'
}, {
  'name': 'InBhaiksuki',
  'astral': '\uD807[\uDC00-\uDC6F]'
}, {
  'name': 'InBlock_Elements',
  'bmp': '\u2580-\u259F'
}, {
  'name': 'InBopomofo',
  'bmp': '\u3100-\u312F'
}, {
  'name': 'InBopomofo_Extended',
  'bmp': '\u31A0-\u31BF'
}, {
  'name': 'InBox_Drawing',
  'bmp': '\u2500-\u257F'
}, {
  'name': 'InBrahmi',
  'astral': '\uD804[\uDC00-\uDC7F]'
}, {
  'name': 'InBraille_Patterns',
  'bmp': '\u2800-\u28FF'
}, {
  'name': 'InBuginese',
  'bmp': '\u1A00-\u1A1F'
}, {
  'name': 'InBuhid',
  'bmp': '\u1740-\u175F'
}, {
  'name': 'InByzantine_Musical_Symbols',
  'astral': '\uD834[\uDC00-\uDCFF]'
}, {
  'name': 'InCJK_Compatibility',
  'bmp': '\u3300-\u33FF'
}, {
  'name': 'InCJK_Compatibility_Forms',
  'bmp': '\uFE30-\uFE4F'
}, {
  'name': 'InCJK_Compatibility_Ideographs',
  'bmp': '\uF900-\uFAFF'
}, {
  'name': 'InCJK_Compatibility_Ideographs_Supplement',
  'astral': '\uD87E[\uDC00-\uDE1F]'
}, {
  'name': 'InCJK_Radicals_Supplement',
  'bmp': '\u2E80-\u2EFF'
}, {
  'name': 'InCJK_Strokes',
  'bmp': '\u31C0-\u31EF'
}, {
  'name': 'InCJK_Symbols_And_Punctuation',
  'bmp': '\u3000-\u303F'
}, {
  'name': 'InCJK_Unified_Ideographs',
  'bmp': '\u4E00-\u9FFF'
}, {
  'name': 'InCJK_Unified_Ideographs_Extension_A',
  'bmp': '\u3400-\u4DBF'
}, {
  'name': 'InCJK_Unified_Ideographs_Extension_B',
  'astral': '[\uD840-\uD868][\uDC00-\uDFFF]|\uD869[\uDC00-\uDEDF]'
}, {
  'name': 'InCJK_Unified_Ideographs_Extension_C',
  'astral': '\uD869[\uDF00-\uDFFF]|[\uD86A-\uD86C][\uDC00-\uDFFF]|\uD86D[\uDC00-\uDF3F]'
}, {
  'name': 'InCJK_Unified_Ideographs_Extension_D',
  'astral': '\uD86D[\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1F]'
}, {
  'name': 'InCJK_Unified_Ideographs_Extension_E',
  'astral': '\uD86E[\uDC20-\uDFFF]|[\uD86F-\uD872][\uDC00-\uDFFF]|\uD873[\uDC00-\uDEAF]'
}, {
  'name': 'InCJK_Unified_Ideographs_Extension_F',
  'astral': '\uD873[\uDEB0-\uDFFF]|[\uD874-\uD879][\uDC00-\uDFFF]|\uD87A[\uDC00-\uDFEF]'
}, {
  'name': 'InCarian',
  'astral': '\uD800[\uDEA0-\uDEDF]'
}, {
  'name': 'InCaucasian_Albanian',
  'astral': '\uD801[\uDD30-\uDD6F]'
}, {
  'name': 'InChakma',
  'astral': '\uD804[\uDD00-\uDD4F]'
}, {
  'name': 'InCham',
  'bmp': '\uAA00-\uAA5F'
}, {
  'name': 'InCherokee',
  'bmp': '\u13A0-\u13FF'
}, {
  'name': 'InCherokee_Supplement',
  'bmp': '\uAB70-\uABBF'
}, {
  'name': 'InChess_Symbols',
  'astral': '\uD83E[\uDE00-\uDE6F]'
}, {
  'name': 'InCombining_Diacritical_Marks',
  'bmp': '\u0300-\u036F'
}, {
  'name': 'InCombining_Diacritical_Marks_Extended',
  'bmp': '\u1AB0-\u1AFF'
}, {
  'name': 'InCombining_Diacritical_Marks_For_Symbols',
  'bmp': '\u20D0-\u20FF'
}, {
  'name': 'InCombining_Diacritical_Marks_Supplement',
  'bmp': '\u1DC0-\u1DFF'
}, {
  'name': 'InCombining_Half_Marks',
  'bmp': '\uFE20-\uFE2F'
}, {
  'name': 'InCommon_Indic_Number_Forms',
  'bmp': '\uA830-\uA83F'
}, {
  'name': 'InControl_Pictures',
  'bmp': '\u2400-\u243F'
}, {
  'name': 'InCoptic',
  'bmp': '\u2C80-\u2CFF'
}, {
  'name': 'InCoptic_Epact_Numbers',
  'astral': '\uD800[\uDEE0-\uDEFF]'
}, {
  'name': 'InCounting_Rod_Numerals',
  'astral': '\uD834[\uDF60-\uDF7F]'
}, {
  'name': 'InCuneiform',
  'astral': '\uD808[\uDC00-\uDFFF]'
}, {
  'name': 'InCuneiform_Numbers_And_Punctuation',
  'astral': '\uD809[\uDC00-\uDC7F]'
}, {
  'name': 'InCurrency_Symbols',
  'bmp': '\u20A0-\u20CF'
}, {
  'name': 'InCypriot_Syllabary',
  'astral': '\uD802[\uDC00-\uDC3F]'
}, {
  'name': 'InCyrillic',
  'bmp': '\u0400-\u04FF'
}, {
  'name': 'InCyrillic_Extended_A',
  'bmp': '\u2DE0-\u2DFF'
}, {
  'name': 'InCyrillic_Extended_B',
  'bmp': '\uA640-\uA69F'
}, {
  'name': 'InCyrillic_Extended_C',
  'bmp': '\u1C80-\u1C8F'
}, {
  'name': 'InCyrillic_Supplement',
  'bmp': '\u0500-\u052F'
}, {
  'name': 'InDeseret',
  'astral': '\uD801[\uDC00-\uDC4F]'
}, {
  'name': 'InDevanagari',
  'bmp': '\u0900-\u097F'
}, {
  'name': 'InDevanagari_Extended',
  'bmp': '\uA8E0-\uA8FF'
}, {
  'name': 'InDingbats',
  'bmp': '\u2700-\u27BF'
}, {
  'name': 'InDogra',
  'astral': '\uD806[\uDC00-\uDC4F]'
}, {
  'name': 'InDomino_Tiles',
  'astral': '\uD83C[\uDC30-\uDC9F]'
}, {
  'name': 'InDuployan',
  'astral': '\uD82F[\uDC00-\uDC9F]'
}, {
  'name': 'InEarly_Dynastic_Cuneiform',
  'astral': '\uD809[\uDC80-\uDD4F]'
}, {
  'name': 'InEgyptian_Hieroglyphs',
  'astral': '\uD80C[\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2F]'
}, {
  'name': 'InElbasan',
  'astral': '\uD801[\uDD00-\uDD2F]'
}, {
  'name': 'InEmoticons',
  'astral': '\uD83D[\uDE00-\uDE4F]'
}, {
  'name': 'InEnclosed_Alphanumeric_Supplement',
  'astral': '\uD83C[\uDD00-\uDDFF]'
}, {
  'name': 'InEnclosed_Alphanumerics',
  'bmp': '\u2460-\u24FF'
}, {
  'name': 'InEnclosed_CJK_Letters_And_Months',
  'bmp': '\u3200-\u32FF'
}, {
  'name': 'InEnclosed_Ideographic_Supplement',
  'astral': '\uD83C[\uDE00-\uDEFF]'
}, {
  'name': 'InEthiopic',
  'bmp': '\u1200-\u137F'
}, {
  'name': 'InEthiopic_Extended',
  'bmp': '\u2D80-\u2DDF'
}, {
  'name': 'InEthiopic_Extended_A',
  'bmp': '\uAB00-\uAB2F'
}, {
  'name': 'InEthiopic_Supplement',
  'bmp': '\u1380-\u139F'
}, {
  'name': 'InGeneral_Punctuation',
  'bmp': '\u2000-\u206F'
}, {
  'name': 'InGeometric_Shapes',
  'bmp': '\u25A0-\u25FF'
}, {
  'name': 'InGeometric_Shapes_Extended',
  'astral': '\uD83D[\uDF80-\uDFFF]'
}, {
  'name': 'InGeorgian',
  'bmp': '\u10A0-\u10FF'
}, {
  'name': 'InGeorgian_Extended',
  'bmp': '\u1C90-\u1CBF'
}, {
  'name': 'InGeorgian_Supplement',
  'bmp': '\u2D00-\u2D2F'
}, {
  'name': 'InGlagolitic',
  'bmp': '\u2C00-\u2C5F'
}, {
  'name': 'InGlagolitic_Supplement',
  'astral': '\uD838[\uDC00-\uDC2F]'
}, {
  'name': 'InGothic',
  'astral': '\uD800[\uDF30-\uDF4F]'
}, {
  'name': 'InGrantha',
  'astral': '\uD804[\uDF00-\uDF7F]'
}, {
  'name': 'InGreek_And_Coptic',
  'bmp': '\u0370-\u03FF'
}, {
  'name': 'InGreek_Extended',
  'bmp': '\u1F00-\u1FFF'
}, {
  'name': 'InGujarati',
  'bmp': '\u0A80-\u0AFF'
}, {
  'name': 'InGunjala_Gondi',
  'astral': '\uD807[\uDD60-\uDDAF]'
}, {
  'name': 'InGurmukhi',
  'bmp': '\u0A00-\u0A7F'
}, {
  'name': 'InHalfwidth_And_Fullwidth_Forms',
  'bmp': '\uFF00-\uFFEF'
}, {
  'name': 'InHangul_Compatibility_Jamo',
  'bmp': '\u3130-\u318F'
}, {
  'name': 'InHangul_Jamo',
  'bmp': '\u1100-\u11FF'
}, {
  'name': 'InHangul_Jamo_Extended_A',
  'bmp': '\uA960-\uA97F'
}, {
  'name': 'InHangul_Jamo_Extended_B',
  'bmp': '\uD7B0-\uD7FF'
}, {
  'name': 'InHangul_Syllables',
  'bmp': '\uAC00-\uD7AF'
}, {
  'name': 'InHanifi_Rohingya',
  'astral': '\uD803[\uDD00-\uDD3F]'
}, {
  'name': 'InHanunoo',
  'bmp': '\u1720-\u173F'
}, {
  'name': 'InHatran',
  'astral': '\uD802[\uDCE0-\uDCFF]'
}, {
  'name': 'InHebrew',
  'bmp': '\u0590-\u05FF'
}, {
  'name': 'InHigh_Private_Use_Surrogates',
  'bmp': '\uDB80-\uDBFF'
}, {
  'name': 'InHigh_Surrogates',
  'bmp': '\uD800-\uDB7F'
}, {
  'name': 'InHiragana',
  'bmp': '\u3040-\u309F'
}, {
  'name': 'InIPA_Extensions',
  'bmp': '\u0250-\u02AF'
}, {
  'name': 'InIdeographic_Description_Characters',
  'bmp': '\u2FF0-\u2FFF'
}, {
  'name': 'InIdeographic_Symbols_And_Punctuation',
  'astral': '\uD81B[\uDFE0-\uDFFF]'
}, {
  'name': 'InImperial_Aramaic',
  'astral': '\uD802[\uDC40-\uDC5F]'
}, {
  'name': 'InIndic_Siyaq_Numbers',
  'astral': '\uD83B[\uDC70-\uDCBF]'
}, {
  'name': 'InInscriptional_Pahlavi',
  'astral': '\uD802[\uDF60-\uDF7F]'
}, {
  'name': 'InInscriptional_Parthian',
  'astral': '\uD802[\uDF40-\uDF5F]'
}, {
  'name': 'InJavanese',
  'bmp': '\uA980-\uA9DF'
}, {
  'name': 'InKaithi',
  'astral': '\uD804[\uDC80-\uDCCF]'
}, {
  'name': 'InKana_Extended_A',
  'astral': '\uD82C[\uDD00-\uDD2F]'
}, {
  'name': 'InKana_Supplement',
  'astral': '\uD82C[\uDC00-\uDCFF]'
}, {
  'name': 'InKanbun',
  'bmp': '\u3190-\u319F'
}, {
  'name': 'InKangxi_Radicals',
  'bmp': '\u2F00-\u2FDF'
}, {
  'name': 'InKannada',
  'bmp': '\u0C80-\u0CFF'
}, {
  'name': 'InKatakana',
  'bmp': '\u30A0-\u30FF'
}, {
  'name': 'InKatakana_Phonetic_Extensions',
  'bmp': '\u31F0-\u31FF'
}, {
  'name': 'InKayah_Li',
  'bmp': '\uA900-\uA92F'
}, {
  'name': 'InKharoshthi',
  'astral': '\uD802[\uDE00-\uDE5F]'
}, {
  'name': 'InKhmer',
  'bmp': '\u1780-\u17FF'
}, {
  'name': 'InKhmer_Symbols',
  'bmp': '\u19E0-\u19FF'
}, {
  'name': 'InKhojki',
  'astral': '\uD804[\uDE00-\uDE4F]'
}, {
  'name': 'InKhudawadi',
  'astral': '\uD804[\uDEB0-\uDEFF]'
}, {
  'name': 'InLao',
  'bmp': '\u0E80-\u0EFF'
}, {
  'name': 'InLatin_1_Supplement',
  'bmp': '\x80-\xFF'
}, {
  'name': 'InLatin_Extended_A',
  'bmp': '\u0100-\u017F'
}, {
  'name': 'InLatin_Extended_Additional',
  'bmp': '\u1E00-\u1EFF'
}, {
  'name': 'InLatin_Extended_B',
  'bmp': '\u0180-\u024F'
}, {
  'name': 'InLatin_Extended_C',
  'bmp': '\u2C60-\u2C7F'
}, {
  'name': 'InLatin_Extended_D',
  'bmp': '\uA720-\uA7FF'
}, {
  'name': 'InLatin_Extended_E',
  'bmp': '\uAB30-\uAB6F'
}, {
  'name': 'InLepcha',
  'bmp': '\u1C00-\u1C4F'
}, {
  'name': 'InLetterlike_Symbols',
  'bmp': '\u2100-\u214F'
}, {
  'name': 'InLimbu',
  'bmp': '\u1900-\u194F'
}, {
  'name': 'InLinear_A',
  'astral': '\uD801[\uDE00-\uDF7F]'
}, {
  'name': 'InLinear_B_Ideograms',
  'astral': '\uD800[\uDC80-\uDCFF]'
}, {
  'name': 'InLinear_B_Syllabary',
  'astral': '\uD800[\uDC00-\uDC7F]'
}, {
  'name': 'InLisu',
  'bmp': '\uA4D0-\uA4FF'
}, {
  'name': 'InLow_Surrogates',
  'bmp': '\uDC00-\uDFFF'
}, {
  'name': 'InLycian',
  'astral': '\uD800[\uDE80-\uDE9F]'
}, {
  'name': 'InLydian',
  'astral': '\uD802[\uDD20-\uDD3F]'
}, {
  'name': 'InMahajani',
  'astral': '\uD804[\uDD50-\uDD7F]'
}, {
  'name': 'InMahjong_Tiles',
  'astral': '\uD83C[\uDC00-\uDC2F]'
}, {
  'name': 'InMakasar',
  'astral': '\uD807[\uDEE0-\uDEFF]'
}, {
  'name': 'InMalayalam',
  'bmp': '\u0D00-\u0D7F'
}, {
  'name': 'InMandaic',
  'bmp': '\u0840-\u085F'
}, {
  'name': 'InManichaean',
  'astral': '\uD802[\uDEC0-\uDEFF]'
}, {
  'name': 'InMarchen',
  'astral': '\uD807[\uDC70-\uDCBF]'
}, {
  'name': 'InMasaram_Gondi',
  'astral': '\uD807[\uDD00-\uDD5F]'
}, {
  'name': 'InMathematical_Alphanumeric_Symbols',
  'astral': '\uD835[\uDC00-\uDFFF]'
}, {
  'name': 'InMathematical_Operators',
  'bmp': '\u2200-\u22FF'
}, {
  'name': 'InMayan_Numerals',
  'astral': '\uD834[\uDEE0-\uDEFF]'
}, {
  'name': 'InMedefaidrin',
  'astral': '\uD81B[\uDE40-\uDE9F]'
}, {
  'name': 'InMeetei_Mayek',
  'bmp': '\uABC0-\uABFF'
}, {
  'name': 'InMeetei_Mayek_Extensions',
  'bmp': '\uAAE0-\uAAFF'
}, {
  'name': 'InMende_Kikakui',
  'astral': '\uD83A[\uDC00-\uDCDF]'
}, {
  'name': 'InMeroitic_Cursive',
  'astral': '\uD802[\uDDA0-\uDDFF]'
}, {
  'name': 'InMeroitic_Hieroglyphs',
  'astral': '\uD802[\uDD80-\uDD9F]'
}, {
  'name': 'InMiao',
  'astral': '\uD81B[\uDF00-\uDF9F]'
}, {
  'name': 'InMiscellaneous_Mathematical_Symbols_A',
  'bmp': '\u27C0-\u27EF'
}, {
  'name': 'InMiscellaneous_Mathematical_Symbols_B',
  'bmp': '\u2980-\u29FF'
}, {
  'name': 'InMiscellaneous_Symbols',
  'bmp': '\u2600-\u26FF'
}, {
  'name': 'InMiscellaneous_Symbols_And_Arrows',
  'bmp': '\u2B00-\u2BFF'
}, {
  'name': 'InMiscellaneous_Symbols_And_Pictographs',
  'astral': '\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDDFF]'
}, {
  'name': 'InMiscellaneous_Technical',
  'bmp': '\u2300-\u23FF'
}, {
  'name': 'InModi',
  'astral': '\uD805[\uDE00-\uDE5F]'
}, {
  'name': 'InModifier_Tone_Letters',
  'bmp': '\uA700-\uA71F'
}, {
  'name': 'InMongolian',
  'bmp': '\u1800-\u18AF'
}, {
  'name': 'InMongolian_Supplement',
  'astral': '\uD805[\uDE60-\uDE7F]'
}, {
  'name': 'InMro',
  'astral': '\uD81A[\uDE40-\uDE6F]'
}, {
  'name': 'InMultani',
  'astral': '\uD804[\uDE80-\uDEAF]'
}, {
  'name': 'InMusical_Symbols',
  'astral': '\uD834[\uDD00-\uDDFF]'
}, {
  'name': 'InMyanmar',
  'bmp': '\u1000-\u109F'
}, {
  'name': 'InMyanmar_Extended_A',
  'bmp': '\uAA60-\uAA7F'
}, {
  'name': 'InMyanmar_Extended_B',
  'bmp': '\uA9E0-\uA9FF'
}, {
  'name': 'InNKo',
  'bmp': '\u07C0-\u07FF'
}, {
  'name': 'InNabataean',
  'astral': '\uD802[\uDC80-\uDCAF]'
}, {
  'name': 'InNew_Tai_Lue',
  'bmp': '\u1980-\u19DF'
}, {
  'name': 'InNewa',
  'astral': '\uD805[\uDC00-\uDC7F]'
}, {
  'name': 'InNumber_Forms',
  'bmp': '\u2150-\u218F'
}, {
  'name': 'InNushu',
  'astral': '\uD82C[\uDD70-\uDEFF]'
}, {
  'name': 'InOgham',
  'bmp': '\u1680-\u169F'
}, {
  'name': 'InOl_Chiki',
  'bmp': '\u1C50-\u1C7F'
}, {
  'name': 'InOld_Hungarian',
  'astral': '\uD803[\uDC80-\uDCFF]'
}, {
  'name': 'InOld_Italic',
  'astral': '\uD800[\uDF00-\uDF2F]'
}, {
  'name': 'InOld_North_Arabian',
  'astral': '\uD802[\uDE80-\uDE9F]'
}, {
  'name': 'InOld_Permic',
  'astral': '\uD800[\uDF50-\uDF7F]'
}, {
  'name': 'InOld_Persian',
  'astral': '\uD800[\uDFA0-\uDFDF]'
}, {
  'name': 'InOld_Sogdian',
  'astral': '\uD803[\uDF00-\uDF2F]'
}, {
  'name': 'InOld_South_Arabian',
  'astral': '\uD802[\uDE60-\uDE7F]'
}, {
  'name': 'InOld_Turkic',
  'astral': '\uD803[\uDC00-\uDC4F]'
}, {
  'name': 'InOptical_Character_Recognition',
  'bmp': '\u2440-\u245F'
}, {
  'name': 'InOriya',
  'bmp': '\u0B00-\u0B7F'
}, {
  'name': 'InOrnamental_Dingbats',
  'astral': '\uD83D[\uDE50-\uDE7F]'
}, {
  'name': 'InOsage',
  'astral': '\uD801[\uDCB0-\uDCFF]'
}, {
  'name': 'InOsmanya',
  'astral': '\uD801[\uDC80-\uDCAF]'
}, {
  'name': 'InPahawh_Hmong',
  'astral': '\uD81A[\uDF00-\uDF8F]'
}, {
  'name': 'InPalmyrene',
  'astral': '\uD802[\uDC60-\uDC7F]'
}, {
  'name': 'InPau_Cin_Hau',
  'astral': '\uD806[\uDEC0-\uDEFF]'
}, {
  'name': 'InPhags_Pa',
  'bmp': '\uA840-\uA87F'
}, {
  'name': 'InPhaistos_Disc',
  'astral': '\uD800[\uDDD0-\uDDFF]'
}, {
  'name': 'InPhoenician',
  'astral': '\uD802[\uDD00-\uDD1F]'
}, {
  'name': 'InPhonetic_Extensions',
  'bmp': '\u1D00-\u1D7F'
}, {
  'name': 'InPhonetic_Extensions_Supplement',
  'bmp': '\u1D80-\u1DBF'
}, {
  'name': 'InPlaying_Cards',
  'astral': '\uD83C[\uDCA0-\uDCFF]'
}, {
  'name': 'InPrivate_Use_Area',
  'bmp': '\uE000-\uF8FF'
}, {
  'name': 'InPsalter_Pahlavi',
  'astral': '\uD802[\uDF80-\uDFAF]'
}, {
  'name': 'InRejang',
  'bmp': '\uA930-\uA95F'
}, {
  'name': 'InRumi_Numeral_Symbols',
  'astral': '\uD803[\uDE60-\uDE7F]'
}, {
  'name': 'InRunic',
  'bmp': '\u16A0-\u16FF'
}, {
  'name': 'InSamaritan',
  'bmp': '\u0800-\u083F'
}, {
  'name': 'InSaurashtra',
  'bmp': '\uA880-\uA8DF'
}, {
  'name': 'InSharada',
  'astral': '\uD804[\uDD80-\uDDDF]'
}, {
  'name': 'InShavian',
  'astral': '\uD801[\uDC50-\uDC7F]'
}, {
  'name': 'InShorthand_Format_Controls',
  'astral': '\uD82F[\uDCA0-\uDCAF]'
}, {
  'name': 'InSiddham',
  'astral': '\uD805[\uDD80-\uDDFF]'
}, {
  'name': 'InSinhala',
  'bmp': '\u0D80-\u0DFF'
}, {
  'name': 'InSinhala_Archaic_Numbers',
  'astral': '\uD804[\uDDE0-\uDDFF]'
}, {
  'name': 'InSmall_Form_Variants',
  'bmp': '\uFE50-\uFE6F'
}, {
  'name': 'InSogdian',
  'astral': '\uD803[\uDF30-\uDF6F]'
}, {
  'name': 'InSora_Sompeng',
  'astral': '\uD804[\uDCD0-\uDCFF]'
}, {
  'name': 'InSoyombo',
  'astral': '\uD806[\uDE50-\uDEAF]'
}, {
  'name': 'InSpacing_Modifier_Letters',
  'bmp': '\u02B0-\u02FF'
}, {
  'name': 'InSpecials',
  'bmp': '\uFFF0-\uFFFF'
}, {
  'name': 'InSundanese',
  'bmp': '\u1B80-\u1BBF'
}, {
  'name': 'InSundanese_Supplement',
  'bmp': '\u1CC0-\u1CCF'
}, {
  'name': 'InSuperscripts_And_Subscripts',
  'bmp': '\u2070-\u209F'
}, {
  'name': 'InSupplemental_Arrows_A',
  'bmp': '\u27F0-\u27FF'
}, {
  'name': 'InSupplemental_Arrows_B',
  'bmp': '\u2900-\u297F'
}, {
  'name': 'InSupplemental_Arrows_C',
  'astral': '\uD83E[\uDC00-\uDCFF]'
}, {
  'name': 'InSupplemental_Mathematical_Operators',
  'bmp': '\u2A00-\u2AFF'
}, {
  'name': 'InSupplemental_Punctuation',
  'bmp': '\u2E00-\u2E7F'
}, {
  'name': 'InSupplemental_Symbols_And_Pictographs',
  'astral': '\uD83E[\uDD00-\uDDFF]'
}, {
  'name': 'InSupplementary_Private_Use_Area_A',
  'astral': '[\uDB80-\uDBBF][\uDC00-\uDFFF]'
}, {
  'name': 'InSupplementary_Private_Use_Area_B',
  'astral': '[\uDBC0-\uDBFF][\uDC00-\uDFFF]'
}, {
  'name': 'InSutton_SignWriting',
  'astral': '\uD836[\uDC00-\uDEAF]'
}, {
  'name': 'InSyloti_Nagri',
  'bmp': '\uA800-\uA82F'
}, {
  'name': 'InSyriac',
  'bmp': '\u0700-\u074F'
}, {
  'name': 'InSyriac_Supplement',
  'bmp': '\u0860-\u086F'
}, {
  'name': 'InTagalog',
  'bmp': '\u1700-\u171F'
}, {
  'name': 'InTagbanwa',
  'bmp': '\u1760-\u177F'
}, {
  'name': 'InTags',
  'astral': '\uDB40[\uDC00-\uDC7F]'
}, {
  'name': 'InTai_Le',
  'bmp': '\u1950-\u197F'
}, {
  'name': 'InTai_Tham',
  'bmp': '\u1A20-\u1AAF'
}, {
  'name': 'InTai_Viet',
  'bmp': '\uAA80-\uAADF'
}, {
  'name': 'InTai_Xuan_Jing_Symbols',
  'astral': '\uD834[\uDF00-\uDF5F]'
}, {
  'name': 'InTakri',
  'astral': '\uD805[\uDE80-\uDECF]'
}, {
  'name': 'InTamil',
  'bmp': '\u0B80-\u0BFF'
}, {
  'name': 'InTangut',
  'astral': '[\uD81C-\uD821][\uDC00-\uDFFF]'
}, {
  'name': 'InTangut_Components',
  'astral': '\uD822[\uDC00-\uDEFF]'
}, {
  'name': 'InTelugu',
  'bmp': '\u0C00-\u0C7F'
}, {
  'name': 'InThaana',
  'bmp': '\u0780-\u07BF'
}, {
  'name': 'InThai',
  'bmp': '\u0E00-\u0E7F'
}, {
  'name': 'InTibetan',
  'bmp': '\u0F00-\u0FFF'
}, {
  'name': 'InTifinagh',
  'bmp': '\u2D30-\u2D7F'
}, {
  'name': 'InTirhuta',
  'astral': '\uD805[\uDC80-\uDCDF]'
}, {
  'name': 'InTransport_And_Map_Symbols',
  'astral': '\uD83D[\uDE80-\uDEFF]'
}, {
  'name': 'InUgaritic',
  'astral': '\uD800[\uDF80-\uDF9F]'
}, {
  'name': 'InUnified_Canadian_Aboriginal_Syllabics',
  'bmp': '\u1400-\u167F'
}, {
  'name': 'InUnified_Canadian_Aboriginal_Syllabics_Extended',
  'bmp': '\u18B0-\u18FF'
}, {
  'name': 'InVai',
  'bmp': '\uA500-\uA63F'
}, {
  'name': 'InVariation_Selectors',
  'bmp': '\uFE00-\uFE0F'
}, {
  'name': 'InVariation_Selectors_Supplement',
  'astral': '\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'InVedic_Extensions',
  'bmp': '\u1CD0-\u1CFF'
}, {
  'name': 'InVertical_Forms',
  'bmp': '\uFE10-\uFE1F'
}, {
  'name': 'InWarang_Citi',
  'astral': '\uD806[\uDCA0-\uDCFF]'
}, {
  'name': 'InYi_Radicals',
  'bmp': '\uA490-\uA4CF'
}, {
  'name': 'InYi_Syllables',
  'bmp': '\uA000-\uA48F'
}, {
  'name': 'InYijing_Hexagram_Symbols',
  'bmp': '\u4DC0-\u4DFF'
}, {
  'name': 'InZanabazar_Square',
  'astral': '\uD806[\uDE00-\uDE4F]'
}];
/*!
 * XRegExp Unicode Blocks
 * <xregexp.com>
 * Steven Levithan (c) 2010-present MIT License
 * Unicode data by Mathias Bynens <mathiasbynens.be>
 */

var unicodeBlocks = XRegExp => {
  /**
   * Adds support for all Unicode blocks. Block names use the prefix 'In'. E.g.,
   * `\p{InBasicLatin}`. Token names are case insensitive, and any spaces, hyphens, and
   * underscores are ignored.
   *
   * Uses Unicode 11.0.0.
   *
   * @requires XRegExp, Unicode Base
   */
  if (!XRegExp.addUnicodeData) {
    throw new ReferenceError('Unicode Base must be loaded before Unicode Blocks');
  }

  XRegExp.addUnicodeData(blocks);
}; // End of module


var categories = [{
  'name': 'C',
  'alias': 'Other',
  'isBmpLast': true,
  'bmp': '\0-\x1F\x7F-\x9F\xAD\u0378\u0379\u0380-\u0383\u038B\u038D\u03A2\u0530\u0557\u0558\u058B\u058C\u0590\u05C8-\u05CF\u05EB-\u05EE\u05F5-\u0605\u061C\u061D\u06DD\u070E\u070F\u074B\u074C\u07B2-\u07BF\u07FB\u07FC\u082E\u082F\u083F\u085C\u085D\u085F\u086B-\u089F\u08B5\u08BE-\u08D2\u08E2\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09FF\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A77-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF2-\u0AF8\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B55\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B78-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BFB-\u0BFF\u0C0D\u0C11\u0C29\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5B-\u0C5F\u0C64\u0C65\u0C70-\u0C77\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0CFF\u0D04\u0D0D\u0D11\u0D45\u0D49\u0D50-\u0D53\u0D64\u0D65\u0D80\u0D81\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DE5\u0DF0\u0DF1\u0DF5-\u0E00\u0E3B-\u0E3E\u0E5C-\u0E80\u0E83\u0E85\u0E86\u0E89\u0E8B\u0E8C\u0E8E-\u0E93\u0E98\u0EA0\u0EA4\u0EA6\u0EA8\u0EA9\u0EAC\u0EBA\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F48\u0F6D-\u0F70\u0F98\u0FBD\u0FCD\u0FDB-\u0FFF\u10C6\u10C8-\u10CC\u10CE\u10CF\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u137D-\u137F\u139A-\u139F\u13F6\u13F7\u13FE\u13FF\u169D-\u169F\u16F9-\u16FF\u170D\u1715-\u171F\u1737-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17DE\u17DF\u17EA-\u17EF\u17FA-\u17FF\u180E\u180F\u181A-\u181F\u1879-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191F\u192C-\u192F\u193C-\u193F\u1941-\u1943\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DB-\u19DD\u1A1C\u1A1D\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1A9F\u1AAE\u1AAF\u1ABF-\u1AFF\u1B4C-\u1B4F\u1B7D-\u1B7F\u1BF4-\u1BFB\u1C38-\u1C3A\u1C4A-\u1C4C\u1C89-\u1C8F\u1CBB\u1CBC\u1CC8-\u1CCF\u1CFA-\u1CFF\u1DFA\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FC5\u1FD4\u1FD5\u1FDC\u1FF0\u1FF1\u1FF5\u1FFF\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2072\u2073\u208F\u209D-\u209F\u20C0-\u20CF\u20F1-\u20FF\u218C-\u218F\u2427-\u243F\u244B-\u245F\u2B74\u2B75\u2B96\u2B97\u2BC9\u2BFF\u2C2F\u2C5F\u2CF4-\u2CF8\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D71-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E4F-\u2E7F\u2E9A\u2EF4-\u2EFF\u2FD6-\u2FEF\u2FFC-\u2FFF\u3040\u3097\u3098\u3100-\u3104\u3130\u318F\u31BB-\u31BF\u31E4-\u31EF\u321F\u32FF\u4DB6-\u4DBF\u9FF0-\u9FFF\uA48D-\uA48F\uA4C7-\uA4CF\uA62C-\uA63F\uA6F8-\uA6FF\uA7BA-\uA7F6\uA82C-\uA82F\uA83A-\uA83F\uA878-\uA87F\uA8C6-\uA8CD\uA8DA-\uA8DF\uA954-\uA95E\uA97D-\uA97F\uA9CE\uA9DA-\uA9DD\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A\uAA5B\uAAC3-\uAADA\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F\uAB66-\uAB6F\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uF8FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBC2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFE\uFDFF\uFE1A-\uFE1F\uFE53\uFE67\uFE6C-\uFE6F\uFE75\uFEFD-\uFF00\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFDF\uFFE7\uFFEF-\uFFFB\uFFFE\uFFFF',
  'astral': '\uD800[\uDC0C\uDC27\uDC3B\uDC3E\uDC4E\uDC4F\uDC5E-\uDC7F\uDCFB-\uDCFF\uDD03-\uDD06\uDD34-\uDD36\uDD8F\uDD9C-\uDD9F\uDDA1-\uDDCF\uDDFE-\uDE7F\uDE9D-\uDE9F\uDED1-\uDEDF\uDEFC-\uDEFF\uDF24-\uDF2C\uDF4B-\uDF4F\uDF7B-\uDF7F\uDF9E\uDFC4-\uDFC7\uDFD6-\uDFFF]|\uD801[\uDC9E\uDC9F\uDCAA-\uDCAF\uDCD4-\uDCD7\uDCFC-\uDCFF\uDD28-\uDD2F\uDD64-\uDD6E\uDD70-\uDDFF\uDF37-\uDF3F\uDF56-\uDF5F\uDF68-\uDFFF]|\uD802[\uDC06\uDC07\uDC09\uDC36\uDC39-\uDC3B\uDC3D\uDC3E\uDC56\uDC9F-\uDCA6\uDCB0-\uDCDF\uDCF3\uDCF6-\uDCFA\uDD1C-\uDD1E\uDD3A-\uDD3E\uDD40-\uDD7F\uDDB8-\uDDBB\uDDD0\uDDD1\uDE04\uDE07-\uDE0B\uDE14\uDE18\uDE36\uDE37\uDE3B-\uDE3E\uDE49-\uDE4F\uDE59-\uDE5F\uDEA0-\uDEBF\uDEE7-\uDEEA\uDEF7-\uDEFF\uDF36-\uDF38\uDF56\uDF57\uDF73-\uDF77\uDF92-\uDF98\uDF9D-\uDFA8\uDFB0-\uDFFF]|\uD803[\uDC49-\uDC7F\uDCB3-\uDCBF\uDCF3-\uDCF9\uDD28-\uDD2F\uDD3A-\uDE5F\uDE7F-\uDEFF\uDF28-\uDF2F\uDF5A-\uDFFF]|\uD804[\uDC4E-\uDC51\uDC70-\uDC7E\uDCBD\uDCC2-\uDCCF\uDCE9-\uDCEF\uDCFA-\uDCFF\uDD35\uDD47-\uDD4F\uDD77-\uDD7F\uDDCE\uDDCF\uDDE0\uDDF5-\uDDFF\uDE12\uDE3F-\uDE7F\uDE87\uDE89\uDE8E\uDE9E\uDEAA-\uDEAF\uDEEB-\uDEEF\uDEFA-\uDEFF\uDF04\uDF0D\uDF0E\uDF11\uDF12\uDF29\uDF31\uDF34\uDF3A\uDF45\uDF46\uDF49\uDF4A\uDF4E\uDF4F\uDF51-\uDF56\uDF58-\uDF5C\uDF64\uDF65\uDF6D-\uDF6F\uDF75-\uDFFF]|\uD805[\uDC5A\uDC5C\uDC5F-\uDC7F\uDCC8-\uDCCF\uDCDA-\uDD7F\uDDB6\uDDB7\uDDDE-\uDDFF\uDE45-\uDE4F\uDE5A-\uDE5F\uDE6D-\uDE7F\uDEB8-\uDEBF\uDECA-\uDEFF\uDF1B\uDF1C\uDF2C-\uDF2F\uDF40-\uDFFF]|\uD806[\uDC3C-\uDC9F\uDCF3-\uDCFE\uDD00-\uDDFF\uDE48-\uDE4F\uDE84\uDE85\uDEA3-\uDEBF\uDEF9-\uDFFF]|\uD807[\uDC09\uDC37\uDC46-\uDC4F\uDC6D-\uDC6F\uDC90\uDC91\uDCA8\uDCB7-\uDCFF\uDD07\uDD0A\uDD37-\uDD39\uDD3B\uDD3E\uDD48-\uDD4F\uDD5A-\uDD5F\uDD66\uDD69\uDD8F\uDD92\uDD99-\uDD9F\uDDAA-\uDEDF\uDEF9-\uDFFF]|\uD808[\uDF9A-\uDFFF]|\uD809[\uDC6F\uDC75-\uDC7F\uDD44-\uDFFF]|[\uD80A\uD80B\uD80E-\uD810\uD812-\uD819\uD823-\uD82B\uD82D\uD82E\uD830-\uD833\uD837\uD839\uD83F\uD87B-\uD87D\uD87F-\uDB3F\uDB41-\uDBFF][\uDC00-\uDFFF]|\uD80D[\uDC2F-\uDFFF]|\uD811[\uDE47-\uDFFF]|\uD81A[\uDE39-\uDE3F\uDE5F\uDE6A-\uDE6D\uDE70-\uDECF\uDEEE\uDEEF\uDEF6-\uDEFF\uDF46-\uDF4F\uDF5A\uDF62\uDF78-\uDF7C\uDF90-\uDFFF]|\uD81B[\uDC00-\uDE3F\uDE9B-\uDEFF\uDF45-\uDF4F\uDF7F-\uDF8E\uDFA0-\uDFDF\uDFE2-\uDFFF]|\uD821[\uDFF2-\uDFFF]|\uD822[\uDEF3-\uDFFF]|\uD82C[\uDD1F-\uDD6F\uDEFC-\uDFFF]|\uD82F[\uDC6B-\uDC6F\uDC7D-\uDC7F\uDC89-\uDC8F\uDC9A\uDC9B\uDCA0-\uDFFF]|\uD834[\uDCF6-\uDCFF\uDD27\uDD28\uDD73-\uDD7A\uDDE9-\uDDFF\uDE46-\uDEDF\uDEF4-\uDEFF\uDF57-\uDF5F\uDF79-\uDFFF]|\uD835[\uDC55\uDC9D\uDCA0\uDCA1\uDCA3\uDCA4\uDCA7\uDCA8\uDCAD\uDCBA\uDCBC\uDCC4\uDD06\uDD0B\uDD0C\uDD15\uDD1D\uDD3A\uDD3F\uDD45\uDD47-\uDD49\uDD51\uDEA6\uDEA7\uDFCC\uDFCD]|\uD836[\uDE8C-\uDE9A\uDEA0\uDEB0-\uDFFF]|\uD838[\uDC07\uDC19\uDC1A\uDC22\uDC25\uDC2B-\uDFFF]|\uD83A[\uDCC5\uDCC6\uDCD7-\uDCFF\uDD4B-\uDD4F\uDD5A-\uDD5D\uDD60-\uDFFF]|\uD83B[\uDC00-\uDC70\uDCB5-\uDDFF\uDE04\uDE20\uDE23\uDE25\uDE26\uDE28\uDE33\uDE38\uDE3A\uDE3C-\uDE41\uDE43-\uDE46\uDE48\uDE4A\uDE4C\uDE50\uDE53\uDE55\uDE56\uDE58\uDE5A\uDE5C\uDE5E\uDE60\uDE63\uDE65\uDE66\uDE6B\uDE73\uDE78\uDE7D\uDE7F\uDE8A\uDE9C-\uDEA0\uDEA4\uDEAA\uDEBC-\uDEEF\uDEF2-\uDFFF]|\uD83C[\uDC2C-\uDC2F\uDC94-\uDC9F\uDCAF\uDCB0\uDCC0\uDCD0\uDCF6-\uDCFF\uDD0D-\uDD0F\uDD6C-\uDD6F\uDDAD-\uDDE5\uDE03-\uDE0F\uDE3C-\uDE3F\uDE49-\uDE4F\uDE52-\uDE5F\uDE66-\uDEFF]|\uD83D[\uDED5-\uDEDF\uDEED-\uDEEF\uDEFA-\uDEFF\uDF74-\uDF7F\uDFD9-\uDFFF]|\uD83E[\uDC0C-\uDC0F\uDC48-\uDC4F\uDC5A-\uDC5F\uDC88-\uDC8F\uDCAE-\uDCFF\uDD0C-\uDD0F\uDD3F\uDD71\uDD72\uDD77-\uDD79\uDD7B\uDDA3-\uDDAF\uDDBA-\uDDBF\uDDC3-\uDDCF\uDE00-\uDE5F\uDE6E-\uDFFF]|\uD869[\uDED7-\uDEFF]|\uD86D[\uDF35-\uDF3F]|\uD86E[\uDC1E\uDC1F]|\uD873[\uDEA2-\uDEAF]|\uD87A[\uDFE1-\uDFFF]|\uD87E[\uDE1E-\uDFFF]|\uDB40[\uDC00-\uDCFF\uDDF0-\uDFFF]'
}, {
  'name': 'Cc',
  'alias': 'Control',
  'bmp': '\0-\x1F\x7F-\x9F'
}, {
  'name': 'Cf',
  'alias': 'Format',
  'bmp': '\xAD\u0600-\u0605\u061C\u06DD\u070F\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB',
  'astral': '\uD804[\uDCBD\uDCCD]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]'
}, {
  'name': 'Cn',
  'alias': 'Unassigned',
  'bmp': '\u0378\u0379\u0380-\u0383\u038B\u038D\u03A2\u0530\u0557\u0558\u058B\u058C\u0590\u05C8-\u05CF\u05EB-\u05EE\u05F5-\u05FF\u061D\u070E\u074B\u074C\u07B2-\u07BF\u07FB\u07FC\u082E\u082F\u083F\u085C\u085D\u085F\u086B-\u089F\u08B5\u08BE-\u08D2\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09FF\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A77-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF2-\u0AF8\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B55\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B78-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BFB-\u0BFF\u0C0D\u0C11\u0C29\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5B-\u0C5F\u0C64\u0C65\u0C70-\u0C77\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0CFF\u0D04\u0D0D\u0D11\u0D45\u0D49\u0D50-\u0D53\u0D64\u0D65\u0D80\u0D81\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DE5\u0DF0\u0DF1\u0DF5-\u0E00\u0E3B-\u0E3E\u0E5C-\u0E80\u0E83\u0E85\u0E86\u0E89\u0E8B\u0E8C\u0E8E-\u0E93\u0E98\u0EA0\u0EA4\u0EA6\u0EA8\u0EA9\u0EAC\u0EBA\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F48\u0F6D-\u0F70\u0F98\u0FBD\u0FCD\u0FDB-\u0FFF\u10C6\u10C8-\u10CC\u10CE\u10CF\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u137D-\u137F\u139A-\u139F\u13F6\u13F7\u13FE\u13FF\u169D-\u169F\u16F9-\u16FF\u170D\u1715-\u171F\u1737-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17DE\u17DF\u17EA-\u17EF\u17FA-\u17FF\u180F\u181A-\u181F\u1879-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191F\u192C-\u192F\u193C-\u193F\u1941-\u1943\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DB-\u19DD\u1A1C\u1A1D\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1A9F\u1AAE\u1AAF\u1ABF-\u1AFF\u1B4C-\u1B4F\u1B7D-\u1B7F\u1BF4-\u1BFB\u1C38-\u1C3A\u1C4A-\u1C4C\u1C89-\u1C8F\u1CBB\u1CBC\u1CC8-\u1CCF\u1CFA-\u1CFF\u1DFA\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FC5\u1FD4\u1FD5\u1FDC\u1FF0\u1FF1\u1FF5\u1FFF\u2065\u2072\u2073\u208F\u209D-\u209F\u20C0-\u20CF\u20F1-\u20FF\u218C-\u218F\u2427-\u243F\u244B-\u245F\u2B74\u2B75\u2B96\u2B97\u2BC9\u2BFF\u2C2F\u2C5F\u2CF4-\u2CF8\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D71-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E4F-\u2E7F\u2E9A\u2EF4-\u2EFF\u2FD6-\u2FEF\u2FFC-\u2FFF\u3040\u3097\u3098\u3100-\u3104\u3130\u318F\u31BB-\u31BF\u31E4-\u31EF\u321F\u32FF\u4DB6-\u4DBF\u9FF0-\u9FFF\uA48D-\uA48F\uA4C7-\uA4CF\uA62C-\uA63F\uA6F8-\uA6FF\uA7BA-\uA7F6\uA82C-\uA82F\uA83A-\uA83F\uA878-\uA87F\uA8C6-\uA8CD\uA8DA-\uA8DF\uA954-\uA95E\uA97D-\uA97F\uA9CE\uA9DA-\uA9DD\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A\uAA5B\uAAC3-\uAADA\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F\uAB66-\uAB6F\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uD7FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBC2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFE\uFDFF\uFE1A-\uFE1F\uFE53\uFE67\uFE6C-\uFE6F\uFE75\uFEFD\uFEFE\uFF00\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFDF\uFFE7\uFFEF-\uFFF8\uFFFE\uFFFF',
  'astral': '\uD800[\uDC0C\uDC27\uDC3B\uDC3E\uDC4E\uDC4F\uDC5E-\uDC7F\uDCFB-\uDCFF\uDD03-\uDD06\uDD34-\uDD36\uDD8F\uDD9C-\uDD9F\uDDA1-\uDDCF\uDDFE-\uDE7F\uDE9D-\uDE9F\uDED1-\uDEDF\uDEFC-\uDEFF\uDF24-\uDF2C\uDF4B-\uDF4F\uDF7B-\uDF7F\uDF9E\uDFC4-\uDFC7\uDFD6-\uDFFF]|\uD801[\uDC9E\uDC9F\uDCAA-\uDCAF\uDCD4-\uDCD7\uDCFC-\uDCFF\uDD28-\uDD2F\uDD64-\uDD6E\uDD70-\uDDFF\uDF37-\uDF3F\uDF56-\uDF5F\uDF68-\uDFFF]|\uD802[\uDC06\uDC07\uDC09\uDC36\uDC39-\uDC3B\uDC3D\uDC3E\uDC56\uDC9F-\uDCA6\uDCB0-\uDCDF\uDCF3\uDCF6-\uDCFA\uDD1C-\uDD1E\uDD3A-\uDD3E\uDD40-\uDD7F\uDDB8-\uDDBB\uDDD0\uDDD1\uDE04\uDE07-\uDE0B\uDE14\uDE18\uDE36\uDE37\uDE3B-\uDE3E\uDE49-\uDE4F\uDE59-\uDE5F\uDEA0-\uDEBF\uDEE7-\uDEEA\uDEF7-\uDEFF\uDF36-\uDF38\uDF56\uDF57\uDF73-\uDF77\uDF92-\uDF98\uDF9D-\uDFA8\uDFB0-\uDFFF]|\uD803[\uDC49-\uDC7F\uDCB3-\uDCBF\uDCF3-\uDCF9\uDD28-\uDD2F\uDD3A-\uDE5F\uDE7F-\uDEFF\uDF28-\uDF2F\uDF5A-\uDFFF]|\uD804[\uDC4E-\uDC51\uDC70-\uDC7E\uDCC2-\uDCCC\uDCCE\uDCCF\uDCE9-\uDCEF\uDCFA-\uDCFF\uDD35\uDD47-\uDD4F\uDD77-\uDD7F\uDDCE\uDDCF\uDDE0\uDDF5-\uDDFF\uDE12\uDE3F-\uDE7F\uDE87\uDE89\uDE8E\uDE9E\uDEAA-\uDEAF\uDEEB-\uDEEF\uDEFA-\uDEFF\uDF04\uDF0D\uDF0E\uDF11\uDF12\uDF29\uDF31\uDF34\uDF3A\uDF45\uDF46\uDF49\uDF4A\uDF4E\uDF4F\uDF51-\uDF56\uDF58-\uDF5C\uDF64\uDF65\uDF6D-\uDF6F\uDF75-\uDFFF]|\uD805[\uDC5A\uDC5C\uDC5F-\uDC7F\uDCC8-\uDCCF\uDCDA-\uDD7F\uDDB6\uDDB7\uDDDE-\uDDFF\uDE45-\uDE4F\uDE5A-\uDE5F\uDE6D-\uDE7F\uDEB8-\uDEBF\uDECA-\uDEFF\uDF1B\uDF1C\uDF2C-\uDF2F\uDF40-\uDFFF]|\uD806[\uDC3C-\uDC9F\uDCF3-\uDCFE\uDD00-\uDDFF\uDE48-\uDE4F\uDE84\uDE85\uDEA3-\uDEBF\uDEF9-\uDFFF]|\uD807[\uDC09\uDC37\uDC46-\uDC4F\uDC6D-\uDC6F\uDC90\uDC91\uDCA8\uDCB7-\uDCFF\uDD07\uDD0A\uDD37-\uDD39\uDD3B\uDD3E\uDD48-\uDD4F\uDD5A-\uDD5F\uDD66\uDD69\uDD8F\uDD92\uDD99-\uDD9F\uDDAA-\uDEDF\uDEF9-\uDFFF]|\uD808[\uDF9A-\uDFFF]|\uD809[\uDC6F\uDC75-\uDC7F\uDD44-\uDFFF]|[\uD80A\uD80B\uD80E-\uD810\uD812-\uD819\uD823-\uD82B\uD82D\uD82E\uD830-\uD833\uD837\uD839\uD83F\uD87B-\uD87D\uD87F-\uDB3F\uDB41-\uDB7F][\uDC00-\uDFFF]|\uD80D[\uDC2F-\uDFFF]|\uD811[\uDE47-\uDFFF]|\uD81A[\uDE39-\uDE3F\uDE5F\uDE6A-\uDE6D\uDE70-\uDECF\uDEEE\uDEEF\uDEF6-\uDEFF\uDF46-\uDF4F\uDF5A\uDF62\uDF78-\uDF7C\uDF90-\uDFFF]|\uD81B[\uDC00-\uDE3F\uDE9B-\uDEFF\uDF45-\uDF4F\uDF7F-\uDF8E\uDFA0-\uDFDF\uDFE2-\uDFFF]|\uD821[\uDFF2-\uDFFF]|\uD822[\uDEF3-\uDFFF]|\uD82C[\uDD1F-\uDD6F\uDEFC-\uDFFF]|\uD82F[\uDC6B-\uDC6F\uDC7D-\uDC7F\uDC89-\uDC8F\uDC9A\uDC9B\uDCA4-\uDFFF]|\uD834[\uDCF6-\uDCFF\uDD27\uDD28\uDDE9-\uDDFF\uDE46-\uDEDF\uDEF4-\uDEFF\uDF57-\uDF5F\uDF79-\uDFFF]|\uD835[\uDC55\uDC9D\uDCA0\uDCA1\uDCA3\uDCA4\uDCA7\uDCA8\uDCAD\uDCBA\uDCBC\uDCC4\uDD06\uDD0B\uDD0C\uDD15\uDD1D\uDD3A\uDD3F\uDD45\uDD47-\uDD49\uDD51\uDEA6\uDEA7\uDFCC\uDFCD]|\uD836[\uDE8C-\uDE9A\uDEA0\uDEB0-\uDFFF]|\uD838[\uDC07\uDC19\uDC1A\uDC22\uDC25\uDC2B-\uDFFF]|\uD83A[\uDCC5\uDCC6\uDCD7-\uDCFF\uDD4B-\uDD4F\uDD5A-\uDD5D\uDD60-\uDFFF]|\uD83B[\uDC00-\uDC70\uDCB5-\uDDFF\uDE04\uDE20\uDE23\uDE25\uDE26\uDE28\uDE33\uDE38\uDE3A\uDE3C-\uDE41\uDE43-\uDE46\uDE48\uDE4A\uDE4C\uDE50\uDE53\uDE55\uDE56\uDE58\uDE5A\uDE5C\uDE5E\uDE60\uDE63\uDE65\uDE66\uDE6B\uDE73\uDE78\uDE7D\uDE7F\uDE8A\uDE9C-\uDEA0\uDEA4\uDEAA\uDEBC-\uDEEF\uDEF2-\uDFFF]|\uD83C[\uDC2C-\uDC2F\uDC94-\uDC9F\uDCAF\uDCB0\uDCC0\uDCD0\uDCF6-\uDCFF\uDD0D-\uDD0F\uDD6C-\uDD6F\uDDAD-\uDDE5\uDE03-\uDE0F\uDE3C-\uDE3F\uDE49-\uDE4F\uDE52-\uDE5F\uDE66-\uDEFF]|\uD83D[\uDED5-\uDEDF\uDEED-\uDEEF\uDEFA-\uDEFF\uDF74-\uDF7F\uDFD9-\uDFFF]|\uD83E[\uDC0C-\uDC0F\uDC48-\uDC4F\uDC5A-\uDC5F\uDC88-\uDC8F\uDCAE-\uDCFF\uDD0C-\uDD0F\uDD3F\uDD71\uDD72\uDD77-\uDD79\uDD7B\uDDA3-\uDDAF\uDDBA-\uDDBF\uDDC3-\uDDCF\uDE00-\uDE5F\uDE6E-\uDFFF]|\uD869[\uDED7-\uDEFF]|\uD86D[\uDF35-\uDF3F]|\uD86E[\uDC1E\uDC1F]|\uD873[\uDEA2-\uDEAF]|\uD87A[\uDFE1-\uDFFF]|\uD87E[\uDE1E-\uDFFF]|\uDB40[\uDC00\uDC02-\uDC1F\uDC80-\uDCFF\uDDF0-\uDFFF]|[\uDBBF\uDBFF][\uDFFE\uDFFF]'
}, {
  'name': 'Co',
  'alias': 'Private_Use',
  'bmp': '\uE000-\uF8FF',
  'astral': '[\uDB80-\uDBBE\uDBC0-\uDBFE][\uDC00-\uDFFF]|[\uDBBF\uDBFF][\uDC00-\uDFFD]'
}, {
  'name': 'Cs',
  'alias': 'Surrogate',
  'bmp': '\uD800-\uDFFF'
}, {
  'name': 'L',
  'alias': 'Letter',
  'bmp': 'A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16F1-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005\u3006\u3031-\u3035\u303B\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6E5\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF40\uDF42-\uDF49\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD23\uDF00-\uDF1C\uDF27\uDF30-\uDF45]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD44\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF1A]|\uD806[\uDC00-\uDC2B\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD89\uDD98\uDEE0-\uDEF2]|\uD808[\uDC00-\uDF99]|\uD809[\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'LC',
  'alias': 'Cased_Letter',
  'bmp': 'A-Za-z\xB5\xC0-\xD6\xD8-\xF6\xF8-\u01BA\u01BC-\u01BF\u01C4-\u0293\u0295-\u02AF\u0370-\u0373\u0376\u0377\u037B-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0560-\u0588\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FD-\u10FF\u13A0-\u13F5\u13F8-\u13FD\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1D00-\u1D2B\u1D6B-\u1D77\u1D79-\u1D9A\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2134\u2139\u213C-\u213F\u2145-\u2149\u214E\u2183\u2184\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2C7B\u2C7E-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA640-\uA66D\uA680-\uA69B\uA722-\uA76F\uA771-\uA787\uA78B-\uA78E\uA790-\uA7B9\uA7FA\uAB30-\uAB5A\uAB60-\uAB65\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF21-\uFF3A\uFF41-\uFF5A',
  'astral': '\uD801[\uDC00-\uDC4F\uDCB0-\uDCD3\uDCD8-\uDCFB]|\uD803[\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD806[\uDCA0-\uDCDF]|\uD81B[\uDE40-\uDE7F]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDD00-\uDD43]'
}, {
  'name': 'Ll',
  'alias': 'Lowercase_Letter',
  'bmp': 'a-z\xB5\xDF-\xF6\xF8-\xFF\u0101\u0103\u0105\u0107\u0109\u010B\u010D\u010F\u0111\u0113\u0115\u0117\u0119\u011B\u011D\u011F\u0121\u0123\u0125\u0127\u0129\u012B\u012D\u012F\u0131\u0133\u0135\u0137\u0138\u013A\u013C\u013E\u0140\u0142\u0144\u0146\u0148\u0149\u014B\u014D\u014F\u0151\u0153\u0155\u0157\u0159\u015B\u015D\u015F\u0161\u0163\u0165\u0167\u0169\u016B\u016D\u016F\u0171\u0173\u0175\u0177\u017A\u017C\u017E-\u0180\u0183\u0185\u0188\u018C\u018D\u0192\u0195\u0199-\u019B\u019E\u01A1\u01A3\u01A5\u01A8\u01AA\u01AB\u01AD\u01B0\u01B4\u01B6\u01B9\u01BA\u01BD-\u01BF\u01C6\u01C9\u01CC\u01CE\u01D0\u01D2\u01D4\u01D6\u01D8\u01DA\u01DC\u01DD\u01DF\u01E1\u01E3\u01E5\u01E7\u01E9\u01EB\u01ED\u01EF\u01F0\u01F3\u01F5\u01F9\u01FB\u01FD\u01FF\u0201\u0203\u0205\u0207\u0209\u020B\u020D\u020F\u0211\u0213\u0215\u0217\u0219\u021B\u021D\u021F\u0221\u0223\u0225\u0227\u0229\u022B\u022D\u022F\u0231\u0233-\u0239\u023C\u023F\u0240\u0242\u0247\u0249\u024B\u024D\u024F-\u0293\u0295-\u02AF\u0371\u0373\u0377\u037B-\u037D\u0390\u03AC-\u03CE\u03D0\u03D1\u03D5-\u03D7\u03D9\u03DB\u03DD\u03DF\u03E1\u03E3\u03E5\u03E7\u03E9\u03EB\u03ED\u03EF-\u03F3\u03F5\u03F8\u03FB\u03FC\u0430-\u045F\u0461\u0463\u0465\u0467\u0469\u046B\u046D\u046F\u0471\u0473\u0475\u0477\u0479\u047B\u047D\u047F\u0481\u048B\u048D\u048F\u0491\u0493\u0495\u0497\u0499\u049B\u049D\u049F\u04A1\u04A3\u04A5\u04A7\u04A9\u04AB\u04AD\u04AF\u04B1\u04B3\u04B5\u04B7\u04B9\u04BB\u04BD\u04BF\u04C2\u04C4\u04C6\u04C8\u04CA\u04CC\u04CE\u04CF\u04D1\u04D3\u04D5\u04D7\u04D9\u04DB\u04DD\u04DF\u04E1\u04E3\u04E5\u04E7\u04E9\u04EB\u04ED\u04EF\u04F1\u04F3\u04F5\u04F7\u04F9\u04FB\u04FD\u04FF\u0501\u0503\u0505\u0507\u0509\u050B\u050D\u050F\u0511\u0513\u0515\u0517\u0519\u051B\u051D\u051F\u0521\u0523\u0525\u0527\u0529\u052B\u052D\u052F\u0560-\u0588\u10D0-\u10FA\u10FD-\u10FF\u13F8-\u13FD\u1C80-\u1C88\u1D00-\u1D2B\u1D6B-\u1D77\u1D79-\u1D9A\u1E01\u1E03\u1E05\u1E07\u1E09\u1E0B\u1E0D\u1E0F\u1E11\u1E13\u1E15\u1E17\u1E19\u1E1B\u1E1D\u1E1F\u1E21\u1E23\u1E25\u1E27\u1E29\u1E2B\u1E2D\u1E2F\u1E31\u1E33\u1E35\u1E37\u1E39\u1E3B\u1E3D\u1E3F\u1E41\u1E43\u1E45\u1E47\u1E49\u1E4B\u1E4D\u1E4F\u1E51\u1E53\u1E55\u1E57\u1E59\u1E5B\u1E5D\u1E5F\u1E61\u1E63\u1E65\u1E67\u1E69\u1E6B\u1E6D\u1E6F\u1E71\u1E73\u1E75\u1E77\u1E79\u1E7B\u1E7D\u1E7F\u1E81\u1E83\u1E85\u1E87\u1E89\u1E8B\u1E8D\u1E8F\u1E91\u1E93\u1E95-\u1E9D\u1E9F\u1EA1\u1EA3\u1EA5\u1EA7\u1EA9\u1EAB\u1EAD\u1EAF\u1EB1\u1EB3\u1EB5\u1EB7\u1EB9\u1EBB\u1EBD\u1EBF\u1EC1\u1EC3\u1EC5\u1EC7\u1EC9\u1ECB\u1ECD\u1ECF\u1ED1\u1ED3\u1ED5\u1ED7\u1ED9\u1EDB\u1EDD\u1EDF\u1EE1\u1EE3\u1EE5\u1EE7\u1EE9\u1EEB\u1EED\u1EEF\u1EF1\u1EF3\u1EF5\u1EF7\u1EF9\u1EFB\u1EFD\u1EFF-\u1F07\u1F10-\u1F15\u1F20-\u1F27\u1F30-\u1F37\u1F40-\u1F45\u1F50-\u1F57\u1F60-\u1F67\u1F70-\u1F7D\u1F80-\u1F87\u1F90-\u1F97\u1FA0-\u1FA7\u1FB0-\u1FB4\u1FB6\u1FB7\u1FBE\u1FC2-\u1FC4\u1FC6\u1FC7\u1FD0-\u1FD3\u1FD6\u1FD7\u1FE0-\u1FE7\u1FF2-\u1FF4\u1FF6\u1FF7\u210A\u210E\u210F\u2113\u212F\u2134\u2139\u213C\u213D\u2146-\u2149\u214E\u2184\u2C30-\u2C5E\u2C61\u2C65\u2C66\u2C68\u2C6A\u2C6C\u2C71\u2C73\u2C74\u2C76-\u2C7B\u2C81\u2C83\u2C85\u2C87\u2C89\u2C8B\u2C8D\u2C8F\u2C91\u2C93\u2C95\u2C97\u2C99\u2C9B\u2C9D\u2C9F\u2CA1\u2CA3\u2CA5\u2CA7\u2CA9\u2CAB\u2CAD\u2CAF\u2CB1\u2CB3\u2CB5\u2CB7\u2CB9\u2CBB\u2CBD\u2CBF\u2CC1\u2CC3\u2CC5\u2CC7\u2CC9\u2CCB\u2CCD\u2CCF\u2CD1\u2CD3\u2CD5\u2CD7\u2CD9\u2CDB\u2CDD\u2CDF\u2CE1\u2CE3\u2CE4\u2CEC\u2CEE\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA641\uA643\uA645\uA647\uA649\uA64B\uA64D\uA64F\uA651\uA653\uA655\uA657\uA659\uA65B\uA65D\uA65F\uA661\uA663\uA665\uA667\uA669\uA66B\uA66D\uA681\uA683\uA685\uA687\uA689\uA68B\uA68D\uA68F\uA691\uA693\uA695\uA697\uA699\uA69B\uA723\uA725\uA727\uA729\uA72B\uA72D\uA72F-\uA731\uA733\uA735\uA737\uA739\uA73B\uA73D\uA73F\uA741\uA743\uA745\uA747\uA749\uA74B\uA74D\uA74F\uA751\uA753\uA755\uA757\uA759\uA75B\uA75D\uA75F\uA761\uA763\uA765\uA767\uA769\uA76B\uA76D\uA76F\uA771-\uA778\uA77A\uA77C\uA77F\uA781\uA783\uA785\uA787\uA78C\uA78E\uA791\uA793-\uA795\uA797\uA799\uA79B\uA79D\uA79F\uA7A1\uA7A3\uA7A5\uA7A7\uA7A9\uA7AF\uA7B5\uA7B7\uA7B9\uA7FA\uAB30-\uAB5A\uAB60-\uAB65\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF41-\uFF5A',
  'astral': '\uD801[\uDC28-\uDC4F\uDCD8-\uDCFB]|\uD803[\uDCC0-\uDCF2]|\uD806[\uDCC0-\uDCDF]|\uD81B[\uDE60-\uDE7F]|\uD835[\uDC1A-\uDC33\uDC4E-\uDC54\uDC56-\uDC67\uDC82-\uDC9B\uDCB6-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDCCF\uDCEA-\uDD03\uDD1E-\uDD37\uDD52-\uDD6B\uDD86-\uDD9F\uDDBA-\uDDD3\uDDEE-\uDE07\uDE22-\uDE3B\uDE56-\uDE6F\uDE8A-\uDEA5\uDEC2-\uDEDA\uDEDC-\uDEE1\uDEFC-\uDF14\uDF16-\uDF1B\uDF36-\uDF4E\uDF50-\uDF55\uDF70-\uDF88\uDF8A-\uDF8F\uDFAA-\uDFC2\uDFC4-\uDFC9\uDFCB]|\uD83A[\uDD22-\uDD43]'
}, {
  'name': 'Lm',
  'alias': 'Modifier_Letter',
  'bmp': '\u02B0-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0374\u037A\u0559\u0640\u06E5\u06E6\u07F4\u07F5\u07FA\u081A\u0824\u0828\u0971\u0E46\u0EC6\u10FC\u17D7\u1843\u1AA7\u1C78-\u1C7D\u1D2C-\u1D6A\u1D78\u1D9B-\u1DBF\u2071\u207F\u2090-\u209C\u2C7C\u2C7D\u2D6F\u2E2F\u3005\u3031-\u3035\u303B\u309D\u309E\u30FC-\u30FE\uA015\uA4F8-\uA4FD\uA60C\uA67F\uA69C\uA69D\uA717-\uA71F\uA770\uA788\uA7F8\uA7F9\uA9CF\uA9E6\uAA70\uAADD\uAAF3\uAAF4\uAB5C-\uAB5F\uFF70\uFF9E\uFF9F',
  'astral': '\uD81A[\uDF40-\uDF43]|\uD81B[\uDF93-\uDF9F\uDFE0\uDFE1]'
}, {
  'name': 'Lo',
  'alias': 'Other_Letter',
  'bmp': '\xAA\xBA\u01BB\u01C0-\u01C3\u0294\u05D0-\u05EA\u05EF-\u05F2\u0620-\u063F\u0641-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u0800-\u0815\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0972-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E45\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u1100-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16F1-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17DC\u1820-\u1842\u1844-\u1878\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C77\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u2135-\u2138\u2D30-\u2D67\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3006\u303C\u3041-\u3096\u309F\u30A1-\u30FA\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA014\uA016-\uA48C\uA4D0-\uA4F7\uA500-\uA60B\uA610-\uA61F\uA62A\uA62B\uA66E\uA6A0-\uA6E5\uA78F\uA7F7\uA7FB-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9E0-\uA9E4\uA9E7-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA6F\uAA71-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB\uAADC\uAAE0-\uAAEA\uAAF2\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF66-\uFF6F\uFF71-\uFF9D\uFFA0-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF40\uDF42-\uDF49\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF]|\uD801[\uDC50-\uDC9D\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDD00-\uDD23\uDF00-\uDF1C\uDF27\uDF30-\uDF45]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD44\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF1A]|\uD806[\uDC00-\uDC2B\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD89\uDD98\uDEE0-\uDEF2]|\uD808[\uDC00-\uDF99]|\uD809[\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD83A[\uDC00-\uDCC4]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Lt',
  'alias': 'Titlecase_Letter',
  'bmp': '\u01C5\u01C8\u01CB\u01F2\u1F88-\u1F8F\u1F98-\u1F9F\u1FA8-\u1FAF\u1FBC\u1FCC\u1FFC'
}, {
  'name': 'Lu',
  'alias': 'Uppercase_Letter',
  'bmp': 'A-Z\xC0-\xD6\xD8-\xDE\u0100\u0102\u0104\u0106\u0108\u010A\u010C\u010E\u0110\u0112\u0114\u0116\u0118\u011A\u011C\u011E\u0120\u0122\u0124\u0126\u0128\u012A\u012C\u012E\u0130\u0132\u0134\u0136\u0139\u013B\u013D\u013F\u0141\u0143\u0145\u0147\u014A\u014C\u014E\u0150\u0152\u0154\u0156\u0158\u015A\u015C\u015E\u0160\u0162\u0164\u0166\u0168\u016A\u016C\u016E\u0170\u0172\u0174\u0176\u0178\u0179\u017B\u017D\u0181\u0182\u0184\u0186\u0187\u0189-\u018B\u018E-\u0191\u0193\u0194\u0196-\u0198\u019C\u019D\u019F\u01A0\u01A2\u01A4\u01A6\u01A7\u01A9\u01AC\u01AE\u01AF\u01B1-\u01B3\u01B5\u01B7\u01B8\u01BC\u01C4\u01C7\u01CA\u01CD\u01CF\u01D1\u01D3\u01D5\u01D7\u01D9\u01DB\u01DE\u01E0\u01E2\u01E4\u01E6\u01E8\u01EA\u01EC\u01EE\u01F1\u01F4\u01F6-\u01F8\u01FA\u01FC\u01FE\u0200\u0202\u0204\u0206\u0208\u020A\u020C\u020E\u0210\u0212\u0214\u0216\u0218\u021A\u021C\u021E\u0220\u0222\u0224\u0226\u0228\u022A\u022C\u022E\u0230\u0232\u023A\u023B\u023D\u023E\u0241\u0243-\u0246\u0248\u024A\u024C\u024E\u0370\u0372\u0376\u037F\u0386\u0388-\u038A\u038C\u038E\u038F\u0391-\u03A1\u03A3-\u03AB\u03CF\u03D2-\u03D4\u03D8\u03DA\u03DC\u03DE\u03E0\u03E2\u03E4\u03E6\u03E8\u03EA\u03EC\u03EE\u03F4\u03F7\u03F9\u03FA\u03FD-\u042F\u0460\u0462\u0464\u0466\u0468\u046A\u046C\u046E\u0470\u0472\u0474\u0476\u0478\u047A\u047C\u047E\u0480\u048A\u048C\u048E\u0490\u0492\u0494\u0496\u0498\u049A\u049C\u049E\u04A0\u04A2\u04A4\u04A6\u04A8\u04AA\u04AC\u04AE\u04B0\u04B2\u04B4\u04B6\u04B8\u04BA\u04BC\u04BE\u04C0\u04C1\u04C3\u04C5\u04C7\u04C9\u04CB\u04CD\u04D0\u04D2\u04D4\u04D6\u04D8\u04DA\u04DC\u04DE\u04E0\u04E2\u04E4\u04E6\u04E8\u04EA\u04EC\u04EE\u04F0\u04F2\u04F4\u04F6\u04F8\u04FA\u04FC\u04FE\u0500\u0502\u0504\u0506\u0508\u050A\u050C\u050E\u0510\u0512\u0514\u0516\u0518\u051A\u051C\u051E\u0520\u0522\u0524\u0526\u0528\u052A\u052C\u052E\u0531-\u0556\u10A0-\u10C5\u10C7\u10CD\u13A0-\u13F5\u1C90-\u1CBA\u1CBD-\u1CBF\u1E00\u1E02\u1E04\u1E06\u1E08\u1E0A\u1E0C\u1E0E\u1E10\u1E12\u1E14\u1E16\u1E18\u1E1A\u1E1C\u1E1E\u1E20\u1E22\u1E24\u1E26\u1E28\u1E2A\u1E2C\u1E2E\u1E30\u1E32\u1E34\u1E36\u1E38\u1E3A\u1E3C\u1E3E\u1E40\u1E42\u1E44\u1E46\u1E48\u1E4A\u1E4C\u1E4E\u1E50\u1E52\u1E54\u1E56\u1E58\u1E5A\u1E5C\u1E5E\u1E60\u1E62\u1E64\u1E66\u1E68\u1E6A\u1E6C\u1E6E\u1E70\u1E72\u1E74\u1E76\u1E78\u1E7A\u1E7C\u1E7E\u1E80\u1E82\u1E84\u1E86\u1E88\u1E8A\u1E8C\u1E8E\u1E90\u1E92\u1E94\u1E9E\u1EA0\u1EA2\u1EA4\u1EA6\u1EA8\u1EAA\u1EAC\u1EAE\u1EB0\u1EB2\u1EB4\u1EB6\u1EB8\u1EBA\u1EBC\u1EBE\u1EC0\u1EC2\u1EC4\u1EC6\u1EC8\u1ECA\u1ECC\u1ECE\u1ED0\u1ED2\u1ED4\u1ED6\u1ED8\u1EDA\u1EDC\u1EDE\u1EE0\u1EE2\u1EE4\u1EE6\u1EE8\u1EEA\u1EEC\u1EEE\u1EF0\u1EF2\u1EF4\u1EF6\u1EF8\u1EFA\u1EFC\u1EFE\u1F08-\u1F0F\u1F18-\u1F1D\u1F28-\u1F2F\u1F38-\u1F3F\u1F48-\u1F4D\u1F59\u1F5B\u1F5D\u1F5F\u1F68-\u1F6F\u1FB8-\u1FBB\u1FC8-\u1FCB\u1FD8-\u1FDB\u1FE8-\u1FEC\u1FF8-\u1FFB\u2102\u2107\u210B-\u210D\u2110-\u2112\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u2130-\u2133\u213E\u213F\u2145\u2183\u2C00-\u2C2E\u2C60\u2C62-\u2C64\u2C67\u2C69\u2C6B\u2C6D-\u2C70\u2C72\u2C75\u2C7E-\u2C80\u2C82\u2C84\u2C86\u2C88\u2C8A\u2C8C\u2C8E\u2C90\u2C92\u2C94\u2C96\u2C98\u2C9A\u2C9C\u2C9E\u2CA0\u2CA2\u2CA4\u2CA6\u2CA8\u2CAA\u2CAC\u2CAE\u2CB0\u2CB2\u2CB4\u2CB6\u2CB8\u2CBA\u2CBC\u2CBE\u2CC0\u2CC2\u2CC4\u2CC6\u2CC8\u2CCA\u2CCC\u2CCE\u2CD0\u2CD2\u2CD4\u2CD6\u2CD8\u2CDA\u2CDC\u2CDE\u2CE0\u2CE2\u2CEB\u2CED\u2CF2\uA640\uA642\uA644\uA646\uA648\uA64A\uA64C\uA64E\uA650\uA652\uA654\uA656\uA658\uA65A\uA65C\uA65E\uA660\uA662\uA664\uA666\uA668\uA66A\uA66C\uA680\uA682\uA684\uA686\uA688\uA68A\uA68C\uA68E\uA690\uA692\uA694\uA696\uA698\uA69A\uA722\uA724\uA726\uA728\uA72A\uA72C\uA72E\uA732\uA734\uA736\uA738\uA73A\uA73C\uA73E\uA740\uA742\uA744\uA746\uA748\uA74A\uA74C\uA74E\uA750\uA752\uA754\uA756\uA758\uA75A\uA75C\uA75E\uA760\uA762\uA764\uA766\uA768\uA76A\uA76C\uA76E\uA779\uA77B\uA77D\uA77E\uA780\uA782\uA784\uA786\uA78B\uA78D\uA790\uA792\uA796\uA798\uA79A\uA79C\uA79E\uA7A0\uA7A2\uA7A4\uA7A6\uA7A8\uA7AA-\uA7AE\uA7B0-\uA7B4\uA7B6\uA7B8\uFF21-\uFF3A',
  'astral': '\uD801[\uDC00-\uDC27\uDCB0-\uDCD3]|\uD803[\uDC80-\uDCB2]|\uD806[\uDCA0-\uDCBF]|\uD81B[\uDE40-\uDE5F]|\uD835[\uDC00-\uDC19\uDC34-\uDC4D\uDC68-\uDC81\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB5\uDCD0-\uDCE9\uDD04\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD38\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD6C-\uDD85\uDDA0-\uDDB9\uDDD4-\uDDED\uDE08-\uDE21\uDE3C-\uDE55\uDE70-\uDE89\uDEA8-\uDEC0\uDEE2-\uDEFA\uDF1C-\uDF34\uDF56-\uDF6E\uDF90-\uDFA8\uDFCA]|\uD83A[\uDD00-\uDD21]'
}, {
  'name': 'M',
  'alias': 'Mark',
  'bmp': '\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08D3-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A70\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B62\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0C00-\u0C04\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0D00-\u0D03\u0D3B\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D82\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0F18\u0F19\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u180B-\u180D\u1885\u1886\u18A9\u1920-\u192B\u1930-\u193B\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F\u1AB0-\u1ABE\u1B00-\u1B04\u1B34-\u1B44\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BE6-\u1BF3\u1C24-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF2-\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DF9\u1DFB-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\uA66F-\uA672\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA880\uA881\uA8B4-\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9E5\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F',
  'astral': '\uD800[\uDDFD\uDEE0\uDF76-\uDF7A]|\uD802[\uDE01-\uDE03\uDE05\uDE06\uDE0C-\uDE0F\uDE38-\uDE3A\uDE3F\uDEE5\uDEE6]|\uD803[\uDD24-\uDD27\uDF46-\uDF50]|\uD804[\uDC00-\uDC02\uDC38-\uDC46\uDC7F-\uDC82\uDCB0-\uDCBA\uDD00-\uDD02\uDD27-\uDD34\uDD45\uDD46\uDD73\uDD80-\uDD82\uDDB3-\uDDC0\uDDC9-\uDDCC\uDE2C-\uDE37\uDE3E\uDEDF-\uDEEA\uDF00-\uDF03\uDF3B\uDF3C\uDF3E-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF57\uDF62\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC35-\uDC46\uDC5E\uDCB0-\uDCC3\uDDAF-\uDDB5\uDDB8-\uDDC0\uDDDC\uDDDD\uDE30-\uDE40\uDEAB-\uDEB7\uDF1D-\uDF2B]|\uD806[\uDC2C-\uDC3A\uDE01-\uDE0A\uDE33-\uDE39\uDE3B-\uDE3E\uDE47\uDE51-\uDE5B\uDE8A-\uDE99]|\uD807[\uDC2F-\uDC36\uDC38-\uDC3F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD31-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD45\uDD47\uDD8A-\uDD8E\uDD90\uDD91\uDD93-\uDD97\uDEF3-\uDEF6]|\uD81A[\uDEF0-\uDEF4\uDF30-\uDF36]|\uD81B[\uDF51-\uDF7E\uDF8F-\uDF92]|\uD82F[\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDCD0-\uDCD6\uDD44-\uDD4A]|\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'Mc',
  'alias': 'Spacing_Mark',
  'bmp': '\u0903\u093B\u093E-\u0940\u0949-\u094C\u094E\u094F\u0982\u0983\u09BE-\u09C0\u09C7\u09C8\u09CB\u09CC\u09D7\u0A03\u0A3E-\u0A40\u0A83\u0ABE-\u0AC0\u0AC9\u0ACB\u0ACC\u0B02\u0B03\u0B3E\u0B40\u0B47\u0B48\u0B4B\u0B4C\u0B57\u0BBE\u0BBF\u0BC1\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCC\u0BD7\u0C01-\u0C03\u0C41-\u0C44\u0C82\u0C83\u0CBE\u0CC0-\u0CC4\u0CC7\u0CC8\u0CCA\u0CCB\u0CD5\u0CD6\u0D02\u0D03\u0D3E-\u0D40\u0D46-\u0D48\u0D4A-\u0D4C\u0D57\u0D82\u0D83\u0DCF-\u0DD1\u0DD8-\u0DDF\u0DF2\u0DF3\u0F3E\u0F3F\u0F7F\u102B\u102C\u1031\u1038\u103B\u103C\u1056\u1057\u1062-\u1064\u1067-\u106D\u1083\u1084\u1087-\u108C\u108F\u109A-\u109C\u17B6\u17BE-\u17C5\u17C7\u17C8\u1923-\u1926\u1929-\u192B\u1930\u1931\u1933-\u1938\u1A19\u1A1A\u1A55\u1A57\u1A61\u1A63\u1A64\u1A6D-\u1A72\u1B04\u1B35\u1B3B\u1B3D-\u1B41\u1B43\u1B44\u1B82\u1BA1\u1BA6\u1BA7\u1BAA\u1BE7\u1BEA-\u1BEC\u1BEE\u1BF2\u1BF3\u1C24-\u1C2B\u1C34\u1C35\u1CE1\u1CF2\u1CF3\u1CF7\u302E\u302F\uA823\uA824\uA827\uA880\uA881\uA8B4-\uA8C3\uA952\uA953\uA983\uA9B4\uA9B5\uA9BA\uA9BB\uA9BD-\uA9C0\uAA2F\uAA30\uAA33\uAA34\uAA4D\uAA7B\uAA7D\uAAEB\uAAEE\uAAEF\uAAF5\uABE3\uABE4\uABE6\uABE7\uABE9\uABEA\uABEC',
  'astral': '\uD804[\uDC00\uDC02\uDC82\uDCB0-\uDCB2\uDCB7\uDCB8\uDD2C\uDD45\uDD46\uDD82\uDDB3-\uDDB5\uDDBF\uDDC0\uDE2C-\uDE2E\uDE32\uDE33\uDE35\uDEE0-\uDEE2\uDF02\uDF03\uDF3E\uDF3F\uDF41-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF57\uDF62\uDF63]|\uD805[\uDC35-\uDC37\uDC40\uDC41\uDC45\uDCB0-\uDCB2\uDCB9\uDCBB-\uDCBE\uDCC1\uDDAF-\uDDB1\uDDB8-\uDDBB\uDDBE\uDE30-\uDE32\uDE3B\uDE3C\uDE3E\uDEAC\uDEAE\uDEAF\uDEB6\uDF20\uDF21\uDF26]|\uD806[\uDC2C-\uDC2E\uDC38\uDE39\uDE57\uDE58\uDE97]|\uD807[\uDC2F\uDC3E\uDCA9\uDCB1\uDCB4\uDD8A-\uDD8E\uDD93\uDD94\uDD96\uDEF5\uDEF6]|\uD81B[\uDF51-\uDF7E]|\uD834[\uDD65\uDD66\uDD6D-\uDD72]'
}, {
  'name': 'Me',
  'alias': 'Enclosing_Mark',
  'bmp': '\u0488\u0489\u1ABE\u20DD-\u20E0\u20E2-\u20E4\uA670-\uA672'
}, {
  'name': 'Mn',
  'alias': 'Nonspacing_Mark',
  'bmp': '\u0300-\u036F\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08D3-\u08E1\u08E3-\u0902\u093A\u093C\u0941-\u0948\u094D\u0951-\u0957\u0962\u0963\u0981\u09BC\u09C1-\u09C4\u09CD\u09E2\u09E3\u09FE\u0A01\u0A02\u0A3C\u0A41\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A70\u0A71\u0A75\u0A81\u0A82\u0ABC\u0AC1-\u0AC5\u0AC7\u0AC8\u0ACD\u0AE2\u0AE3\u0AFA-\u0AFF\u0B01\u0B3C\u0B3F\u0B41-\u0B44\u0B4D\u0B56\u0B62\u0B63\u0B82\u0BC0\u0BCD\u0C00\u0C04\u0C3E-\u0C40\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C81\u0CBC\u0CBF\u0CC6\u0CCC\u0CCD\u0CE2\u0CE3\u0D00\u0D01\u0D3B\u0D3C\u0D41-\u0D44\u0D4D\u0D62\u0D63\u0DCA\u0DD2-\u0DD4\u0DD6\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0F18\u0F19\u0F35\u0F37\u0F39\u0F71-\u0F7E\u0F80-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102D-\u1030\u1032-\u1037\u1039\u103A\u103D\u103E\u1058\u1059\u105E-\u1060\u1071-\u1074\u1082\u1085\u1086\u108D\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4\u17B5\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17DD\u180B-\u180D\u1885\u1886\u18A9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193B\u1A17\u1A18\u1A1B\u1A56\u1A58-\u1A5E\u1A60\u1A62\u1A65-\u1A6C\u1A73-\u1A7C\u1A7F\u1AB0-\u1ABD\u1B00-\u1B03\u1B34\u1B36-\u1B3A\u1B3C\u1B42\u1B6B-\u1B73\u1B80\u1B81\u1BA2-\u1BA5\u1BA8\u1BA9\u1BAB-\u1BAD\u1BE6\u1BE8\u1BE9\u1BED\u1BEF-\u1BF1\u1C2C-\u1C33\u1C36\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE0\u1CE2-\u1CE8\u1CED\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF9\u1DFB-\u1DFF\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302D\u3099\u309A\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA825\uA826\uA8C4\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA951\uA980-\uA982\uA9B3\uA9B6-\uA9B9\uA9BC\uA9E5\uAA29-\uAA2E\uAA31\uAA32\uAA35\uAA36\uAA43\uAA4C\uAA7C\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEC\uAAED\uAAF6\uABE5\uABE8\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F',
  'astral': '\uD800[\uDDFD\uDEE0\uDF76-\uDF7A]|\uD802[\uDE01-\uDE03\uDE05\uDE06\uDE0C-\uDE0F\uDE38-\uDE3A\uDE3F\uDEE5\uDEE6]|\uD803[\uDD24-\uDD27\uDF46-\uDF50]|\uD804[\uDC01\uDC38-\uDC46\uDC7F-\uDC81\uDCB3-\uDCB6\uDCB9\uDCBA\uDD00-\uDD02\uDD27-\uDD2B\uDD2D-\uDD34\uDD73\uDD80\uDD81\uDDB6-\uDDBE\uDDC9-\uDDCC\uDE2F-\uDE31\uDE34\uDE36\uDE37\uDE3E\uDEDF\uDEE3-\uDEEA\uDF00\uDF01\uDF3B\uDF3C\uDF40\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC38-\uDC3F\uDC42-\uDC44\uDC46\uDC5E\uDCB3-\uDCB8\uDCBA\uDCBF\uDCC0\uDCC2\uDCC3\uDDB2-\uDDB5\uDDBC\uDDBD\uDDBF\uDDC0\uDDDC\uDDDD\uDE33-\uDE3A\uDE3D\uDE3F\uDE40\uDEAB\uDEAD\uDEB0-\uDEB5\uDEB7\uDF1D-\uDF1F\uDF22-\uDF25\uDF27-\uDF2B]|\uD806[\uDC2F-\uDC37\uDC39\uDC3A\uDE01-\uDE0A\uDE33-\uDE38\uDE3B-\uDE3E\uDE47\uDE51-\uDE56\uDE59-\uDE5B\uDE8A-\uDE96\uDE98\uDE99]|\uD807[\uDC30-\uDC36\uDC38-\uDC3D\uDC3F\uDC92-\uDCA7\uDCAA-\uDCB0\uDCB2\uDCB3\uDCB5\uDCB6\uDD31-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD45\uDD47\uDD90\uDD91\uDD95\uDD97\uDEF3\uDEF4]|\uD81A[\uDEF0-\uDEF4\uDF30-\uDF36]|\uD81B[\uDF8F-\uDF92]|\uD82F[\uDC9D\uDC9E]|\uD834[\uDD67-\uDD69\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDCD0-\uDCD6\uDD44-\uDD4A]|\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'N',
  'alias': 'Number',
  'bmp': '0-9\xB2\xB3\xB9\xBC-\xBE\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u09F4-\u09F9\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0B72-\u0B77\u0BE6-\u0BF2\u0C66-\u0C6F\u0C78-\u0C7E\u0CE6-\u0CEF\u0D58-\u0D5E\u0D66-\u0D78\u0DE6-\u0DEF\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F33\u1040-\u1049\u1090-\u1099\u1369-\u137C\u16EE-\u16F0\u17E0-\u17E9\u17F0-\u17F9\u1810-\u1819\u1946-\u194F\u19D0-\u19DA\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\u2070\u2074-\u2079\u2080-\u2089\u2150-\u2182\u2185-\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2CFD\u3007\u3021-\u3029\u3038-\u303A\u3192-\u3195\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\uA620-\uA629\uA6E6-\uA6EF\uA830-\uA835\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uA9F0-\uA9F9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19',
  'astral': '\uD800[\uDD07-\uDD33\uDD40-\uDD78\uDD8A\uDD8B\uDEE1-\uDEFB\uDF20-\uDF23\uDF41\uDF4A\uDFD1-\uDFD5]|\uD801[\uDCA0-\uDCA9]|\uD802[\uDC58-\uDC5F\uDC79-\uDC7F\uDCA7-\uDCAF\uDCFB-\uDCFF\uDD16-\uDD1B\uDDBC\uDDBD\uDDC0-\uDDCF\uDDD2-\uDDFF\uDE40-\uDE48\uDE7D\uDE7E\uDE9D-\uDE9F\uDEEB-\uDEEF\uDF58-\uDF5F\uDF78-\uDF7F\uDFA9-\uDFAF]|\uD803[\uDCFA-\uDCFF\uDD30-\uDD39\uDE60-\uDE7E\uDF1D-\uDF26\uDF51-\uDF54]|\uD804[\uDC52-\uDC6F\uDCF0-\uDCF9\uDD36-\uDD3F\uDDD0-\uDDD9\uDDE1-\uDDF4\uDEF0-\uDEF9]|\uD805[\uDC50-\uDC59\uDCD0-\uDCD9\uDE50-\uDE59\uDEC0-\uDEC9\uDF30-\uDF3B]|\uD806[\uDCE0-\uDCF2]|\uD807[\uDC50-\uDC6C\uDD50-\uDD59\uDDA0-\uDDA9]|\uD809[\uDC00-\uDC6E]|\uD81A[\uDE60-\uDE69\uDF50-\uDF59\uDF5B-\uDF61]|\uD81B[\uDE80-\uDE96]|\uD834[\uDEE0-\uDEF3\uDF60-\uDF78]|\uD835[\uDFCE-\uDFFF]|\uD83A[\uDCC7-\uDCCF\uDD50-\uDD59]|\uD83B[\uDC71-\uDCAB\uDCAD-\uDCAF\uDCB1-\uDCB4]|\uD83C[\uDD00-\uDD0C]'
}, {
  'name': 'Nd',
  'alias': 'Decimal_Number',
  'bmp': '0-9\u0660-\u0669\u06F0-\u06F9\u07C0-\u07C9\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F\u0DE6-\u0DEF\u0E50-\u0E59\u0ED0-\u0ED9\u0F20-\u0F29\u1040-\u1049\u1090-\u1099\u17E0-\u17E9\u1810-\u1819\u1946-\u194F\u19D0-\u19D9\u1A80-\u1A89\u1A90-\u1A99\u1B50-\u1B59\u1BB0-\u1BB9\u1C40-\u1C49\u1C50-\u1C59\uA620-\uA629\uA8D0-\uA8D9\uA900-\uA909\uA9D0-\uA9D9\uA9F0-\uA9F9\uAA50-\uAA59\uABF0-\uABF9\uFF10-\uFF19',
  'astral': '\uD801[\uDCA0-\uDCA9]|\uD803[\uDD30-\uDD39]|\uD804[\uDC66-\uDC6F\uDCF0-\uDCF9\uDD36-\uDD3F\uDDD0-\uDDD9\uDEF0-\uDEF9]|\uD805[\uDC50-\uDC59\uDCD0-\uDCD9\uDE50-\uDE59\uDEC0-\uDEC9\uDF30-\uDF39]|\uD806[\uDCE0-\uDCE9]|\uD807[\uDC50-\uDC59\uDD50-\uDD59\uDDA0-\uDDA9]|\uD81A[\uDE60-\uDE69\uDF50-\uDF59]|\uD835[\uDFCE-\uDFFF]|\uD83A[\uDD50-\uDD59]'
}, {
  'name': 'Nl',
  'alias': 'Letter_Number',
  'bmp': '\u16EE-\u16F0\u2160-\u2182\u2185-\u2188\u3007\u3021-\u3029\u3038-\u303A\uA6E6-\uA6EF',
  'astral': '\uD800[\uDD40-\uDD74\uDF41\uDF4A\uDFD1-\uDFD5]|\uD809[\uDC00-\uDC6E]'
}, {
  'name': 'No',
  'alias': 'Other_Number',
  'bmp': '\xB2\xB3\xB9\xBC-\xBE\u09F4-\u09F9\u0B72-\u0B77\u0BF0-\u0BF2\u0C78-\u0C7E\u0D58-\u0D5E\u0D70-\u0D78\u0F2A-\u0F33\u1369-\u137C\u17F0-\u17F9\u19DA\u2070\u2074-\u2079\u2080-\u2089\u2150-\u215F\u2189\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u2CFD\u3192-\u3195\u3220-\u3229\u3248-\u324F\u3251-\u325F\u3280-\u3289\u32B1-\u32BF\uA830-\uA835',
  'astral': '\uD800[\uDD07-\uDD33\uDD75-\uDD78\uDD8A\uDD8B\uDEE1-\uDEFB\uDF20-\uDF23]|\uD802[\uDC58-\uDC5F\uDC79-\uDC7F\uDCA7-\uDCAF\uDCFB-\uDCFF\uDD16-\uDD1B\uDDBC\uDDBD\uDDC0-\uDDCF\uDDD2-\uDDFF\uDE40-\uDE48\uDE7D\uDE7E\uDE9D-\uDE9F\uDEEB-\uDEEF\uDF58-\uDF5F\uDF78-\uDF7F\uDFA9-\uDFAF]|\uD803[\uDCFA-\uDCFF\uDE60-\uDE7E\uDF1D-\uDF26\uDF51-\uDF54]|\uD804[\uDC52-\uDC65\uDDE1-\uDDF4]|\uD805[\uDF3A\uDF3B]|\uD806[\uDCEA-\uDCF2]|\uD807[\uDC5A-\uDC6C]|\uD81A[\uDF5B-\uDF61]|\uD81B[\uDE80-\uDE96]|\uD834[\uDEE0-\uDEF3\uDF60-\uDF78]|\uD83A[\uDCC7-\uDCCF]|\uD83B[\uDC71-\uDCAB\uDCAD-\uDCAF\uDCB1-\uDCB4]|\uD83C[\uDD00-\uDD0C]'
}, {
  'name': 'P',
  'alias': 'Punctuation',
  'bmp': '!-#%-\\*,-\\/:;\\?@\\[-\\]_\\{\\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061E\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166D\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4E\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65',
  'astral': '\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDF55-\uDF59]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9]|\uD805[\uDC4B-\uDC4F\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDF3C-\uDF3E]|\uD806[\uDC3B\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8]|\uD809[\uDC70-\uDC74]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDE97-\uDE9A]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD83A[\uDD5E\uDD5F]'
}, {
  'name': 'Pc',
  'alias': 'Connector_Punctuation',
  'bmp': '_\u203F\u2040\u2054\uFE33\uFE34\uFE4D-\uFE4F\uFF3F'
}, {
  'name': 'Pd',
  'alias': 'Dash_Punctuation',
  'bmp': '\\-\u058A\u05BE\u1400\u1806\u2010-\u2015\u2E17\u2E1A\u2E3A\u2E3B\u2E40\u301C\u3030\u30A0\uFE31\uFE32\uFE58\uFE63\uFF0D'
}, {
  'name': 'Pe',
  'alias': 'Close_Punctuation',
  'bmp': '\\)\\]\\}\u0F3B\u0F3D\u169C\u2046\u207E\u208E\u2309\u230B\u232A\u2769\u276B\u276D\u276F\u2771\u2773\u2775\u27C6\u27E7\u27E9\u27EB\u27ED\u27EF\u2984\u2986\u2988\u298A\u298C\u298E\u2990\u2992\u2994\u2996\u2998\u29D9\u29DB\u29FD\u2E23\u2E25\u2E27\u2E29\u3009\u300B\u300D\u300F\u3011\u3015\u3017\u3019\u301B\u301E\u301F\uFD3E\uFE18\uFE36\uFE38\uFE3A\uFE3C\uFE3E\uFE40\uFE42\uFE44\uFE48\uFE5A\uFE5C\uFE5E\uFF09\uFF3D\uFF5D\uFF60\uFF63'
}, {
  'name': 'Pf',
  'alias': 'Final_Punctuation',
  'bmp': '\xBB\u2019\u201D\u203A\u2E03\u2E05\u2E0A\u2E0D\u2E1D\u2E21'
}, {
  'name': 'Pi',
  'alias': 'Initial_Punctuation',
  'bmp': '\xAB\u2018\u201B\u201C\u201F\u2039\u2E02\u2E04\u2E09\u2E0C\u2E1C\u2E20'
}, {
  'name': 'Po',
  'alias': 'Other_Punctuation',
  'bmp': '!-#%-\'\\*,\\.\\/:;\\?@\\\xA1\xA7\xB6\xB7\xBF\u037E\u0387\u055A-\u055F\u0589\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061E\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u166D\u166E\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u1805\u1807-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2016\u2017\u2020-\u2027\u2030-\u2038\u203B-\u203E\u2041-\u2043\u2047-\u2051\u2053\u2055-\u205E\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00\u2E01\u2E06-\u2E08\u2E0B\u2E0E-\u2E16\u2E18\u2E19\u2E1B\u2E1E\u2E1F\u2E2A-\u2E2E\u2E30-\u2E39\u2E3C-\u2E3F\u2E41\u2E43-\u2E4E\u3001-\u3003\u303D\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFE10-\uFE16\uFE19\uFE30\uFE45\uFE46\uFE49-\uFE4C\uFE50-\uFE52\uFE54-\uFE57\uFE5F-\uFE61\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF07\uFF0A\uFF0C\uFF0E\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3C\uFF61\uFF64\uFF65',
  'astral': '\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDF55-\uDF59]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9]|\uD805[\uDC4B-\uDC4F\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDF3C-\uDF3E]|\uD806[\uDC3B\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8]|\uD809[\uDC70-\uDC74]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDE97-\uDE9A]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD83A[\uDD5E\uDD5F]'
}, {
  'name': 'Ps',
  'alias': 'Open_Punctuation',
  'bmp': '\\(\\[\\{\u0F3A\u0F3C\u169B\u201A\u201E\u2045\u207D\u208D\u2308\u230A\u2329\u2768\u276A\u276C\u276E\u2770\u2772\u2774\u27C5\u27E6\u27E8\u27EA\u27EC\u27EE\u2983\u2985\u2987\u2989\u298B\u298D\u298F\u2991\u2993\u2995\u2997\u29D8\u29DA\u29FC\u2E22\u2E24\u2E26\u2E28\u2E42\u3008\u300A\u300C\u300E\u3010\u3014\u3016\u3018\u301A\u301D\uFD3F\uFE17\uFE35\uFE37\uFE39\uFE3B\uFE3D\uFE3F\uFE41\uFE43\uFE47\uFE59\uFE5B\uFE5D\uFF08\uFF3B\uFF5B\uFF5F\uFF62'
}, {
  'name': 'S',
  'alias': 'Symbol',
  'bmp': '\\$\\+<->\\^`\\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20BF\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2426\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2B95\u2B98-\u2BC8\u2BCA-\u2BFE\u2CE5-\u2CEA\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFB\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E3\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u32FE\u3300-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uFB29\uFBB2-\uFBC1\uFDFC\uFDFD\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD',
  'astral': '\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9B\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD805\uDF3F|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDE8\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD83B[\uDCAC\uDCB0\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD10-\uDD6B\uDD70-\uDDAC\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED4\uDEE0-\uDEEC\uDEF0-\uDEF9\uDF00-\uDF73\uDF80-\uDFD8]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDD00-\uDD0B\uDD10-\uDD3E\uDD40-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF\uDE60-\uDE6D]'
}, {
  'name': 'Sc',
  'alias': 'Currency_Symbol',
  'bmp': '\\$\xA2-\xA5\u058F\u060B\u07FE\u07FF\u09F2\u09F3\u09FB\u0AF1\u0BF9\u0E3F\u17DB\u20A0-\u20BF\uA838\uFDFC\uFE69\uFF04\uFFE0\uFFE1\uFFE5\uFFE6',
  'astral': '\uD83B\uDCB0'
}, {
  'name': 'Sk',
  'alias': 'Modifier_Symbol',
  'bmp': '\\^`\xA8\xAF\xB4\xB8\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u309B\u309C\uA700-\uA716\uA720\uA721\uA789\uA78A\uAB5B\uFBB2-\uFBC1\uFF3E\uFF40\uFFE3',
  'astral': '\uD83C[\uDFFB-\uDFFF]'
}, {
  'name': 'Sm',
  'alias': 'Math_Symbol',
  'bmp': '\\+<->\\|~\xAC\xB1\xD7\xF7\u03F6\u0606-\u0608\u2044\u2052\u207A-\u207C\u208A-\u208C\u2118\u2140-\u2144\u214B\u2190-\u2194\u219A\u219B\u21A0\u21A3\u21A6\u21AE\u21CE\u21CF\u21D2\u21D4\u21F4-\u22FF\u2320\u2321\u237C\u239B-\u23B3\u23DC-\u23E1\u25B7\u25C1\u25F8-\u25FF\u266F\u27C0-\u27C4\u27C7-\u27E5\u27F0-\u27FF\u2900-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2AFF\u2B30-\u2B44\u2B47-\u2B4C\uFB29\uFE62\uFE64-\uFE66\uFF0B\uFF1C-\uFF1E\uFF5C\uFF5E\uFFE2\uFFE9-\uFFEC',
  'astral': '\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD83B[\uDEF0\uDEF1]'
}, {
  'name': 'So',
  'alias': 'Other_Symbol',
  'bmp': '\xA6\xA9\xAE\xB0\u0482\u058D\u058E\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u09FA\u0B70\u0BF3-\u0BF8\u0BFA\u0C7F\u0D4F\u0D79\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116\u2117\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u214A\u214C\u214D\u214F\u218A\u218B\u2195-\u2199\u219C-\u219F\u21A1\u21A2\u21A4\u21A5\u21A7-\u21AD\u21AF-\u21CD\u21D0\u21D1\u21D3\u21D5-\u21F3\u2300-\u2307\u230C-\u231F\u2322-\u2328\u232B-\u237B\u237D-\u239A\u23B4-\u23DB\u23E2-\u2426\u2440-\u244A\u249C-\u24E9\u2500-\u25B6\u25B8-\u25C0\u25C2-\u25F7\u2600-\u266E\u2670-\u2767\u2794-\u27BF\u2800-\u28FF\u2B00-\u2B2F\u2B45\u2B46\u2B4D-\u2B73\u2B76-\u2B95\u2B98-\u2BC8\u2BCA-\u2BFE\u2CE5-\u2CEA\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFB\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u3190\u3191\u3196-\u319F\u31C0-\u31E3\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u32FE\u3300-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA828-\uA82B\uA836\uA837\uA839\uAA77-\uAA79\uFDFD\uFFE4\uFFE8\uFFED\uFFEE\uFFFC\uFFFD',
  'astral': '\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9B\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD805\uDF3F|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDE8\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD83B\uDCAC|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD10-\uDD6B\uDD70-\uDDAC\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFA]|\uD83D[\uDC00-\uDED4\uDEE0-\uDEEC\uDEF0-\uDEF9\uDF00-\uDF73\uDF80-\uDFD8]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDD00-\uDD0B\uDD10-\uDD3E\uDD40-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF\uDE60-\uDE6D]'
}, {
  'name': 'Z',
  'alias': 'Separator',
  'bmp': ' \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000'
}, {
  'name': 'Zl',
  'alias': 'Line_Separator',
  'bmp': '\u2028'
}, {
  'name': 'Zp',
  'alias': 'Paragraph_Separator',
  'bmp': '\u2029'
}, {
  'name': 'Zs',
  'alias': 'Space_Separator',
  'bmp': ' \xA0\u1680\u2000-\u200A\u202F\u205F\u3000'
}];
/*!
 * XRegExp Unicode Categories
 * <xregexp.com>
 * Steven Levithan (c) 2010-present MIT License
 * Unicode data by Mathias Bynens <mathiasbynens.be>
 */

var unicodeCategories = XRegExp => {
  /**
   * Adds support for Unicode's general categories. E.g., `\p{Lu}` or `\p{Uppercase Letter}`. See
   * category descriptions in UAX #44 <http://unicode.org/reports/tr44/#GC_Values_Table>. Token
   * names are case insensitive, and any spaces, hyphens, and underscores are ignored.
   *
   * Uses Unicode 11.0.0.
   *
   * @requires XRegExp, Unicode Base
   */
  if (!XRegExp.addUnicodeData) {
    throw new ReferenceError('Unicode Base must be loaded before Unicode Categories');
  }

  XRegExp.addUnicodeData(categories);
}; // End of module


var properties = [{
  'name': 'ASCII',
  'bmp': '\0-\x7F'
}, {
  'name': 'ASCII_Hex_Digit',
  'bmp': '0-9A-Fa-f'
}, {
  'name': 'Alphabetic',
  'bmp': 'A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0345\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05B0-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05EF-\u05F2\u0610-\u061A\u0620-\u0657\u0659-\u065F\u066E-\u06D3\u06D5-\u06DC\u06E1-\u06E8\u06ED-\u06EF\u06FA-\u06FC\u06FF\u0710-\u073F\u074D-\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0817\u081A-\u082C\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D4-\u08DF\u08E3-\u08E9\u08F0-\u093B\u093D-\u094C\u094E-\u0950\u0955-\u0963\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD-\u09C4\u09C7\u09C8\u09CB\u09CC\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09F0\u09F1\u09FC\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3E-\u0A42\u0A47\u0A48\u0A4B\u0A4C\u0A51\u0A59-\u0A5C\u0A5E\u0A70-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD-\u0AC5\u0AC7-\u0AC9\u0ACB\u0ACC\u0AD0\u0AE0-\u0AE3\u0AF9-\u0AFC\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D-\u0B44\u0B47\u0B48\u0B4B\u0B4C\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCC\u0BD0\u0BD7\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4C\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCC\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D44\u0D46-\u0D48\u0D4A-\u0D4C\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E46\u0E4D\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0ECD\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F71-\u0F81\u0F88-\u0F97\u0F99-\u0FBC\u1000-\u1036\u1038\u103B-\u103F\u1050-\u1062\u1065-\u1068\u106E-\u1086\u108E\u109C\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135F\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1713\u1720-\u1733\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17B3\u17B6-\u17C8\u17D7\u17DC\u1820-\u1878\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u1938\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A1B\u1A20-\u1A5E\u1A61-\u1A74\u1AA7\u1B00-\u1B33\u1B35-\u1B43\u1B45-\u1B4B\u1B80-\u1BA9\u1BAC-\u1BAF\u1BBA-\u1BE5\u1BE7-\u1BF1\u1C00-\u1C35\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1D00-\u1DBF\u1DE7-\u1DF4\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u24B6-\u24E9\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA674-\uA67B\uA67F-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA827\uA840-\uA873\uA880-\uA8C3\uA8C5\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA92A\uA930-\uA952\uA960-\uA97C\uA980-\uA9B2\uA9B4-\uA9BF\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA60-\uAA76\uAA7A\uAA7E-\uAABE\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF5\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD27\uDF00-\uDF1C\uDF27\uDF30-\uDF45]|\uD804[\uDC00-\uDC45\uDC82-\uDCB8\uDCD0-\uDCE8\uDD00-\uDD32\uDD44-\uDD46\uDD50-\uDD72\uDD76\uDD80-\uDDBF\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE34\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEE8\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D-\uDF44\uDF47\uDF48\uDF4B\uDF4C\uDF50\uDF57\uDF5D-\uDF63]|\uD805[\uDC00-\uDC41\uDC43-\uDC45\uDC47-\uDC4A\uDC80-\uDCC1\uDCC4\uDCC5\uDCC7\uDD80-\uDDB5\uDDB8-\uDDBE\uDDD8-\uDDDD\uDE00-\uDE3E\uDE40\uDE44\uDE80-\uDEB5\uDF00-\uDF1A\uDF1D-\uDF2A]|\uD806[\uDC00-\uDC38\uDCA0-\uDCDF\uDCFF\uDE00-\uDE32\uDE35-\uDE3E\uDE50-\uDE83\uDE86-\uDE97\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC3E\uDC40\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD41\uDD43\uDD46\uDD47\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD90\uDD91\uDD93-\uDD96\uDD98\uDEE0-\uDEF6]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF36\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50-\uDF7E\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9E]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43\uDD47]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD83C[\uDD30-\uDD49\uDD50-\uDD69\uDD70-\uDD89]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Any',
  'isBmpLast': true,
  'bmp': '\0-\uFFFF',
  'astral': '[\uD800-\uDBFF][\uDC00-\uDFFF]'
}, {
  'name': 'Assigned',
  'isBmpLast': true,
  'bmp': '\0-\u0377\u037A-\u037F\u0384-\u038A\u038C\u038E-\u03A1\u03A3-\u052F\u0531-\u0556\u0559-\u058A\u058D-\u058F\u0591-\u05C7\u05D0-\u05EA\u05EF-\u05F4\u0600-\u061C\u061E-\u070D\u070F-\u074A\u074D-\u07B1\u07C0-\u07FA\u07FD-\u082D\u0830-\u083E\u0840-\u085B\u085E\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D3-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09FE\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A76\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AF1\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B77\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BFA\u0C00-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C78-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4F\u0D54-\u0D63\u0D66-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2-\u0DF4\u0E01-\u0E3A\u0E3F-\u0E5B\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00-\u0F47\u0F49-\u0F6C\u0F71-\u0F97\u0F99-\u0FBC\u0FBE-\u0FCC\u0FCE-\u0FDA\u1000-\u10C5\u10C7\u10CD\u10D0-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u137C\u1380-\u1399\u13A0-\u13F5\u13F8-\u13FD\u1400-\u169C\u16A0-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1736\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17DD\u17E0-\u17E9\u17F0-\u17F9\u1800-\u180E\u1810-\u1819\u1820-\u1878\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1940\u1944-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u19DE-\u1A1B\u1A1E-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA0-\u1AAD\u1AB0-\u1ABE\u1B00-\u1B4B\u1B50-\u1B7C\u1B80-\u1BF3\u1BFC-\u1C37\u1C3B-\u1C49\u1C4D-\u1C88\u1C90-\u1CBA\u1CBD-\u1CC7\u1CD0-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FC4\u1FC6-\u1FD3\u1FD6-\u1FDB\u1FDD-\u1FEF\u1FF2-\u1FF4\u1FF6-\u1FFE\u2000-\u2064\u2066-\u2071\u2074-\u208E\u2090-\u209C\u20A0-\u20BF\u20D0-\u20F0\u2100-\u218B\u2190-\u2426\u2440-\u244A\u2460-\u2B73\u2B76-\u2B95\u2B98-\u2BC8\u2BCA-\u2BFE\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CF3\u2CF9-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D70\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2E4E\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFB\u3000-\u303F\u3041-\u3096\u3099-\u30FF\u3105-\u312F\u3131-\u318E\u3190-\u31BA\u31C0-\u31E3\u31F0-\u321E\u3220-\u32FE\u3300-\u4DB5\u4DC0-\u9FEF\uA000-\uA48C\uA490-\uA4C6\uA4D0-\uA62B\uA640-\uA6F7\uA700-\uA7B9\uA7F7-\uA82B\uA830-\uA839\uA840-\uA877\uA880-\uA8C5\uA8CE-\uA8D9\uA8E0-\uA953\uA95F-\uA97C\uA980-\uA9CD\uA9CF-\uA9D9\uA9DE-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA5C-\uAAC2\uAADB-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB65\uAB70-\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uD800-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBC1\uFBD3-\uFD3F\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFD\uFE00-\uFE19\uFE20-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFE70-\uFE74\uFE76-\uFEFC\uFEFF\uFF01-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFF9-\uFFFD',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD00-\uDD02\uDD07-\uDD33\uDD37-\uDD8E\uDD90-\uDD9B\uDDA0\uDDD0-\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0-\uDEFB\uDF00-\uDF23\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDF9F-\uDFC3\uDFC8-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDD6F\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC57-\uDC9E\uDCA7-\uDCAF\uDCE0-\uDCF2\uDCF4\uDCF5\uDCFB-\uDD1B\uDD1F-\uDD39\uDD3F\uDD80-\uDDB7\uDDBC-\uDDCF\uDDD2-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE38-\uDE3A\uDE3F-\uDE48\uDE50-\uDE58\uDE60-\uDE9F\uDEC0-\uDEE6\uDEEB-\uDEF6\uDF00-\uDF35\uDF39-\uDF55\uDF58-\uDF72\uDF78-\uDF91\uDF99-\uDF9C\uDFA9-\uDFAF]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDCFA-\uDD27\uDD30-\uDD39\uDE60-\uDE7E\uDF00-\uDF27\uDF30-\uDF59]|\uD804[\uDC00-\uDC4D\uDC52-\uDC6F\uDC7F-\uDCC1\uDCCD\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD46\uDD50-\uDD76\uDD80-\uDDCD\uDDD0-\uDDDF\uDDE1-\uDDF4\uDE00-\uDE11\uDE13-\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA9\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3B-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC59\uDC5B\uDC5D\uDC5E\uDC80-\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDDD\uDE00-\uDE44\uDE50-\uDE59\uDE60-\uDE6C\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF1A\uDF1D-\uDF2B\uDF30-\uDF3F]|\uD806[\uDC00-\uDC3B\uDCA0-\uDCF2\uDCFF\uDE00-\uDE47\uDE50-\uDE83\uDE86-\uDEA2\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC45\uDC50-\uDC6C\uDC70-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD90\uDD91\uDD93-\uDD98\uDDA0-\uDDA9\uDEE0-\uDEF8]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC70-\uDC74\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879\uDB80-\uDBBE\uDBC0-\uDBFE][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDE6E\uDE6F\uDED0-\uDEED\uDEF0-\uDEF5\uDF00-\uDF45\uDF50-\uDF59\uDF5B-\uDF61\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE9A\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9C-\uDCA3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDDE8\uDE00-\uDE45\uDEE0-\uDEF3\uDF00-\uDF56\uDF60-\uDF78]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDC00-\uDE8B\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCC7-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59\uDD5E\uDD5F]|\uD83B[\uDC71-\uDCB4\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD00-\uDD0C\uDD10-\uDD6B\uDD70-\uDDAC\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED4\uDEE0-\uDEEC\uDEF0-\uDEF9\uDF00-\uDF73\uDF80-\uDFD8]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDD00-\uDD0B\uDD10-\uDD3E\uDD40-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF\uDE60-\uDE6D]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDC01\uDC20-\uDC7F\uDD00-\uDDEF]|[\uDBBF\uDBFF][\uDC00-\uDFFD]'
}, {
  'name': 'Bidi_Control',
  'bmp': '\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069'
}, {
  'name': 'Bidi_Mirrored',
  'bmp': '\\(\\)<>\\[\\]\\{\\}\xAB\xBB\u0F3A-\u0F3D\u169B\u169C\u2039\u203A\u2045\u2046\u207D\u207E\u208D\u208E\u2140\u2201-\u2204\u2208-\u220D\u2211\u2215\u2216\u221A-\u221D\u221F-\u2222\u2224\u2226\u222B-\u2233\u2239\u223B-\u224C\u2252-\u2255\u225F\u2260\u2262\u2264-\u226B\u226E-\u228C\u228F-\u2292\u2298\u22A2\u22A3\u22A6-\u22B8\u22BE\u22BF\u22C9-\u22CD\u22D0\u22D1\u22D6-\u22ED\u22F0-\u22FF\u2308-\u230B\u2320\u2321\u2329\u232A\u2768-\u2775\u27C0\u27C3-\u27C6\u27C8\u27C9\u27CB-\u27CD\u27D3-\u27D6\u27DC-\u27DE\u27E2-\u27EF\u2983-\u2998\u299B-\u29A0\u29A2-\u29AF\u29B8\u29C0-\u29C5\u29C9\u29CE-\u29D2\u29D4\u29D5\u29D8-\u29DC\u29E1\u29E3-\u29E5\u29E8\u29E9\u29F4-\u29F9\u29FC\u29FD\u2A0A-\u2A1C\u2A1E-\u2A21\u2A24\u2A26\u2A29\u2A2B-\u2A2E\u2A34\u2A35\u2A3C-\u2A3E\u2A57\u2A58\u2A64\u2A65\u2A6A-\u2A6D\u2A6F\u2A70\u2A73\u2A74\u2A79-\u2AA3\u2AA6-\u2AAD\u2AAF-\u2AD6\u2ADC\u2ADE\u2AE2-\u2AE6\u2AEC-\u2AEE\u2AF3\u2AF7-\u2AFB\u2AFD\u2BFE\u2E02-\u2E05\u2E09\u2E0A\u2E0C\u2E0D\u2E1C\u2E1D\u2E20-\u2E29\u3008-\u3011\u3014-\u301B\uFE59-\uFE5E\uFE64\uFE65\uFF08\uFF09\uFF1C\uFF1E\uFF3B\uFF3D\uFF5B\uFF5D\uFF5F\uFF60\uFF62\uFF63',
  'astral': '\uD835[\uDEDB\uDF15\uDF4F\uDF89\uDFC3]'
}, {
  'name': 'Case_Ignorable',
  'bmp': '\'\\.:\\^`\xA8\xAD\xAF\xB4\xB7\xB8\u02B0-\u036F\u0374\u0375\u037A\u0384\u0385\u0387\u0483-\u0489\u0559\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05F4\u0600-\u0605\u0610-\u061A\u061C\u0640\u064B-\u065F\u0670\u06D6-\u06DD\u06DF-\u06E8\u06EA-\u06ED\u070F\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F5\u07FA\u07FD\u0816-\u082D\u0859-\u085B\u08D3-\u0902\u093A\u093C\u0941-\u0948\u094D\u0951-\u0957\u0962\u0963\u0971\u0981\u09BC\u09C1-\u09C4\u09CD\u09E2\u09E3\u09FE\u0A01\u0A02\u0A3C\u0A41\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A70\u0A71\u0A75\u0A81\u0A82\u0ABC\u0AC1-\u0AC5\u0AC7\u0AC8\u0ACD\u0AE2\u0AE3\u0AFA-\u0AFF\u0B01\u0B3C\u0B3F\u0B41-\u0B44\u0B4D\u0B56\u0B62\u0B63\u0B82\u0BC0\u0BCD\u0C00\u0C04\u0C3E-\u0C40\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C81\u0CBC\u0CBF\u0CC6\u0CCC\u0CCD\u0CE2\u0CE3\u0D00\u0D01\u0D3B\u0D3C\u0D41-\u0D44\u0D4D\u0D62\u0D63\u0DCA\u0DD2-\u0DD4\u0DD6\u0E31\u0E34-\u0E3A\u0E46-\u0E4E\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC6\u0EC8-\u0ECD\u0F18\u0F19\u0F35\u0F37\u0F39\u0F71-\u0F7E\u0F80-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102D-\u1030\u1032-\u1037\u1039\u103A\u103D\u103E\u1058\u1059\u105E-\u1060\u1071-\u1074\u1082\u1085\u1086\u108D\u109D\u10FC\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4\u17B5\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17D7\u17DD\u180B-\u180E\u1843\u1885\u1886\u18A9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193B\u1A17\u1A18\u1A1B\u1A56\u1A58-\u1A5E\u1A60\u1A62\u1A65-\u1A6C\u1A73-\u1A7C\u1A7F\u1AA7\u1AB0-\u1ABE\u1B00-\u1B03\u1B34\u1B36-\u1B3A\u1B3C\u1B42\u1B6B-\u1B73\u1B80\u1B81\u1BA2-\u1BA5\u1BA8\u1BA9\u1BAB-\u1BAD\u1BE6\u1BE8\u1BE9\u1BED\u1BEF-\u1BF1\u1C2C-\u1C33\u1C36\u1C37\u1C78-\u1C7D\u1CD0-\u1CD2\u1CD4-\u1CE0\u1CE2-\u1CE8\u1CED\u1CF4\u1CF8\u1CF9\u1D2C-\u1D6A\u1D78\u1D9B-\u1DF9\u1DFB-\u1DFF\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u200B-\u200F\u2018\u2019\u2024\u2027\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2071\u207F\u2090-\u209C\u20D0-\u20F0\u2C7C\u2C7D\u2CEF-\u2CF1\u2D6F\u2D7F\u2DE0-\u2DFF\u2E2F\u3005\u302A-\u302D\u3031-\u3035\u303B\u3099-\u309E\u30FC-\u30FE\uA015\uA4F8-\uA4FD\uA60C\uA66F-\uA672\uA674-\uA67D\uA67F\uA69C-\uA69F\uA6F0\uA6F1\uA700-\uA721\uA770\uA788-\uA78A\uA7F8\uA7F9\uA802\uA806\uA80B\uA825\uA826\uA8C4\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA951\uA980-\uA982\uA9B3\uA9B6-\uA9B9\uA9BC\uA9CF\uA9E5\uA9E6\uAA29-\uAA2E\uAA31\uAA32\uAA35\uAA36\uAA43\uAA4C\uAA70\uAA7C\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAADD\uAAEC\uAAED\uAAF3\uAAF4\uAAF6\uAB5B-\uAB5F\uABE5\uABE8\uABED\uFB1E\uFBB2-\uFBC1\uFE00-\uFE0F\uFE13\uFE20-\uFE2F\uFE52\uFE55\uFEFF\uFF07\uFF0E\uFF1A\uFF3E\uFF40\uFF70\uFF9E\uFF9F\uFFE3\uFFF9-\uFFFB',
  'astral': '\uD800[\uDDFD\uDEE0\uDF76-\uDF7A]|\uD802[\uDE01-\uDE03\uDE05\uDE06\uDE0C-\uDE0F\uDE38-\uDE3A\uDE3F\uDEE5\uDEE6]|\uD803[\uDD24-\uDD27\uDF46-\uDF50]|\uD804[\uDC01\uDC38-\uDC46\uDC7F-\uDC81\uDCB3-\uDCB6\uDCB9\uDCBA\uDCBD\uDCCD\uDD00-\uDD02\uDD27-\uDD2B\uDD2D-\uDD34\uDD73\uDD80\uDD81\uDDB6-\uDDBE\uDDC9-\uDDCC\uDE2F-\uDE31\uDE34\uDE36\uDE37\uDE3E\uDEDF\uDEE3-\uDEEA\uDF00\uDF01\uDF3B\uDF3C\uDF40\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC38-\uDC3F\uDC42-\uDC44\uDC46\uDC5E\uDCB3-\uDCB8\uDCBA\uDCBF\uDCC0\uDCC2\uDCC3\uDDB2-\uDDB5\uDDBC\uDDBD\uDDBF\uDDC0\uDDDC\uDDDD\uDE33-\uDE3A\uDE3D\uDE3F\uDE40\uDEAB\uDEAD\uDEB0-\uDEB5\uDEB7\uDF1D-\uDF1F\uDF22-\uDF25\uDF27-\uDF2B]|\uD806[\uDC2F-\uDC37\uDC39\uDC3A\uDE01-\uDE0A\uDE33-\uDE38\uDE3B-\uDE3E\uDE47\uDE51-\uDE56\uDE59-\uDE5B\uDE8A-\uDE96\uDE98\uDE99]|\uD807[\uDC30-\uDC36\uDC38-\uDC3D\uDC3F\uDC92-\uDCA7\uDCAA-\uDCB0\uDCB2\uDCB3\uDCB5\uDCB6\uDD31-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD45\uDD47\uDD90\uDD91\uDD95\uDD97\uDEF3\uDEF4]|\uD81A[\uDEF0-\uDEF4\uDF30-\uDF36\uDF40-\uDF43]|\uD81B[\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD82F[\uDC9D\uDC9E\uDCA0-\uDCA3]|\uD834[\uDD67-\uDD69\uDD73-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDCD0-\uDCD6\uDD44-\uDD4A]|\uD83C[\uDFFB-\uDFFF]|\uDB40[\uDC01\uDC20-\uDC7F\uDD00-\uDDEF]'
}, {
  'name': 'Cased',
  'bmp': 'A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u01BA\u01BC-\u01BF\u01C4-\u0293\u0295-\u02B8\u02C0\u02C1\u02E0-\u02E4\u0345\u0370-\u0373\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0560-\u0588\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FD-\u10FF\u13A0-\u13F5\u13F8-\u13FD\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2134\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u217F\u2183\u2184\u24B6-\u24E9\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA640-\uA66D\uA680-\uA69D\uA722-\uA787\uA78B-\uA78E\uA790-\uA7B9\uA7F8-\uA7FA\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF21-\uFF3A\uFF41-\uFF5A',
  'astral': '\uD801[\uDC00-\uDC4F\uDCB0-\uDCD3\uDCD8-\uDCFB]|\uD803[\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD806[\uDCA0-\uDCDF]|\uD81B[\uDE40-\uDE7F]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDD00-\uDD43]|\uD83C[\uDD30-\uDD49\uDD50-\uDD69\uDD70-\uDD89]'
}, {
  'name': 'Changes_When_Casefolded',
  'bmp': 'A-Z\xB5\xC0-\xD6\xD8-\xDF\u0100\u0102\u0104\u0106\u0108\u010A\u010C\u010E\u0110\u0112\u0114\u0116\u0118\u011A\u011C\u011E\u0120\u0122\u0124\u0126\u0128\u012A\u012C\u012E\u0130\u0132\u0134\u0136\u0139\u013B\u013D\u013F\u0141\u0143\u0145\u0147\u0149\u014A\u014C\u014E\u0150\u0152\u0154\u0156\u0158\u015A\u015C\u015E\u0160\u0162\u0164\u0166\u0168\u016A\u016C\u016E\u0170\u0172\u0174\u0176\u0178\u0179\u017B\u017D\u017F\u0181\u0182\u0184\u0186\u0187\u0189-\u018B\u018E-\u0191\u0193\u0194\u0196-\u0198\u019C\u019D\u019F\u01A0\u01A2\u01A4\u01A6\u01A7\u01A9\u01AC\u01AE\u01AF\u01B1-\u01B3\u01B5\u01B7\u01B8\u01BC\u01C4\u01C5\u01C7\u01C8\u01CA\u01CB\u01CD\u01CF\u01D1\u01D3\u01D5\u01D7\u01D9\u01DB\u01DE\u01E0\u01E2\u01E4\u01E6\u01E8\u01EA\u01EC\u01EE\u01F1\u01F2\u01F4\u01F6-\u01F8\u01FA\u01FC\u01FE\u0200\u0202\u0204\u0206\u0208\u020A\u020C\u020E\u0210\u0212\u0214\u0216\u0218\u021A\u021C\u021E\u0220\u0222\u0224\u0226\u0228\u022A\u022C\u022E\u0230\u0232\u023A\u023B\u023D\u023E\u0241\u0243-\u0246\u0248\u024A\u024C\u024E\u0345\u0370\u0372\u0376\u037F\u0386\u0388-\u038A\u038C\u038E\u038F\u0391-\u03A1\u03A3-\u03AB\u03C2\u03CF-\u03D1\u03D5\u03D6\u03D8\u03DA\u03DC\u03DE\u03E0\u03E2\u03E4\u03E6\u03E8\u03EA\u03EC\u03EE\u03F0\u03F1\u03F4\u03F5\u03F7\u03F9\u03FA\u03FD-\u042F\u0460\u0462\u0464\u0466\u0468\u046A\u046C\u046E\u0470\u0472\u0474\u0476\u0478\u047A\u047C\u047E\u0480\u048A\u048C\u048E\u0490\u0492\u0494\u0496\u0498\u049A\u049C\u049E\u04A0\u04A2\u04A4\u04A6\u04A8\u04AA\u04AC\u04AE\u04B0\u04B2\u04B4\u04B6\u04B8\u04BA\u04BC\u04BE\u04C0\u04C1\u04C3\u04C5\u04C7\u04C9\u04CB\u04CD\u04D0\u04D2\u04D4\u04D6\u04D8\u04DA\u04DC\u04DE\u04E0\u04E2\u04E4\u04E6\u04E8\u04EA\u04EC\u04EE\u04F0\u04F2\u04F4\u04F6\u04F8\u04FA\u04FC\u04FE\u0500\u0502\u0504\u0506\u0508\u050A\u050C\u050E\u0510\u0512\u0514\u0516\u0518\u051A\u051C\u051E\u0520\u0522\u0524\u0526\u0528\u052A\u052C\u052E\u0531-\u0556\u0587\u10A0-\u10C5\u10C7\u10CD\u13F8-\u13FD\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1E00\u1E02\u1E04\u1E06\u1E08\u1E0A\u1E0C\u1E0E\u1E10\u1E12\u1E14\u1E16\u1E18\u1E1A\u1E1C\u1E1E\u1E20\u1E22\u1E24\u1E26\u1E28\u1E2A\u1E2C\u1E2E\u1E30\u1E32\u1E34\u1E36\u1E38\u1E3A\u1E3C\u1E3E\u1E40\u1E42\u1E44\u1E46\u1E48\u1E4A\u1E4C\u1E4E\u1E50\u1E52\u1E54\u1E56\u1E58\u1E5A\u1E5C\u1E5E\u1E60\u1E62\u1E64\u1E66\u1E68\u1E6A\u1E6C\u1E6E\u1E70\u1E72\u1E74\u1E76\u1E78\u1E7A\u1E7C\u1E7E\u1E80\u1E82\u1E84\u1E86\u1E88\u1E8A\u1E8C\u1E8E\u1E90\u1E92\u1E94\u1E9A\u1E9B\u1E9E\u1EA0\u1EA2\u1EA4\u1EA6\u1EA8\u1EAA\u1EAC\u1EAE\u1EB0\u1EB2\u1EB4\u1EB6\u1EB8\u1EBA\u1EBC\u1EBE\u1EC0\u1EC2\u1EC4\u1EC6\u1EC8\u1ECA\u1ECC\u1ECE\u1ED0\u1ED2\u1ED4\u1ED6\u1ED8\u1EDA\u1EDC\u1EDE\u1EE0\u1EE2\u1EE4\u1EE6\u1EE8\u1EEA\u1EEC\u1EEE\u1EF0\u1EF2\u1EF4\u1EF6\u1EF8\u1EFA\u1EFC\u1EFE\u1F08-\u1F0F\u1F18-\u1F1D\u1F28-\u1F2F\u1F38-\u1F3F\u1F48-\u1F4D\u1F59\u1F5B\u1F5D\u1F5F\u1F68-\u1F6F\u1F80-\u1FAF\u1FB2-\u1FB4\u1FB7-\u1FBC\u1FC2-\u1FC4\u1FC7-\u1FCC\u1FD8-\u1FDB\u1FE8-\u1FEC\u1FF2-\u1FF4\u1FF7-\u1FFC\u2126\u212A\u212B\u2132\u2160-\u216F\u2183\u24B6-\u24CF\u2C00-\u2C2E\u2C60\u2C62-\u2C64\u2C67\u2C69\u2C6B\u2C6D-\u2C70\u2C72\u2C75\u2C7E-\u2C80\u2C82\u2C84\u2C86\u2C88\u2C8A\u2C8C\u2C8E\u2C90\u2C92\u2C94\u2C96\u2C98\u2C9A\u2C9C\u2C9E\u2CA0\u2CA2\u2CA4\u2CA6\u2CA8\u2CAA\u2CAC\u2CAE\u2CB0\u2CB2\u2CB4\u2CB6\u2CB8\u2CBA\u2CBC\u2CBE\u2CC0\u2CC2\u2CC4\u2CC6\u2CC8\u2CCA\u2CCC\u2CCE\u2CD0\u2CD2\u2CD4\u2CD6\u2CD8\u2CDA\u2CDC\u2CDE\u2CE0\u2CE2\u2CEB\u2CED\u2CF2\uA640\uA642\uA644\uA646\uA648\uA64A\uA64C\uA64E\uA650\uA652\uA654\uA656\uA658\uA65A\uA65C\uA65E\uA660\uA662\uA664\uA666\uA668\uA66A\uA66C\uA680\uA682\uA684\uA686\uA688\uA68A\uA68C\uA68E\uA690\uA692\uA694\uA696\uA698\uA69A\uA722\uA724\uA726\uA728\uA72A\uA72C\uA72E\uA732\uA734\uA736\uA738\uA73A\uA73C\uA73E\uA740\uA742\uA744\uA746\uA748\uA74A\uA74C\uA74E\uA750\uA752\uA754\uA756\uA758\uA75A\uA75C\uA75E\uA760\uA762\uA764\uA766\uA768\uA76A\uA76C\uA76E\uA779\uA77B\uA77D\uA77E\uA780\uA782\uA784\uA786\uA78B\uA78D\uA790\uA792\uA796\uA798\uA79A\uA79C\uA79E\uA7A0\uA7A2\uA7A4\uA7A6\uA7A8\uA7AA-\uA7AE\uA7B0-\uA7B4\uA7B6\uA7B8\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF21-\uFF3A',
  'astral': '\uD801[\uDC00-\uDC27\uDCB0-\uDCD3]|\uD803[\uDC80-\uDCB2]|\uD806[\uDCA0-\uDCBF]|\uD81B[\uDE40-\uDE5F]|\uD83A[\uDD00-\uDD21]'
}, {
  'name': 'Changes_When_Casemapped',
  'bmp': 'A-Za-z\xB5\xC0-\xD6\xD8-\xF6\xF8-\u0137\u0139-\u018C\u018E-\u019A\u019C-\u01A9\u01AC-\u01B9\u01BC\u01BD\u01BF\u01C4-\u0220\u0222-\u0233\u023A-\u0254\u0256\u0257\u0259\u025B\u025C\u0260\u0261\u0263\u0265\u0266\u0268-\u026C\u026F\u0271\u0272\u0275\u027D\u0280\u0283\u0287-\u028C\u0292\u029D\u029E\u0345\u0370-\u0373\u0376\u0377\u037B-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03D1\u03D5-\u03F5\u03F7-\u03FB\u03FD-\u0481\u048A-\u052F\u0531-\u0556\u0561-\u0587\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FD-\u10FF\u13A0-\u13F5\u13F8-\u13FD\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1D79\u1D7D\u1E00-\u1E9B\u1E9E\u1EA0-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2126\u212A\u212B\u2132\u214E\u2160-\u217F\u2183\u2184\u24B6-\u24E9\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2C70\u2C72\u2C73\u2C75\u2C76\u2C7E-\u2CE3\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA640-\uA66D\uA680-\uA69B\uA722-\uA72F\uA732-\uA76F\uA779-\uA787\uA78B-\uA78D\uA790-\uA793\uA796-\uA7AE\uA7B0-\uA7B9\uAB53\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF21-\uFF3A\uFF41-\uFF5A',
  'astral': '\uD801[\uDC00-\uDC4F\uDCB0-\uDCD3\uDCD8-\uDCFB]|\uD803[\uDC80-\uDCB2\uDCC0-\uDCF2]|\uD806[\uDCA0-\uDCDF]|\uD81B[\uDE40-\uDE7F]|\uD83A[\uDD00-\uDD43]'
}, {
  'name': 'Changes_When_Lowercased',
  'bmp': 'A-Z\xC0-\xD6\xD8-\xDE\u0100\u0102\u0104\u0106\u0108\u010A\u010C\u010E\u0110\u0112\u0114\u0116\u0118\u011A\u011C\u011E\u0120\u0122\u0124\u0126\u0128\u012A\u012C\u012E\u0130\u0132\u0134\u0136\u0139\u013B\u013D\u013F\u0141\u0143\u0145\u0147\u014A\u014C\u014E\u0150\u0152\u0154\u0156\u0158\u015A\u015C\u015E\u0160\u0162\u0164\u0166\u0168\u016A\u016C\u016E\u0170\u0172\u0174\u0176\u0178\u0179\u017B\u017D\u0181\u0182\u0184\u0186\u0187\u0189-\u018B\u018E-\u0191\u0193\u0194\u0196-\u0198\u019C\u019D\u019F\u01A0\u01A2\u01A4\u01A6\u01A7\u01A9\u01AC\u01AE\u01AF\u01B1-\u01B3\u01B5\u01B7\u01B8\u01BC\u01C4\u01C5\u01C7\u01C8\u01CA\u01CB\u01CD\u01CF\u01D1\u01D3\u01D5\u01D7\u01D9\u01DB\u01DE\u01E0\u01E2\u01E4\u01E6\u01E8\u01EA\u01EC\u01EE\u01F1\u01F2\u01F4\u01F6-\u01F8\u01FA\u01FC\u01FE\u0200\u0202\u0204\u0206\u0208\u020A\u020C\u020E\u0210\u0212\u0214\u0216\u0218\u021A\u021C\u021E\u0220\u0222\u0224\u0226\u0228\u022A\u022C\u022E\u0230\u0232\u023A\u023B\u023D\u023E\u0241\u0243-\u0246\u0248\u024A\u024C\u024E\u0370\u0372\u0376\u037F\u0386\u0388-\u038A\u038C\u038E\u038F\u0391-\u03A1\u03A3-\u03AB\u03CF\u03D8\u03DA\u03DC\u03DE\u03E0\u03E2\u03E4\u03E6\u03E8\u03EA\u03EC\u03EE\u03F4\u03F7\u03F9\u03FA\u03FD-\u042F\u0460\u0462\u0464\u0466\u0468\u046A\u046C\u046E\u0470\u0472\u0474\u0476\u0478\u047A\u047C\u047E\u0480\u048A\u048C\u048E\u0490\u0492\u0494\u0496\u0498\u049A\u049C\u049E\u04A0\u04A2\u04A4\u04A6\u04A8\u04AA\u04AC\u04AE\u04B0\u04B2\u04B4\u04B6\u04B8\u04BA\u04BC\u04BE\u04C0\u04C1\u04C3\u04C5\u04C7\u04C9\u04CB\u04CD\u04D0\u04D2\u04D4\u04D6\u04D8\u04DA\u04DC\u04DE\u04E0\u04E2\u04E4\u04E6\u04E8\u04EA\u04EC\u04EE\u04F0\u04F2\u04F4\u04F6\u04F8\u04FA\u04FC\u04FE\u0500\u0502\u0504\u0506\u0508\u050A\u050C\u050E\u0510\u0512\u0514\u0516\u0518\u051A\u051C\u051E\u0520\u0522\u0524\u0526\u0528\u052A\u052C\u052E\u0531-\u0556\u10A0-\u10C5\u10C7\u10CD\u13A0-\u13F5\u1C90-\u1CBA\u1CBD-\u1CBF\u1E00\u1E02\u1E04\u1E06\u1E08\u1E0A\u1E0C\u1E0E\u1E10\u1E12\u1E14\u1E16\u1E18\u1E1A\u1E1C\u1E1E\u1E20\u1E22\u1E24\u1E26\u1E28\u1E2A\u1E2C\u1E2E\u1E30\u1E32\u1E34\u1E36\u1E38\u1E3A\u1E3C\u1E3E\u1E40\u1E42\u1E44\u1E46\u1E48\u1E4A\u1E4C\u1E4E\u1E50\u1E52\u1E54\u1E56\u1E58\u1E5A\u1E5C\u1E5E\u1E60\u1E62\u1E64\u1E66\u1E68\u1E6A\u1E6C\u1E6E\u1E70\u1E72\u1E74\u1E76\u1E78\u1E7A\u1E7C\u1E7E\u1E80\u1E82\u1E84\u1E86\u1E88\u1E8A\u1E8C\u1E8E\u1E90\u1E92\u1E94\u1E9E\u1EA0\u1EA2\u1EA4\u1EA6\u1EA8\u1EAA\u1EAC\u1EAE\u1EB0\u1EB2\u1EB4\u1EB6\u1EB8\u1EBA\u1EBC\u1EBE\u1EC0\u1EC2\u1EC4\u1EC6\u1EC8\u1ECA\u1ECC\u1ECE\u1ED0\u1ED2\u1ED4\u1ED6\u1ED8\u1EDA\u1EDC\u1EDE\u1EE0\u1EE2\u1EE4\u1EE6\u1EE8\u1EEA\u1EEC\u1EEE\u1EF0\u1EF2\u1EF4\u1EF6\u1EF8\u1EFA\u1EFC\u1EFE\u1F08-\u1F0F\u1F18-\u1F1D\u1F28-\u1F2F\u1F38-\u1F3F\u1F48-\u1F4D\u1F59\u1F5B\u1F5D\u1F5F\u1F68-\u1F6F\u1F88-\u1F8F\u1F98-\u1F9F\u1FA8-\u1FAF\u1FB8-\u1FBC\u1FC8-\u1FCC\u1FD8-\u1FDB\u1FE8-\u1FEC\u1FF8-\u1FFC\u2126\u212A\u212B\u2132\u2160-\u216F\u2183\u24B6-\u24CF\u2C00-\u2C2E\u2C60\u2C62-\u2C64\u2C67\u2C69\u2C6B\u2C6D-\u2C70\u2C72\u2C75\u2C7E-\u2C80\u2C82\u2C84\u2C86\u2C88\u2C8A\u2C8C\u2C8E\u2C90\u2C92\u2C94\u2C96\u2C98\u2C9A\u2C9C\u2C9E\u2CA0\u2CA2\u2CA4\u2CA6\u2CA8\u2CAA\u2CAC\u2CAE\u2CB0\u2CB2\u2CB4\u2CB6\u2CB8\u2CBA\u2CBC\u2CBE\u2CC0\u2CC2\u2CC4\u2CC6\u2CC8\u2CCA\u2CCC\u2CCE\u2CD0\u2CD2\u2CD4\u2CD6\u2CD8\u2CDA\u2CDC\u2CDE\u2CE0\u2CE2\u2CEB\u2CED\u2CF2\uA640\uA642\uA644\uA646\uA648\uA64A\uA64C\uA64E\uA650\uA652\uA654\uA656\uA658\uA65A\uA65C\uA65E\uA660\uA662\uA664\uA666\uA668\uA66A\uA66C\uA680\uA682\uA684\uA686\uA688\uA68A\uA68C\uA68E\uA690\uA692\uA694\uA696\uA698\uA69A\uA722\uA724\uA726\uA728\uA72A\uA72C\uA72E\uA732\uA734\uA736\uA738\uA73A\uA73C\uA73E\uA740\uA742\uA744\uA746\uA748\uA74A\uA74C\uA74E\uA750\uA752\uA754\uA756\uA758\uA75A\uA75C\uA75E\uA760\uA762\uA764\uA766\uA768\uA76A\uA76C\uA76E\uA779\uA77B\uA77D\uA77E\uA780\uA782\uA784\uA786\uA78B\uA78D\uA790\uA792\uA796\uA798\uA79A\uA79C\uA79E\uA7A0\uA7A2\uA7A4\uA7A6\uA7A8\uA7AA-\uA7AE\uA7B0-\uA7B4\uA7B6\uA7B8\uFF21-\uFF3A',
  'astral': '\uD801[\uDC00-\uDC27\uDCB0-\uDCD3]|\uD803[\uDC80-\uDCB2]|\uD806[\uDCA0-\uDCBF]|\uD81B[\uDE40-\uDE5F]|\uD83A[\uDD00-\uDD21]'
}, {
  'name': 'Changes_When_NFKC_Casefolded',
  'bmp': 'A-Z\xA0\xA8\xAA\xAD\xAF\xB2-\xB5\xB8-\xBA\xBC-\xBE\xC0-\xD6\xD8-\xDF\u0100\u0102\u0104\u0106\u0108\u010A\u010C\u010E\u0110\u0112\u0114\u0116\u0118\u011A\u011C\u011E\u0120\u0122\u0124\u0126\u0128\u012A\u012C\u012E\u0130\u0132-\u0134\u0136\u0139\u013B\u013D\u013F-\u0141\u0143\u0145\u0147\u0149\u014A\u014C\u014E\u0150\u0152\u0154\u0156\u0158\u015A\u015C\u015E\u0160\u0162\u0164\u0166\u0168\u016A\u016C\u016E\u0170\u0172\u0174\u0176\u0178\u0179\u017B\u017D\u017F\u0181\u0182\u0184\u0186\u0187\u0189-\u018B\u018E-\u0191\u0193\u0194\u0196-\u0198\u019C\u019D\u019F\u01A0\u01A2\u01A4\u01A6\u01A7\u01A9\u01AC\u01AE\u01AF\u01B1-\u01B3\u01B5\u01B7\u01B8\u01BC\u01C4-\u01CD\u01CF\u01D1\u01D3\u01D5\u01D7\u01D9\u01DB\u01DE\u01E0\u01E2\u01E4\u01E6\u01E8\u01EA\u01EC\u01EE\u01F1-\u01F4\u01F6-\u01F8\u01FA\u01FC\u01FE\u0200\u0202\u0204\u0206\u0208\u020A\u020C\u020E\u0210\u0212\u0214\u0216\u0218\u021A\u021C\u021E\u0220\u0222\u0224\u0226\u0228\u022A\u022C\u022E\u0230\u0232\u023A\u023B\u023D\u023E\u0241\u0243-\u0246\u0248\u024A\u024C\u024E\u02B0-\u02B8\u02D8-\u02DD\u02E0-\u02E4\u0340\u0341\u0343-\u0345\u034F\u0370\u0372\u0374\u0376\u037A\u037E\u037F\u0384-\u038A\u038C\u038E\u038F\u0391-\u03A1\u03A3-\u03AB\u03C2\u03CF-\u03D6\u03D8\u03DA\u03DC\u03DE\u03E0\u03E2\u03E4\u03E6\u03E8\u03EA\u03EC\u03EE\u03F0-\u03F2\u03F4\u03F5\u03F7\u03F9\u03FA\u03FD-\u042F\u0460\u0462\u0464\u0466\u0468\u046A\u046C\u046E\u0470\u0472\u0474\u0476\u0478\u047A\u047C\u047E\u0480\u048A\u048C\u048E\u0490\u0492\u0494\u0496\u0498\u049A\u049C\u049E\u04A0\u04A2\u04A4\u04A6\u04A8\u04AA\u04AC\u04AE\u04B0\u04B2\u04B4\u04B6\u04B8\u04BA\u04BC\u04BE\u04C0\u04C1\u04C3\u04C5\u04C7\u04C9\u04CB\u04CD\u04D0\u04D2\u04D4\u04D6\u04D8\u04DA\u04DC\u04DE\u04E0\u04E2\u04E4\u04E6\u04E8\u04EA\u04EC\u04EE\u04F0\u04F2\u04F4\u04F6\u04F8\u04FA\u04FC\u04FE\u0500\u0502\u0504\u0506\u0508\u050A\u050C\u050E\u0510\u0512\u0514\u0516\u0518\u051A\u051C\u051E\u0520\u0522\u0524\u0526\u0528\u052A\u052C\u052E\u0531-\u0556\u0587\u061C\u0675-\u0678\u0958-\u095F\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B5C\u0B5D\u0E33\u0EB3\u0EDC\u0EDD\u0F0C\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F73\u0F75-\u0F79\u0F81\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\u10A0-\u10C5\u10C7\u10CD\u10FC\u115F\u1160\u13F8-\u13FD\u17B4\u17B5\u180B-\u180E\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1D2C-\u1D2E\u1D30-\u1D3A\u1D3C-\u1D4D\u1D4F-\u1D6A\u1D78\u1D9B-\u1DBF\u1E00\u1E02\u1E04\u1E06\u1E08\u1E0A\u1E0C\u1E0E\u1E10\u1E12\u1E14\u1E16\u1E18\u1E1A\u1E1C\u1E1E\u1E20\u1E22\u1E24\u1E26\u1E28\u1E2A\u1E2C\u1E2E\u1E30\u1E32\u1E34\u1E36\u1E38\u1E3A\u1E3C\u1E3E\u1E40\u1E42\u1E44\u1E46\u1E48\u1E4A\u1E4C\u1E4E\u1E50\u1E52\u1E54\u1E56\u1E58\u1E5A\u1E5C\u1E5E\u1E60\u1E62\u1E64\u1E66\u1E68\u1E6A\u1E6C\u1E6E\u1E70\u1E72\u1E74\u1E76\u1E78\u1E7A\u1E7C\u1E7E\u1E80\u1E82\u1E84\u1E86\u1E88\u1E8A\u1E8C\u1E8E\u1E90\u1E92\u1E94\u1E9A\u1E9B\u1E9E\u1EA0\u1EA2\u1EA4\u1EA6\u1EA8\u1EAA\u1EAC\u1EAE\u1EB0\u1EB2\u1EB4\u1EB6\u1EB8\u1EBA\u1EBC\u1EBE\u1EC0\u1EC2\u1EC4\u1EC6\u1EC8\u1ECA\u1ECC\u1ECE\u1ED0\u1ED2\u1ED4\u1ED6\u1ED8\u1EDA\u1EDC\u1EDE\u1EE0\u1EE2\u1EE4\u1EE6\u1EE8\u1EEA\u1EEC\u1EEE\u1EF0\u1EF2\u1EF4\u1EF6\u1EF8\u1EFA\u1EFC\u1EFE\u1F08-\u1F0F\u1F18-\u1F1D\u1F28-\u1F2F\u1F38-\u1F3F\u1F48-\u1F4D\u1F59\u1F5B\u1F5D\u1F5F\u1F68-\u1F6F\u1F71\u1F73\u1F75\u1F77\u1F79\u1F7B\u1F7D\u1F80-\u1FAF\u1FB2-\u1FB4\u1FB7-\u1FC4\u1FC7-\u1FCF\u1FD3\u1FD8-\u1FDB\u1FDD-\u1FDF\u1FE3\u1FE8-\u1FEF\u1FF2-\u1FF4\u1FF7-\u1FFE\u2000-\u200F\u2011\u2017\u2024-\u2026\u202A-\u202F\u2033\u2034\u2036\u2037\u203C\u203E\u2047-\u2049\u2057\u205F-\u2071\u2074-\u208E\u2090-\u209C\u20A8\u2100-\u2103\u2105-\u2107\u2109-\u2113\u2115\u2116\u2119-\u211D\u2120-\u2122\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213B-\u2140\u2145-\u2149\u2150-\u217F\u2183\u2189\u222C\u222D\u222F\u2230\u2329\u232A\u2460-\u24EA\u2A0C\u2A74-\u2A76\u2ADC\u2C00-\u2C2E\u2C60\u2C62-\u2C64\u2C67\u2C69\u2C6B\u2C6D-\u2C70\u2C72\u2C75\u2C7C-\u2C80\u2C82\u2C84\u2C86\u2C88\u2C8A\u2C8C\u2C8E\u2C90\u2C92\u2C94\u2C96\u2C98\u2C9A\u2C9C\u2C9E\u2CA0\u2CA2\u2CA4\u2CA6\u2CA8\u2CAA\u2CAC\u2CAE\u2CB0\u2CB2\u2CB4\u2CB6\u2CB8\u2CBA\u2CBC\u2CBE\u2CC0\u2CC2\u2CC4\u2CC6\u2CC8\u2CCA\u2CCC\u2CCE\u2CD0\u2CD2\u2CD4\u2CD6\u2CD8\u2CDA\u2CDC\u2CDE\u2CE0\u2CE2\u2CEB\u2CED\u2CF2\u2D6F\u2E9F\u2EF3\u2F00-\u2FD5\u3000\u3036\u3038-\u303A\u309B\u309C\u309F\u30FF\u3131-\u318E\u3192-\u319F\u3200-\u321E\u3220-\u3247\u3250-\u327E\u3280-\u32FE\u3300-\u33FF\uA640\uA642\uA644\uA646\uA648\uA64A\uA64C\uA64E\uA650\uA652\uA654\uA656\uA658\uA65A\uA65C\uA65E\uA660\uA662\uA664\uA666\uA668\uA66A\uA66C\uA680\uA682\uA684\uA686\uA688\uA68A\uA68C\uA68E\uA690\uA692\uA694\uA696\uA698\uA69A\uA69C\uA69D\uA722\uA724\uA726\uA728\uA72A\uA72C\uA72E\uA732\uA734\uA736\uA738\uA73A\uA73C\uA73E\uA740\uA742\uA744\uA746\uA748\uA74A\uA74C\uA74E\uA750\uA752\uA754\uA756\uA758\uA75A\uA75C\uA75E\uA760\uA762\uA764\uA766\uA768\uA76A\uA76C\uA76E\uA770\uA779\uA77B\uA77D\uA77E\uA780\uA782\uA784\uA786\uA78B\uA78D\uA790\uA792\uA796\uA798\uA79A\uA79C\uA79E\uA7A0\uA7A2\uA7A4\uA7A6\uA7A8\uA7AA-\uA7AE\uA7B0-\uA7B4\uA7B6\uA7B8\uA7F8\uA7F9\uAB5C-\uAB5F\uAB70-\uABBF\uF900-\uFA0D\uFA10\uFA12\uFA15-\uFA1E\uFA20\uFA22\uFA25\uFA26\uFA2A-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFC\uFE00-\uFE19\uFE30-\uFE44\uFE47-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFE70-\uFE72\uFE74\uFE76-\uFEFC\uFEFF\uFF01-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFF0-\uFFF8',
  'astral': '\uD801[\uDC00-\uDC27\uDCB0-\uDCD3]|\uD803[\uDC80-\uDCB2]|\uD806[\uDCA0-\uDCBF]|\uD81B[\uDE40-\uDE5F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD5E-\uDD64\uDD73-\uDD7A\uDDBB-\uDDC0]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDFCB\uDFCE-\uDFFF]|\uD83A[\uDD00-\uDD21]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD83C[\uDD00-\uDD0A\uDD10-\uDD2E\uDD30-\uDD4F\uDD6A\uDD6B\uDD90\uDE00-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51]|\uD87E[\uDC00-\uDE1D]|[\uDB40-\uDB43][\uDC00-\uDFFF]'
}, {
  'name': 'Changes_When_Titlecased',
  'bmp': 'a-z\xB5\xDF-\xF6\xF8-\xFF\u0101\u0103\u0105\u0107\u0109\u010B\u010D\u010F\u0111\u0113\u0115\u0117\u0119\u011B\u011D\u011F\u0121\u0123\u0125\u0127\u0129\u012B\u012D\u012F\u0131\u0133\u0135\u0137\u013A\u013C\u013E\u0140\u0142\u0144\u0146\u0148\u0149\u014B\u014D\u014F\u0151\u0153\u0155\u0157\u0159\u015B\u015D\u015F\u0161\u0163\u0165\u0167\u0169\u016B\u016D\u016F\u0171\u0173\u0175\u0177\u017A\u017C\u017E-\u0180\u0183\u0185\u0188\u018C\u0192\u0195\u0199\u019A\u019E\u01A1\u01A3\u01A5\u01A8\u01AD\u01B0\u01B4\u01B6\u01B9\u01BD\u01BF\u01C4\u01C6\u01C7\u01C9\u01CA\u01CC\u01CE\u01D0\u01D2\u01D4\u01D6\u01D8\u01DA\u01DC\u01DD\u01DF\u01E1\u01E3\u01E5\u01E7\u01E9\u01EB\u01ED\u01EF-\u01F1\u01F3\u01F5\u01F9\u01FB\u01FD\u01FF\u0201\u0203\u0205\u0207\u0209\u020B\u020D\u020F\u0211\u0213\u0215\u0217\u0219\u021B\u021D\u021F\u0223\u0225\u0227\u0229\u022B\u022D\u022F\u0231\u0233\u023C\u023F\u0240\u0242\u0247\u0249\u024B\u024D\u024F-\u0254\u0256\u0257\u0259\u025B\u025C\u0260\u0261\u0263\u0265\u0266\u0268-\u026C\u026F\u0271\u0272\u0275\u027D\u0280\u0283\u0287-\u028C\u0292\u029D\u029E\u0345\u0371\u0373\u0377\u037B-\u037D\u0390\u03AC-\u03CE\u03D0\u03D1\u03D5-\u03D7\u03D9\u03DB\u03DD\u03DF\u03E1\u03E3\u03E5\u03E7\u03E9\u03EB\u03ED\u03EF-\u03F3\u03F5\u03F8\u03FB\u0430-\u045F\u0461\u0463\u0465\u0467\u0469\u046B\u046D\u046F\u0471\u0473\u0475\u0477\u0479\u047B\u047D\u047F\u0481\u048B\u048D\u048F\u0491\u0493\u0495\u0497\u0499\u049B\u049D\u049F\u04A1\u04A3\u04A5\u04A7\u04A9\u04AB\u04AD\u04AF\u04B1\u04B3\u04B5\u04B7\u04B9\u04BB\u04BD\u04BF\u04C2\u04C4\u04C6\u04C8\u04CA\u04CC\u04CE\u04CF\u04D1\u04D3\u04D5\u04D7\u04D9\u04DB\u04DD\u04DF\u04E1\u04E3\u04E5\u04E7\u04E9\u04EB\u04ED\u04EF\u04F1\u04F3\u04F5\u04F7\u04F9\u04FB\u04FD\u04FF\u0501\u0503\u0505\u0507\u0509\u050B\u050D\u050F\u0511\u0513\u0515\u0517\u0519\u051B\u051D\u051F\u0521\u0523\u0525\u0527\u0529\u052B\u052D\u052F\u0561-\u0587\u13F8-\u13FD\u1C80-\u1C88\u1D79\u1D7D\u1E01\u1E03\u1E05\u1E07\u1E09\u1E0B\u1E0D\u1E0F\u1E11\u1E13\u1E15\u1E17\u1E19\u1E1B\u1E1D\u1E1F\u1E21\u1E23\u1E25\u1E27\u1E29\u1E2B\u1E2D\u1E2F\u1E31\u1E33\u1E35\u1E37\u1E39\u1E3B\u1E3D\u1E3F\u1E41\u1E43\u1E45\u1E47\u1E49\u1E4B\u1E4D\u1E4F\u1E51\u1E53\u1E55\u1E57\u1E59\u1E5B\u1E5D\u1E5F\u1E61\u1E63\u1E65\u1E67\u1E69\u1E6B\u1E6D\u1E6F\u1E71\u1E73\u1E75\u1E77\u1E79\u1E7B\u1E7D\u1E7F\u1E81\u1E83\u1E85\u1E87\u1E89\u1E8B\u1E8D\u1E8F\u1E91\u1E93\u1E95-\u1E9B\u1EA1\u1EA3\u1EA5\u1EA7\u1EA9\u1EAB\u1EAD\u1EAF\u1EB1\u1EB3\u1EB5\u1EB7\u1EB9\u1EBB\u1EBD\u1EBF\u1EC1\u1EC3\u1EC5\u1EC7\u1EC9\u1ECB\u1ECD\u1ECF\u1ED1\u1ED3\u1ED5\u1ED7\u1ED9\u1EDB\u1EDD\u1EDF\u1EE1\u1EE3\u1EE5\u1EE7\u1EE9\u1EEB\u1EED\u1EEF\u1EF1\u1EF3\u1EF5\u1EF7\u1EF9\u1EFB\u1EFD\u1EFF-\u1F07\u1F10-\u1F15\u1F20-\u1F27\u1F30-\u1F37\u1F40-\u1F45\u1F50-\u1F57\u1F60-\u1F67\u1F70-\u1F7D\u1F80-\u1F87\u1F90-\u1F97\u1FA0-\u1FA7\u1FB0-\u1FB4\u1FB6\u1FB7\u1FBE\u1FC2-\u1FC4\u1FC6\u1FC7\u1FD0-\u1FD3\u1FD6\u1FD7\u1FE0-\u1FE7\u1FF2-\u1FF4\u1FF6\u1FF7\u214E\u2170-\u217F\u2184\u24D0-\u24E9\u2C30-\u2C5E\u2C61\u2C65\u2C66\u2C68\u2C6A\u2C6C\u2C73\u2C76\u2C81\u2C83\u2C85\u2C87\u2C89\u2C8B\u2C8D\u2C8F\u2C91\u2C93\u2C95\u2C97\u2C99\u2C9B\u2C9D\u2C9F\u2CA1\u2CA3\u2CA5\u2CA7\u2CA9\u2CAB\u2CAD\u2CAF\u2CB1\u2CB3\u2CB5\u2CB7\u2CB9\u2CBB\u2CBD\u2CBF\u2CC1\u2CC3\u2CC5\u2CC7\u2CC9\u2CCB\u2CCD\u2CCF\u2CD1\u2CD3\u2CD5\u2CD7\u2CD9\u2CDB\u2CDD\u2CDF\u2CE1\u2CE3\u2CEC\u2CEE\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA641\uA643\uA645\uA647\uA649\uA64B\uA64D\uA64F\uA651\uA653\uA655\uA657\uA659\uA65B\uA65D\uA65F\uA661\uA663\uA665\uA667\uA669\uA66B\uA66D\uA681\uA683\uA685\uA687\uA689\uA68B\uA68D\uA68F\uA691\uA693\uA695\uA697\uA699\uA69B\uA723\uA725\uA727\uA729\uA72B\uA72D\uA72F\uA733\uA735\uA737\uA739\uA73B\uA73D\uA73F\uA741\uA743\uA745\uA747\uA749\uA74B\uA74D\uA74F\uA751\uA753\uA755\uA757\uA759\uA75B\uA75D\uA75F\uA761\uA763\uA765\uA767\uA769\uA76B\uA76D\uA76F\uA77A\uA77C\uA77F\uA781\uA783\uA785\uA787\uA78C\uA791\uA793\uA797\uA799\uA79B\uA79D\uA79F\uA7A1\uA7A3\uA7A5\uA7A7\uA7A9\uA7B5\uA7B7\uA7B9\uAB53\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF41-\uFF5A',
  'astral': '\uD801[\uDC28-\uDC4F\uDCD8-\uDCFB]|\uD803[\uDCC0-\uDCF2]|\uD806[\uDCC0-\uDCDF]|\uD81B[\uDE60-\uDE7F]|\uD83A[\uDD22-\uDD43]'
}, {
  'name': 'Changes_When_Uppercased',
  'bmp': 'a-z\xB5\xDF-\xF6\xF8-\xFF\u0101\u0103\u0105\u0107\u0109\u010B\u010D\u010F\u0111\u0113\u0115\u0117\u0119\u011B\u011D\u011F\u0121\u0123\u0125\u0127\u0129\u012B\u012D\u012F\u0131\u0133\u0135\u0137\u013A\u013C\u013E\u0140\u0142\u0144\u0146\u0148\u0149\u014B\u014D\u014F\u0151\u0153\u0155\u0157\u0159\u015B\u015D\u015F\u0161\u0163\u0165\u0167\u0169\u016B\u016D\u016F\u0171\u0173\u0175\u0177\u017A\u017C\u017E-\u0180\u0183\u0185\u0188\u018C\u0192\u0195\u0199\u019A\u019E\u01A1\u01A3\u01A5\u01A8\u01AD\u01B0\u01B4\u01B6\u01B9\u01BD\u01BF\u01C5\u01C6\u01C8\u01C9\u01CB\u01CC\u01CE\u01D0\u01D2\u01D4\u01D6\u01D8\u01DA\u01DC\u01DD\u01DF\u01E1\u01E3\u01E5\u01E7\u01E9\u01EB\u01ED\u01EF\u01F0\u01F2\u01F3\u01F5\u01F9\u01FB\u01FD\u01FF\u0201\u0203\u0205\u0207\u0209\u020B\u020D\u020F\u0211\u0213\u0215\u0217\u0219\u021B\u021D\u021F\u0223\u0225\u0227\u0229\u022B\u022D\u022F\u0231\u0233\u023C\u023F\u0240\u0242\u0247\u0249\u024B\u024D\u024F-\u0254\u0256\u0257\u0259\u025B\u025C\u0260\u0261\u0263\u0265\u0266\u0268-\u026C\u026F\u0271\u0272\u0275\u027D\u0280\u0283\u0287-\u028C\u0292\u029D\u029E\u0345\u0371\u0373\u0377\u037B-\u037D\u0390\u03AC-\u03CE\u03D0\u03D1\u03D5-\u03D7\u03D9\u03DB\u03DD\u03DF\u03E1\u03E3\u03E5\u03E7\u03E9\u03EB\u03ED\u03EF-\u03F3\u03F5\u03F8\u03FB\u0430-\u045F\u0461\u0463\u0465\u0467\u0469\u046B\u046D\u046F\u0471\u0473\u0475\u0477\u0479\u047B\u047D\u047F\u0481\u048B\u048D\u048F\u0491\u0493\u0495\u0497\u0499\u049B\u049D\u049F\u04A1\u04A3\u04A5\u04A7\u04A9\u04AB\u04AD\u04AF\u04B1\u04B3\u04B5\u04B7\u04B9\u04BB\u04BD\u04BF\u04C2\u04C4\u04C6\u04C8\u04CA\u04CC\u04CE\u04CF\u04D1\u04D3\u04D5\u04D7\u04D9\u04DB\u04DD\u04DF\u04E1\u04E3\u04E5\u04E7\u04E9\u04EB\u04ED\u04EF\u04F1\u04F3\u04F5\u04F7\u04F9\u04FB\u04FD\u04FF\u0501\u0503\u0505\u0507\u0509\u050B\u050D\u050F\u0511\u0513\u0515\u0517\u0519\u051B\u051D\u051F\u0521\u0523\u0525\u0527\u0529\u052B\u052D\u052F\u0561-\u0587\u10D0-\u10FA\u10FD-\u10FF\u13F8-\u13FD\u1C80-\u1C88\u1D79\u1D7D\u1E01\u1E03\u1E05\u1E07\u1E09\u1E0B\u1E0D\u1E0F\u1E11\u1E13\u1E15\u1E17\u1E19\u1E1B\u1E1D\u1E1F\u1E21\u1E23\u1E25\u1E27\u1E29\u1E2B\u1E2D\u1E2F\u1E31\u1E33\u1E35\u1E37\u1E39\u1E3B\u1E3D\u1E3F\u1E41\u1E43\u1E45\u1E47\u1E49\u1E4B\u1E4D\u1E4F\u1E51\u1E53\u1E55\u1E57\u1E59\u1E5B\u1E5D\u1E5F\u1E61\u1E63\u1E65\u1E67\u1E69\u1E6B\u1E6D\u1E6F\u1E71\u1E73\u1E75\u1E77\u1E79\u1E7B\u1E7D\u1E7F\u1E81\u1E83\u1E85\u1E87\u1E89\u1E8B\u1E8D\u1E8F\u1E91\u1E93\u1E95-\u1E9B\u1EA1\u1EA3\u1EA5\u1EA7\u1EA9\u1EAB\u1EAD\u1EAF\u1EB1\u1EB3\u1EB5\u1EB7\u1EB9\u1EBB\u1EBD\u1EBF\u1EC1\u1EC3\u1EC5\u1EC7\u1EC9\u1ECB\u1ECD\u1ECF\u1ED1\u1ED3\u1ED5\u1ED7\u1ED9\u1EDB\u1EDD\u1EDF\u1EE1\u1EE3\u1EE5\u1EE7\u1EE9\u1EEB\u1EED\u1EEF\u1EF1\u1EF3\u1EF5\u1EF7\u1EF9\u1EFB\u1EFD\u1EFF-\u1F07\u1F10-\u1F15\u1F20-\u1F27\u1F30-\u1F37\u1F40-\u1F45\u1F50-\u1F57\u1F60-\u1F67\u1F70-\u1F7D\u1F80-\u1FB4\u1FB6\u1FB7\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6\u1FC7\u1FCC\u1FD0-\u1FD3\u1FD6\u1FD7\u1FE0-\u1FE7\u1FF2-\u1FF4\u1FF6\u1FF7\u1FFC\u214E\u2170-\u217F\u2184\u24D0-\u24E9\u2C30-\u2C5E\u2C61\u2C65\u2C66\u2C68\u2C6A\u2C6C\u2C73\u2C76\u2C81\u2C83\u2C85\u2C87\u2C89\u2C8B\u2C8D\u2C8F\u2C91\u2C93\u2C95\u2C97\u2C99\u2C9B\u2C9D\u2C9F\u2CA1\u2CA3\u2CA5\u2CA7\u2CA9\u2CAB\u2CAD\u2CAF\u2CB1\u2CB3\u2CB5\u2CB7\u2CB9\u2CBB\u2CBD\u2CBF\u2CC1\u2CC3\u2CC5\u2CC7\u2CC9\u2CCB\u2CCD\u2CCF\u2CD1\u2CD3\u2CD5\u2CD7\u2CD9\u2CDB\u2CDD\u2CDF\u2CE1\u2CE3\u2CEC\u2CEE\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA641\uA643\uA645\uA647\uA649\uA64B\uA64D\uA64F\uA651\uA653\uA655\uA657\uA659\uA65B\uA65D\uA65F\uA661\uA663\uA665\uA667\uA669\uA66B\uA66D\uA681\uA683\uA685\uA687\uA689\uA68B\uA68D\uA68F\uA691\uA693\uA695\uA697\uA699\uA69B\uA723\uA725\uA727\uA729\uA72B\uA72D\uA72F\uA733\uA735\uA737\uA739\uA73B\uA73D\uA73F\uA741\uA743\uA745\uA747\uA749\uA74B\uA74D\uA74F\uA751\uA753\uA755\uA757\uA759\uA75B\uA75D\uA75F\uA761\uA763\uA765\uA767\uA769\uA76B\uA76D\uA76F\uA77A\uA77C\uA77F\uA781\uA783\uA785\uA787\uA78C\uA791\uA793\uA797\uA799\uA79B\uA79D\uA79F\uA7A1\uA7A3\uA7A5\uA7A7\uA7A9\uA7B5\uA7B7\uA7B9\uAB53\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF41-\uFF5A',
  'astral': '\uD801[\uDC28-\uDC4F\uDCD8-\uDCFB]|\uD803[\uDCC0-\uDCF2]|\uD806[\uDCC0-\uDCDF]|\uD81B[\uDE60-\uDE7F]|\uD83A[\uDD22-\uDD43]'
}, {
  'name': 'Composition_Exclusion',
  'bmp': '\u0958-\u095F\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B5C\u0B5D\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F76\u0F78\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\uFB1D\uFB1F\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4E\u2ADC',
  'astral': '\uD834[\uDD5E-\uDD64\uDDBB-\uDDC0]'
}, {
  'name': 'Dash',
  'bmp': '\\-\u058A\u05BE\u1400\u1806\u2010-\u2015\u2053\u207B\u208B\u2212\u2E17\u2E1A\u2E3A\u2E3B\u2E40\u301C\u3030\u30A0\uFE31\uFE32\uFE58\uFE63\uFF0D'
}, {
  'name': 'Default_Ignorable_Code_Point',
  'bmp': '\xAD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8',
  'astral': '\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|[\uDB40-\uDB43][\uDC00-\uDFFF]'
}, {
  'name': 'Deprecated',
  'bmp': '\u0149\u0673\u0F77\u0F79\u17A3\u17A4\u206A-\u206F\u2329\u232A',
  'astral': '\uDB40\uDC01'
}, {
  'name': 'Diacritic',
  'bmp': '\\^`\xA8\xAF\xB4\xB7\xB8\u02B0-\u034E\u0350-\u0357\u035D-\u0362\u0374\u0375\u037A\u0384\u0385\u0483-\u0487\u0559\u0591-\u05A1\u05A3-\u05BD\u05BF\u05C1\u05C2\u05C4\u064B-\u0652\u0657\u0658\u06DF\u06E0\u06E5\u06E6\u06EA-\u06EC\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F5\u0818\u0819\u08E3-\u08FE\u093C\u094D\u0951-\u0954\u0971\u09BC\u09CD\u0A3C\u0A4D\u0ABC\u0ACD\u0AFD-\u0AFF\u0B3C\u0B4D\u0BCD\u0C4D\u0CBC\u0CCD\u0D3B\u0D3C\u0D4D\u0DCA\u0E47-\u0E4C\u0E4E\u0EC8-\u0ECC\u0F18\u0F19\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F82-\u0F84\u0F86\u0F87\u0FC6\u1037\u1039\u103A\u1087-\u108D\u108F\u109A\u109B\u17C9-\u17D3\u17DD\u1939-\u193B\u1A75-\u1A7C\u1A7F\u1AB0-\u1ABD\u1B34\u1B44\u1B6B-\u1B73\u1BAA\u1BAB\u1C36\u1C37\u1C78-\u1C7D\u1CD0-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1D2C-\u1D6A\u1DC4-\u1DCF\u1DF5-\u1DF9\u1DFD-\u1DFF\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2CEF-\u2CF1\u2E2F\u302A-\u302F\u3099-\u309C\u30FC\uA66F\uA67C\uA67D\uA67F\uA69C\uA69D\uA6F0\uA6F1\uA717-\uA721\uA788\uA7F8\uA7F9\uA8C4\uA8E0-\uA8F1\uA92B-\uA92E\uA953\uA9B3\uA9C0\uA9E5\uAA7B-\uAA7D\uAABF-\uAAC2\uAAF6\uAB5B-\uAB5F\uABEC\uABED\uFB1E\uFE20-\uFE2F\uFF3E\uFF40\uFF70\uFF9E\uFF9F\uFFE3',
  'astral': '\uD800\uDEE0|\uD802[\uDEE5\uDEE6]|\uD803[\uDD22-\uDD27\uDF46-\uDF50]|\uD804[\uDCB9\uDCBA\uDD33\uDD34\uDD73\uDDC0\uDDCA-\uDDCC\uDE35\uDE36\uDEE9\uDEEA\uDF3C\uDF4D\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC42\uDC46\uDCC2\uDCC3\uDDBF\uDDC0\uDE3F\uDEB6\uDEB7\uDF2B]|\uD806[\uDC39\uDC3A\uDE34\uDE47\uDE99]|\uD807[\uDC3F\uDD42\uDD44\uDD45\uDD97]|\uD81A[\uDEF0-\uDEF4]|\uD81B[\uDF8F-\uDF9F]|\uD834[\uDD67-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD]|\uD83A[\uDCD0-\uDCD6\uDD44-\uDD46\uDD48-\uDD4A]'
}, {
  'name': 'Emoji',
  'bmp': '#\\*0-9\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2604\u260E\u2611\u2614\u2615\u2618\u261D\u2620\u2622\u2623\u2626\u262A\u262E\u262F\u2638-\u263A\u2640\u2642\u2648-\u2653\u265F\u2660\u2663\u2665\u2666\u2668\u267B\u267E\u267F\u2692-\u2697\u2699\u269B\u269C\u26A0\u26A1\u26AA\u26AB\u26B0\u26B1\u26BD\u26BE\u26C4\u26C5\u26C8\u26CE\u26CF\u26D1\u26D3\u26D4\u26E9\u26EA\u26F0-\u26F5\u26F7-\u26FA\u26FD\u2702\u2705\u2708-\u270D\u270F\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299',
  'astral': '\uD83C[\uDC04\uDCCF\uDD70\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE02\uDE1A\uDE2F\uDE32-\uDE3A\uDE50\uDE51\uDF00-\uDF21\uDF24-\uDF93\uDF96\uDF97\uDF99-\uDF9B\uDF9E-\uDFF0\uDFF3-\uDFF5\uDFF7-\uDFFF]|\uD83D[\uDC00-\uDCFD\uDCFF-\uDD3D\uDD49-\uDD4E\uDD50-\uDD67\uDD6F\uDD70\uDD73-\uDD7A\uDD87\uDD8A-\uDD8D\uDD90\uDD95\uDD96\uDDA4\uDDA5\uDDA8\uDDB1\uDDB2\uDDBC\uDDC2-\uDDC4\uDDD1-\uDDD3\uDDDC-\uDDDE\uDDE1\uDDE3\uDDE8\uDDEF\uDDF3\uDDFA-\uDE4F\uDE80-\uDEC5\uDECB-\uDED2\uDEE0-\uDEE5\uDEE9\uDEEB\uDEEC\uDEF0\uDEF3-\uDEF9]|\uD83E[\uDD10-\uDD3A\uDD3C-\uDD3E\uDD40-\uDD45\uDD47-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF]'
}, {
  'name': 'Emoji_Component',
  'bmp': '#\\*0-9\u200D\u20E3\uFE0F',
  'astral': '\uD83C[\uDDE6-\uDDFF\uDFFB-\uDFFF]|\uD83E[\uDDB0-\uDDB3]|\uDB40[\uDC20-\uDC7F]'
}, {
  'name': 'Emoji_Modifier',
  'astral': '\uD83C[\uDFFB-\uDFFF]'
}, {
  'name': 'Emoji_Modifier_Base',
  'bmp': '\u261D\u26F9\u270A-\u270D',
  'astral': '\uD83C[\uDF85\uDFC2-\uDFC4\uDFC7\uDFCA-\uDFCC]|\uD83D[\uDC42\uDC43\uDC46-\uDC50\uDC66-\uDC69\uDC6E\uDC70-\uDC78\uDC7C\uDC81-\uDC83\uDC85-\uDC87\uDCAA\uDD74\uDD75\uDD7A\uDD90\uDD95\uDD96\uDE45-\uDE47\uDE4B-\uDE4F\uDEA3\uDEB4-\uDEB6\uDEC0\uDECC]|\uD83E[\uDD18-\uDD1C\uDD1E\uDD1F\uDD26\uDD30-\uDD39\uDD3D\uDD3E\uDDB5\uDDB6\uDDB8\uDDB9\uDDD1-\uDDDD]'
}, {
  'name': 'Emoji_Presentation',
  'bmp': '\u231A\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55',
  'astral': '\uD83C[\uDC04\uDCCF\uDD8E\uDD91-\uDD9A\uDDE6-\uDDFF\uDE01\uDE1A\uDE2F\uDE32-\uDE36\uDE38-\uDE3A\uDE50\uDE51\uDF00-\uDF20\uDF2D-\uDF35\uDF37-\uDF7C\uDF7E-\uDF93\uDFA0-\uDFCA\uDFCF-\uDFD3\uDFE0-\uDFF0\uDFF4\uDFF8-\uDFFF]|\uD83D[\uDC00-\uDC3E\uDC40\uDC42-\uDCFC\uDCFF-\uDD3D\uDD4B-\uDD4E\uDD50-\uDD67\uDD7A\uDD95\uDD96\uDDA4\uDDFB-\uDE4F\uDE80-\uDEC5\uDECC\uDED0-\uDED2\uDEEB\uDEEC\uDEF4-\uDEF9]|\uD83E[\uDD10-\uDD3A\uDD3C-\uDD3E\uDD40-\uDD45\uDD47-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF]'
}, {
  'name': 'Expands_On_NFC',
  'bmp': '\u0344\u0958-\u095F\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B5C\u0B5D\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F73\u0F75\u0F76\u0F78\u0F81\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\u2ADC\uFB1D\uFB1F\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4E',
  'astral': '\uD834[\uDD5E-\uDD64\uDDBB-\uDDC0]'
}, {
  'name': 'Expands_On_NFD',
  'bmp': '\xC0-\xC5\xC7-\xCF\xD1-\xD6\xD9-\xDD\xE0-\xE5\xE7-\xEF\xF1-\xF6\xF9-\xFD\xFF-\u010F\u0112-\u0125\u0128-\u0130\u0134-\u0137\u0139-\u013E\u0143-\u0148\u014C-\u0151\u0154-\u0165\u0168-\u017E\u01A0\u01A1\u01AF\u01B0\u01CD-\u01DC\u01DE-\u01E3\u01E6-\u01F0\u01F4\u01F5\u01F8-\u021B\u021E\u021F\u0226-\u0233\u0344\u0385\u0386\u0388-\u038A\u038C\u038E-\u0390\u03AA-\u03B0\u03CA-\u03CE\u03D3\u03D4\u0400\u0401\u0403\u0407\u040C-\u040E\u0419\u0439\u0450\u0451\u0453\u0457\u045C-\u045E\u0476\u0477\u04C1\u04C2\u04D0-\u04D3\u04D6\u04D7\u04DA-\u04DF\u04E2-\u04E7\u04EA-\u04F5\u04F8\u04F9\u0622-\u0626\u06C0\u06C2\u06D3\u0929\u0931\u0934\u0958-\u095F\u09CB\u09CC\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B48\u0B4B\u0B4C\u0B5C\u0B5D\u0B94\u0BCA-\u0BCC\u0C48\u0CC0\u0CC7\u0CC8\u0CCA\u0CCB\u0D4A-\u0D4C\u0DDA\u0DDC-\u0DDE\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F73\u0F75\u0F76\u0F78\u0F81\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\u1026\u1B06\u1B08\u1B0A\u1B0C\u1B0E\u1B12\u1B3B\u1B3D\u1B40\u1B41\u1B43\u1E00-\u1E99\u1E9B\u1EA0-\u1EF9\u1F00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FC1-\u1FC4\u1FC6-\u1FD3\u1FD6-\u1FDB\u1FDD-\u1FEE\u1FF2-\u1FF4\u1FF6-\u1FFC\u212B\u219A\u219B\u21AE\u21CD-\u21CF\u2204\u2209\u220C\u2224\u2226\u2241\u2244\u2247\u2249\u2260\u2262\u226D-\u2271\u2274\u2275\u2278\u2279\u2280\u2281\u2284\u2285\u2288\u2289\u22AC-\u22AF\u22E0-\u22E3\u22EA-\u22ED\u2ADC\u304C\u304E\u3050\u3052\u3054\u3056\u3058\u305A\u305C\u305E\u3060\u3062\u3065\u3067\u3069\u3070\u3071\u3073\u3074\u3076\u3077\u3079\u307A\u307C\u307D\u3094\u309E\u30AC\u30AE\u30B0\u30B2\u30B4\u30B6\u30B8\u30BA\u30BC\u30BE\u30C0\u30C2\u30C5\u30C7\u30C9\u30D0\u30D1\u30D3\u30D4\u30D6\u30D7\u30D9\u30DA\u30DC\u30DD\u30F4\u30F7-\u30FA\u30FE\uAC00-\uD7A3\uFB1D\uFB1F\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4E',
  'astral': '\uD804[\uDC9A\uDC9C\uDCAB\uDD2E\uDD2F\uDF4B\uDF4C]|\uD805[\uDCBB\uDCBC\uDCBE\uDDBA\uDDBB]|\uD834[\uDD5E-\uDD64\uDDBB-\uDDC0]'
}, {
  'name': 'Expands_On_NFKC',
  'bmp': '\xA8\xAF\xB4\xB8\xBC-\xBE\u0132\u0133\u013F\u0140\u0149\u01C4-\u01CC\u01F1-\u01F3\u02D8-\u02DD\u0344\u037A\u0384\u0385\u0587\u0675-\u0678\u0958-\u095F\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B5C\u0B5D\u0E33\u0EB3\u0EDC\u0EDD\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F73\u0F75-\u0F79\u0F81\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\u1E9A\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED\u1FEE\u1FFD\u1FFE\u2017\u2025\u2026\u2033\u2034\u2036\u2037\u203C\u203E\u2047-\u2049\u2057\u20A8\u2100\u2101\u2103\u2105\u2106\u2109\u2116\u2120-\u2122\u213B\u2150-\u215F\u2161-\u2163\u2165-\u2168\u216A\u216B\u2171-\u2173\u2175-\u2178\u217A\u217B\u2189\u222C\u222D\u222F\u2230\u2469-\u24B5\u2A0C\u2A74-\u2A76\u2ADC\u309B\u309C\u309F\u30FF\u3200-\u321E\u3220-\u3243\u3250-\u325F\u327C\u327D\u32B1-\u32CF\u3300-\u33FF\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4F\uFBDD\uFBEA-\uFBFB\uFC00-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFC\uFE19\uFE30\uFE49-\uFE4C\uFE70-\uFE72\uFE74\uFE76-\uFE7F\uFEF5-\uFEFC\uFFE3',
  'astral': '\uD834[\uDD5E-\uDD64\uDDBB-\uDDC0]|\uD83C[\uDD00-\uDD0A\uDD10-\uDD2A\uDD2D\uDD2E\uDD4A-\uDD4F\uDD6A\uDD6B\uDD90\uDE00\uDE01\uDE40-\uDE48]'
}, {
  'name': 'Expands_On_NFKD',
  'bmp': '\xA8\xAF\xB4\xB8\xBC-\xBE\xC0-\xC5\xC7-\xCF\xD1-\xD6\xD9-\xDD\xE0-\xE5\xE7-\xEF\xF1-\xF6\xF9-\xFD\xFF-\u010F\u0112-\u0125\u0128-\u0130\u0132-\u0137\u0139-\u0140\u0143-\u0149\u014C-\u0151\u0154-\u0165\u0168-\u017E\u01A0\u01A1\u01AF\u01B0\u01C4-\u01DC\u01DE-\u01E3\u01E6-\u01F5\u01F8-\u021B\u021E\u021F\u0226-\u0233\u02D8-\u02DD\u0344\u037A\u0384-\u0386\u0388-\u038A\u038C\u038E-\u0390\u03AA-\u03B0\u03CA-\u03CE\u03D3\u03D4\u0400\u0401\u0403\u0407\u040C-\u040E\u0419\u0439\u0450\u0451\u0453\u0457\u045C-\u045E\u0476\u0477\u04C1\u04C2\u04D0-\u04D3\u04D6\u04D7\u04DA-\u04DF\u04E2-\u04E7\u04EA-\u04F5\u04F8\u04F9\u0587\u0622-\u0626\u0675-\u0678\u06C0\u06C2\u06D3\u0929\u0931\u0934\u0958-\u095F\u09CB\u09CC\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B48\u0B4B\u0B4C\u0B5C\u0B5D\u0B94\u0BCA-\u0BCC\u0C48\u0CC0\u0CC7\u0CC8\u0CCA\u0CCB\u0D4A-\u0D4C\u0DDA\u0DDC-\u0DDE\u0E33\u0EB3\u0EDC\u0EDD\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F73\u0F75-\u0F79\u0F81\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\u1026\u1B06\u1B08\u1B0A\u1B0C\u1B0E\u1B12\u1B3B\u1B3D\u1B40\u1B41\u1B43\u1E00-\u1E9B\u1EA0-\u1EF9\u1F00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBD\u1FBF-\u1FC4\u1FC6-\u1FD3\u1FD6-\u1FDB\u1FDD-\u1FEE\u1FF2-\u1FF4\u1FF6-\u1FFE\u2017\u2025\u2026\u2033\u2034\u2036\u2037\u203C\u203E\u2047-\u2049\u2057\u20A8\u2100\u2101\u2103\u2105\u2106\u2109\u2116\u2120-\u2122\u212B\u213B\u2150-\u215F\u2161-\u2163\u2165-\u2168\u216A\u216B\u2171-\u2173\u2175-\u2178\u217A\u217B\u2189\u219A\u219B\u21AE\u21CD-\u21CF\u2204\u2209\u220C\u2224\u2226\u222C\u222D\u222F\u2230\u2241\u2244\u2247\u2249\u2260\u2262\u226D-\u2271\u2274\u2275\u2278\u2279\u2280\u2281\u2284\u2285\u2288\u2289\u22AC-\u22AF\u22E0-\u22E3\u22EA-\u22ED\u2469-\u24B5\u2A0C\u2A74-\u2A76\u2ADC\u304C\u304E\u3050\u3052\u3054\u3056\u3058\u305A\u305C\u305E\u3060\u3062\u3065\u3067\u3069\u3070\u3071\u3073\u3074\u3076\u3077\u3079\u307A\u307C\u307D\u3094\u309B\u309C\u309E\u309F\u30AC\u30AE\u30B0\u30B2\u30B4\u30B6\u30B8\u30BA\u30BC\u30BE\u30C0\u30C2\u30C5\u30C7\u30C9\u30D0\u30D1\u30D3\u30D4\u30D6\u30D7\u30D9\u30DA\u30DC\u30DD\u30F4\u30F7-\u30FA\u30FE\u30FF\u3200-\u321E\u3220-\u3243\u3250-\u325F\u326E-\u327E\u32B1-\u32CF\u3300-\u33FF\uAC00-\uD7A3\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4F\uFBA4\uFBA5\uFBB0\uFBB1\uFBDD\uFBEA-\uFBFB\uFC00-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFC\uFE19\uFE30\uFE49-\uFE4C\uFE70-\uFE72\uFE74\uFE76-\uFE7F\uFE81-\uFE8C\uFEF5-\uFEFC\uFFE3',
  'astral': '\uD804[\uDC9A\uDC9C\uDCAB\uDD2E\uDD2F\uDF4B\uDF4C]|\uD805[\uDCBB\uDCBC\uDCBE\uDDBA\uDDBB]|\uD834[\uDD5E-\uDD64\uDDBB-\uDDC0]|\uD83C[\uDD00-\uDD0A\uDD10-\uDD2A\uDD2D\uDD2E\uDD4A-\uDD4F\uDD6A\uDD6B\uDD90\uDE00\uDE01\uDE13\uDE40-\uDE48]'
}, {
  'name': 'Extended_Pictographic',
  'bmp': '\xA9\xAE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u2388\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u2605\u2607-\u2612\u2614-\u2685\u2690-\u2705\u2708-\u2712\u2714\u2716\u271D\u2721\u2728\u2733\u2734\u2744\u2747\u274C\u274E\u2753-\u2755\u2757\u2763-\u2767\u2795-\u2797\u27A1\u27B0\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299',
  'astral': '\uD83C[\uDC00-\uDCFF\uDD0D-\uDD0F\uDD2F\uDD6C-\uDD71\uDD7E\uDD7F\uDD8E\uDD91-\uDD9A\uDDAD-\uDDE5\uDE01-\uDE0F\uDE1A\uDE2F\uDE32-\uDE3A\uDE3C-\uDE3F\uDE49-\uDFFA]|\uD83D[\uDC00-\uDD3D\uDD46-\uDE4F\uDE80-\uDEFF\uDF74-\uDF7F\uDFD5-\uDFFF]|\uD83E[\uDC0C-\uDC0F\uDC48-\uDC4F\uDC5A-\uDC5F\uDC88-\uDC8F\uDCAE-\uDCFF\uDD0C-\uDD3A\uDD3C-\uDD45\uDD47-\uDFFF]|\uD83F[\uDC00-\uDFFD]'
}, {
  'name': 'Extender',
  'bmp': '\xB7\u02D0\u02D1\u0640\u07FA\u0E46\u0EC6\u180A\u1843\u1AA7\u1C36\u1C7B\u3005\u3031-\u3035\u309D\u309E\u30FC-\u30FE\uA015\uA60C\uA9CF\uA9E6\uAA70\uAADD\uAAF3\uAAF4\uFF70',
  'astral': '\uD804\uDF5D|\uD805[\uDDC6-\uDDC8]|\uD806\uDE98|\uD81A[\uDF42\uDF43]|\uD81B[\uDFE0\uDFE1]|\uD83A[\uDD44-\uDD46]'
}, {
  'name': 'Full_Composition_Exclusion',
  'bmp': '\u0340\u0341\u0343\u0344\u0374\u037E\u0387\u0958-\u095F\u09DC\u09DD\u09DF\u0A33\u0A36\u0A59-\u0A5B\u0A5E\u0B5C\u0B5D\u0F43\u0F4D\u0F52\u0F57\u0F5C\u0F69\u0F73\u0F75\u0F76\u0F78\u0F81\u0F93\u0F9D\u0FA2\u0FA7\u0FAC\u0FB9\u1F71\u1F73\u1F75\u1F77\u1F79\u1F7B\u1F7D\u1FBB\u1FBE\u1FC9\u1FCB\u1FD3\u1FDB\u1FE3\u1FEB\u1FEE\u1FEF\u1FF9\u1FFB\u1FFD\u2000\u2001\u2126\u212A\u212B\u2329\u232A\u2ADC\uF900-\uFA0D\uFA10\uFA12\uFA15-\uFA1E\uFA20\uFA22\uFA25\uFA26\uFA2A-\uFA6D\uFA70-\uFAD9\uFB1D\uFB1F\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4E',
  'astral': '\uD834[\uDD5E-\uDD64\uDDBB-\uDDC0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Grapheme_Base',
  'bmp': ' -~\xA0-\xAC\xAE-\u02FF\u0370-\u0377\u037A-\u037F\u0384-\u038A\u038C\u038E-\u03A1\u03A3-\u0482\u048A-\u052F\u0531-\u0556\u0559-\u058A\u058D-\u058F\u05BE\u05C0\u05C3\u05C6\u05D0-\u05EA\u05EF-\u05F4\u0606-\u060F\u061B\u061E-\u064A\u0660-\u066F\u0671-\u06D5\u06DE\u06E5\u06E6\u06E9\u06EE-\u070D\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07C0-\u07EA\u07F4-\u07FA\u07FE-\u0815\u081A\u0824\u0828\u0830-\u083E\u0840-\u0858\u085E\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0903-\u0939\u093B\u093D-\u0940\u0949-\u094C\u094E-\u0950\u0958-\u0961\u0964-\u0980\u0982\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09BF\u09C0\u09C7\u09C8\u09CB\u09CC\u09CE\u09DC\u09DD\u09DF-\u09E1\u09E6-\u09FD\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3E-\u0A40\u0A59-\u0A5C\u0A5E\u0A66-\u0A6F\u0A72-\u0A74\u0A76\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD-\u0AC0\u0AC9\u0ACB\u0ACC\u0AD0\u0AE0\u0AE1\u0AE6-\u0AF1\u0AF9\u0B02\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B40\u0B47\u0B48\u0B4B\u0B4C\u0B5C\u0B5D\u0B5F-\u0B61\u0B66-\u0B77\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBF\u0BC1\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCC\u0BD0\u0BE6-\u0BFA\u0C01-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C41-\u0C44\u0C58-\u0C5A\u0C60\u0C61\u0C66-\u0C6F\u0C78-\u0C80\u0C82-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CBE\u0CC0\u0CC1\u0CC3\u0CC4\u0CC7\u0CC8\u0CCA\u0CCB\u0CDE\u0CE0\u0CE1\u0CE6-\u0CEF\u0CF1\u0CF2\u0D02\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D3F\u0D40\u0D46-\u0D48\u0D4A-\u0D4C\u0D4E\u0D4F\u0D54-\u0D56\u0D58-\u0D61\u0D66-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DD0\u0DD1\u0DD8-\u0DDE\u0DE6-\u0DEF\u0DF2-\u0DF4\u0E01-\u0E30\u0E32\u0E33\u0E3F-\u0E46\u0E4F-\u0E5B\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00-\u0F17\u0F1A-\u0F34\u0F36\u0F38\u0F3A-\u0F47\u0F49-\u0F6C\u0F7F\u0F85\u0F88-\u0F8C\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE-\u0FDA\u1000-\u102C\u1031\u1038\u103B\u103C\u103F-\u1057\u105A-\u105D\u1061-\u1070\u1075-\u1081\u1083\u1084\u1087-\u108C\u108E-\u109C\u109E-\u10C5\u10C7\u10CD\u10D0-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1360-\u137C\u1380-\u1399\u13A0-\u13F5\u13F8-\u13FD\u1400-\u169C\u16A0-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1735\u1736\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17B6\u17BE-\u17C5\u17C7\u17C8\u17D4-\u17DC\u17E0-\u17E9\u17F0-\u17F9\u1800-\u180A\u1810-\u1819\u1820-\u1878\u1880-\u1884\u1887-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1923-\u1926\u1929-\u192B\u1930\u1931\u1933-\u1938\u1940\u1944-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u19DE-\u1A16\u1A19\u1A1A\u1A1E-\u1A55\u1A57\u1A61\u1A63\u1A64\u1A6D-\u1A72\u1A80-\u1A89\u1A90-\u1A99\u1AA0-\u1AAD\u1B04-\u1B33\u1B35\u1B3B\u1B3D-\u1B41\u1B43-\u1B4B\u1B50-\u1B6A\u1B74-\u1B7C\u1B82-\u1BA1\u1BA6\u1BA7\u1BAA\u1BAE-\u1BE5\u1BE7\u1BEA-\u1BEC\u1BEE\u1BF2\u1BF3\u1BFC-\u1C2B\u1C34\u1C35\u1C3B-\u1C49\u1C4D-\u1C88\u1C90-\u1CBA\u1CBD-\u1CC7\u1CD3\u1CE1\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5-\u1CF7\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FC4\u1FC6-\u1FD3\u1FD6-\u1FDB\u1FDD-\u1FEF\u1FF2-\u1FF4\u1FF6-\u1FFE\u2000-\u200A\u2010-\u2027\u202F-\u205F\u2070\u2071\u2074-\u208E\u2090-\u209C\u20A0-\u20BF\u2100-\u218B\u2190-\u2426\u2440-\u244A\u2460-\u2B73\u2B76-\u2B95\u2B98-\u2BC8\u2BCA-\u2BFE\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CEE\u2CF2\u2CF3\u2CF9-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D70\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E00-\u2E4E\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFB\u3000-\u3029\u3030-\u303F\u3041-\u3096\u309B-\u30FF\u3105-\u312F\u3131-\u318E\u3190-\u31BA\u31C0-\u31E3\u31F0-\u321E\u3220-\u32FE\u3300-\u4DB5\u4DC0-\u9FEF\uA000-\uA48C\uA490-\uA4C6\uA4D0-\uA62B\uA640-\uA66E\uA673\uA67E-\uA69D\uA6A0-\uA6EF\uA6F2-\uA6F7\uA700-\uA7B9\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA824\uA827-\uA82B\uA830-\uA839\uA840-\uA877\uA880-\uA8C3\uA8CE-\uA8D9\uA8F2-\uA8FE\uA900-\uA925\uA92E-\uA946\uA952\uA953\uA95F-\uA97C\uA983-\uA9B2\uA9B4\uA9B5\uA9BA\uA9BB\uA9BD-\uA9CD\uA9CF-\uA9D9\uA9DE-\uA9E4\uA9E6-\uA9FE\uAA00-\uAA28\uAA2F\uAA30\uAA33\uAA34\uAA40-\uAA42\uAA44-\uAA4B\uAA4D\uAA50-\uAA59\uAA5C-\uAA7B\uAA7D-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAAEB\uAAEE-\uAAF5\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB65\uAB70-\uABE4\uABE6\uABE7\uABE9-\uABEC\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBC1\uFBD3-\uFD3F\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFD\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFE70-\uFE74\uFE76-\uFEFC\uFF01-\uFF9D\uFFA0-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD00-\uDD02\uDD07-\uDD33\uDD37-\uDD8E\uDD90-\uDD9B\uDDA0\uDDD0-\uDDFC\uDE80-\uDE9C\uDEA0-\uDED0\uDEE1-\uDEFB\uDF00-\uDF23\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDF9F-\uDFC3\uDFC8-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDD6F\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC57-\uDC9E\uDCA7-\uDCAF\uDCE0-\uDCF2\uDCF4\uDCF5\uDCFB-\uDD1B\uDD1F-\uDD39\uDD3F\uDD80-\uDDB7\uDDBC-\uDDCF\uDDD2-\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE40-\uDE48\uDE50-\uDE58\uDE60-\uDE9F\uDEC0-\uDEE4\uDEEB-\uDEF6\uDF00-\uDF35\uDF39-\uDF55\uDF58-\uDF72\uDF78-\uDF91\uDF99-\uDF9C\uDFA9-\uDFAF]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDCFA-\uDD23\uDD30-\uDD39\uDE60-\uDE7E\uDF00-\uDF27\uDF30-\uDF45\uDF51-\uDF59]|\uD804[\uDC00\uDC02-\uDC37\uDC47-\uDC4D\uDC52-\uDC6F\uDC82-\uDCB2\uDCB7\uDCB8\uDCBB\uDCBC\uDCBE-\uDCC1\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD03-\uDD26\uDD2C\uDD36-\uDD46\uDD50-\uDD72\uDD74-\uDD76\uDD82-\uDDB5\uDDBF-\uDDC8\uDDCD\uDDD0-\uDDDF\uDDE1-\uDDF4\uDE00-\uDE11\uDE13-\uDE2E\uDE32\uDE33\uDE35\uDE38-\uDE3D\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA9\uDEB0-\uDEDE\uDEE0-\uDEE2\uDEF0-\uDEF9\uDF02\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF3F\uDF41-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF5D-\uDF63]|\uD805[\uDC00-\uDC37\uDC40\uDC41\uDC45\uDC47-\uDC59\uDC5B\uDC5D\uDC80-\uDCAF\uDCB1\uDCB2\uDCB9\uDCBB\uDCBC\uDCBE\uDCC1\uDCC4-\uDCC7\uDCD0-\uDCD9\uDD80-\uDDAE\uDDB0\uDDB1\uDDB8-\uDDBB\uDDBE\uDDC1-\uDDDB\uDE00-\uDE32\uDE3B\uDE3C\uDE3E\uDE41-\uDE44\uDE50-\uDE59\uDE60-\uDE6C\uDE80-\uDEAA\uDEAC\uDEAE\uDEAF\uDEB6\uDEC0-\uDEC9\uDF00-\uDF1A\uDF20\uDF21\uDF26\uDF30-\uDF3F]|\uD806[\uDC00-\uDC2E\uDC38\uDC3B\uDCA0-\uDCF2\uDCFF\uDE00\uDE0B-\uDE32\uDE39\uDE3A\uDE3F-\uDE46\uDE50\uDE57\uDE58\uDE5C-\uDE83\uDE86-\uDE89\uDE97\uDE9A-\uDEA2\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2F\uDC3E\uDC40-\uDC45\uDC50-\uDC6C\uDC70-\uDC8F\uDCA9\uDCB1\uDCB4\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD50-\uDD59\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD93\uDD94\uDD96\uDD98\uDDA0-\uDDA9\uDEE0-\uDEF2\uDEF5-\uDEF8]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC70-\uDC74\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDE6E\uDE6F\uDED0-\uDEED\uDEF5\uDF00-\uDF2F\uDF37-\uDF45\uDF50-\uDF59\uDF5B-\uDF61\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE9A\uDF00-\uDF44\uDF50-\uDF7E\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9C\uDC9F]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD66\uDD6A-\uDD6D\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDE8\uDE00-\uDE41\uDE45\uDEE0-\uDEF3\uDF00-\uDF56\uDF60-\uDF78]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85-\uDE8B]|\uD83A[\uDC00-\uDCC4\uDCC7-\uDCCF\uDD00-\uDD43\uDD50-\uDD59\uDD5E\uDD5F]|\uD83B[\uDC71-\uDCB4\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD00-\uDD0C\uDD10-\uDD6B\uDD70-\uDDAC\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED4\uDEE0-\uDEEC\uDEF0-\uDEF9\uDF00-\uDF73\uDF80-\uDFD8]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDD00-\uDD0B\uDD10-\uDD3E\uDD40-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF\uDE60-\uDE6D]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Grapheme_Extend',
  'bmp': '\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08D3-\u08E1\u08E3-\u0902\u093A\u093C\u0941-\u0948\u094D\u0951-\u0957\u0962\u0963\u0981\u09BC\u09BE\u09C1-\u09C4\u09CD\u09D7\u09E2\u09E3\u09FE\u0A01\u0A02\u0A3C\u0A41\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A70\u0A71\u0A75\u0A81\u0A82\u0ABC\u0AC1-\u0AC5\u0AC7\u0AC8\u0ACD\u0AE2\u0AE3\u0AFA-\u0AFF\u0B01\u0B3C\u0B3E\u0B3F\u0B41-\u0B44\u0B4D\u0B56\u0B57\u0B62\u0B63\u0B82\u0BBE\u0BC0\u0BCD\u0BD7\u0C00\u0C04\u0C3E-\u0C40\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C81\u0CBC\u0CBF\u0CC2\u0CC6\u0CCC\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0D00\u0D01\u0D3B\u0D3C\u0D3E\u0D41-\u0D44\u0D4D\u0D57\u0D62\u0D63\u0DCA\u0DCF\u0DD2-\u0DD4\u0DD6\u0DDF\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0F18\u0F19\u0F35\u0F37\u0F39\u0F71-\u0F7E\u0F80-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102D-\u1030\u1032-\u1037\u1039\u103A\u103D\u103E\u1058\u1059\u105E-\u1060\u1071-\u1074\u1082\u1085\u1086\u108D\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4\u17B5\u17B7-\u17BD\u17C6\u17C9-\u17D3\u17DD\u180B-\u180D\u1885\u1886\u18A9\u1920-\u1922\u1927\u1928\u1932\u1939-\u193B\u1A17\u1A18\u1A1B\u1A56\u1A58-\u1A5E\u1A60\u1A62\u1A65-\u1A6C\u1A73-\u1A7C\u1A7F\u1AB0-\u1ABE\u1B00-\u1B03\u1B34\u1B36-\u1B3A\u1B3C\u1B42\u1B6B-\u1B73\u1B80\u1B81\u1BA2-\u1BA5\u1BA8\u1BA9\u1BAB-\u1BAD\u1BE6\u1BE8\u1BE9\u1BED\u1BEF-\u1BF1\u1C2C-\u1C33\u1C36\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE0\u1CE2-\u1CE8\u1CED\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF9\u1DFB-\u1DFF\u200C\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\uA66F-\uA672\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA825\uA826\uA8C4\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA951\uA980-\uA982\uA9B3\uA9B6-\uA9B9\uA9BC\uA9E5\uAA29-\uAA2E\uAA31\uAA32\uAA35\uAA36\uAA43\uAA4C\uAA7C\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEC\uAAED\uAAF6\uABE5\uABE8\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFF9E\uFF9F',
  'astral': '\uD800[\uDDFD\uDEE0\uDF76-\uDF7A]|\uD802[\uDE01-\uDE03\uDE05\uDE06\uDE0C-\uDE0F\uDE38-\uDE3A\uDE3F\uDEE5\uDEE6]|\uD803[\uDD24-\uDD27\uDF46-\uDF50]|\uD804[\uDC01\uDC38-\uDC46\uDC7F-\uDC81\uDCB3-\uDCB6\uDCB9\uDCBA\uDD00-\uDD02\uDD27-\uDD2B\uDD2D-\uDD34\uDD73\uDD80\uDD81\uDDB6-\uDDBE\uDDC9-\uDDCC\uDE2F-\uDE31\uDE34\uDE36\uDE37\uDE3E\uDEDF\uDEE3-\uDEEA\uDF00\uDF01\uDF3B\uDF3C\uDF3E\uDF40\uDF57\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC38-\uDC3F\uDC42-\uDC44\uDC46\uDC5E\uDCB0\uDCB3-\uDCB8\uDCBA\uDCBD\uDCBF\uDCC0\uDCC2\uDCC3\uDDAF\uDDB2-\uDDB5\uDDBC\uDDBD\uDDBF\uDDC0\uDDDC\uDDDD\uDE33-\uDE3A\uDE3D\uDE3F\uDE40\uDEAB\uDEAD\uDEB0-\uDEB5\uDEB7\uDF1D-\uDF1F\uDF22-\uDF25\uDF27-\uDF2B]|\uD806[\uDC2F-\uDC37\uDC39\uDC3A\uDE01-\uDE0A\uDE33-\uDE38\uDE3B-\uDE3E\uDE47\uDE51-\uDE56\uDE59-\uDE5B\uDE8A-\uDE96\uDE98\uDE99]|\uD807[\uDC30-\uDC36\uDC38-\uDC3D\uDC3F\uDC92-\uDCA7\uDCAA-\uDCB0\uDCB2\uDCB3\uDCB5\uDCB6\uDD31-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD45\uDD47\uDD90\uDD91\uDD95\uDD97\uDEF3\uDEF4]|\uD81A[\uDEF0-\uDEF4\uDF30-\uDF36]|\uD81B[\uDF8F-\uDF92]|\uD82F[\uDC9D\uDC9E]|\uD834[\uDD65\uDD67-\uDD69\uDD6E-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDCD0-\uDCD6\uDD44-\uDD4A]|\uDB40[\uDC20-\uDC7F\uDD00-\uDDEF]'
}, {
  'name': 'Grapheme_Link',
  'bmp': '\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D3B\u0D3C\u0D4D\u0DCA\u0E3A\u0F84\u1039\u103A\u1714\u1734\u17D2\u1A60\u1B44\u1BAA\u1BAB\u1BF2\u1BF3\u2D7F\uA806\uA8C4\uA953\uA9C0\uAAF6\uABED',
  'astral': '\uD802\uDE3F|\uD804[\uDC46\uDC7F\uDCB9\uDD33\uDD34\uDDC0\uDE35\uDEEA\uDF4D]|\uD805[\uDC42\uDCC2\uDDBF\uDE3F\uDEB6\uDF2B]|\uD806[\uDC39\uDE34\uDE47\uDE99]|\uD807[\uDC3F\uDD44\uDD45\uDD97]'
}, {
  'name': 'Hex_Digit',
  'bmp': '0-9A-Fa-f\uFF10-\uFF19\uFF21-\uFF26\uFF41-\uFF46'
}, {
  'name': 'Hyphen',
  'bmp': '\\-\xAD\u058A\u1806\u2010\u2011\u2E17\u30FB\uFE63\uFF0D\uFF65'
}, {
  'name': 'IDS_Binary_Operator',
  'bmp': '\u2FF0\u2FF1\u2FF4-\u2FFB'
}, {
  'name': 'IDS_Trinary_Operator',
  'bmp': '\u2FF2\u2FF3'
}, {
  'name': 'ID_Continue',
  'bmp': '0-9A-Z_a-z\xAA\xB5\xB7\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05EF-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u07FD\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D3-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u09FE\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1369-\u1371\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1878\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD27\uDD30-\uDD39\uDF00-\uDF1C\uDF27\uDF30-\uDF50]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD44-\uDD46\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDC9-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3B-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC5E\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF1A\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDC00-\uDC3A\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD90\uDD91\uDD93-\uDD98\uDDA0-\uDDA9\uDEE0-\uDEF6]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'ID_Start',
  'bmp': 'A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD23\uDF00-\uDF1C\uDF27\uDF30-\uDF45]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD44\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF1A]|\uD806[\uDC00-\uDC2B\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD89\uDD98\uDEE0-\uDEF2]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Ideographic',
  'bmp': '\u3006\u3007\u3021-\u3029\u3038-\u303A\u3400-\u4DB5\u4E00-\u9FEF\uF900-\uFA6D\uFA70-\uFAD9',
  'astral': '[\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDD70-\uDEFB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Join_Control',
  'bmp': '\u200C\u200D'
}, {
  'name': 'Logical_Order_Exception',
  'bmp': '\u0E40-\u0E44\u0EC0-\u0EC4\u19B5-\u19B7\u19BA\uAAB5\uAAB6\uAAB9\uAABB\uAABC'
}, {
  'name': 'Lowercase',
  'bmp': 'a-z\xAA\xB5\xBA\xDF-\xF6\xF8-\xFF\u0101\u0103\u0105\u0107\u0109\u010B\u010D\u010F\u0111\u0113\u0115\u0117\u0119\u011B\u011D\u011F\u0121\u0123\u0125\u0127\u0129\u012B\u012D\u012F\u0131\u0133\u0135\u0137\u0138\u013A\u013C\u013E\u0140\u0142\u0144\u0146\u0148\u0149\u014B\u014D\u014F\u0151\u0153\u0155\u0157\u0159\u015B\u015D\u015F\u0161\u0163\u0165\u0167\u0169\u016B\u016D\u016F\u0171\u0173\u0175\u0177\u017A\u017C\u017E-\u0180\u0183\u0185\u0188\u018C\u018D\u0192\u0195\u0199-\u019B\u019E\u01A1\u01A3\u01A5\u01A8\u01AA\u01AB\u01AD\u01B0\u01B4\u01B6\u01B9\u01BA\u01BD-\u01BF\u01C6\u01C9\u01CC\u01CE\u01D0\u01D2\u01D4\u01D6\u01D8\u01DA\u01DC\u01DD\u01DF\u01E1\u01E3\u01E5\u01E7\u01E9\u01EB\u01ED\u01EF\u01F0\u01F3\u01F5\u01F9\u01FB\u01FD\u01FF\u0201\u0203\u0205\u0207\u0209\u020B\u020D\u020F\u0211\u0213\u0215\u0217\u0219\u021B\u021D\u021F\u0221\u0223\u0225\u0227\u0229\u022B\u022D\u022F\u0231\u0233-\u0239\u023C\u023F\u0240\u0242\u0247\u0249\u024B\u024D\u024F-\u0293\u0295-\u02B8\u02C0\u02C1\u02E0-\u02E4\u0345\u0371\u0373\u0377\u037A-\u037D\u0390\u03AC-\u03CE\u03D0\u03D1\u03D5-\u03D7\u03D9\u03DB\u03DD\u03DF\u03E1\u03E3\u03E5\u03E7\u03E9\u03EB\u03ED\u03EF-\u03F3\u03F5\u03F8\u03FB\u03FC\u0430-\u045F\u0461\u0463\u0465\u0467\u0469\u046B\u046D\u046F\u0471\u0473\u0475\u0477\u0479\u047B\u047D\u047F\u0481\u048B\u048D\u048F\u0491\u0493\u0495\u0497\u0499\u049B\u049D\u049F\u04A1\u04A3\u04A5\u04A7\u04A9\u04AB\u04AD\u04AF\u04B1\u04B3\u04B5\u04B7\u04B9\u04BB\u04BD\u04BF\u04C2\u04C4\u04C6\u04C8\u04CA\u04CC\u04CE\u04CF\u04D1\u04D3\u04D5\u04D7\u04D9\u04DB\u04DD\u04DF\u04E1\u04E3\u04E5\u04E7\u04E9\u04EB\u04ED\u04EF\u04F1\u04F3\u04F5\u04F7\u04F9\u04FB\u04FD\u04FF\u0501\u0503\u0505\u0507\u0509\u050B\u050D\u050F\u0511\u0513\u0515\u0517\u0519\u051B\u051D\u051F\u0521\u0523\u0525\u0527\u0529\u052B\u052D\u052F\u0560-\u0588\u10D0-\u10FA\u10FD-\u10FF\u13F8-\u13FD\u1C80-\u1C88\u1D00-\u1DBF\u1E01\u1E03\u1E05\u1E07\u1E09\u1E0B\u1E0D\u1E0F\u1E11\u1E13\u1E15\u1E17\u1E19\u1E1B\u1E1D\u1E1F\u1E21\u1E23\u1E25\u1E27\u1E29\u1E2B\u1E2D\u1E2F\u1E31\u1E33\u1E35\u1E37\u1E39\u1E3B\u1E3D\u1E3F\u1E41\u1E43\u1E45\u1E47\u1E49\u1E4B\u1E4D\u1E4F\u1E51\u1E53\u1E55\u1E57\u1E59\u1E5B\u1E5D\u1E5F\u1E61\u1E63\u1E65\u1E67\u1E69\u1E6B\u1E6D\u1E6F\u1E71\u1E73\u1E75\u1E77\u1E79\u1E7B\u1E7D\u1E7F\u1E81\u1E83\u1E85\u1E87\u1E89\u1E8B\u1E8D\u1E8F\u1E91\u1E93\u1E95-\u1E9D\u1E9F\u1EA1\u1EA3\u1EA5\u1EA7\u1EA9\u1EAB\u1EAD\u1EAF\u1EB1\u1EB3\u1EB5\u1EB7\u1EB9\u1EBB\u1EBD\u1EBF\u1EC1\u1EC3\u1EC5\u1EC7\u1EC9\u1ECB\u1ECD\u1ECF\u1ED1\u1ED3\u1ED5\u1ED7\u1ED9\u1EDB\u1EDD\u1EDF\u1EE1\u1EE3\u1EE5\u1EE7\u1EE9\u1EEB\u1EED\u1EEF\u1EF1\u1EF3\u1EF5\u1EF7\u1EF9\u1EFB\u1EFD\u1EFF-\u1F07\u1F10-\u1F15\u1F20-\u1F27\u1F30-\u1F37\u1F40-\u1F45\u1F50-\u1F57\u1F60-\u1F67\u1F70-\u1F7D\u1F80-\u1F87\u1F90-\u1F97\u1FA0-\u1FA7\u1FB0-\u1FB4\u1FB6\u1FB7\u1FBE\u1FC2-\u1FC4\u1FC6\u1FC7\u1FD0-\u1FD3\u1FD6\u1FD7\u1FE0-\u1FE7\u1FF2-\u1FF4\u1FF6\u1FF7\u2071\u207F\u2090-\u209C\u210A\u210E\u210F\u2113\u212F\u2134\u2139\u213C\u213D\u2146-\u2149\u214E\u2170-\u217F\u2184\u24D0-\u24E9\u2C30-\u2C5E\u2C61\u2C65\u2C66\u2C68\u2C6A\u2C6C\u2C71\u2C73\u2C74\u2C76-\u2C7D\u2C81\u2C83\u2C85\u2C87\u2C89\u2C8B\u2C8D\u2C8F\u2C91\u2C93\u2C95\u2C97\u2C99\u2C9B\u2C9D\u2C9F\u2CA1\u2CA3\u2CA5\u2CA7\u2CA9\u2CAB\u2CAD\u2CAF\u2CB1\u2CB3\u2CB5\u2CB7\u2CB9\u2CBB\u2CBD\u2CBF\u2CC1\u2CC3\u2CC5\u2CC7\u2CC9\u2CCB\u2CCD\u2CCF\u2CD1\u2CD3\u2CD5\u2CD7\u2CD9\u2CDB\u2CDD\u2CDF\u2CE1\u2CE3\u2CE4\u2CEC\u2CEE\u2CF3\u2D00-\u2D25\u2D27\u2D2D\uA641\uA643\uA645\uA647\uA649\uA64B\uA64D\uA64F\uA651\uA653\uA655\uA657\uA659\uA65B\uA65D\uA65F\uA661\uA663\uA665\uA667\uA669\uA66B\uA66D\uA681\uA683\uA685\uA687\uA689\uA68B\uA68D\uA68F\uA691\uA693\uA695\uA697\uA699\uA69B-\uA69D\uA723\uA725\uA727\uA729\uA72B\uA72D\uA72F-\uA731\uA733\uA735\uA737\uA739\uA73B\uA73D\uA73F\uA741\uA743\uA745\uA747\uA749\uA74B\uA74D\uA74F\uA751\uA753\uA755\uA757\uA759\uA75B\uA75D\uA75F\uA761\uA763\uA765\uA767\uA769\uA76B\uA76D\uA76F-\uA778\uA77A\uA77C\uA77F\uA781\uA783\uA785\uA787\uA78C\uA78E\uA791\uA793-\uA795\uA797\uA799\uA79B\uA79D\uA79F\uA7A1\uA7A3\uA7A5\uA7A7\uA7A9\uA7AF\uA7B5\uA7B7\uA7B9\uA7F8-\uA7FA\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABBF\uFB00-\uFB06\uFB13-\uFB17\uFF41-\uFF5A',
  'astral': '\uD801[\uDC28-\uDC4F\uDCD8-\uDCFB]|\uD803[\uDCC0-\uDCF2]|\uD806[\uDCC0-\uDCDF]|\uD81B[\uDE60-\uDE7F]|\uD835[\uDC1A-\uDC33\uDC4E-\uDC54\uDC56-\uDC67\uDC82-\uDC9B\uDCB6-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDCCF\uDCEA-\uDD03\uDD1E-\uDD37\uDD52-\uDD6B\uDD86-\uDD9F\uDDBA-\uDDD3\uDDEE-\uDE07\uDE22-\uDE3B\uDE56-\uDE6F\uDE8A-\uDEA5\uDEC2-\uDEDA\uDEDC-\uDEE1\uDEFC-\uDF14\uDF16-\uDF1B\uDF36-\uDF4E\uDF50-\uDF55\uDF70-\uDF88\uDF8A-\uDF8F\uDFAA-\uDFC2\uDFC4-\uDFC9\uDFCB]|\uD83A[\uDD22-\uDD43]'
}, {
  'name': 'Math',
  'bmp': '\\+<->\\^\\|~\xAC\xB1\xD7\xF7\u03D0-\u03D2\u03D5\u03F0\u03F1\u03F4-\u03F6\u0606-\u0608\u2016\u2032-\u2034\u2040\u2044\u2052\u2061-\u2064\u207A-\u207E\u208A-\u208E\u20D0-\u20DC\u20E1\u20E5\u20E6\u20EB-\u20EF\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2128\u2129\u212C\u212D\u212F-\u2131\u2133-\u2138\u213C-\u2149\u214B\u2190-\u21A7\u21A9-\u21AE\u21B0\u21B1\u21B6\u21B7\u21BC-\u21DB\u21DD\u21E4\u21E5\u21F4-\u22FF\u2308-\u230B\u2320\u2321\u237C\u239B-\u23B5\u23B7\u23D0\u23DC-\u23E2\u25A0\u25A1\u25AE-\u25B7\u25BC-\u25C1\u25C6\u25C7\u25CA\u25CB\u25CF-\u25D3\u25E2\u25E4\u25E7-\u25EC\u25F8-\u25FF\u2605\u2606\u2640\u2642\u2660-\u2663\u266D-\u266F\u27C0-\u27FF\u2900-\u2AFF\u2B30-\u2B44\u2B47-\u2B4C\uFB29\uFE61-\uFE66\uFE68\uFF0B\uFF1C-\uFF1E\uFF3C\uFF3E\uFF5C\uFF5E\uFFE2\uFFE9-\uFFEC',
  'astral': '\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDFCB\uDFCE-\uDFFF]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB\uDEF0\uDEF1]'
}, {
  'name': 'Noncharacter_Code_Point',
  'bmp': '\uFDD0-\uFDEF\uFFFE\uFFFF',
  'astral': '[\uD83F\uD87F\uD8BF\uD8FF\uD93F\uD97F\uD9BF\uD9FF\uDA3F\uDA7F\uDABF\uDAFF\uDB3F\uDB7F\uDBBF\uDBFF][\uDFFE\uDFFF]'
}, {
  'name': 'Other_Alphabetic',
  'bmp': '\u0345\u05B0-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0657\u0659-\u065F\u0670\u06D6-\u06DC\u06E1-\u06E4\u06E7\u06E8\u06ED\u0711\u0730-\u073F\u07A6-\u07B0\u0816\u0817\u081B-\u0823\u0825-\u0827\u0829-\u082C\u08D4-\u08DF\u08E3-\u08E9\u08F0-\u0903\u093A\u093B\u093E-\u094C\u094E\u094F\u0955-\u0957\u0962\u0963\u0981-\u0983\u09BE-\u09C4\u09C7\u09C8\u09CB\u09CC\u09D7\u09E2\u09E3\u0A01-\u0A03\u0A3E-\u0A42\u0A47\u0A48\u0A4B\u0A4C\u0A51\u0A70\u0A71\u0A75\u0A81-\u0A83\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB\u0ACC\u0AE2\u0AE3\u0AFA-\u0AFC\u0B01-\u0B03\u0B3E-\u0B44\u0B47\u0B48\u0B4B\u0B4C\u0B56\u0B57\u0B62\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCC\u0BD7\u0C00-\u0C03\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4C\u0C55\u0C56\u0C62\u0C63\u0C81-\u0C83\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCC\u0CD5\u0CD6\u0CE2\u0CE3\u0D00-\u0D03\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4C\u0D57\u0D62\u0D63\u0D82\u0D83\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E4D\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0ECD\u0F71-\u0F81\u0F8D-\u0F97\u0F99-\u0FBC\u102B-\u1036\u1038\u103B-\u103E\u1056-\u1059\u105E-\u1060\u1062\u1067\u1068\u1071-\u1074\u1082-\u1086\u109C\u109D\u135F\u1712\u1713\u1732\u1733\u1752\u1753\u1772\u1773\u17B6-\u17C8\u1885\u1886\u18A9\u1920-\u192B\u1930-\u1938\u1A17-\u1A1B\u1A55-\u1A5E\u1A61-\u1A74\u1B00-\u1B04\u1B35-\u1B43\u1B80-\u1B82\u1BA1-\u1BA9\u1BAC\u1BAD\u1BE7-\u1BF1\u1C24-\u1C35\u1CF2\u1CF3\u1DE7-\u1DF4\u24B6-\u24E9\u2DE0-\u2DFF\uA674-\uA67B\uA69E\uA69F\uA823-\uA827\uA880\uA881\uA8B4-\uA8C3\uA8C5\uA926-\uA92A\uA947-\uA952\uA980-\uA983\uA9B4-\uA9BF\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAAEB-\uAAEF\uAAF5\uABE3-\uABEA\uFB1E',
  'astral': '\uD800[\uDF76-\uDF7A]|\uD802[\uDE01-\uDE03\uDE05\uDE06\uDE0C-\uDE0F]|\uD803[\uDD24-\uDD27]|\uD804[\uDC00-\uDC02\uDC38-\uDC45\uDC82\uDCB0-\uDCB8\uDD00-\uDD02\uDD27-\uDD32\uDD45\uDD46\uDD80-\uDD82\uDDB3-\uDDBF\uDE2C-\uDE34\uDE37\uDE3E\uDEDF-\uDEE8\uDF00-\uDF03\uDF3E-\uDF44\uDF47\uDF48\uDF4B\uDF4C\uDF57\uDF62\uDF63]|\uD805[\uDC35-\uDC41\uDC43-\uDC45\uDCB0-\uDCC1\uDDAF-\uDDB5\uDDB8-\uDDBE\uDDDC\uDDDD\uDE30-\uDE3E\uDE40\uDEAB-\uDEB5\uDF1D-\uDF2A]|\uD806[\uDC2C-\uDC38\uDE01-\uDE0A\uDE35-\uDE39\uDE3B-\uDE3E\uDE51-\uDE5B\uDE8A-\uDE97]|\uD807[\uDC2F-\uDC36\uDC38-\uDC3E\uDC92-\uDCA7\uDCA9-\uDCB6\uDD31-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD41\uDD43\uDD47\uDD8A-\uDD8E\uDD90\uDD91\uDD93-\uDD96\uDEF3-\uDEF6]|\uD81A[\uDF30-\uDF36]|\uD81B[\uDF51-\uDF7E]|\uD82F\uDC9E|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A\uDD47|\uD83C[\uDD30-\uDD49\uDD50-\uDD69\uDD70-\uDD89]'
}, {
  'name': 'Other_Default_Ignorable_Code_Point',
  'bmp': '\u034F\u115F\u1160\u17B4\u17B5\u2065\u3164\uFFA0\uFFF0-\uFFF8',
  'astral': '\uDB40[\uDC00\uDC02-\uDC1F\uDC80-\uDCFF\uDDF0-\uDFFF]|[\uDB41-\uDB43][\uDC00-\uDFFF]'
}, {
  'name': 'Other_Grapheme_Extend',
  'bmp': '\u09BE\u09D7\u0B3E\u0B57\u0BBE\u0BD7\u0CC2\u0CD5\u0CD6\u0D3E\u0D57\u0DCF\u0DDF\u200C\u302E\u302F\uFF9E\uFF9F',
  'astral': '\uD804[\uDF3E\uDF57]|\uD805[\uDCB0\uDCBD\uDDAF]|\uD834[\uDD65\uDD6E-\uDD72]|\uDB40[\uDC20-\uDC7F]'
}, {
  'name': 'Other_ID_Continue',
  'bmp': '\xB7\u0387\u1369-\u1371\u19DA'
}, {
  'name': 'Other_ID_Start',
  'bmp': '\u1885\u1886\u2118\u212E\u309B\u309C'
}, {
  'name': 'Other_Lowercase',
  'bmp': '\xAA\xBA\u02B0-\u02B8\u02C0\u02C1\u02E0-\u02E4\u0345\u037A\u1D2C-\u1D6A\u1D78\u1D9B-\u1DBF\u2071\u207F\u2090-\u209C\u2170-\u217F\u24D0-\u24E9\u2C7C\u2C7D\uA69C\uA69D\uA770\uA7F8\uA7F9\uAB5C-\uAB5F'
}, {
  'name': 'Other_Math',
  'bmp': '\\^\u03D0-\u03D2\u03D5\u03F0\u03F1\u03F4\u03F5\u2016\u2032-\u2034\u2040\u2061-\u2064\u207D\u207E\u208D\u208E\u20D0-\u20DC\u20E1\u20E5\u20E6\u20EB-\u20EF\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2128\u2129\u212C\u212D\u212F-\u2131\u2133-\u2138\u213C-\u213F\u2145-\u2149\u2195-\u2199\u219C-\u219F\u21A1\u21A2\u21A4\u21A5\u21A7\u21A9-\u21AD\u21B0\u21B1\u21B6\u21B7\u21BC-\u21CD\u21D0\u21D1\u21D3\u21D5-\u21DB\u21DD\u21E4\u21E5\u2308-\u230B\u23B4\u23B5\u23B7\u23D0\u23E2\u25A0\u25A1\u25AE-\u25B6\u25BC-\u25C0\u25C6\u25C7\u25CA\u25CB\u25CF-\u25D3\u25E2\u25E4\u25E7-\u25EC\u2605\u2606\u2640\u2642\u2660-\u2663\u266D\u266E\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\uFE61\uFE63\uFE68\uFF3C\uFF3E',
  'astral': '\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]'
}, {
  'name': 'Other_Uppercase',
  'bmp': '\u2160-\u216F\u24B6-\u24CF',
  'astral': '\uD83C[\uDD30-\uDD49\uDD50-\uDD69\uDD70-\uDD89]'
}, {
  'name': 'Pattern_Syntax',
  'bmp': '!-\\/:-@\\[-\\^`\\{-~\xA1-\xA7\xA9\xAB\xAC\xAE\xB0\xB1\xB6\xBB\xBF\xD7\xF7\u2010-\u2027\u2030-\u203E\u2041-\u2053\u2055-\u205E\u2190-\u245F\u2500-\u2775\u2794-\u2BFF\u2E00-\u2E7F\u3001-\u3003\u3008-\u3020\u3030\uFD3E\uFD3F\uFE45\uFE46'
}, {
  'name': 'Pattern_White_Space',
  'bmp': '\t-\r \x85\u200E\u200F\u2028\u2029'
}, {
  'name': 'Prepended_Concatenation_Mark',
  'bmp': '\u0600-\u0605\u06DD\u070F\u08E2',
  'astral': '\uD804[\uDCBD\uDCCD]'
}, {
  'name': 'Quotation_Mark',
  'bmp': '"\'\xAB\xBB\u2018-\u201F\u2039\u203A\u2E42\u300C-\u300F\u301D-\u301F\uFE41-\uFE44\uFF02\uFF07\uFF62\uFF63'
}, {
  'name': 'Radical',
  'bmp': '\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5'
}, {
  'name': 'Regional_Indicator',
  'astral': '\uD83C[\uDDE6-\uDDFF]'
}, {
  'name': 'Sentence_Terminal',
  'bmp': '!\\.\\?\u0589\u061E\u061F\u06D4\u0700-\u0702\u07F9\u0837\u0839\u083D\u083E\u0964\u0965\u104A\u104B\u1362\u1367\u1368\u166E\u1735\u1736\u1803\u1809\u1944\u1945\u1AA8-\u1AAB\u1B5A\u1B5B\u1B5E\u1B5F\u1C3B\u1C3C\u1C7E\u1C7F\u203C\u203D\u2047-\u2049\u2E2E\u2E3C\u3002\uA4FF\uA60E\uA60F\uA6F3\uA6F7\uA876\uA877\uA8CE\uA8CF\uA92F\uA9C8\uA9C9\uAA5D-\uAA5F\uAAF0\uAAF1\uABEB\uFE52\uFE56\uFE57\uFF01\uFF0E\uFF1F\uFF61',
  'astral': '\uD802[\uDE56\uDE57]|\uD803[\uDF55-\uDF59]|\uD804[\uDC47\uDC48\uDCBE-\uDCC1\uDD41-\uDD43\uDDC5\uDDC6\uDDCD\uDDDE\uDDDF\uDE38\uDE39\uDE3B\uDE3C\uDEA9]|\uD805[\uDC4B\uDC4C\uDDC2\uDDC3\uDDC9-\uDDD7\uDE41\uDE42\uDF3C-\uDF3E]|\uD806[\uDE42\uDE43\uDE9B\uDE9C]|\uD807[\uDC41\uDC42\uDEF7\uDEF8]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37\uDF38\uDF44]|\uD81B\uDE98|\uD82F\uDC9F|\uD836\uDE88'
}, {
  'name': 'Soft_Dotted',
  'bmp': 'ij\u012F\u0249\u0268\u029D\u02B2\u03F3\u0456\u0458\u1D62\u1D96\u1DA4\u1DA8\u1E2D\u1ECB\u2071\u2148\u2149\u2C7C',
  'astral': '\uD835[\uDC22\uDC23\uDC56\uDC57\uDC8A\uDC8B\uDCBE\uDCBF\uDCF2\uDCF3\uDD26\uDD27\uDD5A\uDD5B\uDD8E\uDD8F\uDDC2\uDDC3\uDDF6\uDDF7\uDE2A\uDE2B\uDE5E\uDE5F\uDE92\uDE93]'
}, {
  'name': 'Terminal_Punctuation',
  'bmp': '!,\\.:;\\?\u037E\u0387\u0589\u05C3\u060C\u061B\u061E\u061F\u06D4\u0700-\u070A\u070C\u07F8\u07F9\u0830-\u083E\u085E\u0964\u0965\u0E5A\u0E5B\u0F08\u0F0D-\u0F12\u104A\u104B\u1361-\u1368\u166D\u166E\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17DA\u1802-\u1805\u1808\u1809\u1944\u1945\u1AA8-\u1AAB\u1B5A\u1B5B\u1B5D-\u1B5F\u1C3B-\u1C3F\u1C7E\u1C7F\u203C\u203D\u2047-\u2049\u2E2E\u2E3C\u2E41\u2E4C\u2E4E\u3001\u3002\uA4FE\uA4FF\uA60D-\uA60F\uA6F3-\uA6F7\uA876\uA877\uA8CE\uA8CF\uA92F\uA9C7-\uA9C9\uAA5D-\uAA5F\uAADF\uAAF0\uAAF1\uABEB\uFE50-\uFE52\uFE54-\uFE57\uFF01\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF61\uFF64',
  'astral': '\uD800[\uDF9F\uDFD0]|\uD802[\uDC57\uDD1F\uDE56\uDE57\uDEF0-\uDEF5\uDF3A-\uDF3F\uDF99-\uDF9C]|\uD803[\uDF55-\uDF59]|\uD804[\uDC47-\uDC4D\uDCBE-\uDCC1\uDD41-\uDD43\uDDC5\uDDC6\uDDCD\uDDDE\uDDDF\uDE38-\uDE3C\uDEA9]|\uD805[\uDC4B-\uDC4D\uDC5B\uDDC2-\uDDC5\uDDC9-\uDDD7\uDE41\uDE42\uDF3C-\uDF3E]|\uD806[\uDE42\uDE43\uDE9B\uDE9C\uDEA1\uDEA2]|\uD807[\uDC41-\uDC43\uDC71\uDEF7\uDEF8]|\uD809[\uDC70-\uDC74]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF39\uDF44]|\uD81B[\uDE97\uDE98]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8A]'
}, {
  'name': 'Unified_Ideograph',
  'bmp': '\u3400-\u4DB5\u4E00-\u9FEF\uFA0E\uFA0F\uFA11\uFA13\uFA14\uFA1F\uFA21\uFA23\uFA24\uFA27-\uFA29',
  'astral': '[\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]'
}, {
  'name': 'Uppercase',
  'bmp': 'A-Z\xC0-\xD6\xD8-\xDE\u0100\u0102\u0104\u0106\u0108\u010A\u010C\u010E\u0110\u0112\u0114\u0116\u0118\u011A\u011C\u011E\u0120\u0122\u0124\u0126\u0128\u012A\u012C\u012E\u0130\u0132\u0134\u0136\u0139\u013B\u013D\u013F\u0141\u0143\u0145\u0147\u014A\u014C\u014E\u0150\u0152\u0154\u0156\u0158\u015A\u015C\u015E\u0160\u0162\u0164\u0166\u0168\u016A\u016C\u016E\u0170\u0172\u0174\u0176\u0178\u0179\u017B\u017D\u0181\u0182\u0184\u0186\u0187\u0189-\u018B\u018E-\u0191\u0193\u0194\u0196-\u0198\u019C\u019D\u019F\u01A0\u01A2\u01A4\u01A6\u01A7\u01A9\u01AC\u01AE\u01AF\u01B1-\u01B3\u01B5\u01B7\u01B8\u01BC\u01C4\u01C7\u01CA\u01CD\u01CF\u01D1\u01D3\u01D5\u01D7\u01D9\u01DB\u01DE\u01E0\u01E2\u01E4\u01E6\u01E8\u01EA\u01EC\u01EE\u01F1\u01F4\u01F6-\u01F8\u01FA\u01FC\u01FE\u0200\u0202\u0204\u0206\u0208\u020A\u020C\u020E\u0210\u0212\u0214\u0216\u0218\u021A\u021C\u021E\u0220\u0222\u0224\u0226\u0228\u022A\u022C\u022E\u0230\u0232\u023A\u023B\u023D\u023E\u0241\u0243-\u0246\u0248\u024A\u024C\u024E\u0370\u0372\u0376\u037F\u0386\u0388-\u038A\u038C\u038E\u038F\u0391-\u03A1\u03A3-\u03AB\u03CF\u03D2-\u03D4\u03D8\u03DA\u03DC\u03DE\u03E0\u03E2\u03E4\u03E6\u03E8\u03EA\u03EC\u03EE\u03F4\u03F7\u03F9\u03FA\u03FD-\u042F\u0460\u0462\u0464\u0466\u0468\u046A\u046C\u046E\u0470\u0472\u0474\u0476\u0478\u047A\u047C\u047E\u0480\u048A\u048C\u048E\u0490\u0492\u0494\u0496\u0498\u049A\u049C\u049E\u04A0\u04A2\u04A4\u04A6\u04A8\u04AA\u04AC\u04AE\u04B0\u04B2\u04B4\u04B6\u04B8\u04BA\u04BC\u04BE\u04C0\u04C1\u04C3\u04C5\u04C7\u04C9\u04CB\u04CD\u04D0\u04D2\u04D4\u04D6\u04D8\u04DA\u04DC\u04DE\u04E0\u04E2\u04E4\u04E6\u04E8\u04EA\u04EC\u04EE\u04F0\u04F2\u04F4\u04F6\u04F8\u04FA\u04FC\u04FE\u0500\u0502\u0504\u0506\u0508\u050A\u050C\u050E\u0510\u0512\u0514\u0516\u0518\u051A\u051C\u051E\u0520\u0522\u0524\u0526\u0528\u052A\u052C\u052E\u0531-\u0556\u10A0-\u10C5\u10C7\u10CD\u13A0-\u13F5\u1C90-\u1CBA\u1CBD-\u1CBF\u1E00\u1E02\u1E04\u1E06\u1E08\u1E0A\u1E0C\u1E0E\u1E10\u1E12\u1E14\u1E16\u1E18\u1E1A\u1E1C\u1E1E\u1E20\u1E22\u1E24\u1E26\u1E28\u1E2A\u1E2C\u1E2E\u1E30\u1E32\u1E34\u1E36\u1E38\u1E3A\u1E3C\u1E3E\u1E40\u1E42\u1E44\u1E46\u1E48\u1E4A\u1E4C\u1E4E\u1E50\u1E52\u1E54\u1E56\u1E58\u1E5A\u1E5C\u1E5E\u1E60\u1E62\u1E64\u1E66\u1E68\u1E6A\u1E6C\u1E6E\u1E70\u1E72\u1E74\u1E76\u1E78\u1E7A\u1E7C\u1E7E\u1E80\u1E82\u1E84\u1E86\u1E88\u1E8A\u1E8C\u1E8E\u1E90\u1E92\u1E94\u1E9E\u1EA0\u1EA2\u1EA4\u1EA6\u1EA8\u1EAA\u1EAC\u1EAE\u1EB0\u1EB2\u1EB4\u1EB6\u1EB8\u1EBA\u1EBC\u1EBE\u1EC0\u1EC2\u1EC4\u1EC6\u1EC8\u1ECA\u1ECC\u1ECE\u1ED0\u1ED2\u1ED4\u1ED6\u1ED8\u1EDA\u1EDC\u1EDE\u1EE0\u1EE2\u1EE4\u1EE6\u1EE8\u1EEA\u1EEC\u1EEE\u1EF0\u1EF2\u1EF4\u1EF6\u1EF8\u1EFA\u1EFC\u1EFE\u1F08-\u1F0F\u1F18-\u1F1D\u1F28-\u1F2F\u1F38-\u1F3F\u1F48-\u1F4D\u1F59\u1F5B\u1F5D\u1F5F\u1F68-\u1F6F\u1FB8-\u1FBB\u1FC8-\u1FCB\u1FD8-\u1FDB\u1FE8-\u1FEC\u1FF8-\u1FFB\u2102\u2107\u210B-\u210D\u2110-\u2112\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u2130-\u2133\u213E\u213F\u2145\u2160-\u216F\u2183\u24B6-\u24CF\u2C00-\u2C2E\u2C60\u2C62-\u2C64\u2C67\u2C69\u2C6B\u2C6D-\u2C70\u2C72\u2C75\u2C7E-\u2C80\u2C82\u2C84\u2C86\u2C88\u2C8A\u2C8C\u2C8E\u2C90\u2C92\u2C94\u2C96\u2C98\u2C9A\u2C9C\u2C9E\u2CA0\u2CA2\u2CA4\u2CA6\u2CA8\u2CAA\u2CAC\u2CAE\u2CB0\u2CB2\u2CB4\u2CB6\u2CB8\u2CBA\u2CBC\u2CBE\u2CC0\u2CC2\u2CC4\u2CC6\u2CC8\u2CCA\u2CCC\u2CCE\u2CD0\u2CD2\u2CD4\u2CD6\u2CD8\u2CDA\u2CDC\u2CDE\u2CE0\u2CE2\u2CEB\u2CED\u2CF2\uA640\uA642\uA644\uA646\uA648\uA64A\uA64C\uA64E\uA650\uA652\uA654\uA656\uA658\uA65A\uA65C\uA65E\uA660\uA662\uA664\uA666\uA668\uA66A\uA66C\uA680\uA682\uA684\uA686\uA688\uA68A\uA68C\uA68E\uA690\uA692\uA694\uA696\uA698\uA69A\uA722\uA724\uA726\uA728\uA72A\uA72C\uA72E\uA732\uA734\uA736\uA738\uA73A\uA73C\uA73E\uA740\uA742\uA744\uA746\uA748\uA74A\uA74C\uA74E\uA750\uA752\uA754\uA756\uA758\uA75A\uA75C\uA75E\uA760\uA762\uA764\uA766\uA768\uA76A\uA76C\uA76E\uA779\uA77B\uA77D\uA77E\uA780\uA782\uA784\uA786\uA78B\uA78D\uA790\uA792\uA796\uA798\uA79A\uA79C\uA79E\uA7A0\uA7A2\uA7A4\uA7A6\uA7A8\uA7AA-\uA7AE\uA7B0-\uA7B4\uA7B6\uA7B8\uFF21-\uFF3A',
  'astral': '\uD801[\uDC00-\uDC27\uDCB0-\uDCD3]|\uD803[\uDC80-\uDCB2]|\uD806[\uDCA0-\uDCBF]|\uD81B[\uDE40-\uDE5F]|\uD835[\uDC00-\uDC19\uDC34-\uDC4D\uDC68-\uDC81\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB5\uDCD0-\uDCE9\uDD04\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD38\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD6C-\uDD85\uDDA0-\uDDB9\uDDD4-\uDDED\uDE08-\uDE21\uDE3C-\uDE55\uDE70-\uDE89\uDEA8-\uDEC0\uDEE2-\uDEFA\uDF1C-\uDF34\uDF56-\uDF6E\uDF90-\uDFA8\uDFCA]|\uD83A[\uDD00-\uDD21]|\uD83C[\uDD30-\uDD49\uDD50-\uDD69\uDD70-\uDD89]'
}, {
  'name': 'Variation_Selector',
  'bmp': '\u180B-\u180D\uFE00-\uFE0F',
  'astral': '\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'White_Space',
  'bmp': '\t-\r \x85\xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000'
}, {
  'name': 'XID_Continue',
  'bmp': '0-9A-Z_a-z\xAA\xB5\xB7\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037B-\u037D\u037F\u0386-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05EF-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u07FD\u0800-\u082D\u0840-\u085B\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u08D3-\u08E1\u08E3-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u09FC\u09FE\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0AF9-\u0AFF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C80-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D54-\u0D57\u0D5F-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1369-\u1371\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1878\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CD0-\u1CD2\u1CD4-\u1CF9\u1D00-\u1DF9\u1DFB-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099\u309A\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA8FD-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFC5D\uFC64-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDF9\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFE71\uFE73\uFE77\uFE79\uFE7B\uFE7D\uFE7F-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD27\uDD30-\uDD39\uDF00-\uDF1C\uDF27\uDF30-\uDF50]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD44-\uDD46\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDC9-\uDDCC\uDDD0-\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE37\uDE3E\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3B-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC00-\uDC4A\uDC50-\uDC59\uDC5E\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDDD8-\uDDDD\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9\uDF00-\uDF1A\uDF1D-\uDF2B\uDF30-\uDF39]|\uD806[\uDC00-\uDC3A\uDCA0-\uDCE9\uDCFF\uDE00-\uDE3E\uDE47\uDE50-\uDE83\uDE86-\uDE99\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC40\uDC50-\uDC59\uDC72-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD90\uDD91\uDD93-\uDD98\uDDA0-\uDDA9\uDEE0-\uDEF6]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD836[\uDE00-\uDE36\uDE3B-\uDE6C\uDE75\uDE84\uDE9B-\uDE9F\uDEA1-\uDEAF]|\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6\uDD00-\uDD4A\uDD50-\uDD59]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'XID_Start',
  'bmp': 'A-Za-z\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037B-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u08A0-\u08B4\u08B6-\u08BD\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C88\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FEF\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7B9\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB65\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFC5D\uFC64-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDF9\uFE71\uFE73\uFE77\uFE79\uFE7B\uFE7D\uFE7F-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFF9D\uFFA0-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF2D-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCB0-\uDCD3\uDCD8-\uDCFB\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDCE0-\uDCF2\uDCF4\uDCF5\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48\uDC80-\uDCB2\uDCC0-\uDCF2\uDD00-\uDD23\uDF00-\uDF1C\uDF27\uDF30-\uDF45]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD44\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDDDC\uDE00-\uDE11\uDE13-\uDE2B\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA8\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF50\uDF5D-\uDF61]|\uD805[\uDC00-\uDC34\uDC47-\uDC4A\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDDD8-\uDDDB\uDE00-\uDE2F\uDE44\uDE80-\uDEAA\uDF00-\uDF1A]|\uD806[\uDC00-\uDC2B\uDCA0-\uDCDF\uDCFF\uDE00\uDE0B-\uDE32\uDE3A\uDE50\uDE5C-\uDE83\uDE86-\uDE89\uDE9D\uDEC0-\uDEF8]|\uD807[\uDC00-\uDC08\uDC0A-\uDC2E\uDC40\uDC72-\uDC8F\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD30\uDD46\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD89\uDD98\uDEE0-\uDEF2]|\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC80-\uDD43]|[\uD80C\uD81C-\uD820\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD811[\uDC00-\uDE46]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDE40-\uDE7F\uDF00-\uDF44\uDF50\uDF93-\uDF9F\uDFE0\uDFE1]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]|\uD82C[\uDC00-\uDD1E\uDD70-\uDEFB]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4\uDD00-\uDD43]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}];
/*!
 * XRegExp Unicode Properties
 * <xregexp.com>
 * Steven Levithan (c) 2012-present MIT License
 * Unicode data by Mathias Bynens <mathiasbynens.be>
 */

var unicodeProperties = XRegExp => {
  /**
   * Adds properties to meet the UTS #18 Level 1 RL1.2 requirements for Unicode regex support. See
   * <http://unicode.org/reports/tr18/#RL1.2>. Following are definitions of these properties from
   * UAX #44 <http://unicode.org/reports/tr44/>:
   *
   * - Alphabetic
   *   Characters with the Alphabetic property. Generated from: Lowercase + Uppercase + Lt + Lm +
   *   Lo + Nl + Other_Alphabetic.
   *
   * - Default_Ignorable_Code_Point
   *   For programmatic determination of default ignorable code points. New characters that should
   *   be ignored in rendering (unless explicitly supported) will be assigned in these ranges,
   *   permitting programs to correctly handle the default rendering of such characters when not
   *   otherwise supported.
   *
   * - Lowercase
   *   Characters with the Lowercase property. Generated from: Ll + Other_Lowercase.
   *
   * - Noncharacter_Code_Point
   *   Code points permanently reserved for internal use.
   *
   * - Uppercase
   *   Characters with the Uppercase property. Generated from: Lu + Other_Uppercase.
   *
   * - White_Space
   *   Spaces, separator characters and other control characters which should be treated by
   *   programming languages as "white space" for the purpose of parsing elements.
   *
   * The properties ASCII, Any, and Assigned are also included but are not defined in UAX #44. UTS
   * #18 RL1.2 additionally requires support for Unicode scripts and general categories. These are
   * included in XRegExp's Unicode Categories and Unicode Scripts addons.
   *
   * Token names are case insensitive, and any spaces, hyphens, and underscores are ignored.
   *
   * Uses Unicode 11.0.0.
   *
   * @requires XRegExp, Unicode Base
   */
  if (!XRegExp.addUnicodeData) {
    throw new ReferenceError('Unicode Base must be loaded before Unicode Properties');
  }

  XRegExp.addUnicodeData(properties);
}; // End of module


var scripts = [{
  'name': 'Adlam',
  'astral': '\uD83A[\uDD00-\uDD4A\uDD50-\uDD59\uDD5E\uDD5F]'
}, {
  'name': 'Ahom',
  'astral': '\uD805[\uDF00-\uDF1A\uDF1D-\uDF2B\uDF30-\uDF3F]'
}, {
  'name': 'Anatolian_Hieroglyphs',
  'astral': '\uD811[\uDC00-\uDE46]'
}, {
  'name': 'Arabic',
  'bmp': '\u0600-\u0604\u0606-\u060B\u060D-\u061A\u061C\u061E\u0620-\u063F\u0641-\u064A\u0656-\u066F\u0671-\u06DC\u06DE-\u06FF\u0750-\u077F\u08A0-\u08B4\u08B6-\u08BD\u08D3-\u08E1\u08E3-\u08FF\uFB50-\uFBC1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFD\uFE70-\uFE74\uFE76-\uFEFC',
  'astral': '\uD803[\uDE60-\uDE7E]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB\uDEF0\uDEF1]'
}, {
  'name': 'Armenian',
  'bmp': '\u0531-\u0556\u0559-\u0588\u058A\u058D-\u058F\uFB13-\uFB17'
}, {
  'name': 'Avestan',
  'astral': '\uD802[\uDF00-\uDF35\uDF39-\uDF3F]'
}, {
  'name': 'Balinese',
  'bmp': '\u1B00-\u1B4B\u1B50-\u1B7C'
}, {
  'name': 'Bamum',
  'bmp': '\uA6A0-\uA6F7',
  'astral': '\uD81A[\uDC00-\uDE38]'
}, {
  'name': 'Bassa_Vah',
  'astral': '\uD81A[\uDED0-\uDEED\uDEF0-\uDEF5]'
}, {
  'name': 'Batak',
  'bmp': '\u1BC0-\u1BF3\u1BFC-\u1BFF'
}, {
  'name': 'Bengali',
  'bmp': '\u0980-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09FE'
}, {
  'name': 'Bhaiksuki',
  'astral': '\uD807[\uDC00-\uDC08\uDC0A-\uDC36\uDC38-\uDC45\uDC50-\uDC6C]'
}, {
  'name': 'Bopomofo',
  'bmp': '\u02EA\u02EB\u3105-\u312F\u31A0-\u31BA'
}, {
  'name': 'Brahmi',
  'astral': '\uD804[\uDC00-\uDC4D\uDC52-\uDC6F\uDC7F]'
}, {
  'name': 'Braille',
  'bmp': '\u2800-\u28FF'
}, {
  'name': 'Buginese',
  'bmp': '\u1A00-\u1A1B\u1A1E\u1A1F'
}, {
  'name': 'Buhid',
  'bmp': '\u1740-\u1753'
}, {
  'name': 'Canadian_Aboriginal',
  'bmp': '\u1400-\u167F\u18B0-\u18F5'
}, {
  'name': 'Carian',
  'astral': '\uD800[\uDEA0-\uDED0]'
}, {
  'name': 'Caucasian_Albanian',
  'astral': '\uD801[\uDD30-\uDD63\uDD6F]'
}, {
  'name': 'Chakma',
  'astral': '\uD804[\uDD00-\uDD34\uDD36-\uDD46]'
}, {
  'name': 'Cham',
  'bmp': '\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA5C-\uAA5F'
}, {
  'name': 'Cherokee',
  'bmp': '\u13A0-\u13F5\u13F8-\u13FD\uAB70-\uABBF'
}, {
  'name': 'Common',
  'bmp': '\0-@\\[-`\\{-\xA9\xAB-\xB9\xBB-\xBF\xD7\xF7\u02B9-\u02DF\u02E5-\u02E9\u02EC-\u02FF\u0374\u037E\u0385\u0387\u0589\u0605\u060C\u061B\u061F\u0640\u06DD\u08E2\u0964\u0965\u0E3F\u0FD5-\u0FD8\u10FB\u16EB-\u16ED\u1735\u1736\u1802\u1803\u1805\u1CD3\u1CE1\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5-\u1CF7\u2000-\u200B\u200E-\u2064\u2066-\u2070\u2074-\u207E\u2080-\u208E\u20A0-\u20BF\u2100-\u2125\u2127-\u2129\u212C-\u2131\u2133-\u214D\u214F-\u215F\u2189-\u218B\u2190-\u2426\u2440-\u244A\u2460-\u27FF\u2900-\u2B73\u2B76-\u2B95\u2B98-\u2BC8\u2BCA-\u2BFE\u2E00-\u2E4E\u2FF0-\u2FFB\u3000-\u3004\u3006\u3008-\u3020\u3030-\u3037\u303C-\u303F\u309B\u309C\u30A0\u30FB\u30FC\u3190-\u319F\u31C0-\u31E3\u3220-\u325F\u327F-\u32CF\u3358-\u33FF\u4DC0-\u4DFF\uA700-\uA721\uA788-\uA78A\uA830-\uA839\uA92E\uA9CF\uAB5B\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE66\uFE68-\uFE6B\uFEFF\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFF70\uFF9E\uFF9F\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFF9-\uFFFD',
  'astral': '\uD800[\uDD00-\uDD02\uDD07-\uDD33\uDD37-\uDD3F\uDD90-\uDD9B\uDDD0-\uDDFC\uDEE1-\uDEFB]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD66\uDD6A-\uDD7A\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDE8\uDEE0-\uDEF3\uDF00-\uDF56\uDF60-\uDF78]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDFCB\uDFCE-\uDFFF]|\uD83B[\uDC71-\uDCB4]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD00-\uDD0C\uDD10-\uDD6B\uDD70-\uDDAC\uDDE6-\uDDFF\uDE01\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED4\uDEE0-\uDEEC\uDEF0-\uDEF9\uDF00-\uDF73\uDF80-\uDFD8]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDD00-\uDD0B\uDD10-\uDD3E\uDD40-\uDD70\uDD73-\uDD76\uDD7A\uDD7C-\uDDA2\uDDB0-\uDDB9\uDDC0-\uDDC2\uDDD0-\uDDFF\uDE60-\uDE6D]|\uDB40[\uDC01\uDC20-\uDC7F]'
}, {
  'name': 'Coptic',
  'bmp': '\u03E2-\u03EF\u2C80-\u2CF3\u2CF9-\u2CFF'
}, {
  'name': 'Cuneiform',
  'astral': '\uD808[\uDC00-\uDF99]|\uD809[\uDC00-\uDC6E\uDC70-\uDC74\uDC80-\uDD43]'
}, {
  'name': 'Cypriot',
  'astral': '\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F]'
}, {
  'name': 'Cyrillic',
  'bmp': '\u0400-\u0484\u0487-\u052F\u1C80-\u1C88\u1D2B\u1D78\u2DE0-\u2DFF\uA640-\uA69F\uFE2E\uFE2F'
}, {
  'name': 'Deseret',
  'astral': '\uD801[\uDC00-\uDC4F]'
}, {
  'name': 'Devanagari',
  'bmp': '\u0900-\u0950\u0953-\u0963\u0966-\u097F\uA8E0-\uA8FF'
}, {
  'name': 'Dogra',
  'astral': '\uD806[\uDC00-\uDC3B]'
}, {
  'name': 'Duployan',
  'astral': '\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9C-\uDC9F]'
}, {
  'name': 'Egyptian_Hieroglyphs',
  'astral': '\uD80C[\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]'
}, {
  'name': 'Elbasan',
  'astral': '\uD801[\uDD00-\uDD27]'
}, {
  'name': 'Ethiopic',
  'bmp': '\u1200-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u137C\u1380-\u1399\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E'
}, {
  'name': 'Georgian',
  'bmp': '\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u10FF\u1C90-\u1CBA\u1CBD-\u1CBF\u2D00-\u2D25\u2D27\u2D2D'
}, {
  'name': 'Glagolitic',
  'bmp': '\u2C00-\u2C2E\u2C30-\u2C5E',
  'astral': '\uD838[\uDC00-\uDC06\uDC08-\uDC18\uDC1B-\uDC21\uDC23\uDC24\uDC26-\uDC2A]'
}, {
  'name': 'Gothic',
  'astral': '\uD800[\uDF30-\uDF4A]'
}, {
  'name': 'Grantha',
  'astral': '\uD804[\uDF00-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF50\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]'
}, {
  'name': 'Greek',
  'bmp': '\u0370-\u0373\u0375-\u0377\u037A-\u037D\u037F\u0384\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03E1\u03F0-\u03FF\u1D26-\u1D2A\u1D5D-\u1D61\u1D66-\u1D6A\u1DBF\u1F00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FC4\u1FC6-\u1FD3\u1FD6-\u1FDB\u1FDD-\u1FEF\u1FF2-\u1FF4\u1FF6-\u1FFE\u2126\uAB65',
  'astral': '\uD800[\uDD40-\uDD8E\uDDA0]|\uD834[\uDE00-\uDE45]'
}, {
  'name': 'Gujarati',
  'bmp': '\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AF1\u0AF9-\u0AFF'
}, {
  'name': 'Gunjala_Gondi',
  'astral': '\uD807[\uDD60-\uDD65\uDD67\uDD68\uDD6A-\uDD8E\uDD90\uDD91\uDD93-\uDD98\uDDA0-\uDDA9]'
}, {
  'name': 'Gurmukhi',
  'bmp': '\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A76'
}, {
  'name': 'Han',
  'bmp': '\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u3005\u3007\u3021-\u3029\u3038-\u303B\u3400-\u4DB5\u4E00-\u9FEF\uF900-\uFA6D\uFA70-\uFAD9',
  'astral': '[\uD840-\uD868\uD86A-\uD86C\uD86F-\uD872\uD874-\uD879][\uDC00-\uDFFF]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D\uDC20-\uDFFF]|\uD873[\uDC00-\uDEA1\uDEB0-\uDFFF]|\uD87A[\uDC00-\uDFE0]|\uD87E[\uDC00-\uDE1D]'
}, {
  'name': 'Hangul',
  'bmp': '\u1100-\u11FF\u302E\u302F\u3131-\u318E\u3200-\u321E\u3260-\u327E\uA960-\uA97C\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uFFA0-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC'
}, {
  'name': 'Hanifi_Rohingya',
  'astral': '\uD803[\uDD00-\uDD27\uDD30-\uDD39]'
}, {
  'name': 'Hanunoo',
  'bmp': '\u1720-\u1734'
}, {
  'name': 'Hatran',
  'astral': '\uD802[\uDCE0-\uDCF2\uDCF4\uDCF5\uDCFB-\uDCFF]'
}, {
  'name': 'Hebrew',
  'bmp': '\u0591-\u05C7\u05D0-\u05EA\u05EF-\u05F4\uFB1D-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFB4F'
}, {
  'name': 'Hiragana',
  'bmp': '\u3041-\u3096\u309D-\u309F',
  'astral': '\uD82C[\uDC01-\uDD1E]|\uD83C\uDE00'
}, {
  'name': 'Imperial_Aramaic',
  'astral': '\uD802[\uDC40-\uDC55\uDC57-\uDC5F]'
}, {
  'name': 'Inherited',
  'bmp': '\u0300-\u036F\u0485\u0486\u064B-\u0655\u0670\u0951\u0952\u1AB0-\u1ABE\u1CD0-\u1CD2\u1CD4-\u1CE0\u1CE2-\u1CE8\u1CED\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF9\u1DFB-\u1DFF\u200C\u200D\u20D0-\u20F0\u302A-\u302D\u3099\u309A\uFE00-\uFE0F\uFE20-\uFE2D',
  'astral': '\uD800[\uDDFD\uDEE0]|\uD804\uDF3B|\uD834[\uDD67-\uDD69\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD]|\uDB40[\uDD00-\uDDEF]'
}, {
  'name': 'Inscriptional_Pahlavi',
  'astral': '\uD802[\uDF60-\uDF72\uDF78-\uDF7F]'
}, {
  'name': 'Inscriptional_Parthian',
  'astral': '\uD802[\uDF40-\uDF55\uDF58-\uDF5F]'
}, {
  'name': 'Javanese',
  'bmp': '\uA980-\uA9CD\uA9D0-\uA9D9\uA9DE\uA9DF'
}, {
  'name': 'Kaithi',
  'astral': '\uD804[\uDC80-\uDCC1\uDCCD]'
}, {
  'name': 'Kannada',
  'bmp': '\u0C80-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2'
}, {
  'name': 'Katakana',
  'bmp': '\u30A1-\u30FA\u30FD-\u30FF\u31F0-\u31FF\u32D0-\u32FE\u3300-\u3357\uFF66-\uFF6F\uFF71-\uFF9D',
  'astral': '\uD82C\uDC00'
}, {
  'name': 'Kayah_Li',
  'bmp': '\uA900-\uA92D\uA92F'
}, {
  'name': 'Kharoshthi',
  'astral': '\uD802[\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE35\uDE38-\uDE3A\uDE3F-\uDE48\uDE50-\uDE58]'
}, {
  'name': 'Khmer',
  'bmp': '\u1780-\u17DD\u17E0-\u17E9\u17F0-\u17F9\u19E0-\u19FF'
}, {
  'name': 'Khojki',
  'astral': '\uD804[\uDE00-\uDE11\uDE13-\uDE3E]'
}, {
  'name': 'Khudawadi',
  'astral': '\uD804[\uDEB0-\uDEEA\uDEF0-\uDEF9]'
}, {
  'name': 'Lao',
  'bmp': '\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF'
}, {
  'name': 'Latin',
  'bmp': 'A-Za-z\xAA\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02B8\u02E0-\u02E4\u1D00-\u1D25\u1D2C-\u1D5C\u1D62-\u1D65\u1D6B-\u1D77\u1D79-\u1DBE\u1E00-\u1EFF\u2071\u207F\u2090-\u209C\u212A\u212B\u2132\u214E\u2160-\u2188\u2C60-\u2C7F\uA722-\uA787\uA78B-\uA7B9\uA7F7-\uA7FF\uAB30-\uAB5A\uAB5C-\uAB64\uFB00-\uFB06\uFF21-\uFF3A\uFF41-\uFF5A'
}, {
  'name': 'Lepcha',
  'bmp': '\u1C00-\u1C37\u1C3B-\u1C49\u1C4D-\u1C4F'
}, {
  'name': 'Limbu',
  'bmp': '\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1940\u1944-\u194F'
}, {
  'name': 'Linear_A',
  'astral': '\uD801[\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]'
}, {
  'name': 'Linear_B',
  'astral': '\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA]'
}, {
  'name': 'Lisu',
  'bmp': '\uA4D0-\uA4FF'
}, {
  'name': 'Lycian',
  'astral': '\uD800[\uDE80-\uDE9C]'
}, {
  'name': 'Lydian',
  'astral': '\uD802[\uDD20-\uDD39\uDD3F]'
}, {
  'name': 'Mahajani',
  'astral': '\uD804[\uDD50-\uDD76]'
}, {
  'name': 'Makasar',
  'astral': '\uD807[\uDEE0-\uDEF8]'
}, {
  'name': 'Malayalam',
  'bmp': '\u0D00-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D44\u0D46-\u0D48\u0D4A-\u0D4F\u0D54-\u0D63\u0D66-\u0D7F'
}, {
  'name': 'Mandaic',
  'bmp': '\u0840-\u085B\u085E'
}, {
  'name': 'Manichaean',
  'astral': '\uD802[\uDEC0-\uDEE6\uDEEB-\uDEF6]'
}, {
  'name': 'Marchen',
  'astral': '\uD807[\uDC70-\uDC8F\uDC92-\uDCA7\uDCA9-\uDCB6]'
}, {
  'name': 'Masaram_Gondi',
  'astral': '\uD807[\uDD00-\uDD06\uDD08\uDD09\uDD0B-\uDD36\uDD3A\uDD3C\uDD3D\uDD3F-\uDD47\uDD50-\uDD59]'
}, {
  'name': 'Medefaidrin',
  'astral': '\uD81B[\uDE40-\uDE9A]'
}, {
  'name': 'Meetei_Mayek',
  'bmp': '\uAAE0-\uAAF6\uABC0-\uABED\uABF0-\uABF9'
}, {
  'name': 'Mende_Kikakui',
  'astral': '\uD83A[\uDC00-\uDCC4\uDCC7-\uDCD6]'
}, {
  'name': 'Meroitic_Cursive',
  'astral': '\uD802[\uDDA0-\uDDB7\uDDBC-\uDDCF\uDDD2-\uDDFF]'
}, {
  'name': 'Meroitic_Hieroglyphs',
  'astral': '\uD802[\uDD80-\uDD9F]'
}, {
  'name': 'Miao',
  'astral': '\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F]'
}, {
  'name': 'Modi',
  'astral': '\uD805[\uDE00-\uDE44\uDE50-\uDE59]'
}, {
  'name': 'Mongolian',
  'bmp': '\u1800\u1801\u1804\u1806-\u180E\u1810-\u1819\u1820-\u1878\u1880-\u18AA',
  'astral': '\uD805[\uDE60-\uDE6C]'
}, {
  'name': 'Mro',
  'astral': '\uD81A[\uDE40-\uDE5E\uDE60-\uDE69\uDE6E\uDE6F]'
}, {
  'name': 'Multani',
  'astral': '\uD804[\uDE80-\uDE86\uDE88\uDE8A-\uDE8D\uDE8F-\uDE9D\uDE9F-\uDEA9]'
}, {
  'name': 'Myanmar',
  'bmp': '\u1000-\u109F\uA9E0-\uA9FE\uAA60-\uAA7F'
}, {
  'name': 'Nabataean',
  'astral': '\uD802[\uDC80-\uDC9E\uDCA7-\uDCAF]'
}, {
  'name': 'New_Tai_Lue',
  'bmp': '\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u19DE\u19DF'
}, {
  'name': 'Newa',
  'astral': '\uD805[\uDC00-\uDC59\uDC5B\uDC5D\uDC5E]'
}, {
  'name': 'Nko',
  'bmp': '\u07C0-\u07FA\u07FD-\u07FF'
}, {
  'name': 'Nushu',
  'astral': '\uD81B\uDFE1|\uD82C[\uDD70-\uDEFB]'
}, {
  'name': 'Ogham',
  'bmp': '\u1680-\u169C'
}, {
  'name': 'Ol_Chiki',
  'bmp': '\u1C50-\u1C7F'
}, {
  'name': 'Old_Hungarian',
  'astral': '\uD803[\uDC80-\uDCB2\uDCC0-\uDCF2\uDCFA-\uDCFF]'
}, {
  'name': 'Old_Italic',
  'astral': '\uD800[\uDF00-\uDF23\uDF2D-\uDF2F]'
}, {
  'name': 'Old_North_Arabian',
  'astral': '\uD802[\uDE80-\uDE9F]'
}, {
  'name': 'Old_Permic',
  'astral': '\uD800[\uDF50-\uDF7A]'
}, {
  'name': 'Old_Persian',
  'astral': '\uD800[\uDFA0-\uDFC3\uDFC8-\uDFD5]'
}, {
  'name': 'Old_Sogdian',
  'astral': '\uD803[\uDF00-\uDF27]'
}, {
  'name': 'Old_South_Arabian',
  'astral': '\uD802[\uDE60-\uDE7F]'
}, {
  'name': 'Old_Turkic',
  'astral': '\uD803[\uDC00-\uDC48]'
}, {
  'name': 'Oriya',
  'bmp': '\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B77'
}, {
  'name': 'Osage',
  'astral': '\uD801[\uDCB0-\uDCD3\uDCD8-\uDCFB]'
}, {
  'name': 'Osmanya',
  'astral': '\uD801[\uDC80-\uDC9D\uDCA0-\uDCA9]'
}, {
  'name': 'Pahawh_Hmong',
  'astral': '\uD81A[\uDF00-\uDF45\uDF50-\uDF59\uDF5B-\uDF61\uDF63-\uDF77\uDF7D-\uDF8F]'
}, {
  'name': 'Palmyrene',
  'astral': '\uD802[\uDC60-\uDC7F]'
}, {
  'name': 'Pau_Cin_Hau',
  'astral': '\uD806[\uDEC0-\uDEF8]'
}, {
  'name': 'Phags_Pa',
  'bmp': '\uA840-\uA877'
}, {
  'name': 'Phoenician',
  'astral': '\uD802[\uDD00-\uDD1B\uDD1F]'
}, {
  'name': 'Psalter_Pahlavi',
  'astral': '\uD802[\uDF80-\uDF91\uDF99-\uDF9C\uDFA9-\uDFAF]'
}, {
  'name': 'Rejang',
  'bmp': '\uA930-\uA953\uA95F'
}, {
  'name': 'Runic',
  'bmp': '\u16A0-\u16EA\u16EE-\u16F8'
}, {
  'name': 'Samaritan',
  'bmp': '\u0800-\u082D\u0830-\u083E'
}, {
  'name': 'Saurashtra',
  'bmp': '\uA880-\uA8C5\uA8CE-\uA8D9'
}, {
  'name': 'Sharada',
  'astral': '\uD804[\uDD80-\uDDCD\uDDD0-\uDDDF]'
}, {
  'name': 'Shavian',
  'astral': '\uD801[\uDC50-\uDC7F]'
}, {
  'name': 'Siddham',
  'astral': '\uD805[\uDD80-\uDDB5\uDDB8-\uDDDD]'
}, {
  'name': 'SignWriting',
  'astral': '\uD836[\uDC00-\uDE8B\uDE9B-\uDE9F\uDEA1-\uDEAF]'
}, {
  'name': 'Sinhala',
  'bmp': '\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2-\u0DF4',
  'astral': '\uD804[\uDDE1-\uDDF4]'
}, {
  'name': 'Sogdian',
  'astral': '\uD803[\uDF30-\uDF59]'
}, {
  'name': 'Sora_Sompeng',
  'astral': '\uD804[\uDCD0-\uDCE8\uDCF0-\uDCF9]'
}, {
  'name': 'Soyombo',
  'astral': '\uD806[\uDE50-\uDE83\uDE86-\uDEA2]'
}, {
  'name': 'Sundanese',
  'bmp': '\u1B80-\u1BBF\u1CC0-\u1CC7'
}, {
  'name': 'Syloti_Nagri',
  'bmp': '\uA800-\uA82B'
}, {
  'name': 'Syriac',
  'bmp': '\u0700-\u070D\u070F-\u074A\u074D-\u074F\u0860-\u086A'
}, {
  'name': 'Tagalog',
  'bmp': '\u1700-\u170C\u170E-\u1714'
}, {
  'name': 'Tagbanwa',
  'bmp': '\u1760-\u176C\u176E-\u1770\u1772\u1773'
}, {
  'name': 'Tai_Le',
  'bmp': '\u1950-\u196D\u1970-\u1974'
}, {
  'name': 'Tai_Tham',
  'bmp': '\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA0-\u1AAD'
}, {
  'name': 'Tai_Viet',
  'bmp': '\uAA80-\uAAC2\uAADB-\uAADF'
}, {
  'name': 'Takri',
  'astral': '\uD805[\uDE80-\uDEB7\uDEC0-\uDEC9]'
}, {
  'name': 'Tamil',
  'bmp': '\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BFA'
}, {
  'name': 'Tangut',
  'astral': '\uD81B\uDFE0|[\uD81C-\uD820][\uDC00-\uDFFF]|\uD821[\uDC00-\uDFF1]|\uD822[\uDC00-\uDEF2]'
}, {
  'name': 'Telugu',
  'bmp': '\u0C00-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58-\u0C5A\u0C60-\u0C63\u0C66-\u0C6F\u0C78-\u0C7F'
}, {
  'name': 'Thaana',
  'bmp': '\u0780-\u07B1'
}, {
  'name': 'Thai',
  'bmp': '\u0E01-\u0E3A\u0E40-\u0E5B'
}, {
  'name': 'Tibetan',
  'bmp': '\u0F00-\u0F47\u0F49-\u0F6C\u0F71-\u0F97\u0F99-\u0FBC\u0FBE-\u0FCC\u0FCE-\u0FD4\u0FD9\u0FDA'
}, {
  'name': 'Tifinagh',
  'bmp': '\u2D30-\u2D67\u2D6F\u2D70\u2D7F'
}, {
  'name': 'Tirhuta',
  'astral': '\uD805[\uDC80-\uDCC7\uDCD0-\uDCD9]'
}, {
  'name': 'Ugaritic',
  'astral': '\uD800[\uDF80-\uDF9D\uDF9F]'
}, {
  'name': 'Vai',
  'bmp': '\uA500-\uA62B'
}, {
  'name': 'Warang_Citi',
  'astral': '\uD806[\uDCA0-\uDCF2\uDCFF]'
}, {
  'name': 'Yi',
  'bmp': '\uA000-\uA48C\uA490-\uA4C6'
}, {
  'name': 'Zanabazar_Square',
  'astral': '\uD806[\uDE00-\uDE47]'
}];
/*!
 * XRegExp Unicode Scripts
 * <xregexp.com>
 * Steven Levithan (c) 2010-present MIT License
 * Unicode data by Mathias Bynens <mathiasbynens.be>
 */

var unicodeScripts = XRegExp => {
  /**
   * Adds support for all Unicode scripts. E.g., `\p{Latin}`. Token names are case insensitive,
   * and any spaces, hyphens, and underscores are ignored.
   *
   * Uses Unicode 10.0.0.
   *
   * @requires XRegExp, Unicode Base
   */
  if (!XRegExp.addUnicodeData) {
    throw new ReferenceError('Unicode Base must be loaded before Unicode Scripts');
  }

  XRegExp.addUnicodeData(scripts);
}; // End of module


build(XRegExp);
matchRecursive(XRegExp);
unicodeBase(XRegExp);
unicodeBlocks(XRegExp);
unicodeCategories(XRegExp);
unicodeProperties(XRegExp);
unicodeScripts(XRegExp);
export default XRegExp;