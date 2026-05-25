//! csspurge — filters a vendor CSS file down to the rules whose selectors
//! reference classes actually used in our project source.
//!
//! Inputs:
//!   --input <css>     the stylesheet to filter (e.g. primer.css)
//!   --used  <file>    a newline-separated list of class names known to be
//!                     referenced from project sources (produced by
//!                     cmd/cssusage). Already includes any safelist entries.
//!   --output <css>    output path for the filtered + minified CSS
//!
//! Algorithm: parse with lightningcss → walk the rule list → keep a rule
//! when ANY selector mentions a used class (or carries no class component
//! at all, i.e. tag/pseudo/global selectors like `:root`, `*`, `html`,
//! `body`, `@keyframes`, `@font-face`). Recurse into @media / @supports /
//! @layer / nested groups; drop empty wrappers afterward.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use clap::Parser;
use lightningcss::rules::CssRule;
use lightningcss::stylesheet::{
    MinifyOptions, ParserOptions, PrinterOptions, StyleSheet,
};
use lightningcss::targets::Targets;
use parcel_selectors::parser::Component;

#[derive(Parser)]
#[command(name = "csspurge")]
struct Cli {
    #[arg(long)]
    input: PathBuf,

    #[arg(long)]
    used: PathBuf,

    #[arg(long)]
    output: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let css = fs::read_to_string(&cli.input)?;
    let used = read_used(&cli.used)?;

    let mut stylesheet = StyleSheet::parse(&css, ParserOptions::default())
        .map_err(|e| format!("parse: {}", e))?;

    purge_rules(&mut stylesheet.rules.0, &used);

    stylesheet
        .minify(MinifyOptions {
            targets: Targets::default(),
            unused_symbols: HashSet::new(),
        })
        .map_err(|e| format!("minify: {}", e))?;

    let printed = stylesheet
        .to_css(PrinterOptions {
            minify: true,
            ..Default::default()
        })
        .map_err(|e| format!("print: {}", e))?;

    fs::write(&cli.output, printed.code)?;
    Ok(())
}

fn read_used(path: &PathBuf) -> Result<HashSet<String>, std::io::Error> {
    let body = fs::read_to_string(path)?;
    Ok(body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect())
}

/// Walks a rule vector in place, descending into nested wrappers
/// (@media, @supports, @layer, …) and dropping anything whose selectors
/// have no class-name overlap with `used`. Wrappers that end up empty
/// after recursion are dropped too.
fn purge_rules(rules: &mut Vec<CssRule>, used: &HashSet<String>) {
    rules.retain_mut(|rule| keep_rule(rule, used));
}

fn keep_rule(rule: &mut CssRule, used: &HashSet<String>) -> bool {
    match rule {
        // Inline the selector check — naming the `parcel_selectors`
        // SelectorImpl type explicitly would require `lightningcss::
        // selector::Selectors`, which is gated behind a private module.
        // Letting type inference do its job sidesteps that limitation.
        CssRule::Style(style) => style.selectors.0.iter().any(|sel| {
            let mut any_class = false;
            let mut any_used = false;
            for component in sel.iter_raw_match_order() {
                if let Component::Class(name) = component {
                    any_class = true;
                    if used.contains(name.0.as_ref()) {
                        any_used = true;
                        break;
                    }
                }
            }
            // Selectors with zero class components (`:root`, `*`, tag-only,
            // attribute-only) are kept unconditionally — they carry global
            // theme variables and structural styles we never want to drop.
            !any_class || any_used
        }),
        CssRule::Media(group) => {
            purge_rules(&mut group.rules.0, used);
            !group.rules.0.is_empty()
        }
        CssRule::Supports(group) => {
            purge_rules(&mut group.rules.0, used);
            !group.rules.0.is_empty()
        }
        CssRule::LayerBlock(group) => {
            purge_rules(&mut group.rules.0, used);
            !group.rules.0.is_empty()
        }
        CssRule::Container(group) => {
            purge_rules(&mut group.rules.0, used);
            !group.rules.0.is_empty()
        }
        CssRule::Nesting(group) => {
            purge_rules(&mut group.style.rules.0, used);
            !group.style.rules.0.is_empty()
        }
        CssRule::Scope(group) => {
            purge_rules(&mut group.rules.0, used);
            !group.rules.0.is_empty()
        }
        CssRule::StartingStyle(group) => {
            purge_rules(&mut group.rules.0, used);
            !group.rules.0.is_empty()
        }
        // Bare declarations / global / @-rules that don't carry selectors
        // we can statically analyze: keep them. Most of these are small
        // and rare; the bytes saved by dropping them aren't worth the
        // false-negative risk.
        _ => true,
    }
}

