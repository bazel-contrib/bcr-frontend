/*
 Copyright 2013-2016 Jason Leyba

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

/**
 * @fileoverview A class that facilitates fast autocompletion search.
 */
goog.module("dossier.AutoCompleteMatcher");

const Heap = goog.require("dossier.Heap");
const asserts = goog.require("goog.asserts");
const strings = goog.require("goog.string");

/**
 * Matcher used for auto-complete suggestions in the search box. This class
 * uses multiple passes for its suggestions:
 *
 * 1) A case insensitive substring match is performed on all known words.
 * 2) If the previous step matches more terms than requested, the list is
 *    further filtered using the Damerau–Levenshtein distance.
 *
 * @see https://en.wikipedia.org/wiki/Damerau%E2%80%93Levenshtein_distance
 */
class AutoCompleteMatcher {
    /** @param {!Array<string>} terms */
    constructor(terms) {
        /** @private @const */
        this.terms_ = terms;
    }

    /**
     * Method used by the {@link AutoComplete} class to request matches on an
     * input token.
     * @param {string} token
     * @param {number} max
     * @param {function(string, !Array<string>)} callback
     */
    requestMatchingRows(token, max, callback) {
        callback(token, this.match(token, max));
    }

    /**
     * @param {string} token The token to match on this matcher's terms.
     * @param {number} max The maximum number of results to return.
     * @return {!Array<string>} The matched entries.
     */
    match(token, max) {
        if (!token) {
            return [];
        }

        let matcher = new RegExp(strings.regExpEscape(token), "i");
        let heap = new Heap((a, b) => b.key - a.key);
        for (let term of this.terms_) {
            // 1) Require at least a substring match.
            if (!term.match(matcher)) {
                continue;
            }

            // 2) Select the if it is K-closest (K=max) using Damerau–Levenshtein
            // distance.
            //
            // NB: we could apply this second pass only if there are >max substring
            // matches, but this ensures suggestions are always consistently sorted
            // based on D-L distance.
            let distance = this.damerauLevenshteinDistance_(token, term);
            if (heap.size() < max) {
                heap.insert(distance, term);
            } else if (distance < asserts.assertNumber(heap.peekKey())) {
                heap.remove();
                heap.insert(distance, term);
            }
        }

        const matches = heap
            .entries()
            .sort((a, b) => a.key - b.key)
            .map((e) => e.value);

        return matches;
    }

    /**
     * @param {string} a
     * @param {string} b
     * @return {number}
     * @private
     */
    damerauLevenshteinDistance_(a, b) {
        /** @type {!Array<!Array<number>>} */
        let d = [];

        for (let i = 0; i <= a.length; i++) {
            d[i] = [i];
        }

        for (let j = 0; j <= b.length; j++) {
            d[0][j] = j;
        }

        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                let cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
                d[i][j] = Math.min(
                    d[i - 1][j] + 1, // Deletion
                    d[i][j - 1] + 1, // Insertion
                    d[i - 1][j - 1] + cost, // Substitution
                );

                if (
                    i > 1 &&
                    j > 1 &&
                    a.charAt(i - 1) == b.charAt(j - 2) &&
                    a.charAt(i - 2) == b.charAt(j - 1)
                ) {
                    d[i][j] = Math.min(
                        d[i][j],
                        d[i - 2][j - 2] + cost, // Transposition
                    );
                }
            }
        }

        return d[a.length][b.length];
    }
}
exports = AutoCompleteMatcher;
