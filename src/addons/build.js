/*!
 * XRegExp.build
 * <xregexp.com>
 * Steven Levithan (c) 2012-2017 MIT License
 * Inspired by Lea Verou's RegExp.create <lea.verou.me>
 */

module.exports = function(XRegExp) {

'use strict';

var REGEX_DATA = 'xregexp';
var subParts = /(\()(?!\?)|\\([1-9]\d*)|\\[\s\S]|\[(?:[^\\\]]|\\[\s\S])*\]/g;
var parts = XRegExp.union([/\({{([\w$]+)}}\)|{{([\w$]+)}}/, subParts], 'g', {
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
    var leadingAnchor = /^(?:\(\?:\))*\^/;
    var trailingAnchor = /\$(?:\(\?:\))*$/;

    if (
        leadingAnchor.test(pattern) &&
        trailingAnchor.test(pattern) &&
        // Ensure that the trailing `$` isn't escaped
        trailingAnchor.test(pattern.replace(/\\[\s\S]/g, ''))
    ) {
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
    var flags = addFlagX ? 'x' : '';
    return XRegExp.isRegExp(value) ?
        (value[REGEX_DATA] && value[REGEX_DATA].captureNames ?
            // Don't recompile, to preserve capture names
            value :
            // Recompile as XRegExp
            XRegExp(value.source, flags)
        ) :
        // Compile string as XRegExp
        XRegExp(value, flags);
}

function interpolate(substitution) {
    return substitution instanceof RegExp ? substitution : XRegExp.escape(substitution);
}

function reduceToSubpatternsObject(subpatterns, interpolated, subpatternIndex) {
    subpatterns['subpattern' + subpatternIndex] = interpolated;
    return subpatterns;
}

function embedSubpatternAfter(raw, subpatternIndex, rawLiterals) {
    var hasSubpattern = subpatternIndex < rawLiterals.length - 1;
    return raw + (hasSubpattern ? '{{subpattern' + subpatternIndex + '}}' : '');
}

/**
 * Provides a tag function for building regexes using template literals [1]. See GitHub issue
 * 103 for discussion [2].
 *
 * [1]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_template_literals
 * [2]: https://github.com/slevithan/xregexp/issues/103
 * @example
 *
 * var h12 = /1[0-2]|0?[1-9]/;
 * var h24 = /2[0-3]|[01][0-9]/;
 * var hours = XRegExp.tag('x')`${h12} : | ${h24}`
 * var minutes = /^[0-5][0-9]$/;
 * // Note that explicitly naming the 'minutes' group is required for it to appear in the
 * // `XRegExp.exec()` return value object.
 * var time = XRegExp.tag('x')`^ ${hours} (?<minutes>${minutes}) $`
 * time.test('10:59'); // -> true
 * XRegExp.exec('10:59', time).minutes; // -> '59'
 */
XRegExp.tag = function(flags) {
    return function(literals, ...substitutions) {
        var subpatterns = substitutions.map(interpolate).reduce(reduceToSubpatternsObject, {});
        var pattern = literals.raw.map(embedSubpatternAfter).join('');
        return XRegExp.build(pattern, subpatterns, flags);
    };
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
 * var time = XRegExp.build('(?x)^ {{hours}} ({{minutes}}) $', {
 *   hours: XRegExp.build('{{h12}} : | {{h24}}', {
 *     h12: /1[0-2]|0?[1-9]/,
 *     h24: /2[0-3]|[01][0-9]/
 *   }, 'x'),
 *   minutes: /^[0-5][0-9]$/
 * });
 * time.test('10:59'); // -> true
 * XRegExp.exec('10:59', time).minutes; // -> '59'
 */
XRegExp.build = function(pattern, subs, flags) {
    flags = flags || '';
    // Used with `asXRegExp` calls for `pattern` and subpatterns in `subs`, to work around how
    // some browsers convert `RegExp('\n')` to a regex that contains the literal characters `\`
    // and `n`. See more details at <https://github.com/slevithan/xregexp/pull/163>.
    var addFlagX = flags.indexOf('x') > -1;
    var inlineFlags = /^\(\?([\w$]+)\)/.exec(pattern);
    // Add flags within a leading mode modifier to the overall pattern's flags
    if (inlineFlags) {
        flags = XRegExp._clipDuplicates(flags + inlineFlags[1]);
    }

    var data = {};
    for (var p in subs) {
        if (subs.hasOwnProperty(p)) {
            // Passing to XRegExp enables extended syntax and ensures independent validity,
            // lest an unescaped `(`, `)`, `[`, or trailing `\` breaks the `(?:)` wrapper. For
            // subpatterns provided as native regexes, it dies on octals and adds the property
            // used to hold extended regex instance data, for simplicity.
            var sub = asXRegExp(subs[p], addFlagX);
            data[p] = {
                // Deanchoring allows embedding independently useful anchored regexes. If you
                // really need to keep your anchors, double them (i.e., `^^...$$`).
                pattern: deanchor(sub.source),
                names: sub[REGEX_DATA].captureNames || []
            };
        }
    }

    // Passing to XRegExp dies on octals and ensures the outer pattern is independently valid;
    // helps keep this simple. Named captures will be put back.
    var patternAsRegex = asXRegExp(pattern, addFlagX);

    // 'Caps' is short for 'captures'
    var numCaps = 0;
    var numPriorCaps;
    var numOuterCaps = 0;
    var outerCapsMap = [0];
    var outerCapNames = patternAsRegex[REGEX_DATA].captureNames || [];
    var output = patternAsRegex.source.replace(parts, function($0, $1, $2, $3, $4) {
        var subName = $1 || $2;
        var capName;
        var intro;
        var localCapIndex;
        // Named subpattern
        if (subName) {
            if (!data.hasOwnProperty(subName)) {
                throw new ReferenceError('Undefined property ' + $0);
            }
            // Named subpattern was wrapped in a capturing group
            if ($1) {
                capName = outerCapNames[numOuterCaps];
                outerCapsMap[++numOuterCaps] = ++numCaps;
                // If it's a named group, preserve the name. Otherwise, use the subpattern name
                // as the capture name
                intro = '(?<' + (capName || subName) + '>';
            } else {
                intro = '(?:';
            }
            numPriorCaps = numCaps;
            return intro + data[subName].pattern.replace(subParts, function(match, paren, backref) {
                // Capturing group
                if (paren) {
                    capName = data[subName].names[numCaps - numPriorCaps];
                    ++numCaps;
                    // If the current capture has a name, preserve the name
                    if (capName) {
                        return '(?<' + capName + '>';
                    }
                // Backreference
                } else if (backref) {
                    localCapIndex = +backref - 1;
                    // Rewrite the backreference
                    return data[subName].names[localCapIndex] ?
                        // Need to preserve the backreference name in case using flag `n`
                        '\\k<' + data[subName].names[localCapIndex] + '>' :
                        '\\' + (+backref + numPriorCaps);
                }
                return match;
            }) + ')';
        }
        // Capturing group
        if ($3) {
            capName = outerCapNames[numOuterCaps];
            outerCapsMap[++numOuterCaps] = ++numCaps;
            // If the current capture has a name, preserve the name
            if (capName) {
                return '(?<' + capName + '>';
            }
        // Backreference
        } else if ($4) {
            localCapIndex = +$4 - 1;
            // Rewrite the backreference
            return outerCapNames[localCapIndex] ?
                // Need to preserve the backreference name in case using flag `n`
                '\\k<' + outerCapNames[localCapIndex] + '>' :
                '\\' + outerCapsMap[+$4];
        }
        return $0;
    });

    return XRegExp(output, flags);
};

};              // End of module
