#[path = "../src/ansi_to_html.rs"]
mod ansi_to_html;

use ansi_to_html::{ansi_lines_to_html, ansi_to_html};

#[test]
fn ansi_to_html_escapes_html_and_preserves_newlines() {
    assert_eq!(
        ansi_to_html("a\n<b & \" ' >"),
        "a\n&lt;b &amp; &quot; &#039; &gt;"
    );
}

#[test]
fn ansi_to_html_renders_standard_styles_and_resets() {
    assert_eq!(
        ansi_to_html("\x1b[31;1mred\x1b[22mnormal\x1b[0mplain"),
        concat!(
            "<span style=\"color:#800000;font-weight:bold\">red</span>",
            "<span style=\"color:#800000\">normal</span>",
            "plain"
        )
    );

    assert_eq!(
        ansi_to_html("\x1b[2;3;4mdim italic underline\x1b[23;24m dim only"),
        concat!(
            "<span style=\"opacity:0.6;font-style:italic;text-decoration:underline\">",
            "dim italic underline",
            "</span>",
            "<span style=\"opacity:0.6\"> dim only</span>"
        )
    );
}

#[test]
fn ansi_to_html_renders_bright_foreground_and_background_colors() {
    assert_eq!(
        ansi_to_html("\x1b[96;107mcyan on white\x1b[39mwhite bg\x1b[49m"),
        concat!(
            "<span style=\"color:#00ffff;background-color:#ffffff\">cyan on white</span>",
            "<span style=\"background-color:#ffffff\">white bg</span>"
        )
    );
}

#[test]
fn ansi_to_html_renders_256_color_and_rgb_modes() {
    assert_eq!(
        ansi_to_html("\x1b[38;5;196mred\x1b[48;2;1;2;3mbg\x1b[39mfg reset\x1b[49m"),
        concat!(
            "<span style=\"color:#ff0000\">red</span>",
            "<span style=\"color:#ff0000;background-color:rgb(1,2,3)\">bg</span>",
            "<span style=\"background-color:rgb(1,2,3)\">fg reset</span>"
        )
    );

    assert_eq!(
        ansi_to_html("\x1b[38;5;244mgray\x1b[0m"),
        "<span style=\"color:#808080\">gray</span>"
    );
}

#[test]
fn ansi_to_html_renders_inverse_and_strikethrough_when_present() {
    assert_eq!(
        ansi_to_html("\x1b[31;44;7;9mtext\x1b[27;29mplain"),
        concat!(
            "<span style=\"color:#000080;background-color:#800000;text-decoration:line-through\">",
            "text",
            "</span>",
            "<span style=\"color:#800000;background-color:#000080\">plain</span>"
        )
    );

    assert_eq!(
        ansi_to_html("\x1b[7minverse\x1b[27m"),
        "<span style=\"filter:invert(100%)\">inverse</span>"
    );
}

#[test]
fn ansi_to_html_wraps_lines_and_uses_nbsp_for_empty_lines() {
    assert_eq!(
        ansi_lines_to_html(&["", "\x1b[32mok"]),
        concat!(
            "<div class=\"ansi-line\">&nbsp;</div>",
            "<div class=\"ansi-line\"><span style=\"color:#008000\">ok</span></div>"
        )
    );
}

#[test]
fn ansi_to_html_preserves_unrecognized_or_incomplete_escape_sequences() {
    assert_eq!(ansi_to_html("x\x1b[31xm<"), "x\x1b[31xm&lt;");
    assert_eq!(ansi_to_html("x\x1b[31"), "x\x1b[31");
}

#[test]
fn ansi_to_html_treats_empty_sgr_params_as_reset() {
    assert_eq!(
        ansi_to_html("\x1b[31mred\x1b[mplain"),
        "<span style=\"color:#800000\">red</span>plain"
    );
    assert_eq!(
        ansi_to_html("\x1b[31mred\x1b[;mplain"),
        "<span style=\"color:#800000\">red</span>plain"
    );
}
