pub mod autocomplete;
pub mod box_component;
pub mod cancellable_loader;
pub mod editor;
pub mod editor_component;
pub mod fuzzy;
pub mod input;
pub mod keybindings;
pub mod keys;
pub mod kill_ring;
pub mod latex;
pub mod loader;
pub mod markdown;
pub mod render_cache;
pub mod select_list;
pub mod settings_list;
pub mod spacer;
pub mod stdin_buffer;
pub mod terminal;
pub mod terminal_colors;
pub mod terminal_image;
pub mod text;
pub mod truncated_text;
pub mod undo_stack;
pub mod utils;

pub use autocomplete::{
    ArgumentCompletionFn, AutocompleteCommand, AutocompleteInputEvent, AutocompleteItem,
    AutocompleteOptions, AutocompleteProvider, AutocompleteState, AutocompleteSuggestions,
    CombinedAutocompleteProvider, CompletionEdit, SlashCommand, apply_completion,
    should_trigger_file_completion,
};
pub use box_component::{
    BoxBackgroundFn, BoxChild, BoxChildId, BoxChildInvalidateFn, BoxChildRenderFn, BoxComponent,
    BoxRenderCache,
};
pub use cancellable_loader::{CancellableLoader, CancellationFlag};
pub use editor::{
    CursorPosition, Editor, EditorEvent, EditorOptions, EditorRenderOptions, EditorState,
    JumpDirection, LayoutLine, TextChunk, TextSegment, VisualLine, is_paste_marker, segment_text,
    segment_with_markers, word_wrap_line, word_wrap_line_with_markers, word_wrap_segments,
};
pub use editor_component::EditorComponent;
pub use fuzzy::{FuzzyMatch, fuzzy_filter, fuzzy_match};
pub use input::{CURSOR_MARKER as INPUT_CURSOR_MARKER, Input, InputEvent};
pub use keybindings::{
    KeybindingConflict, KeybindingDefinition, KeybindingDefinitions, KeybindingKeys,
    KeybindingsConfig, KeybindingsManager, TUI_KEYBINDINGS, get_keybindings, set_keybindings,
    tui_keybinding_definitions,
};
pub use keys::{
    KeyEnvironment, KeyEventType, decode_kitty_printable, decode_printable_key, is_key_release,
    is_key_repeat, is_kitty_protocol_active, matches_key, matches_key_with_env, parse_key,
    parse_key_with_env, set_kitty_protocol_active,
};
pub use kill_ring::{KillRing, KillRingPushOptions};
pub use latex::latex_to_unicode;
pub use loader::{
    DEFAULT_FRAMES, DEFAULT_INTERVAL_MS, Loader, LoaderIndicatorOptions, LoaderStyleFn,
};
pub use markdown::{
    DefaultTextStyle, Markdown, MarkdownHighlightCodeFn, MarkdownStyleFn, MarkdownTheme,
};
pub use render_cache::VersionedRenderCache;
pub use select_list::{
    DEFAULT_PRIMARY_COLUMN_WIDTH, MIN_DESCRIPTION_WIDTH, PRIMARY_COLUMN_GAP, SelectItem,
    SelectList, SelectListLayoutOptions, SelectListStyleFn, SelectListTheme,
    SelectListTruncatePrimaryContext, TruncatePrimaryFn,
};
pub use settings_list::{
    SettingItem, SettingsList, SettingsListCancelCallback, SettingsListChangeCallback,
    SettingsListOptions, SettingsListSelectedStyleFn, SettingsListStyleFn, SettingsListTheme,
    SettingsSubmenu, SettingsSubmenuFactory, SettingsSubmenuInputCallback,
    SettingsSubmenuInvalidateCallback, SettingsSubmenuRenderCallback, SettingsSubmenuResult,
};
pub use spacer::Spacer;
pub use stdin_buffer::{StdinBuffer, StdinEvent};
pub use terminal::{
    DEFAULT_COLUMNS, DEFAULT_ROWS, DISABLE_BRACKETED_PASTE_SEQUENCE,
    DISABLE_KITTY_KEYBOARD_PROTOCOL_SEQUENCE, DISABLE_MODIFY_OTHER_KEYS_SEQUENCE,
    ENABLE_BRACKETED_PASTE_SEQUENCE, ENABLE_KITTY_KEYBOARD_PROTOCOL_SEQUENCE,
    ENABLE_MODIFY_OTHER_KEYS_SEQUENCE, ProcessTerminalState,
    QUERY_KITTY_KEYBOARD_PROTOCOL_SEQUENCE, TERMINAL_PROGRESS_ACTIVE_SEQUENCE,
    TERMINAL_PROGRESS_CLEAR_SEQUENCE, TERMINAL_PROGRESS_KEEPALIVE_MS, Terminal, TerminalDimensions,
    TerminalSizeInputs, clear_from_cursor_sequence, clear_line_sequence, clear_screen_sequence,
    hide_cursor_sequence, kitty_protocol_response_flags, move_by_sequence,
    resolve_terminal_columns, resolve_terminal_dimensions, resolve_terminal_rows,
    set_title_sequence, show_cursor_sequence,
};
pub use terminal_colors::{
    AnsiColor, DefaultTerminalColorListener, DefaultTerminalColors, OscColorKind, OscColorResponse,
    QUERY_DEFAULT_BACKGROUND, QUERY_DEFAULT_FOREGROUND, Rgb, TerminalBackgroundKind,
    TerminalColorMode, best_ansi_color, clear_default_terminal_colors,
    detect_background_from_color_fg_bg, get_default_terminal_colors, get_terminal_background_kind,
    is_light_color, on_default_terminal_colors_change, parse_osc_color_response, rgb_to_256,
    rgb_to_hex, set_default_terminal_colors,
};
pub use terminal_image::{
    CellDimensions, ITerm2ImageOptions, ImageDimensions, ImageProtocol, ImageRender,
    ImageRenderOptions, KittyImageOptions, TerminalCapabilities, TerminalEnvironment,
    allocate_image_id, calculate_image_rows, delete_all_kitty_images, delete_kitty_image,
    detect_capabilities, detect_capabilities_from_env, encode_iterm2, encode_kitty,
    get_capabilities, get_cell_dimensions, get_gif_dimensions, get_image_dimensions,
    get_jpeg_dimensions, get_png_dimensions, get_webp_dimensions, hyperlink, image_fallback,
    is_image_line, render_image, reset_capabilities_cache, set_capabilities, set_cell_dimensions,
};
pub use text::{Text, TextBackgroundFn};
pub use truncated_text::TruncatedText;
pub use undo_stack::UndoStack;
pub use utils::{
    AnsiCode, ExtractedSegments, TextSlice, apply_background_to_line, extract_ansi_code,
    extract_segments, is_punctuation_char, is_whitespace_char, normalize_terminal_output,
    slice_by_column, slice_with_width, truncate_to_width, truncate_to_width_default, visible_width,
    wrap_text_with_ansi,
};
