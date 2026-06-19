//! Best-effort LaTeX math to Unicode plain text conversion for terminal display.
//!
//! This is a Rust port of `packages/tui/src/latex.ts`. The goal is readable
//! monospace math, not faithful typesetting.

const SYMBOLS: &[(&str, &str)] = &[
    // Greek lowercase
    ("alpha", "α"),
    ("beta", "β"),
    ("gamma", "γ"),
    ("delta", "δ"),
    ("epsilon", "ε"),
    ("varepsilon", "ε"),
    ("zeta", "ζ"),
    ("eta", "η"),
    ("theta", "θ"),
    ("vartheta", "ϑ"),
    ("iota", "ι"),
    ("kappa", "κ"),
    ("lambda", "λ"),
    ("mu", "μ"),
    ("nu", "ν"),
    ("xi", "ξ"),
    ("pi", "π"),
    ("varpi", "ϖ"),
    ("rho", "ρ"),
    ("varrho", "ϱ"),
    ("sigma", "σ"),
    ("varsigma", "ς"),
    ("tau", "τ"),
    ("upsilon", "υ"),
    ("phi", "ϕ"),
    ("varphi", "φ"),
    ("chi", "χ"),
    ("psi", "ψ"),
    ("omega", "ω"),
    // Greek uppercase
    ("Gamma", "Γ"),
    ("Delta", "Δ"),
    ("Theta", "Θ"),
    ("Lambda", "Λ"),
    ("Xi", "Ξ"),
    ("Pi", "Π"),
    ("Sigma", "Σ"),
    ("Upsilon", "Υ"),
    ("Phi", "Φ"),
    ("Psi", "Ψ"),
    ("Omega", "Ω"),
    // Big operators
    ("sum", "∑"),
    ("prod", "∏"),
    ("coprod", "∐"),
    ("int", "∫"),
    ("iint", "∬"),
    ("iiint", "∭"),
    ("oint", "∮"),
    ("bigcup", "⋃"),
    ("bigcap", "⋂"),
    ("bigoplus", "⨁"),
    ("bigotimes", "⨂"),
    ("bigodot", "⨀"),
    ("bigvee", "⋁"),
    ("bigwedge", "⋀"),
    ("bigsqcup", "⨆"),
    // Binary operators
    ("pm", "±"),
    ("mp", "∓"),
    ("times", "×"),
    ("div", "÷"),
    ("cdot", "·"),
    ("ast", "∗"),
    ("star", "⋆"),
    ("circ", "∘"),
    ("bullet", "•"),
    ("oplus", "⊕"),
    ("ominus", "⊖"),
    ("otimes", "⊗"),
    ("oslash", "⊘"),
    ("odot", "⊙"),
    ("wedge", "∧"),
    ("land", "∧"),
    ("vee", "∨"),
    ("lor", "∨"),
    ("cap", "∩"),
    ("cup", "∪"),
    ("setminus", "∖"),
    ("sqcap", "⊓"),
    ("sqcup", "⊔"),
    ("uplus", "⊎"),
    ("dagger", "†"),
    ("ddagger", "‡"),
    // Relations
    ("leq", "≤"),
    ("le", "≤"),
    ("geq", "≥"),
    ("ge", "≥"),
    ("neq", "≠"),
    ("ne", "≠"),
    ("equiv", "≡"),
    ("sim", "∼"),
    ("simeq", "≃"),
    ("approx", "≈"),
    ("cong", "≅"),
    ("propto", "∝"),
    ("ll", "≪"),
    ("gg", "≫"),
    ("subset", "⊂"),
    ("supset", "⊃"),
    ("subseteq", "⊆"),
    ("supseteq", "⊇"),
    ("sqsubseteq", "⊑"),
    ("sqsupseteq", "⊒"),
    ("in", "∈"),
    ("ni", "∋"),
    ("notin", "∉"),
    ("models", "⊨"),
    ("vdash", "⊢"),
    ("dashv", "⊣"),
    ("perp", "⊥"),
    ("parallel", "∥"),
    ("mid", "∣"),
    ("asymp", "≍"),
    ("doteq", "≐"),
    ("prec", "≺"),
    ("succ", "≻"),
    ("preceq", "⪯"),
    ("succeq", "⪰"),
    ("triangleq", "≜"),
    ("coloneqq", "≔"),
    ("coloneq", "≔"),
    // Arrows
    ("to", "→"),
    ("rightarrow", "→"),
    ("leftarrow", "←"),
    ("gets", "←"),
    ("leftrightarrow", "↔"),
    ("Rightarrow", "⇒"),
    ("Leftarrow", "⇐"),
    ("Leftrightarrow", "⇔"),
    ("iff", "⇔"),
    ("implies", "⇒"),
    ("impliedby", "⇐"),
    ("mapsto", "↦"),
    ("longrightarrow", "⟶"),
    ("longleftarrow", "⟵"),
    ("Longrightarrow", "⟹"),
    ("Longleftarrow", "⟸"),
    ("longmapsto", "⟼"),
    ("uparrow", "↑"),
    ("downarrow", "↓"),
    ("updownarrow", "↕"),
    ("Uparrow", "⇑"),
    ("Downarrow", "⇓"),
    ("hookrightarrow", "↪"),
    ("hookleftarrow", "↩"),
    ("rightharpoonup", "⇀"),
    ("leftharpoonup", "↼"),
    ("rightrightarrows", "⇉"),
    ("rightleftarrows", "⇄"),
    ("leadsto", "⇝"),
    ("nearrow", "↗"),
    ("searrow", "↘"),
    ("nwarrow", "↖"),
    ("swarrow", "↙"),
    // Misc
    ("infty", "∞"),
    ("partial", "∂"),
    ("nabla", "∇"),
    ("forall", "∀"),
    ("exists", "∃"),
    ("nexists", "∄"),
    ("emptyset", "∅"),
    ("varnothing", "∅"),
    ("neg", "¬"),
    ("lnot", "¬"),
    ("angle", "∠"),
    ("triangle", "△"),
    ("square", "□"),
    ("Box", "□"),
    ("blacksquare", "■"),
    ("diamond", "⋄"),
    ("Diamond", "◇"),
    ("aleph", "ℵ"),
    ("hbar", "ℏ"),
    ("ell", "ℓ"),
    ("Re", "ℜ"),
    ("Im", "ℑ"),
    ("wp", "℘"),
    ("top", "⊤"),
    ("bot", "⊥"),
    ("flat", "♭"),
    ("sharp", "♯"),
    ("natural", "♮"),
    ("checkmark", "✓"),
    ("degree", "°"),
    ("prime", "′"),
    ("therefore", "∴"),
    ("because", "∵"),
    // Dots
    ("dots", "…"),
    ("ldots", "…"),
    ("dotsc", "…"),
    ("dotso", "…"),
    ("cdots", "⋯"),
    ("dotsb", "⋯"),
    ("vdots", "⋮"),
    ("ddots", "⋱"),
    // Delimiters
    ("langle", "⟨"),
    ("rangle", "⟩"),
    ("lceil", "⌈"),
    ("rceil", "⌉"),
    ("lfloor", "⌊"),
    ("rfloor", "⌋"),
    ("lvert", "|"),
    ("rvert", "|"),
    ("vert", "|"),
    ("lVert", "‖"),
    ("rVert", "‖"),
    ("Vert", "‖"),
];

const OPERATOR_NAMES: &[&str] = &[
    "log", "ln", "lg", "exp", "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos",
    "arctan", "sinh", "cosh", "tanh", "coth", "min", "max", "argmin", "argmax", "arg", "sup",
    "inf", "lim", "limsup", "liminf", "det", "dim", "ker", "deg", "gcd", "hom", "Pr", "tr", "Tr",
    "rank", "diag", "sgn", "softmax", "mod", "bmod",
];

const SPACING_COMMANDS: &[(&str, &str)] = &[
    ("quad", "  "),
    ("qquad", "    "),
    ("thinspace", " "),
    ("enspace", " "),
    ("medspace", " "),
    ("thickspace", " "),
];

const ACCENTS: &[(&str, &str)] = &[
    ("hat", "\u{302}"),
    ("widehat", "\u{302}"),
    ("bar", "\u{304}"),
    ("overline", "\u{305}"),
    ("underline", "\u{332}"),
    ("vec", "\u{20d7}"),
    ("tilde", "\u{303}"),
    ("widetilde", "\u{303}"),
    ("dot", "\u{307}"),
    ("ddot", "\u{308}"),
    ("breve", "\u{306}"),
    ("check", "\u{30c}"),
    ("acute", "\u{301}"),
    ("grave", "\u{300}"),
    ("mathring", "\u{30a}"),
];

const SUPERSCRIPTS: &[(char, &str)] = &[
    ('0', "⁰"),
    ('1', "¹"),
    ('2', "²"),
    ('3', "³"),
    ('4', "⁴"),
    ('5', "⁵"),
    ('6', "⁶"),
    ('7', "⁷"),
    ('8', "⁸"),
    ('9', "⁹"),
    ('+', "⁺"),
    ('-', "⁻"),
    ('−', "⁻"),
    ('=', "⁼"),
    ('(', "⁽"),
    (')', "⁾"),
    ('*', "*"),
    ('a', "ᵃ"),
    ('b', "ᵇ"),
    ('c', "ᶜ"),
    ('d', "ᵈ"),
    ('e', "ᵉ"),
    ('f', "ᶠ"),
    ('g', "ᵍ"),
    ('h', "ʰ"),
    ('i', "ⁱ"),
    ('j', "ʲ"),
    ('k', "ᵏ"),
    ('l', "ˡ"),
    ('m', "ᵐ"),
    ('n', "ⁿ"),
    ('o', "ᵒ"),
    ('p', "ᵖ"),
    ('r', "ʳ"),
    ('s', "ˢ"),
    ('t', "ᵗ"),
    ('u', "ᵘ"),
    ('v', "ᵛ"),
    ('w', "ʷ"),
    ('x', "ˣ"),
    ('y', "ʸ"),
    ('z', "ᶻ"),
    ('A', "ᴬ"),
    ('B', "ᴮ"),
    ('D', "ᴰ"),
    ('E', "ᴱ"),
    ('G', "ᴳ"),
    ('H', "ᴴ"),
    ('I', "ᴵ"),
    ('J', "ᴶ"),
    ('K', "ᴷ"),
    ('L', "ᴸ"),
    ('M', "ᴹ"),
    ('N', "ᴺ"),
    ('O', "ᴼ"),
    ('P', "ᴾ"),
    ('R', "ᴿ"),
    ('T', "ᵀ"),
    ('U', "ᵁ"),
    ('V', "ⱽ"),
    ('W', "ᵂ"),
    ('β', "ᵝ"),
    ('γ', "ᵞ"),
    ('δ', "ᵟ"),
    ('θ', "ᶿ"),
    ('ϕ', "ᵠ"),
    ('φ', "ᵠ"),
    ('χ', "ᵡ"),
];

const SUBSCRIPTS: &[(char, &str)] = &[
    ('0', "₀"),
    ('1', "₁"),
    ('2', "₂"),
    ('3', "₃"),
    ('4', "₄"),
    ('5', "₅"),
    ('6', "₆"),
    ('7', "₇"),
    ('8', "₈"),
    ('9', "₉"),
    ('+', "₊"),
    ('-', "₋"),
    ('−', "₋"),
    ('=', "₌"),
    ('(', "₍"),
    (')', "₎"),
    ('a', "ₐ"),
    ('e', "ₑ"),
    ('h', "ₕ"),
    ('i', "ᵢ"),
    ('j', "ⱼ"),
    ('k', "ₖ"),
    ('l', "ₗ"),
    ('m', "ₘ"),
    ('n', "ₙ"),
    ('o', "ₒ"),
    ('p', "ₚ"),
    ('r', "ᵣ"),
    ('s', "ₛ"),
    ('t', "ₜ"),
    ('u', "ᵤ"),
    ('v', "ᵥ"),
    ('x', "ₓ"),
    ('β', "ᵦ"),
    ('γ', "ᵧ"),
    ('ρ', "ᵨ"),
    ('ϕ', "ᵩ"),
    ('φ', "ᵩ"),
    ('χ', "ᵪ"),
];

const COMMON_FRACTIONS: &[(&str, &str)] = &[
    ("1/2", "½"),
    ("1/3", "⅓"),
    ("2/3", "⅔"),
    ("1/4", "¼"),
    ("3/4", "¾"),
    ("1/5", "⅕"),
    ("2/5", "⅖"),
    ("3/5", "⅗"),
    ("4/5", "⅘"),
    ("1/6", "⅙"),
    ("5/6", "⅚"),
    ("1/8", "⅛"),
];

const TEXT_COMMANDS: &[&str] = &[
    "text", "textrm", "textit", "textsf", "texttt", "mbox", "hbox",
];

const MATH_FONT_COMMANDS: &[&str] = &[
    "mathrm",
    "mathit",
    "mathsf",
    "mathtt",
    "mathnormal",
    "operatorname",
];

const IGNORED_COMMANDS: &[&str] = &[
    "left",
    "right",
    "big",
    "Big",
    "bigg",
    "Bigg",
    "bigl",
    "bigr",
    "bigm",
    "Bigl",
    "Bigr",
    "Bigm",
    "biggl",
    "biggr",
    "Biggl",
    "Biggr",
    "displaystyle",
    "textstyle",
    "scriptstyle",
    "limits",
    "nolimits",
    "middle",
    "allowbreak",
    "nonumber",
    "notag",
];

const NO_EXCEPTIONS: &[(char, &str)] = &[];
const MATHBB_EXCEPTIONS: &[(char, &str)] = &[
    ('C', "ℂ"),
    ('H', "ℍ"),
    ('N', "ℕ"),
    ('P', "ℙ"),
    ('Q', "ℚ"),
    ('R', "ℝ"),
    ('Z', "ℤ"),
];
const MATHCAL_EXCEPTIONS: &[(char, &str)] = &[
    ('B', "ℬ"),
    ('E', "ℰ"),
    ('F', "ℱ"),
    ('H', "ℋ"),
    ('I', "ℐ"),
    ('L', "ℒ"),
    ('M', "ℳ"),
    ('R', "ℛ"),
    ('e', "ℯ"),
    ('g', "ℊ"),
    ('o', "ℴ"),
];
const MATHFRAK_EXCEPTIONS: &[(char, &str)] =
    &[('C', "ℭ"), ('H', "ℌ"), ('I', "ℑ"), ('R', "ℜ"), ('Z', "ℨ")];

#[derive(Clone, Copy)]
struct AlphabetStyle {
    upper: Option<u32>,
    lower: Option<u32>,
    digit: Option<u32>,
    exceptions: &'static [(char, &'static str)],
}

fn lookup<'a>(table: &'a [(&str, &str)], name: &str) -> Option<&'a str> {
    table
        .iter()
        .find_map(|(key, value)| (*key == name).then_some(*value))
}

fn has_name(table: &[&str], name: &str) -> bool {
    table.contains(&name)
}

fn lookup_char<'a>(table: &'a [(char, &'a str)], ch: char) -> Option<&'a str> {
    table
        .iter()
        .find_map(|(key, value)| (*key == ch).then_some(*value))
}

fn alphabet(name: &str) -> Option<AlphabetStyle> {
    match name {
        "mathbb" => Some(AlphabetStyle {
            upper: Some(0x1d538),
            lower: Some(0x1d552),
            digit: Some(0x1d7d8),
            exceptions: MATHBB_EXCEPTIONS,
        }),
        "mathbf" | "boldsymbol" | "bm" | "textbf" => Some(AlphabetStyle {
            upper: Some(0x1d400),
            lower: Some(0x1d41a),
            digit: Some(0x1d7ce),
            exceptions: NO_EXCEPTIONS,
        }),
        "mathcal" | "mathscr" => Some(AlphabetStyle {
            upper: Some(0x1d49c),
            lower: Some(0x1d4b6),
            digit: None,
            exceptions: MATHCAL_EXCEPTIONS,
        }),
        "mathfrak" => Some(AlphabetStyle {
            upper: Some(0x1d504),
            lower: Some(0x1d51e),
            digit: None,
            exceptions: MATHFRAK_EXCEPTIONS,
        }),
        _ => None,
    }
}

fn escape(ch: char) -> Option<&'static str> {
    match ch {
        '{' => Some("{"),
        '}' => Some("}"),
        '%' => Some("%"),
        '$' => Some("$"),
        '&' => Some("&"),
        '#' => Some("#"),
        '_' => Some("_"),
        '|' => Some("‖"),
        '\\' => Some("\n"),
        ' ' => Some(" "),
        ',' => Some(" "),
        ';' => Some(" "),
        ':' => Some(" "),
        '!' => Some(""),
        _ => None,
    }
}

fn style_alphabet(text: &str, style: AlphabetStyle) -> String {
    let mut result = String::new();
    for ch in text.chars() {
        if let Some(exception) = lookup_char(style.exceptions, ch) {
            result.push_str(exception);
        } else if ch.is_ascii_uppercase() {
            if let Some(base) = style.upper {
                result.push(char::from_u32(base + ch as u32 - 'A' as u32).unwrap_or(ch));
            } else {
                result.push(ch);
            }
        } else if ch.is_ascii_lowercase() {
            if let Some(base) = style.lower {
                result.push(char::from_u32(base + ch as u32 - 'a' as u32).unwrap_or(ch));
            } else {
                result.push(ch);
            }
        } else if ch.is_ascii_digit() {
            if let Some(base) = style.digit {
                result.push(char::from_u32(base + ch as u32 - '0' as u32).unwrap_or(ch));
            } else {
                result.push(ch);
            }
        } else {
            result.push(ch);
        }
    }
    result
}

fn map_script(text: &str, table: &[(char, &str)]) -> Option<String> {
    let mut result = String::new();
    for ch in text.chars() {
        let mapped = lookup_char(table, ch)?;
        result.push_str(mapped);
    }
    Some(result)
}

fn is_combining_mark(ch: char) -> bool {
    matches!(
        ch as u32,
        0x0300..=0x036f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0x20d0..=0x20ff | 0xfe20..=0xfe2f
    )
}

fn is_simple_operand(text: &str) -> bool {
    text.chars().count() == 1
        || (!text.is_empty()
            && text
                .chars()
                .all(|ch| ch.is_alphanumeric() || is_combining_mark(ch)))
}

fn parenthesize(text: &str) -> String {
    if is_simple_operand(text) {
        text.to_owned()
    } else {
        format!("({text})")
    }
}

struct LatexParser<'a> {
    src: &'a str,
    pos: usize,
    text_mode: bool,
}

impl<'a> LatexParser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src,
            pos: 0,
            text_mode: false,
        }
    }

    fn parse(&mut self) -> String {
        self.parse_sequence()
    }

    fn parse_sequence(&mut self) -> String {
        let mut result = String::new();
        while self.pos < self.src.len() {
            let Some(ch) = self.peek() else {
                break;
            };
            if ch == '}' {
                break;
            }
            if (ch == '^' || ch == '_') && !self.text_mode {
                self.bump();
                let table = if ch == '^' { SUPERSCRIPTS } else { SUBSCRIPTS };
                result.push_str(&self.parse_script(table, ch));
                continue;
            }
            if ch == '&' {
                self.bump();
                if !result.chars().last().is_some_and(char::is_whitespace) {
                    result.push(' ');
                }
                continue;
            }
            if let Some(atom) = self.parse_atom() {
                result.push_str(&atom);
            }
        }
        result
    }

    fn parse_atom(&mut self) -> Option<String> {
        let ch = self.peek()?;
        if ch == '{' {
            return Some(self.parse_group());
        }
        if ch == '\\' {
            return Some(self.parse_command());
        }
        self.bump();
        Some(ch.to_string())
    }

    fn parse_group(&mut self) -> String {
        self.bump();
        let content = self.parse_sequence();
        if self.peek() == Some('}') {
            self.bump();
        }
        content
    }

    fn parse_optional_bracket(&mut self) -> Option<String> {
        if self.peek() != Some('[') {
            return None;
        }

        let content_start = self.pos + '['.len_utf8();
        let relative_end = self.src[content_start..].find(']')?;
        let end = content_start + relative_end;
        let mut parser = LatexParser::new(&self.src[content_start..end]);
        let content = parser.parse();
        self.pos = end + ']'.len_utf8();
        Some(content)
    }

    fn parse_argument(&mut self) -> String {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }

        if self.peek() == Some('{') {
            self.parse_group()
        } else {
            self.parse_atom().unwrap_or_default()
        }
    }

    fn parse_script(&mut self, table: &[(char, &str)], operator: char) -> String {
        let content = self.parse_argument();
        if let Some(mapped) = map_script(&content, table) {
            return mapped;
        }

        if content.chars().count() == 1 {
            format!("{operator}{content}")
        } else {
            format!("{operator}{{{content}}}")
        }
    }

    fn parse_command(&mut self) -> String {
        self.bump();
        if self.pos >= self.src.len() {
            return String::new();
        }

        let Some(ch) = self.peek() else {
            return String::new();
        };
        if !ch.is_ascii_alphabetic() {
            self.bump();
            return escape(ch).map_or_else(|| ch.to_string(), ToOwned::to_owned);
        }

        let mut name = String::new();
        while let Some(ch) = self.peek() {
            if !ch.is_ascii_alphabetic() {
                break;
            }
            name.push(ch);
            self.bump();
        }
        if self.peek() == Some('*') {
            self.bump();
        }

        if let Some(symbol) = lookup(SYMBOLS, &name) {
            return symbol.to_owned();
        }
        if has_name(OPERATOR_NAMES, &name) {
            return name;
        }
        if let Some(spacing) = lookup(SPACING_COMMANDS, &name) {
            return spacing.to_owned();
        }
        if has_name(IGNORED_COMMANDS, &name) {
            if name == "left" || name == "right" {
                return self.parse_delimiter();
            }
            return String::new();
        }
        if has_name(TEXT_COMMANDS, &name) {
            let was_text_mode = self.text_mode;
            self.text_mode = true;
            let content = self.parse_argument();
            self.text_mode = was_text_mode;
            return content;
        }
        if has_name(MATH_FONT_COMMANDS, &name) {
            return self.parse_argument();
        }
        if let Some(style) = alphabet(&name) {
            let content = self.parse_argument();
            return style_alphabet(&content, style);
        }
        if let Some(accent) = lookup(ACCENTS, &name) {
            let content = self.parse_argument();
            let mut result = String::new();
            for ch in content.chars() {
                result.push(ch);
                if !ch.is_whitespace() {
                    result.push_str(accent);
                }
            }
            return result;
        }

        match name.as_str() {
            "frac" | "dfrac" | "tfrac" | "cfrac" => {
                let numerator = self.parse_argument();
                let denominator = self.parse_argument();
                let key = format!("{numerator}/{denominator}");
                lookup(COMMON_FRACTIONS, &key).map_or_else(
                    || {
                        format!(
                            "{}/{}",
                            parenthesize(&numerator),
                            parenthesize(&denominator)
                        )
                    },
                    ToOwned::to_owned,
                )
            }
            "binom" => {
                let top = self.parse_argument();
                let bottom = self.parse_argument();
                format!("C({top},{bottom})")
            }
            "sqrt" => {
                let index = self.parse_optional_bracket();
                let radicand = self.parse_argument();
                let operand = if is_simple_operand(&radicand) {
                    radicand
                } else {
                    format!("({radicand})")
                };

                match index.as_deref() {
                    None => format!("√{operand}"),
                    Some("3") => format!("∛{operand}"),
                    Some("4") => format!("∜{operand}"),
                    Some(index) => {
                        let mapped =
                            map_script(index, SUPERSCRIPTS).unwrap_or_else(|| format!("^{index}"));
                        format!("{mapped}√{operand}")
                    }
                }
            }
            "not" => {
                let negated = self.parse_atom().unwrap_or_default();
                format!("{negated}\u{338}")
            }
            "begin" | "end" => {
                self.parse_argument();
                String::new()
            }
            "stackrel" | "overset" => {
                let above = self.parse_argument();
                let base = self.parse_argument();
                map_script(&above, SUPERSCRIPTS).map_or_else(
                    || format!("{base}^{{{above}}}"),
                    |mapped| format!("{base}{mapped}"),
                )
            }
            "underset" => {
                let below = self.parse_argument();
                let base = self.parse_argument();
                map_script(&below, SUBSCRIPTS).map_or_else(
                    || format!("{base}_{{{below}}}"),
                    |mapped| format!("{base}{mapped}"),
                )
            }
            _ => name,
        }
    }

    fn parse_delimiter(&mut self) -> String {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }

        let Some(ch) = self.peek() else {
            return String::new();
        };
        if ch == '.' {
            self.bump();
            return String::new();
        }
        if ch == '\\' {
            return self.parse_command();
        }
        self.bump();
        ch.to_string()
    }

    fn peek(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.pos += ch.len_utf8();
        Some(ch)
    }
}

fn collapse_non_newline_whitespace(input: &str) -> String {
    let mut result = String::new();
    let mut run = String::new();

    for ch in input.chars() {
        if ch.is_whitespace() && ch != '\n' {
            run.push(ch);
            continue;
        }

        flush_whitespace_run(&mut result, &mut run);
        result.push(ch);
    }
    flush_whitespace_run(&mut result, &mut run);

    result
}

fn flush_whitespace_run(result: &mut String, run: &mut String) {
    match run.chars().count() {
        0 => {}
        1 => result.push_str(run),
        _ => result.push(' '),
    }
    run.clear();
}

fn collapse_blank_lines(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut result = String::new();
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        if ch != '\n' {
            result.push(ch);
            index += 1;
            continue;
        }

        let mut lookahead = index + 1;
        let mut last_newline = None;
        while lookahead < chars.len() && chars[lookahead].is_whitespace() {
            if chars[lookahead] == '\n' {
                last_newline = Some(lookahead);
            }
            lookahead += 1;
        }

        if let Some(last_newline) = last_newline {
            result.push('\n');
            index = last_newline + 1;
        } else {
            result.push('\n');
            index += 1;
        }
    }

    result
}

/// Convert LaTeX math source to Unicode plain text.
pub fn latex_to_unicode(tex: &str) -> String {
    let mut parser = LatexParser::new(tex);
    let parsed = parser.parse();
    collapse_blank_lines(&collapse_non_newline_whitespace(&parsed))
}

#[cfg(test)]
mod tests {
    use super::latex_to_unicode;

    #[test]
    fn converts_symbols_big_operators_and_scripts() {
        assert_eq!(
            latex_to_unicode("y_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}"),
            "yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ"
        );
    }

    #[test]
    fn converts_greek_letters_and_relations() {
        assert_eq!(
            latex_to_unicode("\\alpha \\leq \\beta \\implies \\gamma \\to \\infty"),
            "α ≤ β ⇒ γ → ∞"
        );
    }

    #[test]
    fn renders_operator_names_as_plain_words() {
        assert_eq!(latex_to_unicode("O(n \\log n)"), "O(n log n)");
        assert_eq!(latex_to_unicode("\\max_i f(x_i)"), "maxᵢ f(xᵢ)");
    }

    #[test]
    fn renders_fractions_linearly_with_parentheses_only_when_needed() {
        assert_eq!(latex_to_unicode("\\frac{a}{b}"), "a/b");
        assert_eq!(latex_to_unicode("\\frac{x+1}{2}"), "(x+1)/2");
        assert_eq!(latex_to_unicode("\\frac{1}{2} m v^2"), "½ m v²");
    }

    #[test]
    fn renders_square_roots() {
        assert_eq!(latex_to_unicode("\\sqrt{x}"), "√x");
        assert_eq!(latex_to_unicode("\\sqrt{x^2+1}"), "√(x²+1)");
        assert_eq!(latex_to_unicode("\\sqrt[3]{8}"), "∛8");
    }

    #[test]
    fn unwraps_text_commands_and_styles_alphabets() {
        assert_eq!(
            latex_to_unicode("\\text{softmax}(QK^T / \\sqrt{d_k})"),
            "softmax(QKᵀ / √dₖ)"
        );
        assert_eq!(latex_to_unicode("\\mathbb{R}^d"), "ℝᵈ");
        assert_eq!(latex_to_unicode("\\mathcal{L}"), "ℒ");
        assert_eq!(latex_to_unicode("\\mathbf{W} x"), "𝐖 x");
    }

    #[test]
    fn applies_accents_as_combining_characters() {
        assert_eq!(latex_to_unicode("\\hat{y}"), "ŷ");
        assert_eq!(latex_to_unicode("\\vec{x}"), "x⃗");
    }

    #[test]
    fn keeps_tex_notation_for_scripts_without_unicode_forms() {
        assert_eq!(latex_to_unicode("\\nabla_\\theta J(\\theta)"), "∇_θ J(θ)");
        assert_eq!(latex_to_unicode("x_{best}"), "x_{best}");
    }

    #[test]
    fn drops_sizing_commands_and_keeps_delimiters() {
        assert_eq!(
            latex_to_unicode("\\left( \\frac{1}{N} \\sum_{i=1}^N x_i \\right)"),
            "( 1/N ∑ᵢ₌₁ᴺ xᵢ )"
        );
    }

    #[test]
    fn turns_aligned_environments_into_multiple_lines() {
        assert_eq!(
            latex_to_unicode("\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}").trim(),
            "a = b + c \n d = e"
        );
    }

    #[test]
    fn degrades_unknown_commands_to_their_name() {
        assert_eq!(latex_to_unicode("\\foobar x"), "foobar x");
    }

    #[test]
    fn handles_escaped_braces() {
        assert_eq!(
            latex_to_unicode("x \\in \\{1, \\dots, K\\}"),
            "x ∈ {1, …, K}"
        );
    }

    #[test]
    fn collapses_insignificant_whitespace_from_spacing_commands() {
        assert_eq!(
            latex_to_unicode("\\int_0^1 x^2 \\, dx = \\frac{1}{3}"),
            "∫₀¹ x² dx = ⅓"
        );
    }

    #[test]
    fn renders_matrix_environments_as_rows() {
        assert_eq!(
            latex_to_unicode("\\begin{pmatrix}\n1 & 2 \\\\\n3 & 4\n\\end{pmatrix}").trim(),
            "1 2 \n3 4"
        );
    }

    #[test]
    fn treats_accented_characters_as_simple_fraction_operands() {
        assert_eq!(latex_to_unicode("\\frac{\\hat{x}}{2}"), "x̂/2");
    }

    #[test]
    fn keeps_underscores_literal_inside_text_mode_commands() {
        assert_eq!(latex_to_unicode("\\text{x_i}"), "x_i");
        assert_eq!(
            latex_to_unicode("\\text{learning_rate} = 0.1"),
            "learning_rate = 0.1"
        );
        assert_eq!(latex_to_unicode("\\mathrm{x_i}"), "xᵢ");
    }
}
